// §B3.2 / P2 - Dexie save queue with debounce (400 ms).
//
// Handles the debounce + IDB persistence of drafts. Exports a pure
// `SaveQueue` class (no Svelte runes) that FilesStore instantiates.
// The `$state` mutations (`hasPendingSave`, `lastSavedAt`) are
// delegated via injected callbacks - SaveQueue does not import Svelte.

import { db, newId } from './db';
import type { DraftRow } from './db';
import { TIMERS } from './config';
import { uniqueName } from './file-utils';
import type { DocumentRevision } from './document-revisions';

const SAVE_SUPERSEDED = Symbol('save-superseded');

type ConflictApi = {
	conflictOccupancy: typeof import('./draft-occupancy').conflictOccupancy;
	projectConflictVariant: typeof import('./project-conflicts').projectConflictVariant;
};

let conflictApiPromise: Promise<ConflictApi> | null = null;

/** Loads rare conflict helpers before a transaction starts. */
function conflictApi(): Promise<ConflictApi> {
	conflictApiPromise ??= Promise.all([
		import('./draft-occupancy'),
		import('./project-conflicts')
	]).then(([occupancy, conflicts]) => ({
		conflictOccupancy: occupancy.conflictOccupancy,
		projectConflictVariant: conflicts.projectConflictVariant
	}));
	return conflictApiPromise;
}
const METRICS = import.meta.env.VITE_SOURCE_FIDELITY_METRICS === '1';

/** Callbacks to the store's `$state` - injected at construction. */
export interface SaveQueueCallbacks {
	/** Called when the "save in progress" state changes. */
	onPendingChange: (pending: boolean) => void;
	/** Called when an IDB write completes successfully. */
	onSaved: (ts: number) => void;
	/**
	 * Called if an IDB write fails (quota full, IDB unavailable, etc.). Without
	 * this channel, a write failure was swallowed in `console.error` and the UI
	 * always showed "saved" → silent data loss.
	 */
	onError: (err: unknown) => void;
	/**
	 * §M3 - Called after the SUCCESSFUL write of a specific draft (id + updatedAt).
	 * Optional. Used by the store to publish the write to the other tabs
	 * (BroadcastChannel) to avoid silent last-writer-wins.
	 */
	onDraftSaved?: (id: string, updatedAt: number, revision?: DocumentRevision) => void;
	/** Called when a concurrent durable branch was copied to version history. */
	onConflictPreserved?: (id: string, variant: DraftRow) => void;
	/** Called when a write adopts a newer durable project location. */
	onDraftReconciled?: (row: DraftRow) => void;
	/** Persistent per-document errors for a reactive status surface. */
	onFailuresChange?: (ids: string[]) => void;
}

export interface SaveQueueFailure {
	id: string;
	error: unknown;
}

/**
 * Raised by `flushAwait` when at least one live draft is still only in memory.
 * Individual write promises never reject, so unload and debounce paths cannot
 * create unhandled rejections. The awaited durability barrier is the single
 * fail-closed boundary.
 */
export class SaveQueueFlushError extends Error {
	readonly failures: SaveQueueFailure[];

	constructor(failures: SaveQueueFailure[]) {
		super(`Unable to persist ${failures.length} draft(s)`);
		this.name = 'SaveQueueFlushError';
		this.failures = failures;
	}
}

/**
 * Save queue with per-file debounce. A `schedule(id, getRow)` cancels the
 * previous timer for `id` and reschedules a new one. After 400 ms without a
 * new call, `getRow()` is invoked and the row is written to IDB via
 * `db.drafts.put`.
 *
 * Writes for a given id are **serialized** (promise chain) so an older put
 * cannot complete after a newer one and roll back fresher content.
 *
 * `discard(id)` marks the id so in-flight or chained puts neither resurrect
 * a draft after trash/hard-delete nor report onSaved for a removed row.
 *
 * `hasPendingSave` = `saveTimers.size > 0 || pendingWrites > 0`.
 * Without the `pendingWrites` counter, the indicator would fall back to `false`
 * as soon as the timer is cleared, before the IDB write completes.
 */
export class SaveQueue {
	private timers = new Map<string, ReturnType<typeof setTimeout>>();
	private pendingWrites = 0;
	/** Refcount of in-flight / chained puts per id (timer already cleared). */
	private writingIds = new Map<string, number>();
	/** In-flight put promises - used by `flushAwait` / backup to wait for durability. */
	private putPromises = new Set<Promise<void>>();
	/** Latest unresolved durability failure per live draft. Cleared only by a successful put. */
	private durabilityFailures = new Map<string, unknown>();
	/** Last durable content observed by this tab, used for optimistic conflict detection. */
	private persistedRows = new Map<
		string,
		Pick<DraftRow, 'name' | 'content' | 'projectId' | 'relativePath' | 'updatedAt'>
	>();
	/** Per-id serial chain so puts never race each other on the same draft. */
	private chains = new Map<string, Promise<void>>();
	/**
	 * Generation counter per id. Each enqueue bumps it; a chain link skips the
	 * write when a newer generation exists (latest content supersedes stale
	 * snapshots still queued).
	 */
	private generations = new Map<string, number>();
	/**
	 * Ids whose draft must not remain in `drafts` after a put settles
	 * (trash / hard-delete only). Puts check this before and after write.
	 * Never use for reload/backup - that would delete restored rows.
	 */
	private discardedIds = new Set<string>();
	/**
	 * Ids whose in-flight / chained puts must skip write + onSaved without
	 * deleting the IDB row (reload, remote backup-applied). Distinct from
	 * `discardedIds` which reverse-deletes after a put (trash resurrection).
	 */
	private invalidatedIds = new Set<string>();
	private cb: SaveQueueCallbacks;
	private writeRow: ((row: DraftRow) => Promise<unknown>) | undefined;
	private capturedRevisions = new WeakMap<DraftRow, DocumentRevision>();

	constructor(cb: SaveQueueCallbacks, writeRow?: (row: DraftRow) => Promise<unknown>) {
		this.cb = cb;
		this.writeRow = writeRow;
	}

	/** Revisions stay outside the durable row and portable formats. */
	captureRevision(row: DraftRow, revision: DocumentRevision): void {
		if (row.id !== revision.fileId) throw new Error('document-revision-file-mismatch');
		this.capturedRevisions.set(row, revision);
	}

	private readRow(id: string, getRow: () => DraftRow | null): DraftRow | null {
		try {
			return getRow();
		} catch (error) {
			this.durabilityFailures.set(id, error);
			this.cb.onError(error);
			this.updateFlag();
			return null;
		}
	}

	private updateFlag(): void {
		this.cb.onFailuresChange?.([...this.durabilityFailures.keys()]);
		this.cb.onPendingChange(
			this.timers.size > 0 || this.pendingWrites > 0 || this.durabilityFailures.size > 0
		);
	}

	/** Registers the durable baseline read at startup or after a remote sync. */
	trackPersisted(row: DraftRow): void {
		this.persistedRows.set(row.id, {
			name: row.name,
			content: row.content,
			...(row.projectId === undefined ? {} : { projectId: row.projectId }),
			...(row.relativePath === undefined ? {} : { relativePath: row.relativePath }),
			updatedAt: row.updatedAt
		});
	}

	private isActivelySaving(id: string): boolean {
		return this.timers.has(id) || (this.writingIds.get(id) ?? 0) > 0;
	}

	private async putPreservingConflict(row: DraftRow, generation: number): Promise<DraftRow | null> {
		const superseded = () =>
			this.generations.get(row.id) !== generation ||
			this.discardedIds.has(row.id) ||
			this.invalidatedIds.has(row.id);
		if (this.writeRow) {
			if (superseded()) return null;
			await this.writeRow(row);
			// An injected writer has no enclosing transaction to roll back. A
			// discard must reach execute() so it can remove a committed stale row.
			if (this.discardedIds.has(row.id)) return row;
			if (superseded()) return null;
			this.trackPersisted(row);
			return row;
		}
		const conflict = await conflictApi();
		let preserved: DraftRow | undefined;
		let written = row;
		try {
			await db.transaction('rw', db.drafts, db.versions, db.projectAssets, async () => {
				const current = await db.drafts.get(row.id);
				if (superseded()) throw SAVE_SUPERSEDED;
				const baseline = this.persistedRows.get(row.id);
				const durableLocationChanged = Boolean(
					current &&
					baseline &&
					(current.projectId !== baseline.projectId ||
						current.relativePath !== baseline.relativePath)
				);
				if (current && durableLocationChanged) {
					const relocated = { ...row };
					delete relocated.projectId;
					delete relocated.relativePath;
					written = {
						...relocated,
						name: current.name,
						...(current.projectId && current.relativePath
							? { projectId: current.projectId, relativePath: current.relativePath }
							: {})
					};
				}
				const changedSinceRead = current
					? !baseline ||
						current.name !== baseline.name ||
						current.projectId !== baseline.projectId ||
						current.relativePath !== baseline.relativePath ||
						current.updatedAt !== baseline.updatedAt ||
						current.content.length !== baseline.content.length ||
						current.content !== baseline.content
					: false;
				if (
					current &&
					changedSinceRead &&
					(current.name !== written.name || current.content !== written.content)
				) {
					const occupancy = await conflict.conflictOccupancy(current.projectId);
					const [documents, assets] = occupancy
						? [[], []]
						: await Promise.all([db.drafts.toArray(), db.projectAssets.toArray()]);
					const variant = conflict.projectConflictVariant(
						current,
						documents,
						assets,
						occupancy?.occupied
					);
					preserved = {
						...variant,
						id: newId(),
						name:
							variant.relativePath === current.relativePath
								? uniqueName(
										occupancy ? occupancy.names : documents.map((document) => document.name),
										current.name
									)
								: variant.name,
						order:
							(occupancy
								? occupancy.maxOrder
								: documents.reduce((max, document) => Math.max(max, document.order), -1)) + 1,
						open: false
					};
					await db.drafts.put(preserved);
					await db.versions.put({
						id: newId(),
						draftId: current.id,
						name: current.name,
						content: current.content,
						createdAt: Date.now()
					});
				}
				if (superseded()) throw SAVE_SUPERSEDED;
				await db.drafts.put(written);
				if (superseded()) throw SAVE_SUPERSEDED;
			});
		} catch (error) {
			if (error === SAVE_SUPERSEDED) return null;
			throw error;
		}
		this.trackPersisted(written);
		if (preserved) this.cb.onConflictPreserved?.(row.id, preserved);
		if (written !== row) this.cb.onDraftReconciled?.(written);
		return written;
	}

	private bumpGeneration(id: string): number {
		const next = (this.generations.get(id) ?? 0) + 1;
		this.generations.set(id, next);
		return next;
	}

	private incWriting(id: string): void {
		this.writingIds.set(id, (this.writingIds.get(id) ?? 0) + 1);
	}

	private decWriting(id: string): void {
		const n = (this.writingIds.get(id) ?? 1) - 1;
		if (n <= 0) this.writingIds.delete(id);
		else this.writingIds.set(id, n);
	}

	/**
	 * Enqueues a single IDB put on the per-id serial chain. Tracks in-flight
	 * ids so `has(id)` stays true across the timer → write gap (cross-tab
	 * policy must not treat that window as "no local pending").
	 *
	 * If no put is active for `id`, call `db.drafts.put` before the first await.
	 * Callers can inspect the write immediately after a flush.
	 */
	private enqueuePut(row: DraftRow): void {
		const id = row.id;
		const revision = this.capturedRevisions.get(row);
		// A live schedule re-arms a discarded / invalidated id (e.g. restored
		// from trash, or edited again after a cross-tab toast).
		this.discardedIds.delete(id);
		this.invalidatedIds.delete(id);
		const gen = this.bumpGeneration(id);
		this.pendingWrites += 1;
		this.incWriting(id);

		const execute = async (): Promise<void> => {
			// Superseded by a newer enqueue, invalidate, or discard - skip write.
			if (this.generations.get(id) !== gen) return;

			const started = METRICS ? performance.now() : 0;
			try {
				const written = await this.putPreservingConflict(row, gen);
				if (!written) return;
				if (written !== row) row = written;
			} catch (err) {
				// Only surface errors for the still-current live generation.
				if (
					this.generations.get(id) === gen &&
					!this.discardedIds.has(id) &&
					!this.invalidatedIds.has(id)
				) {
					this.durabilityFailures.set(id, err);
					this.cb.onError(err);
				}
				return;
			} finally {
				if (METRICS)
					performance.measure('mdsh:document-storage', { start: started, end: performance.now() });
			}
			// Put finished: trash discard must reverse a resurrection. Compare the
			// durable row with the stale write before deleting. Another tab can
			// write a newer row with the same ID while this put was in flight.
			if (this.discardedIds.has(id)) {
				try {
					const { deleteDiscardedWrite } = await import('./draft-access');
					const outcome = await deleteDiscardedWrite(id, row);
					if (outcome === 'conflict') this.cb.onError(new Error('save-reverse-delete-conflict'));
				} catch (err) {
					this.cb.onError(err);
				}
				return;
			}
			// Invalidate / newer generation: do not notify (and do not delete -
			// the row may be the restored backup / reloaded authority).
			if (this.invalidatedIds.has(id) || this.generations.get(id) !== gen) return;
			this.durabilityFailures.delete(id);
			this.cb.onSaved(Date.now());
			// §M3 - Notifies the other tabs of the successful write.
			if (revision) this.cb.onDraftSaved?.(row.id, row.updatedAt, revision);
			else this.cb.onDraftSaved?.(row.id, row.updatedAt);
		};

		const prev = this.chains.get(id);
		// Call execute() directly when idle so put() starts in this turn.
		const run: Promise<void> = prev ? prev.catch(() => undefined).then(() => execute()) : execute();

		const tracked = run.finally(() => {
			this.pendingWrites -= 1;
			this.decWriting(id);
			this.putPromises.delete(tracked);
			// Drop chain head when this link was the latest for id.
			if (this.chains.get(id) === tracked) this.chains.delete(id);
			this.updateFlag();
		});

		this.chains.set(id, tracked);
		this.putPromises.add(tracked);
	}

	/**
	 * Schedules the write of `id` after `TIMERS.saveDebounceMs`.
	 * `getRow()` is called just before the write - it reads the current state
	 * of the file at flush time (not at schedule time).
	 */
	schedule(id: string, getRow: () => DraftRow | null): void {
		const prev = this.timers.get(id);
		if (prev) clearTimeout(prev);
		this.cb.onPendingChange(true);
		this.timers.set(
			id,
			setTimeout(() => {
				this.timers.delete(id);
				const row = this.readRow(id, getRow);
				if (!row) {
					this.updateFlag();
					return;
				}
				this.enqueuePut(row);
			}, TIMERS.saveDebounceMs)
		);
	}

	/** Queues an immediate durable row on the same per-document serial chain. */
	persist(row: DraftRow): void {
		this.cancel(row.id);
		this.enqueuePut(row);
		this.updateFlag();
	}

	/**
	 * Cancels a pending timer without writing. Used when detaching a tab that
	 * should not flush (prefer `discard` when the Dexie row must not resurface).
	 */
	cancel(id: string): void {
		const t = this.timers.get(id);
		if (t) {
			clearTimeout(t);
			this.timers.delete(id);
		}
		this.updateFlag();
	}

	/**
	 * Cancels the timer and marks `id` so in-flight / chained puts reverse-delete
	 * any resurrection. **Trash / hard-delete only** - never use on reload or
	 * backup restore (that would erase restored drafts).
	 */
	discard(id: string): void {
		this.cancel(id);
		this.invalidatedIds.delete(id);
		this.discardedIds.add(id);
		this.durabilityFailures.delete(id);
		this.persistedRows.delete(id);
		// Bump generation so any chain link still holding a stale row skips put.
		this.bumpGeneration(id);
		this.updateFlag();
	}

	/**
	 * Cancels the timer and marks `id` so in-flight / chained puts skip write
	 * and onSaved **without** deleting the IDB row. Used by `reload` and
	 * cross-tab backup-applied (restored tables must stay intact).
	 */
	invalidate(id: string): void {
		this.cancel(id);
		this.discardedIds.delete(id);
		this.invalidatedIds.add(id);
		this.durabilityFailures.delete(id);
		this.bumpGeneration(id);
		this.updateFlag();
	}

	/** Cancels all timers without writing (e.g. global reorder of timers only). */
	cancelAll(ids: string[]): void {
		for (const id of ids) {
			const t = this.timers.get(id);
			if (t) {
				clearTimeout(t);
				this.timers.delete(id);
			}
		}
		this.updateFlag();
	}

	/**
	 * Invalidates every listed id (timers + in-flight puts, no reverse-delete).
	 * Used by `reload` and cross-tab backup-applied.
	 */
	invalidateAll(ids: string[]): void {
		for (const id of ids) this.invalidate(id);
	}

	/**
	 * Discards every listed id (timers + reverse-delete). Prefer per-id
	 * `discard` from trash/hard-delete; bulk form for tests / rare paths.
	 */
	discardAll(ids: string[]): void {
		for (const id of ids) this.discard(id);
	}

	/**
	 * Waits for active or chained puts while discard stays active. Then clears
	 * the discard and invalidation flags and increments the generation.
	 * Keeping discard active lets reverse-delete finish.
	 *
	 * Run this before a trash restore. Otherwise, an earlier put can delete the
	 * restored draft after `restoreFromTrash` writes it.
	 */
	async settleAndRearm(id: string): Promise<void> {
		const chain = this.chains.get(id);
		if (chain) {
			try {
				await chain;
			} catch {
				// Prior put errors are already routed to onError.
			}
		}
		this.discardedIds.delete(id);
		this.invalidatedIds.delete(id);
		this.bumpGeneration(id);
		this.updateFlag();
	}

	/**
	 * §M1 - Immediately writes pending content for IDs with an active timer.
	 * Preserve pending keystrokes before clearing timers. `reorder` uses this
	 * before it writes the new order. Workspace switches call `close({ keepDB: true })`
	 * to keep edits. Unlike `cancelAll`, this writes pending keystrokes before removing their timers.
	 *
	 * Fire-and-forget (consistent with `flush`); the writes are counted in
	 * `pendingWrites` so the "saving" indicator stays accurate.
	 */
	flushPending(ids: string[], getRow: (id: string) => DraftRow | null): void {
		for (const id of ids) {
			const t = this.timers.get(id);
			if (!t) continue;
			clearTimeout(t);
			this.timers.delete(id);
			const row = this.readRow(id, () => getRow(id));
			if (!row) continue;
			this.enqueuePut(row);
		}
		this.updateFlag();
	}

	/**
	 * True while `id` has an armed debounce timer OR an in-flight/chained IDB put.
	 * Cross-tab guards must use this so they do not reload / overwrite during
	 * the write window after the timer fires.
	 */
	has(id: string): boolean {
		return this.isActivelySaving(id) || this.durabilityFailures.has(id);
	}

	/** True when the latest content is known to exist only in memory. */
	hasDurabilityFailure(id: string): boolean {
		return this.durabilityFailures.has(id);
	}

	/**
	 * §A2.8 - Immediate flush: clears the timers and writes all pending rows.
	 * Called on `pagehide` / `beforeunload`. This is best effort. A process kill
	 * can stop the transaction; only a completed awaited barrier proves a save.
	 */
	flush(getRow: (id: string) => DraftRow | null, retryFailed = true): void {
		const ids = new Set([
			...this.timers.keys(),
			...(retryFailed ? this.durabilityFailures.keys() : [])
		]);
		for (const id of ids) {
			const t = this.timers.get(id);
			if (t) clearTimeout(t);
			this.timers.delete(id);
			const row = this.readRow(id, () => getRow(id));
			if (!row) continue;
			// §m3 - `onSaved` ONLY after the write succeeds (like the `schedule`
			// path). Previously `onSaved(Date.now())` was called unconditionally at
			// the end of the loop → the UI could show "saved" while a put failed
			// (invariant "onSaved ⇒ write succeeded" broken). In the unload context
			// the UI disappears, but we keep the consistency for possible
			// non-unload flushes.
			this.enqueuePut(row);
		}
		this.updateFlag();
	}

	/**
	 * Flushes armed timers then waits until every in-flight put settles.
	 * Drains in a loop so puts started during the wait (rare) are still
	 * awaited. Used by backup export so the JSON snapshot includes the latest
	 * keystrokes.
	 */
	async flushAwait(getRow: (id: string) => DraftRow | null): Promise<void> {
		// Retry rows that failed previously even if no new edit re-armed a timer.
		// This lets a temporary quota/IDB outage recover without another keystroke.
		for (const id of [...this.durabilityFailures.keys()]) {
			if (this.isActivelySaving(id)) continue;
			const row = this.readRow(id, () => getRow(id));
			if (row) this.enqueuePut(row);
		}
		// Bound the loop so a pathological continuous schedule cannot hang forever.
		for (let i = 0; i < 8; i++) {
			this.flush(getRow, false);
			if (this.putPromises.size === 0 && this.timers.size === 0) break;
			if (this.putPromises.size > 0) {
				await Promise.all([...this.putPromises]);
			}
			if (this.timers.size === 0 && this.putPromises.size === 0) break;
		}
		// Final flush of anything still armed. A continuous producer is reported
		// as non-durable instead of being presented as a successful barrier.
		this.flush(getRow, false);
		if (this.putPromises.size > 0) await Promise.all([...this.putPromises]);
		const failures = [...this.durabilityFailures].map(([id, error]) => ({ id, error }));
		if (this.timers.size > 0) {
			for (const id of this.timers.keys()) {
				if (!failures.some((failure) => failure.id === id)) {
					failures.push({ id, error: new Error('Draft changed during durability flush') });
				}
			}
		}
		if (failures.length > 0) throw new SaveQueueFlushError(failures);
	}
}

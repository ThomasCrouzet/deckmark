// §6.8 - Workspaces / named sessions
//
// Saves "which files are open" as a named workspace. Lets you juggle between
// distinct projects (e.g. "Notes meeting", "Article blog", "Brouillon roman")
// without losing the context of open tabs.
//
// Dexie persistence (table `workspaces`, version v3) - not localStorage because
// the list can grow (a workspace stores an array of ids + metadata).
//
// Note: the store never touches the `drafts` rows directly - it manipulates the
// "open/active" state via `filesStore`. The files themselves stay in the DB.

import { browser } from '$app/env';
import { db, newId, type WorkspaceRow } from './db';
import { filesStore } from './files.svelte';
import { reportPersistenceError } from './storage';
import { t } from '#lib/i18n/index.js';

class WorkspaceStore {
	workspaces = $state<WorkspaceRow[]>([]);
	loaded = $state(false);

	/**
	 * Latest mutation revision for each workspace. A completion may publish or
	 * reconcile only when it still owns this revision.
	 */
	private revisions = new Map<string, number>();
	/** Tail of the durable write queue for each workspace. */
	private writeQueues = new Map<string, Promise<void>>();
	/** Increments when the list is replaced, so stale completions cannot publish. */
	private listEpoch = 0;

	async load(): Promise<void> {
		if (!browser || this.loaded) return;
		const rows = await db.workspaces.orderBy('updatedAt').reverse().toArray();
		this.workspaces = rows;
		this.loaded = true;
	}

	/** §1.1 - Reloads from Dexie after a backup restore. */
	async reload(): Promise<void> {
		this.listEpoch += 1;
		this.revisions.clear();
		this.loaded = false;
		// Drain earlier writes so the reload reads the latest durable rows.
		await Promise.all([...this.writeQueues.values()]);
		await this.load();
	}

	private nextRevision(id: string): number {
		const revision = (this.revisions.get(id) ?? 0) + 1;
		this.revisions.set(id, revision);
		return revision;
	}

	private isLatestRevision(id: string, revision: number): boolean {
		return this.revisions.get(id) === revision;
	}

	/**
	 * Runs same-workspace writes one after another. Serialized durable writes
	 * keep the latest intent last, even when two callers overlap.
	 */
	private enqueue(id: string, task: () => Promise<void>): Promise<void> {
		const previous = this.writeQueues.get(id) ?? Promise.resolve();
		const run = previous.then(task, task);
		this.writeQueues.set(
			id,
			run.then(
				() => undefined,
				() => undefined
			)
		);
		return run;
	}

	private async waitForWrites(id: string): Promise<void> {
		await this.writeQueues.get(id);
	}

	private async readDurable(id: string): Promise<WorkspaceRow | null | undefined> {
		try {
			return (await db.workspaces.get(id)) ?? null;
		} catch {
			// The write failure already reported; keep the current display.
			return undefined;
		}
	}

	private replaceFromDurable(ws: WorkspaceRow, durable: WorkspaceRow): void {
		ws.name = durable.name;
		ws.fileIds = durable.fileIds;
		ws.activeId = durable.activeId;
		ws.createdAt = durable.createdAt;
		ws.updatedAt = durable.updatedAt;
	}

	private removeById(id: string): void {
		const index = this.workspaces.findIndex((candidate) => candidate.id === id);
		if (index !== -1) this.workspaces.splice(index, 1);
	}

	/** Places a row at its `updatedAt` order. Equal dates keep their order. */
	private placeByUpdatedAt(ws: WorkspaceRow): void {
		const current = this.workspaces.indexOf(ws);
		if (current === -1) return;
		this.workspaces.splice(current, 1);
		let index = 0;
		while (index < this.workspaces.length && this.workspaces[index]!.updatedAt > ws.updatedAt) {
			index += 1;
		}
		this.workspaces.splice(index, 0, ws);
	}

	/**
	 * Applies the latest durable row after the last queued write failed. A row
	 * that no longer exists on disk is removed, never resurrected in the list.
	 */
	private async reconcile(
		ws: WorkspaceRow,
		id: string,
		previousIndex: number,
		baseUpdatedAt: number
	): Promise<void> {
		const durable = await this.readDurable(id);
		if (durable === undefined) return;
		if (durable === null) {
			this.removeById(id);
			return;
		}
		this.replaceFromDurable(ws, durable);
		if (durable.updatedAt === baseUpdatedAt) {
			const current = this.workspaces.indexOf(ws);
			if (current !== -1 && current !== previousIndex) {
				this.workspaces.splice(current, 1);
				this.workspaces.splice(Math.min(previousIndex, this.workspaces.length), 0, ws);
			}
			return;
		}
		this.placeByUpdatedAt(ws);
	}

	/**
	 * Saves the current state as a new workspace. The name is trimmed; fallback
	 * the localized untitled name (`Sans nom` in French) for an empty confirmed value.
	 *
	 * Write-then-mutate: we write to IDB BEFORE mutating the runes state. If the
	 * `put` fails (full quota…), the error is notified and the list is left
	 * untouched - the UI never lies about a non-persisted phantom workspace.
	 * Returns `null` on failure.
	 */
	async save(name: string): Promise<WorkspaceRow | null> {
		const ws: WorkspaceRow = {
			id: newId(),
			name: name.trim() || t('workspaces.defaultName'),
			fileIds: filesStore.files.map((f) => f.id),
			activeId: filesStore.activeId,
			createdAt: Date.now(),
			updatedAt: Date.now()
		};
		try {
			await filesStore.flushPendingAwait();
			// $state.snapshot: Dexie clones via structuredClone, the runes proxy
			// would trigger `DataCloneError` (the proxy's getter functions are not
			// cloneable). `ws` here is a bare object (not yet in the `$state`), but
			// we keep the call for consistency and robustness.
			await db.workspaces.put($state.snapshot(ws));
		} catch (err) {
			reportPersistenceError(err, 'save');
			return null;
		}
		// Insert at the head only after the write succeeds (ordered by updatedAt
		// desc - the last saved is the most recent, so it appears first).
		this.workspaces.unshift(ws);
		return ws;
	}

	/**
	 * Updates an existing workspace with the current state (open files +
	 * activeId). Useful for "Update workspace" without creating a new
	 * one (refresh after adding/removing a tab).
	 *
	 * The durable write is a narrow property update, so a concurrent rename or
	 * another tab cannot lose unrelated fields. The visible row changes only
	 * after the write succeeds. A failure reconciles with the durable row and
	 * never restores a snapshot over newer accepted state.
	 */
	async update(id: string): Promise<void> {
		try {
			await filesStore.flushPendingAwait();
		} catch (err) {
			reportPersistenceError(err, 'save');
			return;
		}
		const ws = this.workspaces.find((w) => w.id === id);
		if (!ws) return;
		const revision = this.nextRevision(id);
		const epoch = this.listEpoch;
		const fileIds = filesStore.files.map((f) => f.id);
		const activeId = filesStore.activeId;
		const updatedAt = Date.now();
		const previousIndex = this.workspaces.indexOf(ws);
		const baseUpdatedAt = ws.updatedAt;

		await this.enqueue(id, async () => {
			if (epoch !== this.listEpoch) return;
			try {
				await db.workspaces.update(id, { fileIds, activeId, updatedAt });
			} catch (err) {
				reportPersistenceError(err, 'save');
				if (!this.isLatestRevision(id, revision) || epoch !== this.listEpoch) return;
				await this.reconcile(ws, id, previousIndex, baseUpdatedAt);
				return;
			}
			if (!this.isLatestRevision(id, revision) || epoch !== this.listEpoch) return;
			const durable = await this.readDurable(id);
			if (durable === null) {
				this.removeById(id);
				return;
			}
			if (durable === undefined) {
				// The write succeeded but the read failed: publish the written fields.
				ws.fileIds = fileIds;
				ws.activeId = activeId;
				ws.updatedAt = updatedAt;
				this.placeByUpdatedAt(ws);
				return;
			}
			this.replaceFromDurable(ws, durable);
			this.placeByUpdatedAt(ws);
		});
	}

	/**
	 * Renames a workspace. The durable write is a narrow property update, so a
	 * concurrent tab update keeps its file membership. The name changes only
	 * after the write succeeds; a failed older rename cannot replace a newer
	 * accepted name.
	 */
	async rename(id: string, name: string): Promise<void> {
		const ws = this.workspaces.find((w) => w.id === id);
		if (!ws) return;
		const trimmed = name.trim();
		if (!trimmed) return; // No-op if empty - keep the old name.
		const revision = this.nextRevision(id);
		const epoch = this.listEpoch;
		const updatedAt = Date.now();
		const previousIndex = this.workspaces.indexOf(ws);
		const baseUpdatedAt = ws.updatedAt;

		await this.enqueue(id, async () => {
			if (epoch !== this.listEpoch) return;
			try {
				await db.workspaces.update(id, { name: trimmed, updatedAt });
			} catch (err) {
				reportPersistenceError(err, 'save');
				if (!this.isLatestRevision(id, revision) || epoch !== this.listEpoch) return;
				await this.reconcile(ws, id, previousIndex, baseUpdatedAt);
				return;
			}
			if (!this.isLatestRevision(id, revision) || epoch !== this.listEpoch) return;
			const durable = await this.readDurable(id);
			if (durable === null) {
				this.removeById(id);
				return;
			}
			if (durable === undefined) {
				// The write succeeded but the read failed: publish the written fields.
				ws.name = trimmed;
				ws.updatedAt = updatedAt;
				return;
			}
			this.replaceFromDurable(ws, durable);
		});
	}

	/**
	 * Write-then-mutate: we delete from IDB BEFORE removing from the list. The
	 * delete waits behind earlier same-workspace writes, so a pending update
	 * cannot recreate the row after the delete.
	 */
	async delete(id: string): Promise<void> {
		const idx = this.workspaces.findIndex((w) => w.id === id);
		if (idx === -1) return;
		const epoch = this.listEpoch;
		await this.enqueue(id, async () => {
			try {
				await db.workspaces.delete(id);
			} catch (err) {
				reportPersistenceError(err, 'delete');
				return;
			}
			if (epoch !== this.listEpoch) return;
			this.removeById(id);
		});
	}

	/**
	 * Restores a workspace:
	 *   1. Opens the workspace's files that are no longer in the open session but
	 *      still exist in the DB (`drafts.bulkGet`).
	 *   2. Closes tabs outside the workspace with `keepDB: true`. The files stay
	 *      available to other workspaces.
	 *   3. Activates the target tab.
	 *
	 * Files present in the workspace but absent from the DB (deleted via `close`
	 * + trash purge) are silently ignored. Same for `activeId`: if the targeted
	 * file no longer exists, we keep the current activeId.
	 *
	 * Without `keepDB: true`, `closeMany` would destroy the files on every
	 * workspace switch - critical bug fixed after the Tier 5-9 review.
	 */
	/** Latest workspace restore request. An older restore must not publish. */
	private restoreGeneration = 0;

	async restore(id: string): Promise<void> {
		const ws = this.workspaces.find((w) => w.id === id);
		if (!ws) return;
		const generation = ++this.restoreGeneration;
		const isCurrent = () => generation === this.restoreGeneration;

		// Drain earlier writes for this workspace before reading its durable file
		// list. A stale completion must not replace the restored session.
		await this.waitForWrites(id);
		if (!this.workspaces.some((candidate) => candidate.id === id)) return;

		// Durability barrier: keepDB flushes are otherwise fire-and-forget, so a
		// rapid switch away and back could re-open pre-edit IDB content.
		try {
			await filesStore.flushPendingAwait();
		} catch (err) {
			reportPersistenceError(err, 'save');
			// Fail closed: keep every current tab and its in-memory content intact.
			return;
		}
		if (!isCurrent()) return;

		// 1. Open the missing files from Dexie (preserve the ids).
		const openIds = new Set(filesStore.files.map((f) => f.id));
		const toReopen = ws.fileIds.filter((wsId) => !openIds.has(wsId));
		if (toReopen.length > 0) {
			try {
				await filesStore.openWorkspace(toReopen, isCurrent);
			} catch (err) {
				// IDB read failure: without this catch, restore() rejected silently
				// (the WorkspacesPanel caller has no .catch) - the user did not
				// understand why nothing was happening.
				reportPersistenceError(err, 'load');
				return;
			}
		}
		if (!isCurrent()) return;

		// 2. Close the tabs outside the workspace WITHOUT touching the DB.
		const wsIds = new Set(ws.fileIds);
		const toClose = filesStore.files.map((f) => f.id).filter((fid) => !wsIds.has(fid));
		filesStore.closeMany(toClose, { trash: false, keepDB: true });

		// 2b. Sidebar order must match workspace fileIds (schema contract).
		filesStore.reorderToIds(ws.fileIds);

		// 3. Activate the target if it exists (otherwise fallback already handled by close).
		if (ws.activeId && filesStore.files.some((f) => f.id === ws.activeId)) {
			await filesStore.ensureContent([ws.activeId]);
			if (!isCurrent()) return;
			filesStore.setActive(ws.activeId);
		}
	}
}

export const workspaceStore = new WorkspaceStore();

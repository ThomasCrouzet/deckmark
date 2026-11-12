// §2.4 - Local version history.
//
// The save (400 ms debounce) overwrites the previous content; beyond the session
// undo, nothing allows going back. This module captures timestamped snapshots in
// `db.versions`, throttled and deduplicated so as not to blow up the storage,
// with purge by recency + age.
//
// Everything is local (Dexie) - no network. Pure logic + db access, testable.

import { db, newId, type VersionRow } from './db';

// Compile-time metrics stay out of the production bundle. Tests and the
// instrumented E2E build keep the observed path counters.
const HISTORY_METRICS =
	import.meta.env.MODE === 'test' || import.meta.env.VITE_SOURCE_FIDELITY_METRICS === '1';

function markHistory(name: string): void {
	window.dispatchEvent(
		new CustomEvent('deckmark:editor-perf', { detail: { kind: 'counter', name } })
	);
}

export const VERSION_LIMITS = {
	/** Max number of versions kept per file. */
	maxPerDraft: 30,
	/** Max age of a version (ms) - 30 days. */
	maxAgeMs: 30 * 24 * 60 * 60 * 1000,
	/** Min interval between two snapshots of the same file (ms) - 5 min. */
	minIntervalMs: 5 * 60 * 1000
} as const;

export interface SnapshotInput {
	id: string;
	name: string;
	content: string;
}

interface VersionIndexEntry {
	id: string;
	createdAt: unknown;
}

function versionRange(draftId: string) {
	return db.versions
		.where('[draftId+createdAt]')
		.between([draftId, -Infinity], [draftId, Infinity]);
}

function versionRow(draft: SnapshotInput, now: number): VersionRow {
	return {
		id: newId(),
		draftId: draft.id,
		name: draft.name,
		content: draft.content,
		createdAt: now
	};
}

async function putCheckpoint(draft: SnapshotInput, now: number): Promise<boolean> {
	const last = await versionRange(draft.id).last();
	if (last?.content === draft.content && last.name === draft.name) return false;
	await db.versions.put(versionRow(draft, now));
	await pruneVersions(draft.id, now);
	return true;
}

/**
 * Records a snapshot of the file, IF relevant:
 *   - non-empty content;
 *   - different from the last snapshot (no duplicate);
 *   - last snapshot older than `minIntervalMs` (throttle).
 * Then purges the file's history. Returns `true` if a snapshot was written.
 * Fire-and-forget on the caller side (does not block the save).
 */
export async function recordVersion(draft: SnapshotInput, now = Date.now()): Promise<boolean> {
	if (!draft.content.trim()) return false;
	// rw transaction: the sequence read (last snapshot) → throttle/dedup decision
	// → write → purge is atomic. Without it, two concurrent flushes of the same
	// file read the same "last" and wrote two near-identical snapshots.
	return db.transaction('rw', db.versions, async () => {
		// The newest compound-index key decides the throttle before any content
		// body loads. The full row is read only for a candidate checkpoint.
		const latestKey = await versionRange(draft.id).lastKey();
		if (HISTORY_METRICS) markHistory('history.latest-key');
		if (latestKey) {
			const createdAt = (latestKey as unknown[])[1] as number;
			if (now - createdAt < VERSION_LIMITS.minIntervalMs) return false;
			const last = await versionRange(draft.id).last();
			if (HISTORY_METRICS) markHistory('history.latest-body');
			if (last?.content === draft.content) return false;
		}
		await db.versions.put(versionRow(draft, now));
		await pruneVersions(draft.id, now);
		return true;
	});
}

/**
 * Records the exact state before a destructive content operation. Unlike the
 * periodic snapshot, this checkpoint is never throttled and accepts empty
 * content. The caller must await it before mutating the draft.
 */
export async function createCheckpoint(draft: SnapshotInput, now = Date.now()): Promise<boolean> {
	return db.transaction('rw', db.versions, () => putCheckpoint(draft, now));
}

/**
 * Atomically records checkpoints for a group operation. A storage failure
 * aborts the whole transaction, so callers can leave every draft unchanged.
 */
export async function createCheckpoints(
	drafts: readonly SnapshotInput[],
	now = Date.now()
): Promise<number> {
	return db.transaction('rw', db.versions, async () => {
		let written = 0;
		for (const draft of drafts) {
			if (await putCheckpoint(draft, now)) written += 1;
		}
		return written;
	});
}

/**
 * Purges a file's history: deletes versions that are too old (`maxAgeMs`) then,
 * among those remaining, keeps only the `maxPerDraft` most recent ones. Returns
 * the number of versions deleted.
 *
 * A key-cursor pass avoids reading surviving bodies. When a row is absent from
 * the compound index (malformed legacy data), the current full-row sort is kept.
 */
export async function pruneVersions(draftId: string, now = Date.now()): Promise<number> {
	const total = await db.versions.where('draftId').equals(draftId).count();
	let entries: VersionIndexEntry[] = [];
	await versionRange(draftId).eachKey((key, cursor) => {
		entries.push({ id: cursor.primaryKey as string, createdAt: (key as unknown[])[1] });
	});
	if (entries.length !== total) entries = (await listVersions(draftId)).reverse();
	const toDelete: string[] = [];
	const survivors: VersionIndexEntry[] = [];
	for (const entry of entries) {
		if (now - (entry.createdAt as number) > VERSION_LIMITS.maxAgeMs) toDelete.push(entry.id);
		else survivors.push(entry);
	}
	const excess = survivors.length - VERSION_LIMITS.maxPerDraft;
	for (let index = 0; index < excess; index++) toDelete.push(survivors[index]!.id);
	if (toDelete.length) await db.versions.bulkDelete(toDelete);
	return toDelete.length;
}

export interface VersionSummary {
	id: string;
	createdAt: number;
}

/**
 * Lists version identities and timestamps without materializing every stored
 * body. The panel then loads only the selected version.
 */
export async function listVersionSummaries(draftId: string): Promise<VersionSummary[]> {
	const idb = db.backendDB();
	return new Promise<VersionSummary[]>((resolve, reject) => {
		let transaction: IDBTransaction;
		try {
			transaction = idb.transaction('versions', 'readonly');
		} catch (error) {
			reject(error);
			return;
		}
		const summaries: VersionSummary[] = [];
		const range = IDBKeyRange.bound(
			[draftId, Number.NEGATIVE_INFINITY],
			[draftId, Number.POSITIVE_INFINITY]
		);
		const request = transaction
			.objectStore('versions')
			.index('[draftId+createdAt]')
			.openKeyCursor(range);
		request.onerror = () => reject(request.error);
		request.onsuccess = () => {
			const cursor = request.result;
			if (!cursor) return;
			const key = cursor.key;
			if (Array.isArray(key) && typeof key[1] === 'number')
				summaries.push({ id: cursor.primaryKey as string, createdAt: key[1] });
			cursor.continue();
		};
		transaction.oncomplete = () => resolve(summaries.reverse());
		transaction.onerror = () => reject(transaction.error);
		transaction.onabort = () => reject(transaction.error);
	});
}

/**
 * Test-only gate for one version body read. The E2E build exposes it so a
 * browser case can remove the row between the summary list and the body read.
 * A production build exposes no hook.
 */
interface VersionReadGate {
	id: string;
	opened: Promise<void>;
	release: () => void;
}

let versionReadGate: VersionReadGate | null = null;
let heldVersionReadGate: VersionReadGate | null = null;

if (import.meta.env.VITE_SOURCE_FIDELITY_METRICS === '1' && typeof window !== 'undefined') {
	(
		window as unknown as {
			__MDSH_VERSION_READS__?: {
				hold: (id: string) => void;
				release: () => void;
			};
		}
	).__MDSH_VERSION_READS__ = {
		hold(id: string): void {
			let release = (): void => {};
			const opened = new Promise<void>((resolve) => {
				release = resolve;
			});
			versionReadGate = { id, opened, release };
		},
		release(): void {
			const gate = versionReadGate ?? heldVersionReadGate;
			versionReadGate = null;
			heldVersionReadGate = null;
			gate?.release();
		}
	};
}

async function awaitVersionReadGate(id: string): Promise<void> {
	const gate = versionReadGate;
	if (!gate || gate.id !== id) return;
	// One shot: a later read of the same id must not wait again. Keep the
	// gate reachable for release while the read is open.
	versionReadGate = null;
	heldVersionReadGate = gate;
	await gate.opened;
	if (heldVersionReadGate === gate) heldVersionReadGate = null;
}

/** Loads one version body for preview or restore. */
export async function getVersion(id: string): Promise<VersionRow | undefined> {
	await awaitVersionReadGate(id);
	return db.versions.get(id);
}

/** Lists a file's versions, most recent first. */
export async function listVersions(draftId: string): Promise<VersionRow[]> {
	const all = await db.versions.where('draftId').equals(draftId).sortBy('createdAt');
	return all.reverse();
}

/** Deletes a file's entire history (called on the permanent deletion of the draft). */
export async function deleteVersionsFor(draftId: string): Promise<void> {
	await db.versions.where('draftId').equals(draftId).delete();
}

/**
 * Counts added and removed lines with a line multiset. This uses O(n) memory.
 * It supplies the history's "+X / -Y" indicator without a heavy diff library.
 * This is not an LCS diff.
 */
export function lineDiffStats(from: string, to: string): { added: number; removed: number } {
	const count = (s: string): Map<string, number> => {
		const m = new Map<string, number>();
		for (const line of s.split('\n')) m.set(line, (m.get(line) ?? 0) + 1);
		return m;
	};
	const a = count(from);
	const b = count(to);
	let added = 0;
	let removed = 0;
	for (const [line, n] of b) {
		const d = n - (a.get(line) ?? 0);
		if (d > 0) added += d;
	}
	for (const [line, n] of a) {
		const d = n - (b.get(line) ?? 0);
		if (d > 0) removed += d;
	}
	return { added, removed };
}

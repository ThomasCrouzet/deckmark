// §P2.8 - Pure trash logic (trash / undo-close).
//
// This module extracts the Dexie operations and the purge timer management from
// FilesStore. No Svelte runes - directly testable via Vitest.
//
// The Svelte state mutations (`files`, `trash`, `activeId`) stay in FilesStore,
// which passes callbacks. This respects the Svelte 5 constraint: `$state` cannot
// live outside the store's init scope.

import { db, newId } from './db';
import type { DraftRow, TrashedRow } from './db';
import type { TrashedFile } from './types';
import { TIMERS } from './config';
import { deleteHandle } from './fsa';
import { isDesktop } from './desktop';
import { reportPersistenceError } from './storage';
import { uniqueName } from './file-utils';
import { pathKey } from './project-paths';
import { projectConflictVariant } from './project-conflicts';
import { sameDraftIdentity } from './draft-identity';

async function deletePurgedDiskLink(id: string): Promise<void> {
	if (isDesktop()) {
		const { deleteUnownedDiskLink } = await import('./disk-cleanup');
		await deleteUnownedDiskLink(id);
	} else {
		await deleteHandle(id);
	}
}

/**
 * Complete and symmetric purge of a file leaving the trash: removes the
 * `trashed` row, the FSA handle and the entire version history (key `draftId`
 * === id). Used by both purge paths (the store's timer + purge of expired
 * entries on a late reload) so no snapshot orphans the storage.
 */
async function fullPurge(id: string): Promise<void> {
	const hasDraft = await db.transaction(
		'rw',
		db.drafts,
		db.trashed,
		db.versions,
		db.comments,
		async () => {
			const current = await db.drafts.get(id);
			await db.trashed.delete(id);
			if (!current) {
				await db.versions.where('draftId').equals(id).delete();
				await db.comments.where('draftId').equals(id).delete();
			}
			return Boolean(current);
		}
	);
	if (!hasDraft)
		await deletePurgedDiskLink(id).catch((error) => reportPersistenceError(error, 'delete'));
}

async function preserveCurrentVariant(
	id: string,
	replacement: DraftRow
): Promise<DraftRow | undefined> {
	const current = await db.drafts.get(id);
	if (!current || sameDraftIdentity(current, replacement)) return;
	const [documents, assets] = await Promise.all([db.drafts.toArray(), db.projectAssets.toArray()]);
	const variant = projectConflictVariant(current, documents, assets);
	const preserved = {
		...variant,
		id: newId(),
		name:
			variant.relativePath === current.relativePath
				? uniqueName(
						documents.map((document) => document.name),
						current.name
					)
				: variant.name,
		order: documents.reduce((max, document) => Math.max(max, document.order), -1) + 1,
		open: false
	};
	await db.drafts.put(preserved);
	await copyVersionHistory(id, preserved.id);
	await copyComments(id, preserved.id);
	return preserved;
}

async function copyVersionHistory(sourceId: string, targetId: string): Promise<void> {
	const versions = await db.versions.where('draftId').equals(sourceId).toArray();
	await db.versions.bulkPut(
		versions.map((version) => ({ ...version, id: newId(), draftId: targetId }))
	);
}

/**
 * A preserved branch keeps its editorial comments. Both branches receive a
 * copy, so a later purge of one branch cannot remove the other branch's review.
 */
async function copyComments(sourceId: string, targetId: string): Promise<void> {
	const comments = await db.comments.where('draftId').equals(sourceId).toArray();
	if (!comments.length) return;
	await db.comments.bulkPut(
		comments.map((comment) => ({ ...comment, id: newId(), draftId: targetId }))
	);
}

/** Preserves a trash entry before reusing its id. Must run inside the caller transaction. */
export async function preserveTrashEntry(id: string): Promise<TrashedRow | undefined> {
	const previous = await db.trashed.get(id);
	if (!previous) return;
	const preservedId = newId();
	const preserved = { ...previous, id: preservedId, file: { ...previous.file, id: preservedId } };
	await db.trashed.put(preserved);
	await copyVersionHistory(id, preservedId);
	await copyComments(id, preservedId);
	return preserved;
}

// ─── Types ───────────────────────────────────────────────────────────────────

/** Result of loading a trash entry from Dexie. */
export interface TrashLoadResult {
	entry: TrashedFile;
	/** Time remaining before automatic purge (ms). */
	remainingMs: number;
}

// ─── Low-level functions (pure / testable) ─────────────────────────────

/**
 * Reads the `trashed` table from Dexie and computes, for each entry, the time
 * remaining before automatic purge.
 *
 * Returns only the entries still within the undo window. The expired entries
 * are deleted from Dexie in place (DB side-effect, no Svelte state).
 */
export async function loadTrashRows(now = Date.now()): Promise<TrashLoadResult[]> {
	const { readTrashSummaries } = await import('./trash-summary-read');
	let summaries: Awaited<ReturnType<typeof readTrashSummaries>> = await readTrashSummaries();
	// Small trash stays fully resident: the metadata round-trip is only worth
	// its restore indirection when bodies would be materialized in bulk.
	const summaryBytes = summaries?.reduce((total, item) => total + item.contentLength, 0) ?? 0;
	if (summaries && summaryBytes <= 512 * 1024 && summaries.length <= 64) summaries = null;
	const results: TrashLoadResult[] = [];
	const expired = new Map<string, TrashLoadResult>();
	if (summaries) {
		for (const summary of summaries) {
			const entry: TrashedFile = {
				file: {
					id: summary.id,
					name: summary.name,
					content: '',
					...(summary.projectId
						? { projectId: summary.projectId, relativePath: summary.relativePath }
						: {}),
					...(summary.kind ? { kind: summary.kind } : {}),
					...(summary.mime ? { mime: summary.mime } : {}),
					createdAt: summary.createdAt,
					updatedAt: summary.updatedAt,
					dirty: false,
					linkedToDisk: false,
					contentDeferred: true
				},
				order: summary.order,
				trashedAt: summary.trashedAt
			};
			const remainingMs = TIMERS.trashRetentionMs - (now - summary.trashedAt);
			if (remainingMs <= 0) expired.set(summary.id, { entry, remainingMs });
			else results.push({ entry, remainingMs });
		}
	} else {
		const trashedRows = await db.trashed.orderBy('trashedAt').toArray();
		for (const tr of trashedRows) {
			const entry = trashEntryFromRow(tr);
			const remainingMs = TIMERS.trashRetentionMs - (now - tr.trashedAt);
			if (remainingMs <= 0) expired.set(tr.id, { entry, remainingMs });
			else results.push({ entry, remainingMs });
		}
	}
	// Purge outside the startup scan in small batches so hundreds of expired
	// entries do not serialize disk-link cleanup on the first paint.
	const expiredIds = [...expired.keys()];
	for (let offset = 0; offset < expiredIds.length; offset += 20) {
		await Promise.all(
			expiredIds.slice(offset, offset + 20).map(async (id) => {
				try {
					await fullPurge(id);
				} catch (error) {
					reportPersistenceError(error, 'trash');
					const entry = expired.get(id);
					if (entry) results.push(entry);
				}
			})
		);
	}
	return results;
}

function trashEntryFromRow(tr: TrashedRow): TrashedFile {
	return {
		file: {
			id: tr.file.id,
			name: tr.file.name,
			content: tr.file.content,
			...(tr.file.projectId
				? { projectId: tr.file.projectId, relativePath: tr.file.relativePath }
				: {}),
			...(tr.file.kind ? { kind: tr.file.kind } : {}),
			...(tr.file.mime ? { mime: tr.file.mime } : {}),
			...(tr.file.data ? { data: tr.file.data } : {}),
			createdAt: tr.file.createdAt,
			updatedAt: tr.file.updatedAt,
			dirty: false,
			linkedToDisk: false
		},
		order: tr.order,
		trashedAt: tr.trashedAt
	};
}

/**
 * Moves a file from `drafts` to `trashed` in a single Dexie transaction. No
 * effect on the Svelte state - the store updates `this.trash` separately.
 * Returns `true` if the transaction succeeded, `false` otherwise (the store then
 * cancels its optimistic mutation so the UI does not lie about a failed write).
 */
export async function moveToTrash(
	id: string,
	draftRow: DraftRow,
	order: number,
	trashedAt: number,
	onPreserved?: (row: TrashedRow) => void,
	onVariantPreserved?: (row: DraftRow) => void
): Promise<boolean> {
	const row: TrashedRow = { id, file: draftRow, order, trashedAt };
	let preserved: TrashedRow | undefined;
	let variant: DraftRow | undefined;
	try {
		await db.transaction(
			'rw',
			[db.drafts, db.trashed, db.versions, db.projectAssets, db.comments],
			async () => {
				variant = await preserveCurrentVariant(id, draftRow);
				preserved = await preserveTrashEntry(id);
				await db.drafts.delete(id);
				await db.trashed.put(row);
			}
		);
		if (preserved) onPreserved?.(preserved);
		if (variant) onVariantPreserved?.(variant);
		return true;
	} catch (err) {
		reportPersistenceError(err, 'trash');
		return false;
	}
}

/** Moves the complete batch or leaves every document in place. */
export async function moveManyToTrash(rows: readonly TrashedRow[]): Promise<{
	preserved: TrashedRow[];
	variants: DraftRow[];
}> {
	const unique = [...new Map(rows.map((row) => [row.id, row])).values()];
	const preserved: TrashedRow[] = [];
	const variants: DraftRow[] = [];
	if (unique.length === 0) return { preserved, variants };
	await db.transaction(
		'rw',
		[db.drafts, db.trashed, db.versions, db.projectAssets, db.comments],
		async () => {
			for (const row of unique) {
				const variant = await preserveCurrentVariant(row.id, row.file);
				if (variant) variants.push(variant);
				const previous = await preserveTrashEntry(row.id);
				if (previous) preserved.push(previous);
			}
			await db.trashed.bulkPut(unique);
			await db.drafts.bulkDelete(unique.map((row) => row.id));
		}
	);
	return { preserved, variants };
}

/** Deletes only the requested trash entries. A live draft keeps its history and disk link. */
export async function purgeManyPermanently(ids: readonly string[]): Promise<void> {
	const unique = [...new Set(ids)];
	if (unique.length === 0) return;
	const unlinkedIds = await db.transaction(
		'rw',
		db.drafts,
		db.trashed,
		db.versions,
		db.comments,
		async () => {
			const entries = (await db.trashed.bulkGet(unique)).filter(
				(row): row is TrashedRow => row !== undefined
			);
			const drafts = await db.drafts.bulkGet(entries.map((row) => row.id));
			const removedIds = entries.filter((_row, index) => !drafts[index]).map((row) => row.id);
			await db.trashed.bulkDelete(entries.map((row) => row.id));
			if (removedIds.length) {
				await db.versions.where('draftId').anyOf(removedIds).delete();
				const commentIds = await db.comments.where('draftId').anyOf(removedIds).primaryKeys();
				if (commentIds.length) await db.comments.bulkDelete(commentIds);
			}
			return removedIds;
		}
	);
	// Disk links use a separate database. Report cleanup failures after the main commit.
	await Promise.all(
		unlinkedIds.map((id) =>
			deletePurgedDiskLink(id).catch((error) => reportPersistenceError(error, 'delete'))
		)
	);
}

/**
 * Restores a file from the trash atomically: rewrites the `drafts` row AND
 * deletes the `trashed` entry in a single transaction. Without this atomicity, a
 * crash / an eviction between the two left the file in NO table (data loss in
 * the debounce window). Returns `true` if the transaction succeeded.
 */
export async function restoreFromTrash(
	id: string,
	draftRow: DraftRow,
	onPreserved?: (row: DraftRow) => void,
	onRestored?: (row: DraftRow) => void
): Promise<boolean> {
	let preserved: DraftRow | undefined;
	let restored = draftRow;
	try {
		await db.transaction(
			'rw',
			[db.drafts, db.trashed, db.versions, db.projectAssets, db.comments],
			async () => {
				preserved = await preserveCurrentVariant(draftRow.id, draftRow);
				if (draftRow.projectId && draftRow.relativePath) {
					const [projectDocuments, projectAssets] = await Promise.all([
						db.drafts.where('projectId').equals(draftRow.projectId).toArray(),
						db.projectAssets.where('projectId').equals(draftRow.projectId).toArray()
					]);
					const restoredPathKey = pathKey(draftRow.relativePath);
					const occupied =
						projectDocuments.some(
							(document) =>
								document.id !== draftRow.id &&
								document.relativePath &&
								pathKey(document.relativePath) === restoredPathKey
						) || projectAssets.some((asset) => pathKey(asset.path) === restoredPathKey);
					if (occupied) {
						restored = projectConflictVariant(draftRow, projectDocuments, projectAssets);
					}
				}
				if (restored.id !== id) {
					await copyVersionHistory(id, restored.id);
					await copyComments(id, restored.id);
				}
				await db.drafts.put(restored);
				await db.trashed.delete(id);
			}
		);
		if (preserved) onPreserved?.(preserved);
		onRestored?.(restored);
		return true;
	} catch (err) {
		reportPersistenceError(err, 'save');
		return false;
	}
}

/**
 * Permanent purge of a trash entry (undo timer expired): removes from Dexie,
 * deletes the possible FSA handle and the version history. The store has already
 * removed the entry from `this.trash`.
 */
export async function purgePermanently(id: string): Promise<void> {
	await fullPurge(id);
}

/**
 * Persists the new order of all files after a drag-reorder. Single Dexie
 * transaction - `update` only touches the `order` field (no rewrite of the full
 * content).
 *
 * @param orderedIds - ids in the new order (index = Dexie order).
 * @returns `Date.now()` at commit, or `null` if the transaction failed (so the
 *   store does NOT show "saved" on a non-persisted order).
 */
export async function persistReorder(orderedIds: string[]): Promise<number | null> {
	try {
		await db.transaction('rw', db.drafts, async () => {
			await Promise.all(orderedIds.map((id, idx) => db.drafts.update(id, { order: idx })));
		});
		return Date.now();
	} catch (err) {
		reportPersistenceError(err, 'reorder');
		return null;
	}
}

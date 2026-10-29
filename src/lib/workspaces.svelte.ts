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

	async load(): Promise<void> {
		if (!browser || this.loaded) return;
		const rows = await db.workspaces.orderBy('updatedAt').reverse().toArray();
		this.workspaces = rows;
		this.loaded = true;
	}

	/** §1.1 - Reloads from Dexie after a backup restore. */
	async reload(): Promise<void> {
		this.loaded = false;
		await this.load();
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
	 * Update the row before the write for immediate feedback. If the write fails,
	 * restore all fields and the previous position, then notify the user.
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
		// Capture the prior state for a faithful rollback on failure.
		const prevIdx = this.workspaces.indexOf(ws);
		const prevFileIds = ws.fileIds;
		const prevActiveId = ws.activeId;
		const prevUpdatedAt = ws.updatedAt;

		ws.fileIds = filesStore.files.map((f) => f.id);
		ws.activeId = filesStore.activeId;
		ws.updatedAt = Date.now();
		// Reorder to the head (the most recently modified moves up).
		const idx = this.workspaces.indexOf(ws);
		if (idx > 0) {
			this.workspaces.splice(idx, 1);
			this.workspaces.unshift(ws);
		}
		try {
			await db.workspaces.put($state.snapshot(ws));
		} catch (err) {
			// Rollback: restore the original fields + position.
			ws.fileIds = prevFileIds;
			ws.activeId = prevActiveId;
			ws.updatedAt = prevUpdatedAt;
			const cur = this.workspaces.indexOf(ws);
			if (cur !== prevIdx && cur !== -1) {
				this.workspaces.splice(cur, 1);
				this.workspaces.splice(prevIdx, 0, ws);
			}
			reportPersistenceError(err, 'save');
		}
	}

	/**
	 * Optimistic + rollback: restores the previous name (and `updatedAt`) if the
	 * write fails, and notifies - no phantom rename on the UI side.
	 */
	async rename(id: string, name: string): Promise<void> {
		const ws = this.workspaces.find((w) => w.id === id);
		if (!ws) return;
		const trimmed = name.trim();
		if (!trimmed) return; // No-op if empty - keep the old name.
		const prevName = ws.name;
		const prevUpdatedAt = ws.updatedAt;
		ws.name = trimmed;
		ws.updatedAt = Date.now();
		try {
			await db.workspaces.put($state.snapshot(ws));
		} catch (err) {
			ws.name = prevName;
			ws.updatedAt = prevUpdatedAt;
			reportPersistenceError(err, 'save');
		}
	}

	/**
	 * Write-then-mutate: we delete from IDB BEFORE removing from the list. If the
	 * `delete` fails, the workspace stays displayed (it is still in the database)
	 * and the error is notified - no phantom disappearance reappearing on reload.
	 */
	async delete(id: string): Promise<void> {
		const idx = this.workspaces.findIndex((w) => w.id === id);
		if (idx === -1) return;
		try {
			await db.workspaces.delete(id);
		} catch (err) {
			reportPersistenceError(err, 'delete');
			return;
		}
		// Re-look-up the index (the list may have changed during the await).
		const cur = this.workspaces.findIndex((w) => w.id === id);
		if (cur !== -1) this.workspaces.splice(cur, 1);
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
	async restore(id: string): Promise<void> {
		const ws = this.workspaces.find((w) => w.id === id);
		if (!ws) return;

		// Durability barrier: keepDB flushes are otherwise fire-and-forget, so a
		// rapid switch away and back could re-open pre-edit IDB content.
		try {
			await filesStore.flushPendingAwait();
		} catch (err) {
			reportPersistenceError(err, 'save');
			// Fail closed: keep every current tab and its in-memory content intact.
			return;
		}

		// 1. Open the missing files from Dexie (preserve the ids).
		const openIds = new Set(filesStore.files.map((f) => f.id));
		const toReopen = ws.fileIds.filter((wsId) => !openIds.has(wsId));
		if (toReopen.length > 0) {
			let rows: Awaited<ReturnType<typeof db.drafts.bulkGet>>;
			try {
				rows = await db.drafts.bulkGet(toReopen);
			} catch (err) {
				// IDB read failure: without this catch, restore() rejected silently
				// (the WorkspacesPanel caller has no .catch) - the user did not
				// understand why nothing was happening.
				reportPersistenceError(err, 'load');
				return;
			}
			// bulkGet order matches toReopen; openMany appends - we reorder below.
			const validRows = rows.filter((r): r is NonNullable<typeof r> => Boolean(r));
			if (validRows.length > 0) filesStore.openMany(validRows);
		}

		// 2. Close the tabs outside the workspace WITHOUT touching the DB.
		const wsIds = new Set(ws.fileIds);
		const toClose = filesStore.files.map((f) => f.id).filter((fid) => !wsIds.has(fid));
		filesStore.closeMany(toClose, { trash: false, keepDB: true });

		// 2b. Sidebar order must match workspace fileIds (schema contract).
		filesStore.reorderToIds(ws.fileIds);

		// 3. Activate the target if it exists (otherwise fallback already handled by close).
		if (ws.activeId && filesStore.files.some((f) => f.id === ws.activeId)) {
			filesStore.setActive(ws.activeId);
		}
	}
}

export const workspaceStore = new WorkspaceStore();

import Dexie, { type Table } from 'dexie';
import type { DocumentKind } from './document-kind';

export interface DraftRow {
	id: string;
	name: string;
	content: string;
	projectId?: string;
	relativePath?: string;
	createdAt: number;
	updatedAt: number;
	order: number;
	/** Whether the document is currently shown as an open tab. Missing means open for v4 data. */
	open?: boolean;
}

/**
 * Persists trash during the undo period. This prevents a close or crash from
 * leaving a draft row without a UI entry.
 */
export interface TrashedRow {
	id: string;
	file: DraftRow;
	order: number;
	trashedAt: number;
}

/**
 * §6.8 - Workspaces / named sessions: saves a set of open files (and the active
 * tab) under a user-given name. Lets you juggle between distinct projects
 * ("Meeting notes", "Blog article", "Novel draft") without losing the context
 * of open tabs.
 *
 * `fileIds` is the order of the files as they appear in the sidebar at save
 * time. On restore, files open outside the workspace are closed (without trash
 * - straight close), and missing ones (deleted since) are silently ignored.
 */
export interface WorkspaceRow {
	id: string;
	name: string;
	fileIds: string[];
	activeId: string | null;
	createdAt: number;
	updatedAt: number;
}

/**
 * §2.4 - Local version history: timestamped snapshot of a draft's content.
 * Each version has its own ID. `draftId` finds a file's history.
 * `[draftId+createdAt]` sorts versions and supports purging old entries.
 */
export interface VersionRow {
	id: string;
	draftId: string;
	/** File name at snapshot time (the file may have been renamed since). */
	name: string;
	content: string;
	createdAt: number;
}

/**
 * §2.7 - Reusable document template. `builtin` distinguishes the provided
 * templates (meeting note, journal, todo) from user-created ones. Builtin
 * templates are (re)injected at boot and are not persisted twice - stable
 * `id` `builtin:<slug>` for idempotency.
 */
export interface TemplateRow {
	id: string;
	name: string;
	content: string;
	builtin: boolean;
	/** Intended document type. Absent in older backups; treat as a note. */
	kind?: DocumentKind;
	createdAt: number;
	updatedAt: number;
}

export interface MetadataRow {
	key: string;
	value: string;
}

export interface ProjectRow {
	id: string;
	name: string;
	createdAt: number;
	updatedAt: number;
	/** A native registry identifier, never a grant supplied by imported data. */
	nativeRootId?: string;
}

export interface ProjectAssetRow {
	id: string;
	projectId: string;
	path: string;
	mime: string;
	data: Uint8Array;
}

export const DISK_LINK_EPOCH_KEY = 'disk-link-epoch';
export const LEGACY_DISK_LINK_EPOCH = 'legacy';

class MdshDB extends Dexie {
	drafts!: Table<DraftRow, string>;
	trashed!: Table<TrashedRow, string>;
	workspaces!: Table<WorkspaceRow, string>;
	versions!: Table<VersionRow, string>;
	templates!: Table<TemplateRow, string>;
	metadata!: Table<MetadataRow, string>;
	projects!: Table<ProjectRow, string>;
	projectAssets!: Table<ProjectAssetRow, string>;

	constructor() {
		super('mdsh');
		this.version(1).stores({
			drafts: 'id, updatedAt, order'
		});
		// v2: adds the `trashed` table - indexed by trashedAt to scan expired
		// entries at startup.
		this.version(2).stores({
			drafts: 'id, updatedAt, order',
			trashed: 'id, trashedAt'
		});
		// v3 (§6.8): adds the `workspaces` table - indexed by updatedAt
		// to sort sessions by recency on the UI side. No data migration needed
		// (new table).
		this.version(3).stores({
			drafts: 'id, updatedAt, order',
			trashed: 'id, trashedAt',
			workspaces: 'id, updatedAt'
		});
		// v4 (§2.4 / §2.7): `versions` (local history) and `templates`
		// (document templates) tables. New tables → no data migration.
		// `versions`: composite index `[draftId+createdAt]` to list/purge a
		// file's history by recency without a full scan.
		this.version(4).stores({
			drafts: 'id, updatedAt, order',
			trashed: 'id, trashedAt',
			workspaces: 'id, updatedAt',
			versions: 'id, draftId, createdAt, [draftId+createdAt]',
			templates: 'id, updatedAt'
		});
		// v5: stores the disk-link epoch in the main database. A replacement
		// restore rotates this value in the same transaction as the draft rows.
		// Records in the separate mdsh-fs database are usable only for this epoch.
		this.version(5).stores({
			drafts: 'id, updatedAt, order',
			trashed: 'id, trashedAt',
			workspaces: 'id, updatedAt',
			versions: 'id, draftId, createdAt, [draftId+createdAt]',
			templates: 'id, updatedAt',
			metadata: 'key'
		});
		this.version(6).stores({
			drafts: 'id, updatedAt, order, projectId, &[projectId+relativePath]',
			projects: 'id, updatedAt',
			projectAssets: 'id, projectId, &[projectId+path]'
		});
	}
}

export const db = new MdshDB();

export function newId(): string {
	// `crypto.randomUUID()` is available in all target browsers (Chrome 92+,
	// Firefox 95+, Safari 15.4+) and guarantees uniqueness - unlike a
	// `Date.now()+Math.random()` which can collide under heavy concurrent
	// creation (multi-file from launchQueue, share_target, multi-file drop).
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	// Fallback for an old test environment / SSR - unlikely but keeps the contract.
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Returns the current epoch for records in the separate disk-link database. */
export async function getDiskLinkEpoch(): Promise<string> {
	return db.transaction('rw', db.metadata, async () => {
		const current = await db.metadata.get(DISK_LINK_EPOCH_KEY);
		if (current) return current.value;
		await db.metadata.put({ key: DISK_LINK_EPOCH_KEY, value: LEGACY_DISK_LINK_EPOCH });
		return LEGACY_DISK_LINK_EPOCH;
	});
}

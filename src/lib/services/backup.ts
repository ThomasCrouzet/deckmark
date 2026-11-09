import { preserveTrashEntry } from '../trash';
import { BACKUP_LIMITS, IMPORT_LIMITS, MAX_IMAGE_BYTES } from '../config';
import { readUtf8File, ImportReadError, validateMarkdownContent } from '../import-limits';
// §1.1 - Versioned backup / restore of portable application state.
//
// All of mdsh lives in IndexedDB (no backend). A "Clear site data", a quota
// eviction, a browser switch or a PWA reinstall = total and silent loss. The
// ZIP export only backs up the `.md` files; this module backs up the STATE:
// drafts (with tab order), workspaces and templates, in a single portable +
// versioned JSON file.
//
// Backup scope:
//   - INCLUDED : open and closed `drafts`, `workspaces`, `templates`.
//   - EXCLUDED : the retained trash and local version history. Concurrent
//                branches are preserved as closed drafts and are included.
//
// Design: pure functions + direct Dexie access (testable via
// fake-indexeddb), no dependency on the runes stores. The DOM helpers
// (download / file read) are guarded with `typeof document/window`.

import {
	db,
	newId,
	DISK_LINK_EPOCH_KEY,
	type DraftRow,
	type ProjectAssetRow,
	type ProjectRow,
	type SnippetRow,
	type WorkspaceRow,
	type TemplateRow,
	type CommentRow
} from '../db';
import { encryptString, decryptString, isEncryptedEnvelope } from '../crypto';
import { t } from '#lib/i18n/index.js';
import { rewriteWikiLinkTargets } from '../wiki-links';
import { documentKind } from '../document-kind';
import { imageMime, pathKey, projectPath } from '../project-paths';
import { MAX_SNIPPETS, normalizeSnippetRow, validSnippetRow } from '../snippets';

export const BACKUP_FORMAT = 'mdsh-backup';
export const BACKUP_SCHEMA_VERSION = 2;

const PROJECT_BACKUP_LIMITS = {
	maxProjects: IMPORT_LIMITS.maxFiles,
	maxAssets: 1300,
	maxAssetBytesTotal: IMPORT_LIMITS.maxBatchBytes
} as const;
const PROJECT_NATIVE_BASELINE_PREFIX = 'project-native-revisions:';

async function ensureLiveDraftsDurable(): Promise<void> {
	const { filesStore } = await import('../files.svelte');
	await filesStore.flushPendingAwait();
}

export interface BackupFile {
	format: typeof BACKUP_FORMAT;
	schemaVersion: number;
	exportedAt: number;
	drafts: DraftRow[];
	workspaces: WorkspaceRow[];
	templates: TemplateRow[];
	/**
	 * Reusable snippets. Older files omit this optional collection. New files
	 * keep the schema 2 envelope so an older build can still restore the other
	 * collections.
	 */
	snippets?: SnippetRow[];
	/** Schema 2 portable projects. Schema 1 fixtures omit this collection. */
	projects?: BackupProject[];
	/** Schema 2 assets use bounded base64 instead of IndexedDB binary values. */
	projectAssets?: BackupProjectAsset[];
	/** Editorial comments. Older backups omit this collection. */
	comments?: CommentRow[];
}

export type BackupProject = Omit<ProjectRow, 'nativeRootId'>;

export interface BackupProjectAsset {
	id: string;
	projectId: string;
	path: string;
	mime: string;
	data: string;
}

function rewriteDraftLinks(content: string, idMap: Map<string, string>): string {
	if (documentKind(content) === 'presentation') return content;
	return rewriteWikiLinkTargets(content, (target) => {
		const id = target.split('#', 1)[0]!;
		const mapped = idMap.get(id);
		return mapped === undefined ? target : mapped + target.slice(id.length);
	});
}

/** Preserves imported ID links, including cycles and repeated merges. */
export function planDraftMerge(
	incoming: DraftRow[],
	existing: DraftRow[],
	projectIdMap = new Map<string, string>()
) {
	const candidates = new Map<string, DraftRow>();
	const importedIdMap = new Map<string, string>();
	const dependants = new Map<string, Set<string>>();
	const byId = new Map(incoming.map((draft) => [draft.id, draft]));
	const existingByIdentity = new Map<string, DraftRow[]>();
	const identity = (
		name: string,
		createdAt: number,
		updatedAt: number,
		projectId: string | undefined,
		relativePath: string | undefined
	) => JSON.stringify([name, createdAt, updatedAt, projectId ?? '', relativePath ?? '']);
	for (const row of existing) {
		const key = identity(row.name, row.createdAt, row.updatedAt, row.projectId, row.relativePath);
		const bucket = existingByIdentity.get(key);
		if (bucket) bucket.push(row);
		else existingByIdentity.set(key, [row]);
	}
	for (const draft of incoming) {
		const mappedProjectId = draft.projectId
			? (projectIdMap.get(draft.projectId) ?? draft.projectId)
			: undefined;
		const matches =
			existingByIdentity.get(
				identity(draft.name, draft.createdAt, draft.updatedAt, mappedProjectId, draft.relativePath)
			) ?? [];
		const candidate = matches.find((row) => row.content === draft.content) ?? matches[0];
		if (candidate) candidates.set(draft.id, candidate);
		importedIdMap.set(draft.id, candidate?.id ?? newId());
		if (documentKind(draft.content) === 'presentation') continue;
		rewriteWikiLinkTargets(draft.content, (target) => {
			const id = target.split('#', 1)[0]!;
			if (byId.has(id)) {
				const ids = dependants.get(id) ?? new Set<string>();
				ids.add(draft.id);
				dependants.set(id, ids);
			}
			return target;
		});
	}
	const rewrite = (content: string) => rewriteDraftLinks(content, importedIdMap);
	const queue = [...candidates.keys()];
	for (let index = 0; index < queue.length; index++) {
		const id = queue[index]!;
		const candidate = candidates.get(id);
		if (!candidate || candidate.content === rewrite(byId.get(id)!.content)) continue;
		candidates.delete(id);
		importedIdMap.set(id, newId());
		queue.push(...(dependants.get(id) ?? []));
	}
	let order = existing.reduce((max, draft) => Math.max(max, draft.order), -1);
	const draftsToPut = incoming.map((draft): DraftRow | null =>
		candidates.has(draft.id)
			? null
			: {
					...draft,
					id: importedIdMap.get(draft.id)!,
					content: rewrite(draft.content),
					...(draft.projectId
						? { projectId: projectIdMap.get(draft.projectId) ?? draft.projectId }
						: {}),
					order: ++order
				}
	);
	return { importedIdMap, draftsToPut };
}

export type RestoreMode = 'merge' | 'replace';

/** Backups already validated by `parseBackupWithReport`, including large restores. */
const validatedBackups = new WeakSet<object>();

export interface RestoreCounts {
	drafts: number;
	workspaces: number;
	templates: number;
	snippets: number;
	projects: number;
	projectAssets: number;
	comments?: number;
	unchanged: {
		drafts: number;
		workspaces: number;
		templates: number;
		snippets?: number;
		projects?: number;
		projectAssets?: number;
	};
	/**
	 * Total number of entries present in the file but REJECTED as corrupted
	 * (invalid drafts/workspaces/templates filtered out by `parseBackup`). > 0 ⇒ the
	 * restore is partial: should be reported to the user (cf. SettingsPanel).
	 */
	skipped: number;
}

/** Number of entries rejected per collection during the parse (corrupted rows filtered out). */
export interface BackupSkipped {
	drafts: number;
	workspaces: number;
	templates: number;
	snippets: number;
	projects: number;
	projectAssets: number;
	comments?: number;
}

/** Result of `parseBackup`: the valid backup + the count of rejected rows. */
export interface ParsedBackup {
	backup: BackupFile;
	skipped: BackupSkipped;
}

/** Parsing/validation error of a backup file (actionable FR message). */
export class BackupParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'BackupParseError';
	}
}

// ─── Collection ──────────────────────────────────────────────────────────────

/** Reads the persisted state and builds the backup object (draft order preserved). */
export async function collectBackup(now = Date.now()): Promise<BackupFile> {
	const [draftRows, workspaces, templates, snippetRows, projectRows, assetRows, comments] =
		await Promise.all([
			db.drafts.orderBy('order').toArray(),
			db.workspaces.orderBy('updatedAt').toArray(),
			db.templates.orderBy('updatedAt').toArray(),
			db.snippets.orderBy('updatedAt').toArray(),
			db.projects.orderBy('updatedAt').toArray(),
			db.projectAssets.toArray(),
			db.comments.orderBy('createdAt').toArray()
		]);
	const drafts = draftRows.map(normalizeDraft);
	const snippets = snippetRows.map(normalizeSnippetRow);
	const projects = projectRows.map(normalizeProject);
	const projectAssets = assetRows.map((asset) => ({
		id: asset.id,
		projectId: asset.projectId,
		path: asset.path,
		mime: asset.mime,
		data: bytesToBase64(asset.data)
	}));
	return {
		format: BACKUP_FORMAT,
		schemaVersion: BACKUP_SCHEMA_VERSION,
		exportedAt: now,
		drafts,
		workspaces,
		templates,
		snippets,
		projects,
		projectAssets,
		comments
	};
}

/** Serializes a backup into indented JSON (readable/diffable). */
export function serializeBackup(backup: BackupFile): string {
	return JSON.stringify(backup, null, 2);
}

// ─── Validation ────────────────────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validTimestamp(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 8.64e15;
}

function normalizeDraft(draft: DraftRow): DraftRow {
	return {
		id: draft.id,
		name: draft.name,
		content: draft.content,
		...(draft.projectId === undefined ? {} : { projectId: draft.projectId }),
		...(draft.relativePath === undefined ? {} : { relativePath: draft.relativePath }),
		...(draft.origin === undefined ? {} : { origin: draft.origin }),
		...(draft.kind === undefined ? {} : { kind: draft.kind }),
		...(draft.mime === undefined ? {} : { mime: draft.mime }),
		...(draft.data === undefined ? {} : { data: draft.data }),
		createdAt: draft.createdAt,
		updatedAt: draft.updatedAt,
		order: draft.order,
		...(draft.open === undefined ? {} : { open: draft.open })
	};
}

function normalizeProject(project: ProjectRow): BackupProject {
	return {
		id: project.id,
		name: project.name,
		createdAt: project.createdAt,
		updatedAt: project.updatedAt
	};
}

function bytesToBase64(data: Uint8Array): string {
	let binary = '';
	const chunkSize = 0x8000;
	for (let offset = 0; offset < data.byteLength; offset += chunkSize) {
		binary += String.fromCharCode(...data.subarray(offset, offset + chunkSize));
	}
	return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
	if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
		throw new BackupParseError(t('backup.notMdshBackup'));
	}
	let binary: string;
	try {
		binary = atob(value);
	} catch {
		throw new BackupParseError(t('backup.notMdshBackup'));
	}
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

function validDraft(v: unknown): v is DraftRow {
	if (!isObject(v)) return false;
	return (
		typeof v.id === 'string' &&
		v.id.length > 0 &&
		typeof v.name === 'string' &&
		typeof v.content === 'string' &&
		validTimestamp(v.createdAt) &&
		validTimestamp(v.updatedAt) &&
		typeof v.order === 'number' &&
		Number.isFinite(v.order) &&
		(v.open === undefined || typeof v.open === 'boolean') &&
		(v.projectId === undefined || (typeof v.projectId === 'string' && v.projectId.length > 0)) &&
		(v.relativePath === undefined ||
			(typeof v.relativePath === 'string' && v.relativePath.length > 0)) &&
		(v.origin === undefined ||
			v.origin === 'created' ||
			v.origin === 'imported' ||
			v.origin === 'template') &&
		(v.kind === undefined ||
			v.kind === 'note' ||
			v.kind === 'presentation' ||
			v.kind === 'code' ||
			v.kind === 'image' ||
			v.kind === 'pdf') &&
		(v.mime === undefined || typeof v.mime === 'string') &&
		(v.data === undefined || typeof v.data === 'string') &&
		(v.projectId === undefined) === (v.relativePath === undefined)
	);
}

function validComment(v: unknown): v is CommentRow {
	if (!isObject(v)) return false;
	return (
		typeof v.id === 'string' &&
		v.id.length > 0 &&
		typeof v.draftId === 'string' &&
		v.draftId.length > 0 &&
		typeof v.quote === 'string' &&
		typeof v.body === 'string' &&
		typeof v.author === 'string' &&
		(v.status === 'open' || v.status === 'resolved') &&
		typeof v.from === 'number' &&
		Number.isFinite(v.from) &&
		typeof v.to === 'number' &&
		Number.isFinite(v.to) &&
		validTimestamp(v.createdAt) &&
		validTimestamp(v.updatedAt)
	);
}

function validProject(v: unknown): v is BackupProject {
	if (!isObject(v)) return false;
	return (
		typeof v.id === 'string' &&
		v.id.length > 0 &&
		typeof v.name === 'string' &&
		v.name.length > 0 &&
		validTimestamp(v.createdAt) &&
		validTimestamp(v.updatedAt)
	);
}

function validProjectAsset(v: unknown): v is BackupProjectAsset {
	if (!isObject(v)) return false;
	return (
		typeof v.id === 'string' &&
		v.id.length > 0 &&
		typeof v.projectId === 'string' &&
		v.projectId.length > 0 &&
		typeof v.path === 'string' &&
		v.path.length > 0 &&
		typeof v.mime === 'string' &&
		(v.mime.startsWith('image/') || v.mime === 'application/octet-stream') &&
		v.mime.length <= 128 &&
		typeof v.data === 'string'
	);
}

function validWorkspace(v: unknown): v is WorkspaceRow {
	if (!isObject(v)) return false;
	return (
		typeof v.id === 'string' &&
		v.id.length > 0 &&
		typeof v.name === 'string' &&
		Array.isArray(v.fileIds) &&
		v.fileIds.length <= BACKUP_LIMITS.maxWorkspaceReferences &&
		v.fileIds.every((x) => typeof x === 'string' && x.length > 0) &&
		new Set(v.fileIds).size === v.fileIds.length &&
		(v.activeId === null || (typeof v.activeId === 'string' && v.fileIds.includes(v.activeId))) &&
		validTimestamp(v.createdAt) &&
		validTimestamp(v.updatedAt)
	);
}

function validTemplate(v: unknown): v is TemplateRow {
	if (!isObject(v)) return false;
	return (
		typeof v.id === 'string' &&
		v.id.length > 0 &&
		typeof v.name === 'string' &&
		typeof v.content === 'string' &&
		typeof v.builtin === 'boolean' &&
		(v.kind === undefined || v.kind === 'note' || v.kind === 'presentation') &&
		validTimestamp(v.createdAt) &&
		validTimestamp(v.updatedAt)
	);
}

/**
 * Parses + validates a backup file and reports the rejected rows.
 * The envelope, every required collection and every row must be valid.
 * Invalid or duplicate rows reject the entire restore before any mutation.
 *
 * @throws {BackupParseError} invalid JSON, unexpected format, or future version.
 */
export function parseBackupWithReport(json: string): ParsedBackup {
	assertBackupTextSize(json);
	let raw: unknown;
	try {
		raw = JSON.parse(json);
	} catch {
		throw new BackupParseError(t('backup.invalidJson'));
	}
	return validateBackupValue(raw);
}

/** Validates a generated or imported backup value without a second JSON parse. */
export function validateBackupValue(raw: unknown): ParsedBackup {
	if (!isObject(raw) || raw.format !== BACKUP_FORMAT) {
		throw new BackupParseError(t('backup.notMdshBackup'));
	}
	const schemaVersion = raw.schemaVersion;
	// Rejects missing, non-integer (3.5), null or negative versions
	// - symptoms of a corrupted or tampered-with file.
	if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion) || schemaVersion < 1) {
		throw new BackupParseError(t('backup.invalidSchema'));
	}
	if (schemaVersion > BACKUP_SCHEMA_VERSION) {
		throw new BackupParseError(t('backup.futureVersion', { version: schemaVersion }));
	}
	if (
		!Array.isArray(raw.drafts) ||
		!Array.isArray(raw.workspaces) ||
		!Array.isArray(raw.templates) ||
		(raw.snippets !== undefined && !Array.isArray(raw.snippets)) ||
		(schemaVersion >= 2 && (!Array.isArray(raw.projects) || !Array.isArray(raw.projectAssets)))
	) {
		throw new BackupParseError(t('backup.notMdshBackup'));
	}
	if (!validTimestamp(raw.exportedAt)) {
		throw new BackupParseError(t('backup.notMdshBackup'));
	}
	if (
		raw.drafts.length + raw.templates.length > BACKUP_LIMITS.maxDocuments ||
		raw.workspaces.length > BACKUP_LIMITS.maxWorkspaces ||
		(Array.isArray(raw.snippets) && raw.snippets.length > MAX_SNIPPETS) ||
		(schemaVersion >= 2 &&
			(raw.projects as unknown[]).length > PROJECT_BACKUP_LIMITS.maxProjects) ||
		(schemaVersion >= 2 &&
			(raw.projectAssets as unknown[]).length > PROJECT_BACKUP_LIMITS.maxAssets)
	)
		throw new BackupParseError(t('backup.tooLarge'));
	const draftRows = raw.drafts.filter(validDraft);
	const workspaceRows = raw.workspaces.filter(validWorkspace);
	const templateRows = raw.templates.filter(validTemplate);
	const snippetRows = Array.isArray(raw.snippets) ? raw.snippets.filter(validSnippetRow) : [];
	const projectRows = schemaVersion >= 2 ? (raw.projects as unknown[]).filter(validProject) : [];
	const assetRows =
		schemaVersion >= 2 ? (raw.projectAssets as unknown[]).filter(validProjectAsset) : [];
	const commentRows =
		raw.comments === undefined
			? []
			: Array.isArray(raw.comments)
				? raw.comments.filter(validComment)
				: null;
	if (commentRows === null) throw new BackupParseError(t('backup.notMdshBackup'));
	const skipped = {
		drafts: raw.drafts.length - draftRows.length,
		workspaces: raw.workspaces.length - workspaceRows.length,
		templates: raw.templates.length - templateRows.length,
		snippets: Array.isArray(raw.snippets) ? raw.snippets.length - snippetRows.length : 0,
		projects: schemaVersion >= 2 ? (raw.projects as unknown[]).length - projectRows.length : 0,
		projectAssets:
			schemaVersion >= 2 ? (raw.projectAssets as unknown[]).length - assetRows.length : 0,
		comments:
			raw.comments === undefined ? 0 : (raw.comments as unknown[]).length - commentRows.length
	};
	if (
		skipped.drafts +
			skipped.workspaces +
			skipped.templates +
			skipped.snippets +
			skipped.projects +
			skipped.projectAssets +
			(skipped.comments ?? 0) >
		0
	) {
		throw new BackupParseError(t('backup.notMdshBackup'));
	}
	const drafts = draftRows.map(normalizeDraft);
	const workspaces = workspaceRows.map((workspace) => ({
		id: workspace.id,
		name: workspace.name,
		fileIds: [...workspace.fileIds],
		activeId: workspace.activeId,
		createdAt: workspace.createdAt,
		updatedAt: workspace.updatedAt
	}));
	const templates = templateRows.map((template) => ({
		id: template.id,
		name: template.name,
		content: template.content,
		builtin: template.builtin,
		...(template.kind ? { kind: template.kind } : {}),
		createdAt: template.createdAt,
		updatedAt: template.updatedAt
	}));
	const snippets = snippetRows.map(normalizeSnippetRow);
	const projects = projectRows.map((project) => normalizeProject(project));
	const projectAssets = assetRows.map((asset) => ({
		id: asset.id,
		projectId: asset.projectId,
		path: asset.path,
		mime: asset.mime,
		data: asset.data
	}));
	if (
		workspaces.reduce((total, workspace) => total + workspace.fileIds.length, 0) >
		BACKUP_LIMITS.maxTotalWorkspaceReferences
	)
		throw new BackupParseError(t('backup.tooLarge'));
	let contentBytes = 0;
	for (const row of [...drafts, ...templates]) {
		const size = new TextEncoder().encode(row.content).byteLength;
		contentBytes += size;
		if (size > IMPORT_LIMITS.maxFileBytes || contentBytes > IMPORT_LIMITS.maxBatchBytes)
			throw new BackupParseError(t('backup.tooLarge'));
		try {
			validateMarkdownContent(row.content);
		} catch {
			throw new BackupParseError(t('backup.notMdshBackup'));
		}
	}
	for (const snippet of snippets) {
		const size = new TextEncoder().encode(snippet.code).byteLength;
		contentBytes += size;
		if (size > IMPORT_LIMITS.maxFileBytes || contentBytes > IMPORT_LIMITS.maxBatchBytes)
			throw new BackupParseError(t('backup.tooLarge'));
	}
	for (const rows of [drafts, workspaces, templates, snippets, commentRows]) {
		if (new Set(rows.map((row) => row.id)).size !== rows.length) {
			throw new BackupParseError(t('backup.notMdshBackup'));
		}
	}
	if (
		new Set(projects.map((project) => project.id)).size !== projects.length ||
		new Set(projectAssets.map((asset) => asset.id)).size !== projectAssets.length
	) {
		throw new BackupParseError(t('backup.notMdshBackup'));
	}
	const projectIds = new Set(projects.map((project) => project.id));
	const projectPaths = new Set<string>();
	for (const draft of drafts) {
		if (!draft.projectId || !draft.relativePath) continue;
		if (!projectIds.has(draft.projectId)) throw new BackupParseError(t('backup.notMdshBackup'));
		let normalized: string;
		try {
			normalized = projectPath(draft.relativePath);
		} catch {
			throw new BackupParseError(t('backup.notMdshBackup'));
		}
		if (normalized !== draft.relativePath) throw new BackupParseError(t('backup.notMdshBackup'));
		const key = `${draft.projectId}\0${pathKey(normalized)}`;
		if (projectPaths.has(key)) throw new BackupParseError(t('backup.notMdshBackup'));
		projectPaths.add(key);
	}
	let assetBytes = 0;
	for (const asset of projectAssets) {
		if (!projectIds.has(asset.projectId)) throw new BackupParseError(t('backup.notMdshBackup'));
		let normalized: string;
		try {
			normalized = projectPath(asset.path);
		} catch {
			throw new BackupParseError(t('backup.notMdshBackup'));
		}
		if (normalized !== asset.path) throw new BackupParseError(t('backup.notMdshBackup'));
		const key = `${asset.projectId}\0${pathKey(normalized)}`;
		if (projectPaths.has(key)) throw new BackupParseError(t('backup.notMdshBackup'));
		projectPaths.add(key);
		const maximum =
			asset.mime.startsWith('image/') || imageMime(asset.path)
				? MAX_IMAGE_BYTES
				: IMPORT_LIMITS.maxFileBytes;
		if (asset.data.length > Math.ceil(maximum / 3) * 4)
			throw new BackupParseError(t('backup.tooLarge'));
		const size = base64ToBytes(asset.data).byteLength;
		assetBytes += size;
		if (size > maximum || assetBytes > PROJECT_BACKUP_LIMITS.maxAssetBytesTotal) {
			throw new BackupParseError(t('backup.tooLarge'));
		}
	}
	const backup: BackupFile = {
		format: BACKUP_FORMAT,
		schemaVersion,
		exportedAt: raw.exportedAt,
		drafts,
		workspaces,
		templates,
		...(raw.snippets === undefined ? {} : { snippets }),
		projects,
		projectAssets,
		comments: commentRows
	};
	validatedBackups.add(backup);
	return { backup, skipped };
}

/**
 * Parses + validates a backup file (without the rejection count - cf.
 * `parseBackupWithReport` when the number of corrupted entries matters).
 *
 * @throws {BackupParseError} invalid JSON, unexpected format, or future version.
 */
export function parseBackup(json: string): BackupFile {
	return parseBackupWithReport(json).backup;
}

// ─── Application ──────────────────────────────────────────────────────────

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function sameProjectContent(
	incomingProjectId: string,
	existingProjectId: string,
	incomingDrafts: DraftRow[],
	existingDrafts: DraftRow[],
	incomingAssets: ProjectAssetRow[],
	existingAssets: ProjectAssetRow[]
): boolean {
	const incomingDocuments = incomingDrafts
		.filter((draft) => draft.projectId === incomingProjectId)
		.sort((left, right) => (left.relativePath ?? '').localeCompare(right.relativePath ?? ''));
	const existingDocuments = existingDrafts
		.filter((draft) => draft.projectId === existingProjectId)
		.sort((left, right) => (left.relativePath ?? '').localeCompare(right.relativePath ?? ''));
	if (incomingDocuments.length !== existingDocuments.length) return false;
	const idMap = new Map<string, string>();
	for (let index = 0; index < incomingDocuments.length; index++) {
		const incoming = incomingDocuments[index]!;
		const existing = existingDocuments[index]!;
		if (incoming.relativePath !== existing.relativePath) return false;
		idMap.set(incoming.id, existing.id);
	}
	for (let index = 0; index < incomingDocuments.length; index++) {
		const incoming = incomingDocuments[index]!;
		const existing = existingDocuments[index]!;
		if (
			incoming.relativePath !== existing.relativePath ||
			incoming.name !== existing.name ||
			rewriteDraftLinks(incoming.content, idMap) !== existing.content ||
			incoming.createdAt !== existing.createdAt ||
			incoming.updatedAt !== existing.updatedAt ||
			incoming.open !== existing.open
		) {
			return false;
		}
	}
	const incomingProjectAssets = incomingAssets
		.filter((asset) => asset.projectId === incomingProjectId)
		.sort((left, right) => left.path.localeCompare(right.path));
	const existingProjectAssets = existingAssets
		.filter((asset) => asset.projectId === existingProjectId)
		.sort((left, right) => left.path.localeCompare(right.path));
	if (incomingProjectAssets.length !== existingProjectAssets.length) return false;
	return incomingProjectAssets.every((incoming, index) => {
		const existing = existingProjectAssets[index]!;
		return (
			incoming.path === existing.path &&
			incoming.mime === existing.mime &&
			equalBytes(incoming.data, existing.data)
		);
	});
}

function planProjectMerge(
	incomingProjects: BackupProject[],
	incomingDrafts: DraftRow[],
	incomingAssets: ProjectAssetRow[],
	existingProjects: ProjectRow[],
	existingDrafts: DraftRow[],
	existingAssets: ProjectAssetRow[]
) {
	const projectIdMap = new Map<string, string>();
	const reservedProjectIds = new Set(existingProjects.map((project) => project.id));
	const reservedAssetIds = new Set(existingAssets.map((asset) => asset.id));
	const projectsToPut: ProjectRow[] = [];
	const assetsToPut: ProjectAssetRow[] = [];
	let unchangedAssets = 0;
	for (const project of incomingProjects) {
		const candidate = existingProjects.find(
			(existing) =>
				existing.name === project.name &&
				existing.createdAt === project.createdAt &&
				existing.updatedAt === project.updatedAt &&
				sameProjectContent(
					project.id,
					existing.id,
					incomingDrafts,
					existingDrafts,
					incomingAssets,
					existingAssets
				)
		);
		if (candidate) {
			projectIdMap.set(project.id, candidate.id);
			unchangedAssets += incomingAssets.filter((asset) => asset.projectId === project.id).length;
			continue;
		}
		let mappedId = project.id;
		while (reservedProjectIds.has(mappedId)) mappedId = newId();
		reservedProjectIds.add(mappedId);
		projectIdMap.set(project.id, mappedId);
		projectsToPut.push({ ...project, id: mappedId });
		for (const asset of incomingAssets.filter((row) => row.projectId === project.id)) {
			let assetId = asset.id;
			while (reservedAssetIds.has(assetId)) assetId = newId();
			reservedAssetIds.add(assetId);
			assetsToPut.push({ ...asset, id: assetId, projectId: mappedId });
		}
	}
	return { projectIdMap, projectsToPut, assetsToPut, unchangedAssets };
}

/**
 * Writes a backup into IndexedDB.
 *
 * - `replace` : first clears drafts/workspaces/templates, then re-inserts everything.
 * - `merge`   : keeps existing rows and imports distinct variants under new
 *               ids. Imported workspace references follow the mapped ids.
 *               Identical variants are not imported twice.
 *
 * Single transaction → atomic (no half-restored state on failure).
 *
 * `skipped` (from the parse) is propagated as is into the result: `applyBackup`
 * only writes already-validated rows, the rejection count comes from upstream.
 */
export async function applyBackup(
	backup: BackupFile,
	mode: RestoreMode,
	skipped = 0
): Promise<RestoreCounts> {
	if (!validatedBackups.has(backup)) backup = validateBackupValue(backup).backup;
	if (skipped > 0) throw new BackupParseError(t('backup.notMdshBackup'));
	const projects = backup.projects ?? [];
	const snippets = backup.snippets ?? [];
	const projectAssets = (backup.projectAssets ?? []).map((asset): ProjectAssetRow => ({
		...asset,
		data: base64ToBytes(asset.data)
	}));
	const counts: RestoreCounts = {
		drafts: 0,
		workspaces: 0,
		templates: 0,
		snippets: 0,
		projects: 0,
		projectAssets: 0,
		unchanged: {
			drafts: 0,
			workspaces: 0,
			templates: 0,
			...(backup.snippets === undefined ? {} : { snippets: 0 }),
			...(backup.schemaVersion >= 2 ? { projects: 0, projectAssets: 0 } : {})
		},
		skipped
	};
	await db.transaction(
		'rw',
		[
			db.drafts,
			db.workspaces,
			db.templates,
			db.snippets,
			db.versions,
			db.trashed,
			db.metadata,
			db.projects,
			db.projectAssets,
			db.comments
		],
		async () => {
			if (mode === 'replace') {
				// Keep a durable recovery point, including writes from other tabs that
				// committed immediately before this transaction acquired the database.
				const [currentDrafts, currentProjects, currentAssets] = await Promise.all([
					db.drafts.toArray(),
					db.projects.toArray(),
					db.projectAssets.toArray()
				]);
				const incomingProjects = new Map(projects.map((project) => [project.id, project]));
				const incomingDrafts = new Map(backup.drafts.map((draft) => [draft.id, draft]));
				const unchangedProjects = new Set(
					currentProjects
						.filter((project) => {
							const incoming = incomingProjects.get(project.id);
							return (
								incoming !== undefined &&
								incoming.name === project.name &&
								sameProjectContent(
									project.id,
									incoming.id,
									currentDrafts,
									backup.drafts,
									currentAssets,
									projectAssets
								)
							);
						})
						.map((project) => project.id)
				);
				for (const current of currentDrafts) {
					const incoming = incomingDrafts.get(current.id);
					if (
						incoming?.content === current.content &&
						incoming.name === current.name &&
						incoming.projectId === current.projectId &&
						incoming.relativePath === current.relativePath &&
						(!current.projectId || unchangedProjects.has(current.projectId))
					)
						continue;
					await preserveTrashEntry(current.id);
					await db.trashed.put({
						id: current.id,
						file: current,
						order: current.order,
						trashedAt: Date.now()
					});
				}
				// Retained trash needs its original assets, including trash from before this restore.
				const retained = await db.trashed.toArray();
				const recoveryProjects: ProjectRow[] = [];
				const recoveryAssets: ProjectAssetRow[] = [];
				const projectIdMap = new Map<string, string>();
				const draftIdMap = new Map<string, string>();
				const projectIds = new Set([...projects, ...currentProjects].map((project) => project.id));
				const assetIds = new Set([...projectAssets, ...currentAssets].map((asset) => asset.id));
				for (const projectId of new Set(retained.flatMap((row) => row.file.projectId ?? []))) {
					const project = currentProjects.find((row) => row.id === projectId);
					if (!project) throw new BackupParseError(t('backup.notMdshBackup'));
					let mappedId = projectId;
					if (projects.some((row) => row.id === projectId)) {
						do mappedId = newId();
						while (projectIds.has(mappedId));
					}
					projectIds.add(mappedId);
					projectIdMap.set(projectId, mappedId);
					recoveryProjects.push({ ...normalizeProject(project), id: mappedId });
					for (const asset of currentAssets.filter((row) => row.projectId === projectId)) {
						let assetId = asset.id;
						if (projectAssets.some((row) => row.id === assetId)) {
							do assetId = newId();
							while (assetIds.has(assetId));
						}
						assetIds.add(assetId);
						recoveryAssets.push({ ...asset, id: assetId, projectId: mappedId });
					}
				}
				for (let index = 0; index < retained.length; index++) {
					const row = retained[index]!;
					// Keep standalone trash references until restoration resolves the collision.
					if (!row.file.projectId || !backup.drafts.some((draft) => draft.id === row.id)) continue;
					const preserved = (await preserveTrashEntry(row.id))!;
					await db.trashed.delete(row.id);
					draftIdMap.set(row.id, preserved.id);
					retained[index] = preserved;
				}
				await db.trashed.bulkPut(
					retained.map((row) => ({
						...row,
						file: {
							...normalizeDraft(row.file),
							content: rewriteDraftLinks(row.file.content, draftIdMap),
							...(row.file.projectId ? { projectId: projectIdMap.get(row.file.projectId)! } : {})
						}
					}))
				);
				await Promise.all([
					db.drafts.clear(),
					db.workspaces.clear(),
					db.templates.clear(),
					db.snippets.clear(),
					db.projects.clear(),
					db.projectAssets.clear(),
					db.comments.clear()
				]);
				await db.metadata.where('key').startsWith(PROJECT_NATIVE_BASELINE_PREFIX).delete();
				await db.metadata.put({ key: DISK_LINK_EPOCH_KEY, value: newId() });
				await Promise.all([
					db.drafts.bulkPut(backup.drafts),
					db.workspaces.bulkPut(backup.workspaces),
					db.templates.bulkPut(backup.templates),
					db.snippets.bulkPut(snippets),
					db.projects.bulkPut([...projects, ...recoveryProjects]),
					db.projectAssets.bulkPut([...projectAssets, ...recoveryAssets]),
					db.comments.bulkPut(backup.comments ?? [])
				]);
				counts.drafts = backup.drafts.length;
				counts.workspaces = backup.workspaces.length;
				counts.templates = backup.templates.length;
				counts.snippets = snippets.length;
				counts.projects = projects.length;
				counts.projectAssets = projectAssets.length;
				counts.comments = backup.comments?.length ?? 0;
				if (backup.snippets !== undefined) counts.unchanged.snippets = 0;
				return;
			}
			// merge
			const [existing, existingProjects, existingAssets] = await Promise.all([
				db.drafts.toArray(),
				db.projects.toArray(),
				db.projectAssets.toArray()
			]);
			const projectPlan = planProjectMerge(
				projects,
				backup.drafts,
				projectAssets,
				existingProjects,
				existing,
				existingAssets
			);
			const { importedIdMap, draftsToPut } = planDraftMerge(
				backup.drafts,
				existing,
				projectPlan.projectIdMap
			);
			const existingWorkspaces = await db.workspaces.toArray();
			const workspaceIds = new Set(existingWorkspaces.map((row) => row.id));
			const workspaceKeys = new Set(
				existingWorkspaces.map((row) =>
					JSON.stringify([
						row.name,
						row.activeId,
						row.createdAt,
						row.updatedAt,
						row.fileIds.join('\0')
					])
				)
			);
			const workspacesToPut = backup.workspaces.flatMap((workspace) => {
				const fileIds = workspace.fileIds.flatMap((id) => {
					const mapped = importedIdMap.get(id);
					return mapped ? [mapped] : [];
				});
				const mapped = {
					...workspace,
					fileIds: [...new Set(fileIds)],
					activeId: workspace.activeId ? (importedIdMap.get(workspace.activeId) ?? null) : null
				};
				const identical = workspaceKeys.has(
					JSON.stringify([
						mapped.name,
						mapped.activeId,
						mapped.createdAt,
						mapped.updatedAt,
						mapped.fileIds.join('\0')
					])
				);
				if (identical) return [];
				return [{ ...mapped, id: workspaceIds.has(mapped.id) ? newId() : mapped.id }];
			});
			const existingTemplates = await db.templates.toArray();
			const templateIds = new Set(existingTemplates.map((row) => row.id));
			const templateKeys = new Set(
				existingTemplates.map((row) =>
					JSON.stringify([
						row.name,
						row.content,
						row.builtin,
						row.kind ?? 'note',
						row.createdAt,
						row.updatedAt
					])
				)
			);
			const templatesToPut = backup.templates.flatMap((template) => {
				const identical = templateKeys.has(
					JSON.stringify([
						template.name,
						template.content,
						template.builtin,
						template.kind ?? 'note',
						template.createdAt,
						template.updatedAt
					])
				);
				if (identical) return [];
				return [{ ...template, id: templateIds.has(template.id) ? newId() : template.id }];
			});
			const existingComments = await db.comments.toArray();
			const commentIds = new Set(existingComments.map((row) => row.id));
			const commentKeys = new Set(
				existingComments.map((row) => JSON.stringify([row.id, row.body, row.status, row.updatedAt]))
			);
			const commentsToPut = (backup.comments ?? []).flatMap((comment) => {
				const mappedDraftId = importedIdMap.get(comment.draftId);
				if (!mappedDraftId) return [];
				const mapped = { ...comment, draftId: mappedDraftId };
				const identical = commentKeys.has(
					JSON.stringify([mapped.id, mapped.body, mapped.status, mapped.updatedAt])
				);
				if (identical) return [];
				return [{ ...mapped, id: commentIds.has(mapped.id) ? newId() : mapped.id }];
			});
			const existingSnippets = await db.snippets.toArray();
			const snippetIds = new Set(existingSnippets.map((row) => row.id));
			const snippetKeys = new Set(
				existingSnippets.map((row) =>
					JSON.stringify([
						row.title,
						row.code,
						row.language,
						row.tags.join('\0'),
						row.folder,
						row.projectId,
						row.favorite,
						row.createdAt,
						row.updatedAt
					])
				)
			);
			const snippetsToPut = snippets.flatMap((snippet) => {
				const identical = snippetKeys.has(
					JSON.stringify([
						snippet.title,
						snippet.code,
						snippet.language,
						snippet.tags.join('\0'),
						snippet.folder,
						snippet.projectId,
						snippet.favorite,
						snippet.createdAt,
						snippet.updatedAt
					])
				);
				if (identical) return [];
				return [{ ...snippet, id: snippetIds.has(snippet.id) ? newId() : snippet.id }];
			});
			await Promise.all([
				db.drafts.bulkPut(draftsToPut.filter((row): row is DraftRow => row !== null)),
				db.workspaces.bulkPut(workspacesToPut),
				db.templates.bulkPut(templatesToPut),
				db.snippets.bulkPut(snippetsToPut),
				db.projects.bulkPut(projectPlan.projectsToPut),
				db.projectAssets.bulkPut(projectPlan.assetsToPut),
				db.comments.bulkPut(commentsToPut)
			]);
			counts.drafts = draftsToPut.filter((row) => row !== null).length;
			counts.workspaces = workspacesToPut.length;
			counts.templates = templatesToPut.length;
			counts.snippets = snippetsToPut.length;
			counts.projects = projectPlan.projectsToPut.length;
			counts.projectAssets = projectPlan.assetsToPut.length;
			counts.comments = commentsToPut.length;
			counts.unchanged = {
				drafts: backup.drafts.length - counts.drafts,
				workspaces: backup.workspaces.length - counts.workspaces,
				templates: backup.templates.length - counts.templates,
				...(backup.snippets === undefined ? {} : { snippets: snippets.length - counts.snippets }),
				...(backup.schemaVersion >= 2
					? {
							projects: projects.length - counts.projects,
							projectAssets: projectPlan.unchangedAssets
						}
					: {})
			};
		}
	);
	return counts;
}

// ─── DOM orchestration (download / file read) ───────────────────────────────

/**
 * @returns `true` when a download/save was initiated; `false` when the user
 * cancelled the desktop save dialog.
 */
async function triggerDownload(blob: Blob, filename: string): Promise<boolean> {
	const { isDesktop } = await import('../desktop');
	if (isDesktop()) {
		const { tauriSaveExportBlob } = await import('../disk-tauri');
		return await tauriSaveExportBlob(blob, filename);
	}
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(url);
	return true;
}

/**
 * Builds the backup and triggers its download. If `passphrase` is
 * provided (§2.8), the content is encrypted (AES-GCM) and the file is unreadable
 * without the passphrase.
 *
 * @returns `false` if the desktop save dialog was cancelled (no success toast).
 */
export async function downloadBackup(
	passphrase?: string,
	ensureDurable: () => Promise<void> = ensureLiveDraftsDurable
): Promise<boolean> {
	if (typeof document === 'undefined') return false;
	await ensureDurable();
	const now = Date.now();
	const backup = await collectBackup(now);
	const json = serializeBackup(backup);
	parseBackupWithReport(json);
	const stamp = new Date(now).toISOString().slice(0, 10);
	if (passphrase) {
		const envelope = await encryptString(json, passphrase);
		const encrypted = JSON.stringify(envelope);
		assertBackupTextSize(encrypted);
		const blob = new Blob([encrypted], { type: 'application/json;charset=utf-8' });
		return triggerDownload(blob, `deckmark-backup-${stamp}.encrypted.json`);
	}
	const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
	return triggerDownload(blob, `deckmark-backup-${stamp}.json`);
}

/** §2.8 - Detects whether a backup text is an encrypted envelope. */
export function isEncryptedBackup(text: string): boolean {
	assertBackupTextSize(text);
	try {
		return isEncryptedEnvelope(JSON.parse(text));
	} catch {
		return false;
	}
}

/** §2.8 - Decrypts a backup envelope → plaintext JSON. */
export async function decryptBackupText(text: string, passphrase: string): Promise<string> {
	assertBackupTextSize(text);
	let env: unknown;
	try {
		env = JSON.parse(text);
	} catch {
		throw new BackupParseError(t('backup.encryptedInvalidJson'));
	}
	if (!isEncryptedEnvelope(env)) throw new BackupParseError(t('backup.notEncrypted'));
	return decryptString(env, passphrase);
}

/**
 * Restores from a text (plaintext or encrypted). If encrypted, `passphrase` is
 * required (otherwise BackupParseError). Validates then applies according to `mode`.
 */
export async function restoreFromText(
	text: string,
	mode: RestoreMode,
	passphrase?: string,
	ensureDurable: () => Promise<void> = ensureLiveDraftsDurable
): Promise<RestoreCounts> {
	await ensureDurable();
	const { backup, skipped } = await inspectBackupText(text, passphrase);
	const skippedTotal =
		skipped.drafts +
		skipped.workspaces +
		skipped.templates +
		skipped.snippets +
		skipped.projects +
		skipped.projectAssets;
	return applyBackup(backup, mode, skippedTotal);
}

/** Validates a backup without changing drafts or requesting disk access. */
export async function inspectBackupText(text: string, passphrase?: string): Promise<ParsedBackup> {
	let json = text;
	if (isEncryptedBackup(text)) {
		if (!passphrase) throw new BackupParseError(t('backup.passphraseRequired'));
		json = await decryptBackupText(text, passphrase);
	}
	return parseBackupWithReport(json);
}

/** Reads a backup file (plaintext or encrypted), validates it and applies it. */
export async function restoreFromFile(
	file: File,
	mode: RestoreMode,
	passphrase?: string
): Promise<RestoreCounts> {
	let text: string;
	try {
		text = await readUtf8File(file, IMPORT_LIMITS.maxBatchBytes);
	} catch (error) {
		if (error instanceof ImportReadError)
			throw new BackupParseError(
				t(error.reason === 'file-size' ? 'backup.tooLarge' : 'backup.invalidJson')
			);
		throw error;
	}
	return restoreFromText(text, mode, passphrase);
}

function assertBackupTextSize(text: string): void {
	if (
		text.length > IMPORT_LIMITS.maxBatchBytes ||
		new TextEncoder().encode(text).byteLength > IMPORT_LIMITS.maxBatchBytes
	)
		throw new BackupParseError(t('backup.tooLarge'));
}

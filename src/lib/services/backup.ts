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
import { checkAborted, isAbortError } from '../abort';
import { triggerDownload } from './export';
// Bounded work for the backup snapshot.
//
// The policy lives in this lazy module, so the boot bundle does not grow. Each
// stage reads or serializes a bounded window, then yields. A signal stops the
// operation at every page or chunk boundary. The counters are local evidence;
// they are not a heap measurement and they do not replace a native run.

export const EXPORT_BATCH_POLICY = {
	/** Rows read and normalized before a yield. */
	maxRows: 32,
	/** One raw project asset row is converted and released at a time. */
	maxAssetRows: 1,
	/** Serialized JSON characters kept in one output chunk. */
	maxChunkChars: 512 * 1024,
	/** Text characters validated before an early yield inside one batch. */
	maxTextChars: 1024 * 1024
} as const;

export type ExportPhase = 'collect' | 'encode' | 'compress' | 'encrypt' | 'write';

export interface ExportProgress {
	phase: ExportPhase;
	completed: number;
	total: number;
	/** Whole percent of the complete operation, from 0 to 100. */
	percent: number;
}

export type ExportProgressReporter = (progress: ExportProgress) => void;

export interface ExportPipelineSnapshot {
	kind: string;
	completed: boolean;
	cancelled: boolean;
	batches: number;
	yields: number;
	rows: number;
	maxBatchRows: number;
	maxLiveAssetBytes: number;
	serializedChars: number;
	maxChunkChars: number;
	joinedCopyChars: number;
	maxPercent: number;
	progressEvents: number;
	timings: Record<string, number>;
}

interface MainScheduler {
	yield?: () => Promise<void>;
}

function instrumentedDelay(): number {
	const value = (globalThis as { __MDSH_EXPORT_PIPELINE_DELAY_MS__?: unknown })
		.__MDSH_EXPORT_PIPELINE_DELAY_MS__;
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
	return Math.min(500, Math.round(value));
}

/**
 * Gives the browser one turn to process input, paint and other tasks. The
 * scheduler API yields without a timer clamp where the engine provides it.
 * The instrumented delay makes the yield points observable in a local profile.
 */
export async function yieldToMainThread(): Promise<void> {
	const scheduler = (globalThis as { scheduler?: MainScheduler }).scheduler;
	if (scheduler && typeof scheduler.yield === 'function') {
		await scheduler.yield();
	} else {
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	const delay = instrumentedDelay();
	if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
}

const published: ExportPipelineSnapshot[] = [];
const MAX_PUBLISHED = 20;
let probeInstalled = false;

function installProbe(): void {
	if (probeInstalled || typeof window === 'undefined') return;
	probeInstalled = true;
	const host = window as unknown as {
		__MDSH_EXPORT_PIPELINE__?: {
			runs(): ExportPipelineSnapshot[];
			reset(): void;
		};
	};
	host.__MDSH_EXPORT_PIPELINE__ = {
		runs: () => published.map((snapshot) => ({ ...snapshot, timings: { ...snapshot.timings } })),
		reset: () => {
			published.length = 0;
		}
	};
}

/** Counters for one operation. One run covers collection, encoding and output. */
export class ExportPipelineRun {
	private readonly kind: string;
	private readonly startedAt = performance.now();
	private batches = 0;
	private yields = 0;
	private rows = 0;
	private maxBatchRows = 0;
	private maxLiveAssetBytes = 0;
	private serializedChars = 0;
	private maxChunkChars = 0;
	private joinedCopyChars = 0;
	private maxPercent = 0;
	private progressEvents = 0;
	private readonly timings: Record<string, number> = {};
	private phaseStartedAt: number | null = null;
	private phaseName: string | null = null;
	private finished = false;

	constructor(kind: string) {
		this.kind = kind;
		installProbe();
	}

	beginPhase(name: string): void {
		if (this.phaseName && this.phaseStartedAt !== null) this.endPhase();
		this.phaseName = name;
		this.phaseStartedAt = performance.now();
	}

	endPhase(): void {
		if (!this.phaseName || this.phaseStartedAt === null) return;
		this.timings[this.phaseName] =
			(this.timings[this.phaseName] ?? 0) + (performance.now() - this.phaseStartedAt);
		this.phaseName = null;
		this.phaseStartedAt = null;
	}

	noteBatch(rows: number, liveAssetBytes = 0): void {
		this.batches++;
		this.rows += rows;
		if (rows > this.maxBatchRows) this.maxBatchRows = rows;
		if (liveAssetBytes > this.maxLiveAssetBytes) this.maxLiveAssetBytes = liveAssetBytes;
	}

	noteYield(): void {
		this.yields++;
	}

	noteChunk(chars: number): void {
		this.serializedChars += chars;
		if (chars > this.maxChunkChars) this.maxChunkChars = chars;
	}

	noteJoinedCopy(chars: number): void {
		if (chars > this.joinedCopyChars) this.joinedCopyChars = chars;
	}

	noteProgress(percent: number): void {
		const bounded = Math.min(100, Math.max(0, Math.round(percent)));
		this.progressEvents++;
		if (bounded > this.maxPercent) this.maxPercent = bounded;
	}

	finish(outcome: 'completed' | 'cancelled' | 'failed'): void {
		if (this.finished) return;
		this.finished = true;
		this.endPhase();
		this.timings.total = performance.now() - this.startedAt;
		const snapshot: ExportPipelineSnapshot = {
			kind: this.kind,
			completed: outcome === 'completed',
			cancelled: outcome === 'cancelled',
			batches: this.batches,
			yields: this.yields,
			rows: this.rows,
			maxBatchRows: this.maxBatchRows,
			maxLiveAssetBytes: this.maxLiveAssetBytes,
			serializedChars: this.serializedChars,
			maxChunkChars: this.maxChunkChars,
			joinedCopyChars: this.joinedCopyChars,
			maxPercent: this.maxPercent,
			progressEvents: this.progressEvents,
			timings: { ...this.timings }
		};
		published.push(snapshot);
		if (published.length > MAX_PUBLISHED) published.shift();
	}
}

/**
 * Reads exact rows in bounded key pages.
 *
 * The caller captures the key order once. A page then reads its rows by key, so
 * a concurrent insert or delete cannot shift a later page. A signal stops the
 * read at a page boundary.
 */
export async function readKeyBatches<T>(
	keys: readonly string[],
	read: (keys: string[]) => Promise<Array<T | undefined>>,
	options: {
		limit: number;
		signal?: AbortSignal | undefined;
		run: ExportPipelineRun;
		onBatch: (rows: T[], requested: number) => void | Promise<void>;
		/** Raw bytes held by one page, for the asset live-bytes counter. */
		liveBytes?: ((rows: T[]) => number) | undefined;
	}
): Promise<void> {
	for (let offset = 0; offset < keys.length; offset += options.limit) {
		if (options.signal?.aborted) throw new DOMException('Operation cancelled', 'AbortError');
		const page = keys.slice(offset, offset + options.limit);
		const rows = (await read(page)).filter((row): row is T => row !== undefined);
		options.run.noteBatch(page.length, options.liveBytes?.(rows) ?? 0);
		await options.onBatch(rows, page.length);
		if (offset + options.limit < keys.length) {
			options.run.noteYield();
			await yieldToMainThread();
		}
	}
}

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
		const candidate = matches.find((row) => sameDraftSource(row, draft)) ?? matches[0];
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
		const incoming = byId.get(id)!;
		const rewritten = rewrite(incoming.content);
		if (
			!candidate ||
			(candidate.content === rewritten &&
				sameDraftSource(candidate, { ...incoming, content: rewritten }))
		)
			continue;
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

const MIB = 1024 * 1024;

/** Size in MiB with one decimal, for the limit messages. */
function mib(bytes: number): string {
	return (bytes / MIB).toFixed(1);
}

/** The title of a stored row, when the row has one. */
function rowTitle(row: unknown): string | null {
	if (typeof row !== 'object' || row === null) return null;
	const { name, title } = row as { name?: unknown; title?: unknown };
	const value = typeof name === 'string' ? name : typeof title === 'string' ? title : '';
	return value.length > 0 ? value : null;
}

// ─── Collection ──────────────────────────────────────────────────────────────

export interface BackupCollectOptions {
	signal?: AbortSignal | undefined;
	onProgress?: ExportProgressReporter | undefined;
	/** Shared run when the caller measures the complete operation. */
	run?: ExportPipelineRun;
}

/** Exact source byte length of each generated project asset. */
type GeneratedAssetBytes = Map<string, number>;

/**
 * Identity of a generated snapshot.
 *
 * The backup path does not consume editor revisions or changed spans. It reads
 * the durable rows after the save queue flush, in bounded pages. The identity
 * states the exact durable state that the snapshot captured, so the revision
 * lanes (#569, #572, #574) can compare a snapshot without a second full read.
 * A snapshot never mixes an editor revision with durable bytes: the flush
 * completes before the first page read.
 */
export interface BackupSnapshotIdentity {
	exportedAt: number;
	drafts: number;
	workspaces: number;
	templates: number;
	snippets: number;
	projects: number;
	projectAssets: number;
	comments: number;
}

export function backupSnapshotIdentity(backup: BackupFile): BackupSnapshotIdentity {
	return {
		exportedAt: backup.exportedAt,
		drafts: backup.drafts.length,
		workspaces: backup.workspaces.length,
		templates: backup.templates.length,
		snippets: backup.snippets?.length ?? 0,
		projects: backup.projects?.length ?? 0,
		projectAssets: backup.projectAssets?.length ?? 0,
		comments: backup.comments?.length ?? 0
	};
}

/**
 * Reads the persisted state and builds the backup object (draft order preserved).
 *
 * The read is bounded: each collection is read in pages of at most
 * `EXPORT_BATCH_POLICY.maxRows` rows, and one raw project asset is converted
 * and released at a time. Rows are validated as they arrive, so an invalid or
 * oversized row fails before the complete corpus is resident. A signal stops
 * the read at a page boundary.
 */
export async function collectBackup(
	now = Date.now(),
	options: BackupCollectOptions = {}
): Promise<BackupFile> {
	const run = options.run ?? new ExportPipelineRun('backup-collect');
	const signal = options.signal;
	const encoder = new TextEncoder();
	run.beginPhase('collect');
	// Capture the key order once per store. Pages then read exact rows by key,
	// so a concurrent insert or delete cannot shift a later page.
	const [draftIds, workspaceIds, templateIds, snippetIds, projectIds, assetIds, commentIds] =
		await Promise.all([
			db.drafts.orderBy('order').primaryKeys(),
			db.workspaces.orderBy('updatedAt').primaryKeys(),
			db.templates.orderBy('updatedAt').primaryKeys(),
			db.snippets.orderBy('updatedAt').primaryKeys(),
			db.projects.orderBy('updatedAt').primaryKeys(),
			db.projectAssets.toCollection().primaryKeys(),
			db.comments.orderBy('createdAt').primaryKeys()
		]);
	const totalRows =
		draftIds.length +
		workspaceIds.length +
		templateIds.length +
		snippetIds.length +
		projectIds.length +
		assetIds.length +
		commentIds.length;
	let processed = 0;
	let contentBytes = 0;
	let assetBytesTotal = 0;
	const assetBytes: GeneratedAssetBytes = new Map();
	const draftLocations: Array<{ projectId: string; relativePath: string }> = [];

	const report = () => {
		const percent = totalRows > 0 ? (processed / totalRows) * 70 : 70;
		options.onProgress?.({ phase: 'collect', completed: processed, total: totalRows, percent });
		run.noteProgress(percent);
	};
	const invalid = () => new BackupParseError(t('backup.notMdshBackup'));
	const tooLarge = () => new BackupParseError(t('backup.tooLarge'));
	// A row that fails validation is named when it has a title.
	const invalidRow = (row: unknown) => {
		const title = rowTitle(row);
		return title ? new BackupParseError(t('backup.invalidDocument', { title })) : invalid();
	};
	if (draftIds.length + templateIds.length > BACKUP_LIMITS.maxDocuments)
		throw new BackupParseError(
			t('backup.tooManyDocuments', { count: draftIds.length + templateIds.length })
		);
	const checkText = (content: string, title: string) => {
		try {
			validateMarkdownContent(content);
		} catch {
			throw new BackupParseError(t('backup.binaryDocument', { title }));
		}
		const size = encoder.encode(content).byteLength;
		contentBytes += size;
		if (size > IMPORT_LIMITS.maxFileBytes)
			throw new BackupParseError(t('backup.documentTooLarge', { title, size: mib(size) }));
		if (contentBytes > IMPORT_LIMITS.maxBatchBytes)
			throw new BackupParseError(t('backup.totalTooLarge', { title, size: mib(contentBytes) }));
	};
	const page = {
		limit: EXPORT_BATCH_POLICY.maxRows,
		signal,
		run
	};

	const drafts: DraftRow[] = [];
	await readKeyBatches(draftIds, (keys) => db.drafts.bulkGet(keys), {
		...page,
		onBatch: (rows, requested) => {
			for (const row of rows) {
				if (!validDraft(row)) throw invalidRow(row);
				checkText(row.content, row.name);
				const normalized = normalizeDraft(row);
				drafts.push(normalized);
				if (normalized.projectId && normalized.relativePath)
					draftLocations.push({
						projectId: normalized.projectId,
						relativePath: normalized.relativePath
					});
			}
			processed += requested;
			report();
		}
	});

	const workspaces: WorkspaceRow[] = [];
	await readKeyBatches(workspaceIds, (keys) => db.workspaces.bulkGet(keys), {
		...page,
		onBatch: (rows, requested) => {
			for (const row of rows) {
				if (!validWorkspace(row)) throw invalid();
				workspaces.push(row);
			}
			processed += requested;
			report();
		}
	});

	const templates: TemplateRow[] = [];
	await readKeyBatches(templateIds, (keys) => db.templates.bulkGet(keys), {
		...page,
		onBatch: (rows, requested) => {
			for (const row of rows) {
				if (!validTemplate(row)) throw invalidRow(row);
				checkText(row.content, row.name);
				templates.push(row);
			}
			processed += requested;
			report();
		}
	});

	const snippets: SnippetRow[] = [];
	await readKeyBatches(snippetIds, (keys) => db.snippets.bulkGet(keys), {
		...page,
		onBatch: (rows, requested) => {
			for (const row of rows) {
				if (!validSnippetRow(row)) throw invalidRow(row);
				checkText(row.code, row.title);
				snippets.push(normalizeSnippetRow(row));
			}
			processed += requested;
			report();
		}
	});

	const projects: BackupProject[] = [];
	await readKeyBatches(projectIds, (keys) => db.projects.bulkGet(keys), {
		...page,
		onBatch: (rows, requested) => {
			for (const row of rows) {
				if (!validProject(row)) throw invalid();
				projects.push(normalizeProject(row));
			}
			processed += requested;
			report();
		}
	});

	const projectAssets: BackupProjectAsset[] = [];
	await readKeyBatches(assetIds, (keys) => db.projectAssets.bulkGet(keys), {
		...page,
		limit: EXPORT_BATCH_POLICY.maxAssetRows,
		liveBytes: (rows) => rows.reduce((total, row) => total + row.data.byteLength, 0),
		onBatch: (rows, requested) => {
			for (const asset of rows) {
				if (
					typeof asset.id !== 'string' ||
					asset.id.length === 0 ||
					typeof asset.projectId !== 'string' ||
					asset.projectId.length === 0 ||
					typeof asset.path !== 'string' ||
					asset.path.length === 0 ||
					typeof asset.mime !== 'string' ||
					asset.mime.length > 128 ||
					!(asset.mime.startsWith('image/') || asset.mime === 'application/octet-stream') ||
					!(asset.data instanceof Uint8Array)
				)
					throw invalid();
				const maximum =
					asset.mime.startsWith('image/') || imageMime(asset.path)
						? MAX_IMAGE_BYTES
						: IMPORT_LIMITS.maxFileBytes;
				const size = asset.data.byteLength;
				assetBytesTotal += size;
				if (size > maximum || assetBytesTotal > PROJECT_BACKUP_LIMITS.maxAssetBytesTotal)
					throw tooLarge();
				// Converted from the exact row bytes, then the row is released.
				assetBytes.set(asset.id, size);
				projectAssets.push({
					id: asset.id,
					projectId: asset.projectId,
					path: asset.path,
					mime: asset.mime,
					data: bytesToBase64(asset.data)
				});
			}
			processed += requested;
			report();
		}
	});

	const comments: CommentRow[] = [];
	await readKeyBatches(commentIds, (keys) => db.comments.bulkGet(keys), {
		...page,
		onBatch: (rows, requested) => {
			for (const row of rows) {
				if (!validComment(row)) throw invalid();
				comments.push(row);
			}
			processed += requested;
			report();
		}
	});

	const backup: BackupFile = {
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
	validateGeneratedBackup(backup, assetBytes, draftLocations);
	run.endPhase();
	run.noteProgress(70);
	return backup;
}

/**
 * Cross-collection checks for locally generated data. Row shape, text limits
 * and exact asset sizes are already checked during the bounded read. Imported
 * files still take the complete hostile-input check in `validateBackupValue`,
 * including a second decode of every Base64 payload.
 */
function validateGeneratedBackup(
	backup: BackupFile,
	assetBytes: GeneratedAssetBytes,
	draftLocations: ReadonlyArray<{ projectId: string; relativePath: string }>
): void {
	const invalid = () => new BackupParseError(t('backup.notMdshBackup'));
	const tooLarge = () => new BackupParseError(t('backup.tooLarge'));
	if (
		backup.drafts.length + backup.templates.length > BACKUP_LIMITS.maxDocuments ||
		backup.workspaces.length > BACKUP_LIMITS.maxWorkspaces ||
		(backup.snippets?.length ?? 0) > MAX_SNIPPETS ||
		(backup.projects?.length ?? 0) > PROJECT_BACKUP_LIMITS.maxProjects ||
		(backup.projectAssets?.length ?? 0) > PROJECT_BACKUP_LIMITS.maxAssets
	)
		throw tooLarge();
	for (const rows of [
		backup.drafts,
		backup.workspaces,
		backup.templates,
		backup.snippets ?? [],
		backup.comments ?? []
	]) {
		if (new Set(rows.map((row) => row.id)).size !== rows.length) throw invalid();
	}
	const projects = backup.projects ?? [];
	const assets = backup.projectAssets ?? [];
	if (
		new Set(projects.map((project) => project.id)).size !== projects.length ||
		new Set(assets.map((asset) => asset.id)).size !== assets.length
	)
		throw invalid();
	if (
		backup.workspaces.reduce((total, workspace) => total + workspace.fileIds.length, 0) >
		BACKUP_LIMITS.maxTotalWorkspaceReferences
	)
		throw tooLarge();
	const projectIds = new Set(projects.map((project) => project.id));
	const paths = new Set<string>();
	const addPath = (projectId: string, relativePath: string) => {
		if (!projectIds.has(projectId)) throw invalid();
		let normalized: string;
		try {
			normalized = projectPath(relativePath);
		} catch {
			throw invalid();
		}
		if (normalized !== relativePath) throw invalid();
		const key = `${projectId}\0${pathKey(normalized)}`;
		if (paths.has(key)) throw invalid();
		paths.add(key);
	};
	for (const location of draftLocations) addPath(location.projectId, location.relativePath);
	let total = 0;
	for (const asset of assets) {
		addPath(asset.projectId, asset.path);
		const size = assetBytes.get(asset.id);
		if (size === undefined) throw invalid();
		total += size;
	}
	if (total > PROJECT_BACKUP_LIMITS.maxAssetBytesTotal) throw tooLarge();
	// The generated object is complete. `applyBackup` may write it directly.
	validatedBackups.add(backup);
}

/**
 * Serializes a backup into indented JSON (readable/diffable).
 *
 * The text is produced in pieces. The complete collection is never converted
 * to one second JSON string, so a caller can hand the pieces to a Blob.
 */
export function serializeBackup(backup: BackupFile): string {
	return [...backupJsonChunks(backup)].join('');
}

export interface BackupEncodeOptions {
	signal?: AbortSignal | undefined;
	onProgress?: ExportProgressReporter | undefined;
	run?: ExportPipelineRun;
}

/**
 * Serializes a backup into bounded JSON chunks. Each item is serialized once.
 * The output matches `JSON.stringify(backup, null, 2)` byte for byte.
 */
export async function serializeBackupBounded(
	backup: BackupFile,
	options: BackupEncodeOptions = {}
): Promise<string[]> {
	const run = options.run ?? new ExportPipelineRun('backup-encode');
	const expected = estimateBackupChars(backup);
	const output: string[] = [];
	let buffer = '';
	let encoded = 0;
	run.beginPhase('encode');
	const flush = async () => {
		if (!buffer) return;
		output.push(buffer);
		encoded += buffer.length;
		run.noteChunk(buffer.length);
		buffer = '';
		checkAborted(options.signal);
		run.noteYield();
		await yieldToMainThread();
		const percent = 70 + (expected > 0 ? Math.min(20, (encoded / expected) * 20) : 20);
		options.onProgress?.({
			phase: 'encode',
			completed: encoded,
			total: expected,
			percent
		});
		run.noteProgress(percent);
	};
	for (const piece of backupJsonChunks(backup)) {
		buffer += piece;
		if (buffer.length >= EXPORT_BATCH_POLICY.maxChunkChars) await flush();
	}
	await flush();
	run.endPhase();
	run.noteProgress(90);
	return output;
}

/** Indentation-independent size estimate for progress only. */
function estimateBackupChars(backup: BackupFile): number {
	let total = 512;
	for (const row of backup.drafts) total += row.content.length + row.name.length + 256;
	for (const row of backup.workspaces) total += row.name.length + row.fileIds.length * 64 + 256;
	for (const row of backup.templates) total += row.content.length + row.name.length + 256;
	for (const row of backup.snippets ?? []) total += row.code.length + row.title.length + 256;
	for (const row of backup.projects ?? []) total += row.name.length + 256;
	for (const row of backup.projectAssets ?? []) total += row.data.length + row.path.length + 256;
	for (const row of backup.comments ?? []) total += row.body.length + row.quote.length + 256;
	return total;
}

/**
 * Produces the exact `JSON.stringify(backup, null, 2)` text in small pieces.
 * Collection arrays are serialized item by item, at the same indentation as
 * the complete encoder.
 */
function* backupJsonChunks(backup: BackupFile): Generator<string> {
	yield '{';
	yield `\n  "format": ${JSON.stringify(backup.format)},`;
	yield `\n  "schemaVersion": ${JSON.stringify(backup.schemaVersion)},`;
	yield `\n  "exportedAt": ${JSON.stringify(backup.exportedAt)},`;
	const collections: Array<[string, unknown[] | undefined]> = [
		['drafts', backup.drafts],
		['workspaces', backup.workspaces],
		['templates', backup.templates],
		['snippets', backup.snippets],
		['projects', backup.projects],
		['projectAssets', backup.projectAssets],
		['comments', backup.comments]
	];
	const present = collections.filter((entry) => entry[1] !== undefined);
	for (let index = 0; index < present.length; index++) {
		const [key, rows] = present[index]!;
		const last = index === present.length - 1;
		yield `\n  ${JSON.stringify(key)}: `;
		yield* jsonArrayChunks(rows!, last);
	}
	yield '\n}';
}

function* jsonArrayChunks(rows: readonly unknown[], lastCollection: boolean): Generator<string> {
	if (rows.length === 0) {
		yield lastCollection ? '[]' : '[],';
		return;
	}
	yield '[';
	for (let index = 0; index < rows.length; index++) {
		const text = JSON.stringify(rows[index], null, 2) ?? 'null';
		yield `\n    ${text.replace(/\n/g, '\n    ')}${index === rows.length - 1 ? '' : ','}`;
	}
	yield lastCollection ? '\n  ]' : '\n  ],';
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
	if (data.byteLength === 0) return '';
	// 24 KiB is a multiple of three, so each chunk produces a complete Base64
	// group and the pieces concatenate exactly. The complete binary string is
	// never held for a large asset.
	const chunkSize = 3 * 8192;
	const parts: string[] = [];
	for (let offset = 0; offset < data.byteLength; offset += chunkSize) {
		parts.push(btoa(String.fromCharCode(...data.subarray(offset, offset + chunkSize))));
	}
	return parts.join('');
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
export interface BackupValidationOptions {
	/**
	 * Exact byte lengths of Base64 payloads that this build produced. A value
	 * for an asset skips the decode that hostile imported input still needs.
	 */
	assetBytes?: ReadonlyMap<string, number>;
}

export function validateBackupValue(raw: unknown, trusted?: BackupValidationOptions): ParsedBackup {
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
		if (size > IMPORT_LIMITS.maxFileBytes)
			throw new BackupParseError(
				t('backup.documentTooLarge', { title: row.name, size: mib(size) })
			);
		if (contentBytes > IMPORT_LIMITS.maxBatchBytes)
			throw new BackupParseError(
				t('backup.totalTooLarge', { title: row.name, size: mib(contentBytes) })
			);
		try {
			validateMarkdownContent(row.content);
		} catch {
			throw new BackupParseError(t('backup.binaryDocument', { title: row.name }));
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
		const size = trusted?.assetBytes?.get(asset.id) ?? base64ToBytes(asset.data).byteLength;
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

/** Exact source identity of a draft: text, document kind, MIME and binary payload. */
function sameDraftSource(left: DraftRow, right: DraftRow): boolean {
	return (
		left.content === right.content &&
		(left.kind ?? 'note') === (right.kind ?? 'note') &&
		(left.mime ?? '') === (right.mime ?? '') &&
		(left.data ?? '') === (right.data ?? '')
	);
}

/**
 * Moves every history snapshot to the recovery identity of the draft it
 * documents. Version history is keyed by draft id, so a replaced draft that
 * keeps its id must take its snapshots with it before an incoming draft claims
 * that id. Runs inside the Replace transaction.
 */
async function moveVersionHistory(sourceId: string, targetId: string): Promise<void> {
	if (sourceId === targetId) return;
	await db.versions.where('draftId').equals(sourceId).modify({ draftId: targetId });
}

/** Exact editorial-comment identity, including the mapped draft and anchor. */
function commentIdentity(row: CommentRow): string {
	return JSON.stringify([
		row.draftId,
		row.quote,
		row.from,
		row.to,
		row.body,
		row.author,
		row.status,
		row.createdAt,
		row.updatedAt
	]);
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
			!sameDraftSource(
				{ ...incoming, content: rewriteDraftLinks(incoming.content, idMap) },
				existing
			) ||
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
				const [currentDrafts, currentProjects, currentAssets, currentComments] = await Promise.all([
					db.drafts.toArray(),
					db.projects.toArray(),
					db.projectAssets.toArray(),
					db.comments.toArray()
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
				const trashIdMap = new Map<string, string>();
				const preservedHistoryIds = new Set<string>();
				for (const current of currentDrafts) {
					const incoming = incomingDrafts.get(current.id);
					if (
						incoming &&
						sameDraftSource(incoming, current) &&
						incoming.name === current.name &&
						incoming.projectId === current.projectId &&
						incoming.relativePath === current.relativePath &&
						(!current.projectId || unchangedProjects.has(current.projectId))
					) {
						// Complete source identity (text, kind, MIME, binary payload) plus
						// name and location match: the same draft is restored, so its
						// existing history stays with it.
						preservedHistoryIds.add(current.id);
						continue;
					}
					await preserveTrashEntry(current.id);
					// A different incoming draft claims this id. The retained copy takes
					// a durable recovery identity so its history, comments and links do
					// not attach to the incoming document.
					let trashId = current.id;
					if (incoming) {
						do trashId = newId();
						while (incomingDrafts.has(trashId) || currentDrafts.some((row) => row.id === trashId));
						trashIdMap.set(current.id, trashId);
						await moveVersionHistory(current.id, trashId);
					}
					await db.trashed.put({
						id: trashId,
						file: trashId === current.id ? current : { ...current, id: trashId },
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
				const retainedOriginalIds = new Set(retained.map((row) => row.id));
				for (let index = 0; index < retained.length; index++) {
					const row = retained[index]!;
					// An incoming draft that claims a retained trash id also needs the
					// recovery copy under a fresh id. Standalone rows included: their
					// history is keyed by the same draft id.
					if (!backup.drafts.some((draft) => draft.id === row.id)) continue;
					const preserved = (await preserveTrashEntry(row.id))!;
					await db.trashed.delete(row.id);
					draftIdMap.set(row.id, preserved.id);
					retained[index] = preserved;
				}
				const recoveryLinkMap = new Map([...trashIdMap, ...draftIdMap]);
				await db.trashed.bulkPut(
					retained.map((row) => ({
						...row,
						file: {
							...normalizeDraft(row.file),
							content: rewriteDraftLinks(row.file.content, recoveryLinkMap),
							...(row.file.projectId ? { projectId: projectIdMap.get(row.file.projectId)! } : {})
						}
					}))
				);
				// An incoming draft that did not preserve an identical owner keeps no
				// history under its id. This also removes orphan snapshots whose draft
				// and trash owners were already gone.
				for (const id of incomingDrafts.keys()) {
					if (preservedHistoryIds.has(id)) continue;
					await db.versions.where('draftId').equals(id).delete();
				}
				// Re-attach existing review comments to the retained recovery
				// identity instead of discarding them with the replaced drafts.
				const currentDraftIds = new Set(currentDrafts.map((row) => row.id));
				const recoveryCommentDraftId = (id: string) =>
					draftIdMap.get(id) ?? trashIdMap.get(id) ?? id;
				const incomingComments = backup.comments ?? [];
				const commentIds = new Set(incomingComments.map((row) => row.id));
				const commentKeys = new Set(incomingComments.map(commentIdentity));
				const recoveryComments: CommentRow[] = [];
				for (const comment of currentComments) {
					if (!currentDraftIds.has(comment.draftId) && !retainedOriginalIds.has(comment.draftId))
						continue;
					const mapped = { ...comment, draftId: recoveryCommentDraftId(comment.draftId) };
					const key = commentIdentity(mapped);
					if (commentKeys.has(key)) continue;
					commentKeys.add(key);
					const id = commentIds.has(mapped.id) ? newId() : mapped.id;
					commentIds.add(id);
					recoveryComments.push({ ...mapped, id });
				}
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
					db.comments.bulkPut([...incomingComments, ...recoveryComments])
				]);
				counts.drafts = backup.drafts.length;
				counts.workspaces = backup.workspaces.length;
				counts.templates = backup.templates.length;
				counts.snippets = snippets.length;
				counts.projects = projects.length;
				counts.projectAssets = projectAssets.length;
				counts.comments = incomingComments.length + recoveryComments.length;
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
			const admittedComments = new Set(existingComments.map(commentIdentity));
			const commentsToPut = (backup.comments ?? []).flatMap((comment) => {
				const mappedDraftId =
					importedIdMap.get(comment.draftId) ??
					(existing.some((row) => row.id === comment.draftId) ? comment.draftId : undefined);
				if (!mappedDraftId) return [];
				const mapped = { ...comment, draftId: mappedDraftId };
				const identity = commentIdentity(mapped);
				// Deduplicate on the complete row, including the mapped draft and
				// the anchor, so a colliding ID cannot suppress another review.
				if (admittedComments.has(identity)) return [];
				admittedComments.add(identity);
				const id = commentIds.has(mapped.id) ? newId() : mapped.id;
				commentIds.add(id);
				return [{ ...mapped, id }];
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
				// Apply the project ID remap before deduplication so an imported
				// snippet follows its restored project after an ID collision.
				const mappedProjectId = snippet.projectId
					? (projectPlan.projectIdMap.get(snippet.projectId) ?? snippet.projectId)
					: undefined;
				const mapped = {
					...snippet,
					...(mappedProjectId ? { projectId: mappedProjectId } : {})
				};
				const identical = snippetKeys.has(
					JSON.stringify([
						mapped.title,
						mapped.code,
						mapped.language,
						mapped.tags.join('\0'),
						mapped.folder,
						mapped.projectId,
						mapped.favorite,
						mapped.createdAt,
						mapped.updatedAt
					])
				);
				if (identical) return [];
				return [{ ...mapped, id: snippetIds.has(mapped.id) ? newId() : mapped.id }];
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
 * Builds the backup and triggers its download. If `passphrase` is
 * provided (§2.8), the content is encrypted (AES-GCM) and the file is unreadable
 * without the passphrase.
 *
 * @returns `false` if the desktop save dialog was cancelled (no success toast).
 */
export interface BackupExportOptions {
	signal?: AbortSignal | undefined;
	onProgress?: ExportProgressReporter | undefined;
}

export async function downloadBackup(
	passphrase?: string,
	ensureDurable: () => Promise<void> = ensureLiveDraftsDurable,
	options: BackupExportOptions = {}
): Promise<boolean> {
	if (typeof document === 'undefined') return false;
	const run = new ExportPipelineRun('backup');
	try {
		await ensureDurable();
		checkAborted(options.signal);
		const now = Date.now();
		// The collection validates every row, every limit and the complete
		// generated shape. A second full validation pass would repeat that work
		// on the same object. Imported text still goes through
		// `parseBackupWithReport` (untrusted input).
		const backup = await collectBackup(now, {
			signal: options.signal,
			onProgress: options.onProgress,
			run
		});
		const chunks = await serializeBackupBounded(backup, {
			signal: options.signal,
			onProgress: options.onProgress,
			run
		});
		assertBackupChunksSize(chunks);
		const stamp = new Date(now).toISOString().slice(0, 10);
		if (passphrase) {
			// AES-GCM takes one contiguous plaintext buffer. The joined copy is
			// measured and stays bounded by the 64 MiB backup limit.
			const json = chunks.join('');
			run.noteJoinedCopy(json.length);
			assertBackupTextSize(json);
			run.beginPhase('encrypt');
			const envelope = await encryptString(json, passphrase);
			const encrypted = JSON.stringify(envelope);
			assertBackupTextSize(encrypted);
			run.endPhase();
			run.noteProgress(100);
			run.finish('completed');
			const blob = new Blob([encrypted], { type: 'application/json;charset=utf-8' });
			return triggerDownload(blob, `deckmark-backup-${stamp}.encrypted.json`);
		}
		run.noteProgress(100);
		run.finish('completed');
		const blob = new Blob(chunks, { type: 'application/json;charset=utf-8' });
		return triggerDownload(blob, `deckmark-backup-${stamp}.json`);
	} catch (error) {
		run.finish(isAbortError(error) ? 'cancelled' : 'failed');
		throw error;
	}
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

/** Rejects a generated JSON text over the backup limit before any output. */
function assertBackupChunksSize(chunks: readonly string[]): void {
	const encoder = new TextEncoder();
	let bytes = 0;
	for (const chunk of chunks) {
		bytes += encoder.encode(chunk).byteLength;
		if (bytes > IMPORT_LIMITS.maxBatchBytes) throw new BackupParseError(t('backup.fileTooLarge'));
	}
}

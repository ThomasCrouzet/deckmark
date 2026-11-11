import { browser } from '$app/env';

import { db, newId, type DraftRow, type ProjectAssetRow, type ProjectRow } from './db';

import { diskConflictStore } from './disk-conflict.svelte';
import { isDesktop } from './desktop';
import { filesStore } from './files.svelte';
import { importProject } from './projects';
import type { ProjectInput } from './project-archive';
import { pathKey, projectPath, projectWikiCandidates, relativeDestination } from './project-paths';
import { documentKindForFile } from './document-kind';
import { renameProjectLinks } from './project-links';
import { normalizeRename } from './file-utils';
import { rewriteWikiLinkTargets } from './wiki-links';
import { notify } from './notify.svelte';
import { t } from './i18n';
import { reportError } from './report';
import {
	removeProjectRenameJournal,
	updateProjectRenameStage,
	writeProjectRenameJournal
} from './project-rename-journal';
import {
	manifestNativeProject,
	openNativeProject,
	pickNativeProject,
	readNativeProjectEntry,
	refreshNativeProject,
	renameNativeProjectEntry,
	revokeNativeProject,
	writeNativeProjectAsset,
	writeNativeProjectText,
	type NativeProjectAssetEntry,
	type NativeProjectEntry,
	type NativeProjectManifestEntry,
	type NativeProjectMarkdownEntry,
	type NativeProjectSnapshot
} from './project-tauri';
import type { FileItem } from './types';
import { createCheckpoint } from './version-history';
import { recoverPendingProjectRenames } from './project-rename-recovery';

const BASELINE_PREFIX = 'project-native-revisions:';

interface NativeSession {
	rootId: string;
	token: string;
}

export interface NativeProjectFailure {
	path: string;
	operation: 'open' | 'refresh' | 'save' | 'disconnect';
	message: string;
}

export interface NativeProjectMissingEntry {
	/** Project-relative path of the local entry that has no disk file. */
	path: string;
	kind: 'markdown' | 'asset';
	/** Disk revision recorded before the removal. */
	revision: string;
	/** The user chose to keep the local copy without a disk file. */
	localOnly: boolean;
}

export interface NativeProjectReport {
	succeeded: string[];
	failed: NativeProjectFailure[];
	missing: NativeProjectMissingEntry[];
}

export class NativeProjectOperationError extends Error {
	constructor(
		message: string,
		readonly report: NativeProjectReport
	) {
		super(message);
		this.name = 'NativeProjectOperationError';
	}
}

export interface NativeRenameReceipt {
	rollback(): Promise<void>;
	commit(): Promise<void>;
}

const sessions = new Map<string, NativeSession>();
const operationTails = new Map<string, Promise<void>>();

async function withCrossTabLock<T>(projectId: string, run: () => Promise<T>): Promise<T> {
	if (typeof navigator !== 'undefined' && navigator.locks?.request) {
		return navigator.locks.request(`mdsh:native-project:${projectId}`, run);
	}
	return run();
}

function runProjectOperation<T>(projectId: string, run: () => Promise<T>): Promise<T> {
	const previous = operationTails.get(projectId) ?? Promise.resolve();
	const operation = previous.catch(() => {}).then(() => withCrossTabLock(projectId, run));
	const settled = operation.then(
		() => {},
		() => {}
	);
	operationTails.set(projectId, settled);
	void settled.then(() => {
		if (operationTails.get(projectId) === settled) operationTails.delete(projectId);
	});
	return operation;
}

function reserveProjectRename(
	projectId: string,
	run: () => Promise<NativeRenameReceipt>
): Promise<NativeRenameReceipt> {
	let release!: () => void;
	const hold = new Promise<void>((resolve) => (release = resolve));
	let resolveReady!: (receipt: NativeRenameReceipt) => void;
	let rejectReady!: (error: unknown) => void;
	const ready = new Promise<NativeRenameReceipt>((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});
	const previous = operationTails.get(projectId) ?? Promise.resolve();
	const operation = previous
		.catch(() => {})
		.then(() =>
			withCrossTabLock(projectId, async () => {
				try {
					const receipt = await run();
					let finished = false;
					let released = false;
					const releaseOnce = () => {
						if (released) return;
						released = true;
						release();
					};
					const finish = async (action: () => Promise<void>) => {
						if (finished) return;
						try {
							await action();
							finished = true;
						} finally {
							releaseOnce();
						}
					};
					resolveReady({
						rollback: () => finish(receipt.rollback),
						commit: () => finish(receipt.commit)
					});
					await hold;
				} catch (error) {
					rejectReady(error);
					release();
					throw error;
				}
			})
		);
	const settled = operation.then(
		() => {},
		() => {}
	);
	operationTails.set(projectId, settled);
	void settled.then(() => {
		if (operationTails.get(projectId) === settled) operationTails.delete(projectId);
	});
	return ready;
}

export function nativeProjectsAvailable(): boolean {
	return isDesktop();
}

function baselineKey(projectId: string): string {
	return `${BASELINE_PREFIX}${projectId}`;
}

async function loadBaseline(projectId: string): Promise<Record<string, string>> {
	const row = await db.metadata.get(baselineKey(projectId));
	if (!row) return {};
	try {
		const parsed: unknown = JSON.parse(row.value);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
		return Object.fromEntries(
			Object.entries(parsed).filter(
				(entry): entry is [string, string] => typeof entry[1] === 'string'
			)
		);
	} catch {
		return {};
	}
}

async function storeBaseline(projectId: string, baseline: Record<string, string>): Promise<void> {
	await db.metadata.put({ key: baselineKey(projectId), value: JSON.stringify(baseline) });
}

const MANIFEST_PREFIX = 'project-native-manifest:';
const MISSING_PREFIX = 'project-native-missing:';

interface StoredManifestEntry extends NativeProjectManifestEntry {
	revision: string;
}

interface StoredMissingEntry extends NativeProjectMissingEntry {
	detectedAt: number;
}

interface DiskEntry extends NativeProjectManifestEntry {
	revision: string;
	mime?: string;
	content?: string;
	bytes?: Uint8Array;
}

interface DiskDelta {
	entries: Map<string, DiskEntry>;
	changed: NativeProjectEntry[];
	removed: StoredManifestEntry[];
	stored: Map<string, StoredManifestEntry>;
}

function manifestKey(projectId: string): string {
	return `${MANIFEST_PREFIX}${projectId}`;
}

function missingKey(projectId: string): string {
	return `${MISSING_PREFIX}${projectId}`;
}

function publicMissing(entries: Iterable<StoredMissingEntry>): NativeProjectMissingEntry[] {
	return [...entries]
		.map((entry) => ({
			path: entry.path,
			kind: entry.kind,
			revision: entry.revision,
			localOnly: entry.localOnly
		}))
		.sort((left, right) => left.path.localeCompare(right.path));
}

async function loadMissing(projectId: string): Promise<Map<string, StoredMissingEntry>> {
	const result = new Map<string, StoredMissingEntry>();
	const row = await db.metadata.get(missingKey(projectId));
	if (!row) return result;
	try {
		const parsed: unknown = JSON.parse(row.value);
		if (!Array.isArray(parsed)) return result;
		for (const value of parsed) {
			if (!value || typeof value !== 'object') continue;
			const entry = value as Record<string, unknown>;
			if (typeof entry.path !== 'string' || (entry.kind !== 'markdown' && entry.kind !== 'asset')) {
				continue;
			}
			const path = projectPath(entry.path);
			result.set(pathKey(path), {
				path,
				kind: entry.kind,
				revision: typeof entry.revision === 'string' ? entry.revision : '',
				localOnly: entry.localOnly === true,
				detectedAt:
					typeof entry.detectedAt === 'number' && Number.isFinite(entry.detectedAt)
						? entry.detectedAt
						: Date.now()
			});
		}
	} catch {
		/* A malformed review record must not grant or discard local bytes. */
	}
	return result;
}

async function storeMissing(
	projectId: string,
	entries: Iterable<StoredMissingEntry>
): Promise<void> {
	const value = JSON.stringify(
		[...entries].sort((left, right) => left.path.localeCompare(right.path))
	);
	await db.metadata.put({ key: missingKey(projectId), value });
}

function manifestOf(entries: Iterable<StoredManifestEntry>): string {
	return JSON.stringify(
		[...entries]
			.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
			.map((entry) => ({
				kind: entry.kind,
				relativePath: entry.relativePath,
				mtimeMs: entry.mtimeMs,
				size: entry.size,
				first: entry.first,
				second: entry.second,
				revision: entry.revision
			}))
	);
}

function storedEntry(entry: NativeProjectManifestEntry, revision: string): StoredManifestEntry {
	return {
		kind: entry.kind,
		relativePath: entry.relativePath,
		mtimeMs: entry.mtimeMs,
		size: entry.size,
		first: entry.first,
		second: entry.second,
		revision
	};
}

async function loadManifest(projectId: string): Promise<Map<string, StoredManifestEntry> | null> {
	const row = await db.metadata.get(manifestKey(projectId));
	if (!row) return null;
	try {
		const parsed: unknown = JSON.parse(row.value);
		if (!Array.isArray(parsed)) return null;
		const entries = new Map<string, StoredManifestEntry>();
		for (const value of parsed) {
			if (!value || typeof value !== 'object') return null;
			const entry = value as Record<string, unknown>;
			const kind = entry.kind === 'asset' ? 'asset' : entry.kind === 'markdown' ? 'markdown' : null;
			if (
				!kind ||
				typeof entry.relativePath !== 'string' ||
				typeof entry.mtimeMs !== 'number' ||
				typeof entry.size !== 'number'
			)
				return null;
			entries.set(entry.relativePath, {
				kind,
				relativePath: entry.relativePath,
				mtimeMs: entry.mtimeMs,
				size: entry.size,
				first: typeof entry.first === 'number' ? entry.first : -1,
				second: typeof entry.second === 'number' ? entry.second : -1,
				revision: typeof entry.revision === 'string' ? entry.revision : ''
			});
		}
		return entries;
	} catch {
		return null;
	}
}

async function storeManifest(
	projectId: string,
	entries: Iterable<StoredManifestEntry>
): Promise<void> {
	await db.metadata.put({ key: manifestKey(projectId), value: manifestOf(entries) });
}

async function loadDiskDelta(
	projectId: string,
	session: NativeSession,
	authoritative = false
): Promise<DiskDelta> {
	const manifest = await manifestNativeProject(session.token, authoritative);
	const stored = (await loadManifest(projectId)) ?? new Map<string, StoredManifestEntry>();
	const current = new Set(manifest.entries.map((entry) => pathKey(entry.relativePath)));
	const currentRaw = new Set(manifest.entries.map((entry) => entry.relativePath));
	// A case-only rename on a case-insensitive file system keeps the path key.
	// Drop the stale raw key so the manifest holds one spelling of the path.
	for (const relativePath of [...stored.keys()]) {
		if (!currentRaw.has(relativePath) && current.has(pathKey(relativePath))) {
			stored.delete(relativePath);
		}
	}
	const entries = new Map<string, DiskEntry>();
	const changed: NativeProjectEntry[] = [];
	const now = Date.now();
	for (const entry of manifest.entries) {
		const previous = stored.get(entry.relativePath);
		const key = pathKey(entry.relativePath);
		if (!shouldReadProjectEntry(previous, entry, now, authoritative)) {
			entries.set(key, { ...entry, revision: entry.revision ?? previous!.revision });
			continue;
		}
		const fresh = await readNativeProjectEntry(session.token, entry.relativePath);
		changed.push(fresh);
		entries.set(key, { ...entry, ...fresh });
	}
	const removed = [...stored.values()].filter((entry) => !current.has(pathKey(entry.relativePath)));
	for (const entry of removed) stored.delete(entry.relativePath);
	return { entries, changed, removed, stored };
}

function revisions(snapshot: NativeProjectSnapshot): Record<string, string> {
	return Object.fromEntries(
		snapshot.entries.map((entry) => [projectPath(entry.relativePath), entry.revision])
	);
}

function manifestFromSnapshot(snapshot: NativeProjectSnapshot): StoredManifestEntry[] {
	return snapshot.entries.map((entry) => storedEntry(entry, entry.revision));
}

function projectInput(snapshot: NativeProjectSnapshot): ProjectInput {
	return {
		name: snapshot.name,
		documents: snapshot.entries
			.filter((entry): entry is NativeProjectMarkdownEntry => entry.kind === 'markdown')
			.map((entry) => ({ relativePath: projectPath(entry.relativePath), content: entry.content })),
		assets: snapshot.entries
			.filter((entry): entry is NativeProjectAssetEntry => entry.kind === 'asset')
			.map((entry) => ({
				path: projectPath(entry.relativePath),
				mime: entry.mime,
				data: entry.bytes
			}))
	};
}

async function sha256(bytes: Uint8Array): Promise<string> {
	if (!globalThis.crypto?.subtle) throw new Error('Content hashing is not available');
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
	return `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function textBytes(content: string): Uint8Array {
	return new TextEncoder().encode(content);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function dataUrl(mime: string, bytes: Uint8Array): string {
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += 32_768) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
	}
	return `data:${mime};base64,${btoa(binary)}`;
}

async function projectRow(projectId: string): Promise<ProjectRow> {
	const project = await db.projects.get(projectId);
	if (!project) throw new Error('Project no longer exists');
	return project;
}

async function ensureSession(projectId: string): Promise<NativeSession> {
	const project = await projectRow(projectId);
	if (!project.nativeRootId) throw new Error('Project has no native directory');
	const current = sessions.get(projectId);
	if (current?.rootId === project.nativeRootId) return current;
	const snapshot = await openNativeProject(project.nativeRootId);
	const session = { rootId: snapshot.rootId, token: snapshot.token };
	sessions.set(projectId, session);
	return session;
}

async function currentSnapshot(projectId: string): Promise<NativeProjectSnapshot> {
	const session = await ensureSession(projectId);
	try {
		return await refreshNativeProject(session.token);
	} catch (error) {
		sessions.delete(projectId);
		const project = await projectRow(projectId);
		if (!project.nativeRootId) throw error;
		const snapshot = await openNativeProject(project.nativeRootId);
		sessions.set(projectId, { rootId: snapshot.rootId, token: snapshot.token });
		return snapshot;
	}
}

export async function pickAndImportNativeProject(): Promise<ProjectRow | null> {
	if (!browser || !nativeProjectsAvailable()) return null;
	const snapshot = await pickNativeProject();
	if (!snapshot) return null;
	const linked = await db.projects
		.filter((project) => project.nativeRootId === snapshot.rootId)
		.first();
	if (linked) {
		sessions.set(linked.id, { rootId: snapshot.rootId, token: snapshot.token });
		await refreshNativeProjectFromDisk(linked.id, snapshot);
		return linked;
	}
	try {
		const imported = await importProject(projectInput(snapshot));
		const linkedProject = { ...imported, nativeRootId: snapshot.rootId, updatedAt: Date.now() };
		await db.projects.put(linkedProject);
		await storeBaseline(imported.id, revisions(snapshot));
		await storeManifest(imported.id, manifestFromSnapshot(snapshot));
		sessions.set(imported.id, { rootId: snapshot.rootId, token: snapshot.token });
		return linkedProject;
	} catch (error) {
		await revokeNativeProject(snapshot.token).catch(() => {});
		throw error;
	}
}

export async function openNativeProjectConnection(projectId: string): Promise<boolean> {
	if (!browser || !nativeProjectsAvailable()) return false;
	await ensureSession(projectId);
	return true;
}

export async function reopenNativeProjects(): Promise<NativeProjectFailure[]> {
	if (!browser || !nativeProjectsAvailable()) return [];
	const linked = await db.projects.filter((project) => !!project.nativeRootId).toArray();
	const failed: NativeProjectFailure[] = [];
	for (const project of linked) {
		try {
			await ensureSession(project.id);
		} catch (error) {
			failed.push({
				path: project.name,
				operation: 'open',
				message: String(error)
			});
		}
	}
	try {
		failed.push(
			...(await recoverPendingProjectRenames((id) => refreshNativeProjectFromDiskInternal(id)))
		);
	} catch {
		/* Recovery stays best effort. The journal remains for the next start. */
	}
	return failed;
}

function expectedFile(file: FileItem) {
	return {
		content: file.content,
		...(file.relativePath === undefined ? {} : { relativePath: file.relativePath }),
		updatedAt: file.updatedAt
	};
}

function fileMatchesRow(file: FileItem | undefined, row: DraftRow): boolean {
	return (
		!!file &&
		file.id === row.id &&
		file.projectId === row.projectId &&
		file.relativePath === row.relativePath &&
		file.content === row.content &&
		file.updatedAt === row.updatedAt
	);
}

async function applyDocument(
	row: DraftRow,
	entry: NativeProjectMarkdownEntry,
	checkpoint: boolean
): Promise<void> {
	const memory = filesStore.library.find((file) => file.id === row.id);
	if (!fileMatchesRow(memory, row)) {
		throw new Error('Local document changed during native refresh');
	}
	const expected = expectedFile(memory!);
	const next = await db.transaction('rw', db.drafts, db.versions, async () => {
		const durable = await db.drafts.get(row.id);
		if (
			!durable ||
			durable.content !== row.content ||
			durable.relativePath !== row.relativePath ||
			durable.updatedAt !== row.updatedAt
		) {
			throw new Error('Durable document changed during native refresh');
		}
		if (checkpoint) await createCheckpoint({ id: row.id, name: row.name, content: row.content });
		const updated: DraftRow = { ...durable, content: entry.content, updatedAt: Date.now() };
		await db.drafts.put(updated);
		return updated;
	});
	const applied = filesStore.acceptProjectRows([next], new Map([[row.id, expected]]));
	if (!applied.includes(row.id)) throw new Error('Local document changed during native commit');
	const current = filesStore.library.find((file) => file.id === row.id);
	if (current) current.dirty = false;
}

type LocalEntry = { kind: 'markdown'; row: DraftRow } | { kind: 'asset'; row: ProjectAssetRow };

interface IndexedLocalEntry {
	kind: 'markdown' | 'asset';
	relativePath: string;
	id?: string;
}

/**
 * Compact path index built from compound index keys. It avoids loading document
 * bodies or binary asset rows for a scan that only needs path identity.
 */
interface LocalProjectIndex {
	entries: Map<string, IndexedLocalEntry>;
	paths: Set<string>;
}

async function loadLocalProjectIndex(projectId: string): Promise<LocalProjectIndex> {
	const entries = new Map<string, IndexedLocalEntry>();
	const paths = new Set<string>();
	const collect = async (
		table: typeof db.drafts | typeof db.projectAssets,
		index: '[projectId+relativePath]' | '[projectId+path]',
		kind: 'markdown' | 'asset'
	): Promise<void> => {
		const keys = await table.where(index).between([projectId, ''], [projectId, '\uffff']).keys();
		for (const key of keys) {
			const relativePath = String(Array.isArray(key) ? key[1] : key);
			if (!relativePath) continue;
			const path = pathKey(relativePath);
			paths.add(path);
			entries.set(path, { kind, relativePath });
		}
	};
	await collect(db.drafts, '[projectId+relativePath]', 'markdown');
	await collect(db.projectAssets, '[projectId+path]', 'asset');
	return { entries, paths };
}

async function localEntryId(
	projectId: string,
	entry: IndexedLocalEntry
): Promise<string | undefined> {
	if (entry.id) return entry.id;
	const ids =
		entry.kind === 'markdown'
			? await db.drafts
					.where('[projectId+relativePath]')
					.equals([projectId, entry.relativePath])
					.primaryKeys()
			: await db.projectAssets
					.where('[projectId+path]')
					.equals([projectId, entry.relativePath])
					.primaryKeys();
	const id = ids[0];
	if (id) entry.id = id;
	return entry.id;
}

/** Load one matched row, hydrating its deferred body only when it is needed. */
async function loadLocalEntry(
	projectId: string,
	entry: IndexedLocalEntry
): Promise<LocalEntry | undefined> {
	const id = await localEntryId(projectId, entry);
	if (!id) return undefined;
	if (entry.kind === 'markdown') {
		await filesStore.ensureContent([id]);
		const row = await db.drafts.get(id);
		return row ? { kind: 'markdown', row } : undefined;
	}
	const row = await db.projectAssets.get(id);
	return row ? { kind: 'asset', row } : undefined;
}

async function addDiskEntry(
	projectId: string,
	entry: NativeProjectEntry,
	index: LocalProjectIndex
): Promise<void> {
	const now = Date.now();
	const key = pathKey(entry.relativePath);
	if (index.paths.has(key)) throw new Error('Project path already exists');
	if (entry.kind === 'markdown') {
		const row: DraftRow = {
			id: newId(),
			name: entry.relativePath.split('/').pop()!,
			content: entry.content,
			projectId,
			relativePath: projectPath(entry.relativePath),
			createdAt: now,
			updatedAt: now,
			order: filesStore.library.length,
			open: false
		};
		await db.transaction('rw', db.projects, db.drafts, db.projectAssets, async () => {
			if (!(await db.projects.get(projectId))) throw new Error('Project no longer exists');
			const duplicate = await db.drafts
				.where('[projectId+relativePath]')
				.equals([projectId, row.relativePath!])
				.count();
			if (duplicate) throw new Error('Project path already exists');
			await db.drafts.add(row);
		});
		index.paths.add(key);
		index.entries.set(key, { kind: 'markdown', relativePath: row.relativePath!, id: row.id });
		filesStore.acceptProjectRows([row]);
		return;
	}
	const row: ProjectAssetRow = {
		id: newId(),
		projectId,
		path: projectPath(entry.relativePath),
		mime: entry.mime,
		data: entry.bytes
	};
	await db.transaction('rw', db.projects, db.drafts, db.projectAssets, async () => {
		if (!(await db.projects.get(projectId))) throw new Error('Project no longer exists');
		const duplicate = await db.projectAssets
			.where('[projectId+path]')
			.equals([projectId, row.path])
			.count();
		if (duplicate) throw new Error('Project path already exists');
		await db.projectAssets.add(row);
	});
	index.paths.add(key);
	index.entries.set(key, { kind: 'asset', relativePath: row.path, id: row.id });
}

/**
 * Batched baseline changes. Unchanged entries write nothing. A large operation
 * flushes at most once per 128 changes, so a crash loses only the re-detectable
 * tail instead of serializing the full map once per entry.
 */
class BaselineChanges {
	private changes = 0;

	constructor(
		private readonly projectId: string,
		readonly values: Record<string, string>
	) {}

	set(path: string, revision: string): void {
		if (this.values[path] === revision) return;
		this.values[path] = revision;
		this.changes += 1;
	}

	remove(path: string): void {
		if (!(path in this.values)) return;
		delete this.values[path];
		this.changes += 1;
	}

	move(from: string, to: string, revision: string): void {
		for (const key of Object.keys(this.values)) {
			if (key !== to && pathKey(key) === pathKey(from)) this.remove(key);
		}
		this.set(to, revision);
	}

	async flush(force = false): Promise<void> {
		if (this.changes === 0) return;
		if (!force && this.changes < 128) return;
		await storeBaseline(this.projectId, this.values);
		this.changes = 0;
	}
}

async function applyAsset(row: ProjectAssetRow, entry: NativeProjectAssetEntry): Promise<void> {
	await db.transaction('rw', db.projectAssets, async () => {
		const durable = await db.projectAssets.get(row.id);
		if (!durable || !bytesEqual(durable.data, row.data) || durable.path !== row.path) {
			throw new Error('Local asset changed during native refresh');
		}
		await db.projectAssets.put({ ...durable, mime: entry.mime, data: entry.bytes });
	});
	const { invalidateProjectMediaCache } = await import('./project-media');
	invalidateProjectMediaCache();
}

async function preserveAssetConflict(
	row: ProjectAssetRow,
	mime: string,
	data: Uint8Array,
	label: 'local' | 'disk'
): Promise<string> {
	return db.transaction('rw', db.drafts, db.projectAssets, async () => {
		const [documents, assets] = await Promise.all([
			db.drafts.where('projectId').equals(row.projectId).toArray(),
			db.projectAssets.where('projectId').equals(row.projectId).toArray()
		]);
		const used = new Set(
			[...documents.map((item) => item.relativePath!), ...assets.map((item) => item.path)].map(
				pathKey
			)
		);
		const parts = row.path.split('/');
		const filename = parts.pop()!;
		const dot = filename.lastIndexOf('.');
		const stem = dot > 0 ? filename.slice(0, dot) : filename;
		const extension = dot > 0 ? filename.slice(dot) : '';
		let suffix = 1;
		let path: string;
		do {
			path = projectPath([...parts, `${stem}.${label}-conflict-${suffix++}${extension}`].join('/'));
		} while (used.has(pathKey(path)));
		await db.projectAssets.add({ id: newId(), projectId: row.projectId, path, mime, data });
		return path;
	});
}

async function resolveDocumentConflict(
	token: string,
	row: DraftRow,
	disk: DiskEntry,
	baseline: BaselineChanges
): Promise<'resolved' | 'cancelled'> {
	const freshDisk = await readNativeProjectEntry(token, disk.relativePath);
	if (freshDisk.kind !== 'markdown' || freshDisk.revision !== disk.revision) {
		throw new Error('Disk document changed during conflict review');
	}
	const resolution = await diskConflictStore.resolve({
		name: row.relativePath ?? row.name,
		localContent: row.content,
		diskContent: freshDisk.content
	});
	if (resolution === 'cancel') return 'cancelled';
	if (resolution === 'reload') {
		await createCheckpoint({ id: row.id, name: row.name, content: row.content });
		const fresh = await readNativeProjectEntry(token, disk.relativePath);
		if (fresh.kind !== 'markdown' || fresh.revision !== freshDisk.revision) {
			throw new Error('Disk document changed during conflict review');
		}
		await applyDocument(row, fresh, false);
		baseline.set(row.relativePath!, fresh.revision);
		return 'resolved';
	}
	await createCheckpoint({ id: row.id, name: row.name, content: freshDisk.content });
	const current = filesStore.library.find((file) => file.id === row.id);
	if (!fileMatchesRow(current, row)) {
		throw new Error('Local document changed during conflict review');
	}
	const expected = expectedFile(current!);
	const written = await writeNativeProjectText(
		token,
		row.relativePath!,
		row.content,
		freshDisk.revision
	);
	baseline.set(row.relativePath!, written.revision);
	const after = filesStore.library.find((file) => file.id === row.id);
	if (
		after &&
		after.content === expected.content &&
		after.relativePath === expected.relativePath &&
		after.updatedAt === expected.updatedAt
	)
		after.dirty = false;
	return 'resolved';
}

async function resolveAssetConflict(
	token: string,
	row: ProjectAssetRow,
	disk: DiskEntry,
	baseline: BaselineChanges
): Promise<'resolved' | 'cancelled'> {
	const freshDisk = await readNativeProjectEntry(token, disk.relativePath);
	if (freshDisk.kind !== 'asset' || freshDisk.revision !== disk.revision) {
		throw new Error('Disk asset changed during conflict review');
	}
	const mime = freshDisk.mime;
	const resolution = await diskConflictStore.resolve({
		name: row.path,
		localContent: dataUrl(row.mime, row.data),
		diskContent: dataUrl(mime, freshDisk.bytes)
	});
	if (resolution === 'cancel') return 'cancelled';
	if (resolution === 'reload') {
		await preserveAssetConflict(row, row.mime, row.data, 'local');
		const fresh = await readNativeProjectEntry(token, disk.relativePath);
		if (fresh.kind !== 'asset' || fresh.revision !== freshDisk.revision) {
			throw new Error('Disk asset changed during conflict review');
		}
		await applyAsset(row, fresh);
		baseline.set(row.path, fresh.revision);
		return 'resolved';
	}
	const current = await db.projectAssets.get(row.id);
	if (
		!current ||
		current.path !== row.path ||
		current.mime !== row.mime ||
		!bytesEqual(current.data, row.data)
	) {
		throw new Error('Local asset changed during conflict review');
	}
	await preserveAssetConflict(row, mime, freshDisk.bytes, 'disk');
	const written = await writeNativeProjectAsset(token, row.path, row.data, freshDisk.revision);
	baseline.set(row.path, written.revision);
	return 'resolved';
}

/** Adopt the on-disk spelling of a path that only changed letter case. */
async function moveLocalEntryPath(known: LocalEntry, path: string): Promise<void> {
	if (known.kind === 'markdown') {
		if (known.row.relativePath === path) return;
		const memory = filesStore.library.find((file) => file.id === known.row.id);
		if (!fileMatchesRow(memory, known.row)) {
			throw new Error('Local document changed during native refresh');
		}
		const durable = await db.drafts.get(known.row.id);
		if (
			!durable ||
			durable.content !== known.row.content ||
			durable.relativePath !== known.row.relativePath ||
			durable.updatedAt !== known.row.updatedAt
		) {
			throw new Error('Durable document changed during native refresh');
		}
		const updated: DraftRow = {
			...known.row,
			relativePath: path,
			name: path.split('/').pop()!,
			updatedAt: Date.now()
		};
		await db.drafts.put(updated);
		known.row = updated;
		filesStore.acceptProjectRows([updated]);
		const current = filesStore.library.find((file) => file.id === updated.id);
		if (current) current.dirty = false;
		return;
	}
	if (known.row.path === path) return;
	const durable = await db.projectAssets.get(known.row.id);
	if (!durable || durable.path !== known.row.path || !bytesEqual(durable.data, known.row.data)) {
		throw new Error('Local asset changed during native refresh');
	}
	const updated: ProjectAssetRow = { ...known.row, path };
	await db.projectAssets.put(updated);
	known.row = updated;
	const { invalidateProjectMediaCache } = await import('./project-media');
	invalidateProjectMediaCache();
}

/**
 * A removed path and an added path with the same kind and exact revision are
 * one external rename. Pair them only when the match is unambiguous, and only
 * for a clean local copy. A dirty local copy keeps both sides so no edit is
 * lost.
 */
function pairExternalRenames(
	removed: readonly StoredManifestEntry[],
	changed: readonly NativeProjectEntry[],
	local: LocalProjectIndex
): Map<string, StoredManifestEntry> {
	const sources = new Map<string, StoredManifestEntry[]>();
	for (const entry of removed) {
		const key = `${entry.kind}:${entry.revision}`;
		const list = sources.get(key) ?? [];
		list.push(entry);
		sources.set(key, list);
	}
	const targets = new Map<string, NativeProjectEntry[]>();
	for (const entry of changed) {
		if (local.paths.has(pathKey(entry.relativePath))) continue;
		const key = `${entry.kind}:${entry.revision}`;
		const list = targets.get(key) ?? [];
		list.push(entry);
		targets.set(key, list);
	}
	const pairs = new Map<string, StoredManifestEntry>();
	for (const [key, list] of targets) {
		const source = sources.get(key);
		if (list.length === 1 && source?.length === 1) {
			pairs.set(pathKey(list[0]!.relativePath), source[0]!);
		}
	}
	return pairs;
}

async function refreshNativeProjectFromDiskInternal(
	projectId: string,
	providedSnapshot?: NativeProjectSnapshot,
	authoritative = false
): Promise<NativeProjectReport> {
	await filesStore.flushPendingAwait();
	const session = await ensureSession(projectId);
	let delta: DiskDelta;
	if (providedSnapshot) {
		const entries = new Map<string, DiskEntry>();
		const stored = new Map<string, StoredManifestEntry>();
		for (const entry of providedSnapshot.entries) {
			const key = pathKey(entry.relativePath);
			entries.set(key, { ...entry });
			stored.set(entry.relativePath, storedEntry(entry, entry.revision));
		}
		delta = {
			entries,
			changed: providedSnapshot.entries,
			removed: [],
			stored
		};
	} else {
		delta = await loadDiskDelta(projectId, session, authoritative);
	}
	const remember = (entry: NativeProjectEntry, revision: string): void => {
		delta.stored.set(entry.relativePath, storedEntry(entry, revision));
	};
	const baseline = new BaselineChanges(projectId, await loadBaseline(projectId));
	// Path identity comes from compound index keys. A no-change refresh does not
	// load a single document body or binary asset row.
	const local = await loadLocalProjectIndex(projectId);

	// A path that exists on disk again was restored outside DeckMark. Its local
	// bytes are already present, so the missing review can close.
	const missing = await loadMissing(projectId);
	let missingChanged = false;
	for (const key of [...missing.keys()]) {
		// The disk file or the local row can disappear while the review waits.
		if (delta.entries.has(key) || !local.paths.has(key)) {
			missing.delete(key);
			missingChanged = true;
		}
	}
	// Every removed path with a local row stays visible until the user reviews
	// it. The manifest drops the disk path, but this record preserves the
	// baseline revision and the retry state across restarts.
	for (const entry of delta.removed) {
		const key = pathKey(entry.relativePath);
		if (!local.paths.has(key)) continue;
		const previous = missing.get(key);
		missing.set(key, {
			path: projectPath(entry.relativePath),
			kind: entry.kind,
			revision: entry.revision,
			localOnly: previous?.localOnly === true,
			detectedAt: previous?.detectedAt ?? Date.now()
		});
		missingChanged = true;
	}
	const renames = pairExternalRenames(delta.removed, delta.changed, local);
	if (missingChanged) await storeMissing(projectId, missing.values());

	// Two disk entries that fold to one path cannot both become project rows.
	// Reject every member of the collision before the first one can enter the
	// local index for this refresh.
	const duplicateKeys = new Set<string>();
	const seenKeys = new Set<string>();
	for (const entry of delta.changed) {
		const key = pathKey(entry.relativePath);
		if (seenKeys.has(key)) duplicateKeys.add(key);
		seenKeys.add(key);
	}
	const report: NativeProjectReport = {
		succeeded: [],
		failed: [],
		missing: []
	};
	if (!delta.changed.length && !delta.removed.length) {
		// The stored manifest already matches the verified disk state. A quiet
		// refresh writes no manifest and no baseline.
		report.missing = publicMissing(missing.values());
		return report;
	}
	for (const entry of delta.changed) {
		const path = projectPath(entry.relativePath);
		const key = pathKey(path);
		try {
			if (duplicateKeys.has(key)) throw new Error('Project path already exists');
			const indexed = local.entries.get(key);
			const known = indexed ? await loadLocalEntry(projectId, indexed) : undefined;
			if (!known) {
				const source = renames.get(key);
				const sourceKey = source ? pathKey(source.relativePath) : null;
				const sourceEntry = sourceKey ? local.entries.get(sourceKey) : undefined;
				const candidate = sourceEntry ? await loadLocalEntry(projectId, sourceEntry) : undefined;
				if (source && candidate) {
					const candidateRevision =
						candidate.kind === 'markdown'
							? await sha256(textBytes(candidate.row.content))
							: await sha256(candidate.row.data);
					if (candidateRevision === entry.revision && candidate.kind === entry.kind) {
						await moveLocalEntryPath(candidate, path);
						baseline.move(projectPath(source.relativePath), path, entry.revision);
						remember(entry, entry.revision);
						report.succeeded.push(path);
						if (sourceKey) local.entries.delete(sourceKey);
						if (sourceEntry) {
							sourceEntry.relativePath = path;
							local.entries.set(key, sourceEntry);
						}
						if (missing.delete(pathKey(source.relativePath))) {
							await storeMissing(projectId, missing.values());
						}
						continue;
					}
				}
				await addDiskEntry(projectId, entry, local);
				baseline.set(path, entry.revision);
				remember(entry, entry.revision);
				report.succeeded.push(path);
				continue;
			}
			if (known.kind !== entry.kind) throw new Error('Project entry type changed on disk');
			const localRevision =
				known.kind === 'markdown'
					? await sha256(textBytes(known.row.content))
					: await sha256(known.row.data);
			if (localRevision === entry.revision) {
				if (
					(known.kind === 'markdown' && known.row.relativePath !== path) ||
					(known.kind === 'asset' && known.row.path !== path)
				) {
					const previousPath = known.kind === 'markdown' ? known.row.relativePath! : known.row.path;
					await moveLocalEntryPath(known, path);
					baseline.move(previousPath, path, entry.revision);
					if (indexed) indexed.relativePath = path;
				}
				baseline.set(path, entry.revision);
				remember(entry, entry.revision);
				report.succeeded.push(path);
				continue;
			}
			const base = baseline.values[path];
			const localDirty = base ? localRevision !== base : localRevision !== entry.revision;
			const externalChanged = base !== entry.revision;
			if (!externalChanged) {
				remember(entry, entry.revision);
				continue;
			}
			if (!localDirty) {
				const fresh = await readNativeProjectEntry(session.token, path);
				if (fresh.revision !== entry.revision || fresh.kind !== known.kind) {
					throw new Error('Disk entry changed during refresh');
				}
				if (known.kind === 'markdown' && fresh.kind === 'markdown')
					await applyDocument(known.row, fresh, true);
				else if (known.kind === 'asset' && fresh.kind === 'asset')
					await applyAsset(known.row, fresh);
				baseline.set(path, fresh.revision);
				remember(entry, fresh.revision);
				report.succeeded.push(path);
				continue;
			}
			const resolved =
				known.kind === 'markdown' && entry.kind === 'markdown'
					? await resolveDocumentConflict(session.token, known.row, entry, baseline)
					: known.kind === 'asset' && entry.kind === 'asset'
						? await resolveAssetConflict(session.token, known.row, entry, baseline)
						: 'cancelled';
			if (resolved === 'cancelled') throw new Error('Conflict review was cancelled');
			remember(entry, entry.revision);
			report.succeeded.push(path);
		} catch (error) {
			report.failed.push({ path, operation: 'refresh', message: String(error) });
		}
		await baseline.flush();
	}
	await baseline.flush(true);
	await storeManifest(projectId, delta.stored.values()).catch(() => {});
	report.missing = publicMissing(missing.values());
	if (report.failed.length)
		throw new NativeProjectOperationError('Native project refresh failed', report);
	return report;
}

export function refreshNativeProjectFromDisk(
	projectId: string,
	providedSnapshot?: NativeProjectSnapshot,
	options?: { authoritative?: boolean }
): Promise<NativeProjectReport> {
	return runProjectOperation(projectId, () =>
		refreshNativeProjectFromDiskInternal(
			projectId,
			providedSnapshot,
			options?.authoritative === true
		)
	);
}

/** Pending disk removals for a project survive a restart until the user reviews them. */
export async function listNativeProjectMissingEntries(
	projectId: string
): Promise<NativeProjectMissingEntry[]> {
	return publicMissing((await loadMissing(projectId)).values());
}

async function recreateMissingEntry(projectId: string, record: StoredMissingEntry): Promise<void> {
	const session = await ensureSession(projectId);
	const baseline = await loadBaseline(projectId);
	const manifest = (await loadManifest(projectId)) ?? new Map<string, StoredManifestEntry>();
	const path = projectPath(record.path);
	const key = pathKey(path);
	if (record.kind === 'markdown') {
		const row = (await db.drafts.where('projectId').equals(projectId).toArray()).find(
			(entry) => pathKey(entry.relativePath!) === key
		);
		if (!row) throw new Error('Local document is missing');
		const written = await writeNativeProjectText(session.token, path, row.content, null);
		baseline[path] = written.revision;
		await storeBaseline(projectId, baseline);
		manifest.set(path, storedEntry(written, written.revision));
		await storeManifest(projectId, manifest.values());
		const current = filesStore.library.find((file) => file.id === row.id);
		if (current) current.dirty = false;
		return;
	}
	const row = (await db.projectAssets.where('projectId').equals(projectId).toArray()).find(
		(entry) => pathKey(entry.path) === key
	);
	if (!row) throw new Error('Local asset is missing');
	const written = await writeNativeProjectAsset(session.token, path, row.data, null);
	baseline[path] = written.revision;
	await storeBaseline(projectId, baseline);
	manifest.set(path, storedEntry(written, written.revision));
	await storeManifest(projectId, manifest.values());
}

async function resolveMissingEntryInternal(
	projectId: string,
	path: string,
	resolution: 'recreate' | 'retain'
): Promise<NativeProjectMissingEntry[]> {
	const normalized = projectPath(path);
	const key = pathKey(normalized);
	const missing = await loadMissing(projectId);
	const record = missing.get(key);
	if (!record) return publicMissing(missing.values());
	if (resolution === 'retain') {
		missing.set(key, { ...record, localOnly: true });
		await storeMissing(projectId, missing.values());
		return publicMissing(missing.values());
	}
	await recreateMissingEntry(projectId, record);
	missing.delete(key);
	await storeMissing(projectId, missing.values());
	return publicMissing(missing.values());
}

/**
 * Resolve one missing disk path without destroying local bytes.
 * `recreate` writes the exact local bytes back. `retain` keeps the document or
 * asset in the library and stops project saves from recreating it unseen.
 */
export function resolveNativeProjectMissingEntry(
	projectId: string,
	path: string,
	resolution: 'recreate' | 'retain'
): Promise<NativeProjectMissingEntry[]> {
	return runProjectOperation(projectId, () =>
		resolveMissingEntryInternal(projectId, path, resolution)
	);
}

async function reviewMissingDocument(row: DraftRow): Promise<'overwrite' | 'cancelled'> {
	const resolution = await diskConflictStore.resolve({
		name: row.relativePath ?? row.name,
		localContent: row.content,
		diskContent: ''
	});
	if (resolution !== 'overwrite') return 'cancelled';
	await createCheckpoint({ id: row.id, name: row.name, content: '' });
	return 'overwrite';
}

async function reviewMissingAsset(row: ProjectAssetRow): Promise<'overwrite' | 'cancelled'> {
	const resolution = await diskConflictStore.resolve({
		name: row.path,
		localContent: dataUrl(row.mime, row.data),
		diskContent: ''
	});
	return resolution === 'overwrite' ? 'overwrite' : 'cancelled';
}

async function saveNativeProjectInternal(projectId: string): Promise<NativeProjectReport> {
	await filesStore.flushPendingAwait();
	const session = await ensureSession(projectId);
	const delta = await loadDiskDelta(projectId, session);
	const disk = delta.entries;
	const baseline = new BaselineChanges(projectId, await loadBaseline(projectId));
	const remember = (entry: NativeProjectManifestEntry & { revision: string }): void => {
		delta.stored.set(entry.relativePath, storedEntry(entry, entry.revision));
	};
	// Only a dirty document, a changed disk entry or an unresolved path needs a
	// body read. Clean documents whose baseline matches the disk are skipped
	// before any hydration.
	const dirty = new Set(
		filesStore.library
			.filter((file) => file.projectId === projectId && file.dirty && file.relativePath)
			.map((file) => pathKey(file.relativePath!))
	);
	const local = await loadLocalProjectIndex(projectId);
	// A retained copy has no disk file. Saving it unseen would recreate the path
	// that the user chose to keep local only.
	const retained = new Set(
		[...(await loadMissing(projectId)).values()]
			.filter((entry) => entry.localOnly)
			.map((entry) => pathKey(entry.path))
	);
	const report: NativeProjectReport = { succeeded: [], failed: [], missing: [] };
	for (const indexed of local.entries.values()) {
		if (indexed.kind !== 'markdown') continue;
		const path = projectPath(indexed.relativePath);
		const key = pathKey(path);
		try {
			if (retained.has(key)) continue;
			const entry = disk.get(key);
			if (!dirty.has(key) && entry && baseline.values[path] === entry.revision) continue;
			const loaded = await loadLocalEntry(projectId, indexed);
			if (!loaded || loaded.kind !== 'markdown') throw new Error('Local document is missing');
			const row = loaded.row;
			const localRevision = await sha256(textBytes(row.content));
			if (entry && entry.kind !== 'markdown') throw new Error('Project entry type changed on disk');
			if (entry?.revision === localRevision) {
				baseline.set(path, entry.revision);
				remember(entry);
				report.succeeded.push(path);
				continue;
			}
			if (entry && baseline.values[path] !== entry.revision) {
				const resolved = await resolveDocumentConflict(session.token, row, entry, baseline);
				if (resolved === 'cancelled') throw new Error('Conflict review was cancelled');
				remember({ ...entry, revision: baseline.values[path]! });
				report.succeeded.push(path);
				continue;
			}
			let expectedRevision: string | null = entry?.revision ?? null;
			if (!entry && baseline.values[path]) {
				if ((await reviewMissingDocument(row)) === 'cancelled') {
					throw new Error('Disk deletion review was cancelled');
				}
				expectedRevision = null;
			}
			const current = filesStore.library.find((file) => file.id === row.id);
			if (!fileMatchesRow(current, row)) throw new Error('Local document changed during save');
			const expected = expectedFile(current!);
			const written = await writeNativeProjectText(
				session.token,
				path,
				row.content,
				expectedRevision
			);
			baseline.set(path, written.revision);
			remember(written);
			const after = filesStore.library.find((file) => file.id === row.id);
			if (
				after &&
				after.content === expected.content &&
				after.relativePath === expected.relativePath &&
				after.updatedAt === expected.updatedAt
			)
				after.dirty = false;
			report.succeeded.push(path);
		} catch (error) {
			report.failed.push({ path, operation: 'save', message: String(error) });
		}
		await baseline.flush();
	}
	for (const indexed of local.entries.values()) {
		if (indexed.kind !== 'asset') continue;
		const path = projectPath(indexed.relativePath);
		try {
			if (retained.has(pathKey(path))) continue;
			const loaded = await loadLocalEntry(projectId, indexed);
			if (!loaded || loaded.kind !== 'asset') throw new Error('Local asset is missing');
			const row = loaded.row;
			const entry = disk.get(pathKey(path));
			const localRevision = await sha256(row.data);
			if (entry && entry.kind !== 'asset') throw new Error('Project entry type changed on disk');
			if (entry?.revision === localRevision) {
				baseline.set(path, entry.revision);
				remember(entry);
				report.succeeded.push(path);
				continue;
			}
			if (entry && baseline.values[path] !== entry.revision) {
				const resolved = await resolveAssetConflict(session.token, row, entry, baseline);
				if (resolved === 'cancelled') throw new Error('Conflict review was cancelled');
				remember({ ...entry, revision: baseline.values[path]! });
				report.succeeded.push(path);
				continue;
			}
			let expectedRevision: string | null = entry?.revision ?? null;
			if (!entry && baseline.values[path]) {
				if ((await reviewMissingAsset(row)) === 'cancelled') {
					throw new Error('Disk deletion review was cancelled');
				}
				expectedRevision = null;
			}
			const durable = await db.projectAssets.get(row.id);
			if (!durable || !bytesEqual(durable.data, row.data))
				throw new Error('Local asset changed during save');
			const written = await writeNativeProjectAsset(
				session.token,
				path,
				row.data,
				expectedRevision
			);
			baseline.set(path, written.revision);
			remember(written);
			report.succeeded.push(path);
		} catch (error) {
			report.failed.push({ path, operation: 'save', message: String(error) });
		}
		await baseline.flush();
	}
	await baseline.flush(true);
	await storeManifest(projectId, delta.stored.values()).catch(() => {});
	if (report.failed.length)
		throw new NativeProjectOperationError('Native project save failed', report);
	return report;
}

export async function saveNativeProject(projectId: string): Promise<NativeProjectReport> {
	const report = await runProjectOperation(projectId, () => saveNativeProjectInternal(projectId));
	if (typeof window !== 'undefined') {
		window.dispatchEvent(new Event('mdsh:native-project-saved'));
	}
	return report;
}

async function disconnectNativeProjectInternal(projectId: string): Promise<void> {
	const project = await projectRow(projectId);
	const session = sessions.get(projectId);
	let needsOpen = !session;
	if (session) {
		try {
			await revokeNativeProject(session.token);
			needsOpen = false;
		} catch (error) {
			const message = String(error);
			if (message.includes('unknown or revoked native project root')) needsOpen = false;
			else if (message.includes('invalid or expired native project token')) needsOpen = true;
			else throw error;
		}
	}
	if (needsOpen && project.nativeRootId) {
		try {
			const opened = await openNativeProject(project.nativeRootId);
			await revokeNativeProject(opened.token);
		} catch (error) {
			if (!String(error).includes('unknown or revoked native project root')) throw error;
		}
	}
	const { nativeRootId: _removed, ...localProject } = project;
	await db.transaction('rw', db.projects, db.metadata, async () => {
		await db.projects.put({ ...localProject, updatedAt: Date.now() });
		await db.metadata.delete(baselineKey(projectId));
		await db.metadata.delete(manifestKey(projectId));
		await db.metadata.delete(missingKey(projectId));
	});
	sessions.delete(projectId);
}

export function disconnectNativeProject(projectId: string): Promise<void> {
	return runProjectOperation(projectId, () => disconnectNativeProjectInternal(projectId));
}

async function renameNativeProjectDocumentInternal(
	projectId: string,
	oldPath: string,
	newPath: string
): Promise<NativeRenameReceipt> {
	const project = await projectRow(projectId);
	if (!project.nativeRootId) return { rollback: async () => {}, commit: async () => {} };
	const snapshot = await currentSnapshot(projectId);
	const session = sessions.get(projectId)!;
	const baseline = await loadBaseline(projectId);
	const oldEntry = snapshot.entries.find(
		(entry) => pathKey(entry.relativePath) === pathKey(oldPath)
	);
	if (!oldEntry && !baseline[oldPath]) return { rollback: async () => {}, commit: async () => {} };
	if (!oldEntry || baseline[oldPath] !== oldEntry.revision) {
		throw new Error('Native document changed before rename');
	}
	if (oldEntry.kind !== 'markdown') throw new Error('Native rename source is not Markdown');
	const renamed = await renameNativeProjectEntry(
		session.token,
		projectPath(oldPath),
		projectPath(newPath),
		oldEntry.revision
	);
	let settled = false;
	return {
		async rollback() {
			if (settled) return;
			await renameNativeProjectEntry(
				session.token,
				projectPath(newPath),
				projectPath(oldPath),
				renamed.revision
			);
			settled = true;
		},
		async commit() {
			if (settled) return;
			delete baseline[oldPath];
			baseline[newPath] = renamed.revision;
			await storeBaseline(projectId, baseline);

			const current = filesStore.library.find(
				(file) => file.projectId === projectId && file.relativePath === newPath
			);

			if (current && (await sha256(textBytes(current.content))) === renamed.revision) {
				current.dirty = false;
			}
			settled = true;
		}
	};
}

export function renameNativeProjectDocument(
	projectId: string,
	oldPath: string,
	newPath: string
): Promise<NativeRenameReceipt> {
	return reserveProjectRename(projectId, () =>
		renameNativeProjectDocumentInternal(projectId, oldPath, newPath)
	);
}

// Rename orchestration stays in this lazy bundle to keep the boot bundle within
// its size budget. The journal and native receipt remain the source of truth
// for crash recovery.
let renameQueue: Promise<unknown> = Promise.resolve();

export function renameProjectDocument(id: string, requested: string): Promise<boolean> {
	const operation = renameQueue
		.catch(() => {})
		.then(async () => {
			let nativeRename: import('./projects-native').NativeRenameReceipt | undefined;
			let committed = false;
			let renameJournalId: string | null = null;
			try {
				await filesStore.flushPendingAwait();
				const document = filesStore.library.find((file) => file.id === id);
				if (!document?.projectId || !document.relativePath) return false;
				await filesStore.ensureProjectContent(document.projectId);
				const name = normalizeRename(requested, document.name);
				if (name.includes('/') || name.includes('\\')) throw new Error('Use a filename');
				const oldPath = document.relativePath;
				const newPath = projectPath([...oldPath.split('/').slice(0, -1), name].join('/'));
				if (oldPath === newPath) return true;
				const snapshot = filesStore.library
					.filter((file) => file.projectId === document.projectId)
					.map((file) => ({ ...file }));
				const rewrite = (content: string, fileId: string) => {
					const file = snapshot.find((entry) => entry.id === fileId)!;
					const kind = documentKindForFile(file);
					if (kind !== 'note' && kind !== 'presentation') return content;
					const from = file.relativePath!;
					const linked = renameProjectLinks(content, from, oldPath, newPath);
					if (kind !== 'note') return linked;
					return rewriteWikiLinkTargets(linked, (target) => {
						const candidates = projectWikiCandidates(file, target, snapshot);
						if (candidates.length !== 1 || candidates[0]!.id !== id || target === id) return target;
						const suffix = target.match(/#.*$/)?.[0] ?? '';
						const next = relativeDestination(from === oldPath ? newPath : from, newPath);

						return (
							(/\.(?:md|markdown|mdx|txt)$/i.test(target.split('#', 1)[0]!)
								? next
								: next.replace(/\.(?:md|markdown|mdx|txt)$/i, '')) + suffix
						);
					});
				};
				const rewritten = snapshot
					.map((file) => {
						const content = rewrite(file.content, file.id);
						return { file, content, relativePath: file.id === id ? newPath : file.relativePath! };
					})
					.filter((entry) => entry.content !== entry.file.content || entry.file.id === id);
				const { renameNativeProjectDocument } = await import('./projects-native');
				renameJournalId = newId();
				await writeProjectRenameJournal({
					id: renameJournalId,
					projectId: document.projectId,
					oldPath,
					newPath,
					stage: 'prepared',
					updatedAt: Date.now()
				});
				nativeRename = await renameNativeProjectDocument(document.projectId, oldPath, newPath);
				if (renameJournalId) {
					await updateProjectRenameStage(renameJournalId, 'disk-renamed').catch(() => {});
				}
				const rows = await db.transaction(
					'rw',
					db.drafts,
					db.projectAssets,
					db.versions,
					async () => {
						const durable = await db.drafts
							.where('projectId')
							.equals(document.projectId!)
							.toArray();
						const assets = await db.projectAssets
							.where('projectId')
							.equals(document.projectId!)
							.toArray();
						if (
							durable.some(
								(row) => row.id !== id && pathKey(row.relativePath!) === pathKey(newPath)
							) ||
							assets.some((asset) => pathKey(asset.path) === pathKey(newPath))
						)
							throw new Error('Project path already exists');
						const result: DraftRow[] = [];
						for (const entry of rewritten) {
							const before = durable.find((row) => row.id === entry.file.id);
							const current = filesStore.library.find((file) => file.id === entry.file.id);
							if (
								!before ||
								before.content !== entry.file.content ||
								before.relativePath !== entry.file.relativePath ||
								current?.content !== entry.file.content
							)
								throw new Error('The document changed during rename');
							await db.versions.add({
								id: newId(),
								draftId: before.id,
								name: before.name,
								content: before.content,
								createdAt: Date.now()
							});
							result.push({
								...before,
								name: before.id === id ? name : before.name,
								relativePath: entry.relativePath,
								content: entry.content,
								updatedAt: Date.now()
							});
						}
						await db.drafts.bulkPut(result);
						return result;
					}
				);
				committed = true;
				if (renameJournalId) {
					await updateProjectRenameStage(renameJournalId, 'db-rewritten').catch(() => {});
				}
				filesStore.acceptProjectRows(
					rows,
					new Map(snapshot.map((file) => [file.id, file])),
					rewrite
				);
				let baselineCommitted = false;
				try {
					await nativeRename.commit();
					baselineCommitted = true;
				} catch {
					// The disk rename and draft rows already committed. A transient
					// baseline write failure must not report a false rename failure.
					await new Promise((resolve) => setTimeout(resolve, 250));
					try {
						await nativeRename.commit();
						baselineCommitted = true;
					} catch (second) {
						reportError('project rename baseline', second);
						notify.info(t('projects.renameBaselinePending'));
					}
				}
				if (renameJournalId && baselineCommitted)
					await removeProjectRenameJournal(renameJournalId).catch(() => {});
				return true;
			} catch (error) {
				if (nativeRename && !committed) {
					try {
						await nativeRename.rollback();
						if (renameJournalId) await removeProjectRenameJournal(renameJournalId).catch(() => {});
					} catch (rollbackError) {
						reportError('project rename rollback', rollbackError);
					}
				}
				reportError('project rename', error);
				notify.error(t('projects.operationFailed'));
				return false;
			}
		});
	renameQueue = operation;
	return operation;
}

export interface ProjectEntryStamp {
	kind: 'markdown' | 'asset';
	relativePath: string;
	mtimeMs: number;
	size: number;
	first: number;
	second: number;
	revision: string;
}

export type ProjectEntryMetadata = Omit<ProjectEntryStamp, 'revision'> & { revision?: string };

/** Window in which a file write may share its timestamp with a scan. */
export const PROJECT_REFRESH_RACY_WINDOW_MS = 2_000;

export function shouldReadProjectEntry(
	known: ProjectEntryStamp | undefined,
	current: ProjectEntryMetadata,
	now = Date.now(),
	authoritative = false
): boolean {
	if (!known || known.revision === '') return true;
	if (authoritative && current.revision) return known.revision !== current.revision;
	if (
		known.kind !== current.kind ||
		known.mtimeMs !== current.mtimeMs ||
		known.size !== current.size ||
		known.first !== current.first ||
		known.second !== current.second
	)
		return true;
	return Math.abs(now - current.mtimeMs) < PROJECT_REFRESH_RACY_WINDOW_MS;
}

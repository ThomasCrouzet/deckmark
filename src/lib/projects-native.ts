import { browser } from '$app/env';

import { db, newId, type DraftRow, type ProjectAssetRow, type ProjectRow } from './db';

import { diskConflictStore } from './disk-conflict.svelte';
import { isDesktop } from './desktop';
import { filesStore } from './files.svelte';
import { importProject } from './projects';
import type { ProjectInput } from './project-archive';
import { pathKey, projectPath, projectWikiCandidates, relativeDestination } from './project-paths';
import { shouldReadProjectEntry } from './project-archive';
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

export interface NativeProjectReport {
	succeeded: string[];
	failed: NativeProjectFailure[];
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

interface StoredManifestEntry extends NativeProjectManifestEntry {
	revision: string;
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
	removed: string[];
	stored: Map<string, StoredManifestEntry>;
}

function manifestKey(projectId: string): string {
	return `${MANIFEST_PREFIX}${projectId}`;
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

async function loadDiskDelta(projectId: string, session: NativeSession): Promise<DiskDelta> {
	const manifest = await manifestNativeProject(session.token);
	const stored = (await loadManifest(projectId)) ?? new Map<string, StoredManifestEntry>();
	const entries = new Map<string, DiskEntry>();
	const changed: NativeProjectEntry[] = [];
	const now = Date.now();
	for (const entry of manifest.entries) {
		const previous = stored.get(entry.relativePath);
		const key = pathKey(entry.relativePath);
		if (!shouldReadProjectEntry(previous, entry, now)) {
			entries.set(key, { ...entry, revision: previous!.revision });
			continue;
		}
		const fresh = await readNativeProjectEntry(session.token, entry.relativePath);
		changed.push(fresh);
		entries.set(key, { ...entry, ...fresh });
	}
	const current = new Set(manifest.entries.map((entry) => pathKey(entry.relativePath)));
	const removed = [...stored.values()]
		.filter((entry) => !current.has(pathKey(entry.relativePath)))
		.map((entry) => entry.relativePath);
	for (const relativePath of removed) stored.delete(relativePath);
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

async function addDiskEntry(projectId: string, entry: NativeProjectEntry): Promise<void> {
	const now = Date.now();
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
			const [documents, assets] = await Promise.all([
				db.drafts.where('projectId').equals(projectId).toArray(),
				db.projectAssets.where('projectId').equals(projectId).toArray()
			]);
			if (
				[...documents.map((item) => item.relativePath!), ...assets.map((item) => item.path)].some(
					(path) => pathKey(path) === pathKey(row.relativePath!)
				)
			)
				throw new Error('Project path already exists');
			await db.drafts.add(row);
		});
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
		const [documents, assets] = await Promise.all([
			db.drafts.where('projectId').equals(projectId).toArray(),
			db.projectAssets.where('projectId').equals(projectId).toArray()
		]);
		if (
			[...documents.map((item) => item.relativePath!), ...assets.map((item) => item.path)].some(
				(path) => pathKey(path) === pathKey(row.path)
			)
		)
			throw new Error('Project path already exists');
		await db.projectAssets.add(row);
	});
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
	projectId: string,
	token: string,
	row: DraftRow,
	disk: DiskEntry,
	baseline: Record<string, string>
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
		baseline[row.relativePath!] = fresh.revision;
		await storeBaseline(projectId, baseline);
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
	baseline[row.relativePath!] = written.revision;
	await storeBaseline(projectId, baseline);
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
	projectId: string,
	token: string,
	row: ProjectAssetRow,
	disk: DiskEntry,
	baseline: Record<string, string>
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
		baseline[row.path] = fresh.revision;
		await storeBaseline(projectId, baseline);
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
	baseline[row.path] = written.revision;
	await storeBaseline(projectId, baseline);
	return 'resolved';
}

async function refreshNativeProjectFromDiskInternal(
	projectId: string,
	providedSnapshot?: NativeProjectSnapshot
): Promise<NativeProjectReport> {
	await filesStore.flushPendingAwait();
	await filesStore.ensureProjectContent(projectId);
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
		delta = await loadDiskDelta(projectId, session);
		if (!delta.changed.length && !delta.removed.length) {
			await storeManifest(projectId, delta.stored.values()).catch(() => {});
			return { succeeded: [], failed: [] };
		}
	}
	const remember = (entry: NativeProjectEntry, revision: string): void => {
		delta.stored.set(entry.relativePath, storedEntry(entry, revision));
	};
	const baseline = await loadBaseline(projectId);
	const documents = await db.drafts.where('projectId').equals(projectId).toArray();
	const assets = await db.projectAssets.where('projectId').equals(projectId).toArray();
	const local = new Map<
		string,
		{ kind: 'markdown'; row: DraftRow } | { kind: 'asset'; row: ProjectAssetRow }
	>();
	for (const row of documents) local.set(pathKey(row.relativePath!), { kind: 'markdown', row });
	for (const row of assets) local.set(pathKey(row.path), { kind: 'asset', row });
	const report: NativeProjectReport = { succeeded: [], failed: [] };
	for (const entry of delta.changed) {
		const path = projectPath(entry.relativePath);
		const known = local.get(pathKey(path));
		try {
			if (!known) {
				await addDiskEntry(projectId, entry);
				baseline[path] = entry.revision;
				await storeBaseline(projectId, baseline);
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
				baseline[path] = entry.revision;
				await storeBaseline(projectId, baseline);
				remember(entry, entry.revision);
				report.succeeded.push(path);
				continue;
			}
			const base = baseline[path];
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
				baseline[path] = fresh.revision;
				await storeBaseline(projectId, baseline);
				remember(entry, fresh.revision);
				report.succeeded.push(path);
				continue;
			}
			const resolved =
				known.kind === 'markdown' && entry.kind === 'markdown'
					? await resolveDocumentConflict(projectId, session.token, known.row, entry, baseline)
					: known.kind === 'asset' && entry.kind === 'asset'
						? await resolveAssetConflict(projectId, session.token, known.row, entry, baseline)
						: 'cancelled';
			if (resolved === 'cancelled') throw new Error('Conflict review was cancelled');
			remember(entry, entry.revision);
			report.succeeded.push(path);
		} catch (error) {
			report.failed.push({ path, operation: 'refresh', message: String(error) });
		}
	}
	await storeManifest(projectId, delta.stored.values()).catch(() => {});
	if (report.failed.length)
		throw new NativeProjectOperationError('Native project refresh failed', report);
	return report;
}

export function refreshNativeProjectFromDisk(
	projectId: string,
	providedSnapshot?: NativeProjectSnapshot
): Promise<NativeProjectReport> {
	return runProjectOperation(projectId, () =>
		refreshNativeProjectFromDiskInternal(projectId, providedSnapshot)
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
	await filesStore.ensureProjectContent(projectId);
	const session = await ensureSession(projectId);
	const delta = await loadDiskDelta(projectId, session);
	const disk = delta.entries;
	const baseline = await loadBaseline(projectId);
	const remember = (entry: NativeProjectManifestEntry & { revision: string }): void => {
		delta.stored.set(entry.relativePath, storedEntry(entry, entry.revision));
	};
	const documents = await db.drafts.where('projectId').equals(projectId).toArray();
	const assets = await db.projectAssets.where('projectId').equals(projectId).toArray();
	const report: NativeProjectReport = { succeeded: [], failed: [] };
	for (const row of documents) {
		const path = projectPath(row.relativePath!);
		try {
			const entry = disk.get(pathKey(path));
			const localRevision = await sha256(textBytes(row.content));
			if (entry && entry.kind !== 'markdown') throw new Error('Project entry type changed on disk');
			if (entry?.revision === localRevision) {
				baseline[path] = entry.revision;
				await storeBaseline(projectId, baseline);
				remember(entry);
				report.succeeded.push(path);
				continue;
			}
			if (entry && baseline[path] !== entry.revision) {
				const resolved = await resolveDocumentConflict(
					projectId,
					session.token,
					row,
					entry,
					baseline
				);
				if (resolved === 'cancelled') throw new Error('Conflict review was cancelled');
				remember({ ...entry, revision: baseline[path]! });
				report.succeeded.push(path);
				continue;
			}
			let expectedRevision: string | null = entry?.revision ?? null;
			if (!entry && baseline[path]) {
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
			baseline[path] = written.revision;
			await storeBaseline(projectId, baseline);
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
	}
	for (const row of assets) {
		const path = projectPath(row.path);
		try {
			const entry = disk.get(pathKey(path));
			const localRevision = await sha256(row.data);
			if (entry && entry.kind !== 'asset') throw new Error('Project entry type changed on disk');
			if (entry?.revision === localRevision) {
				baseline[path] = entry.revision;
				await storeBaseline(projectId, baseline);
				remember(entry);
				report.succeeded.push(path);
				continue;
			}
			if (entry && baseline[path] !== entry.revision) {
				const resolved = await resolveAssetConflict(projectId, session.token, row, entry, baseline);
				if (resolved === 'cancelled') throw new Error('Conflict review was cancelled');
				remember({ ...entry, revision: baseline[path]! });
				report.succeeded.push(path);
				continue;
			}
			let expectedRevision: string | null = entry?.revision ?? null;
			if (!entry && baseline[path]) {
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
			baseline[path] = written.revision;
			await storeBaseline(projectId, baseline);
			remember(written);
			report.succeeded.push(path);
		} catch (error) {
			report.failed.push({ path, operation: 'save', message: String(error) });
		}
	}
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

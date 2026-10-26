import { browser } from '$app/env';

import { db, newId, type DraftRow, type ProjectAssetRow, type ProjectRow } from './db';

import { diskConflictStore } from './disk-conflict.svelte';
import { isDesktop } from './desktop';
import { filesStore } from './files.svelte';
import { importProject } from './projects';
import type { ProjectInput } from './project-archive';
import { pathKey, projectPath } from './project-paths';
import {
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
	type NativeProjectMarkdownEntry,
	type NativeProjectSnapshot
} from './project-tauri';
import type { FileItem } from './types';
import { createCheckpoint } from './version-history';

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
					const finish = async (action: () => Promise<void>) => {
						if (finished) return;
						try {
							await action();
						} finally {
							finished = true;
							release();
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

function revisions(snapshot: NativeProjectSnapshot): Record<string, string> {
	return Object.fromEntries(
		snapshot.entries.map((entry) => [projectPath(entry.relativePath), entry.revision])
	);
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
	disk: NativeProjectMarkdownEntry,
	baseline: Record<string, string>
): Promise<'resolved' | 'cancelled'> {
	const resolution = await diskConflictStore.resolve({
		name: row.relativePath ?? row.name,
		localContent: row.content,
		diskContent: disk.content
	});
	if (resolution === 'cancel') return 'cancelled';
	if (resolution === 'reload') {
		await createCheckpoint({ id: row.id, name: row.name, content: row.content });
		const fresh = await readNativeProjectEntry(token, disk.relativePath);
		if (fresh.kind !== 'markdown' || fresh.revision !== disk.revision) {
			throw new Error('Disk document changed during conflict review');
		}
		await applyDocument(row, fresh, false);
		baseline[row.relativePath!] = fresh.revision;
		await storeBaseline(projectId, baseline);
		return 'resolved';
	}
	await createCheckpoint({ id: row.id, name: row.name, content: disk.content });
	const current = filesStore.library.find((file) => file.id === row.id);
	if (!fileMatchesRow(current, row)) {
		throw new Error('Local document changed during conflict review');
	}
	const expected = expectedFile(current!);
	const written = await writeNativeProjectText(
		token,
		row.relativePath!,
		row.content,
		disk.revision
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
	disk: NativeProjectAssetEntry,
	baseline: Record<string, string>
): Promise<'resolved' | 'cancelled'> {
	const resolution = await diskConflictStore.resolve({
		name: row.path,
		localContent: dataUrl(row.mime, row.data),
		diskContent: dataUrl(disk.mime, disk.bytes)
	});
	if (resolution === 'cancel') return 'cancelled';
	if (resolution === 'reload') {
		await preserveAssetConflict(row, row.mime, row.data, 'local');
		const fresh = await readNativeProjectEntry(token, disk.relativePath);
		if (fresh.kind !== 'asset' || fresh.revision !== disk.revision) {
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
	await preserveAssetConflict(row, disk.mime, disk.bytes, 'disk');
	const written = await writeNativeProjectAsset(token, row.path, row.data, disk.revision);
	baseline[row.path] = written.revision;
	await storeBaseline(projectId, baseline);
	return 'resolved';
}

async function refreshNativeProjectFromDiskInternal(
	projectId: string,
	providedSnapshot?: NativeProjectSnapshot
): Promise<NativeProjectReport> {
	await filesStore.flushPendingAwait();
	const snapshot = providedSnapshot ?? (await currentSnapshot(projectId));
	const session = sessions.get(projectId);
	if (!session) throw new Error('Native project session is unavailable');
	const baseline = await loadBaseline(projectId);
	const documents = await db.drafts.where('projectId').equals(projectId).toArray();
	const assets = await db.projectAssets.where('projectId').equals(projectId).toArray();
	const local = new Map<
		string,
		{ kind: 'markdown'; row: DraftRow } | { kind: 'asset'; row: ProjectAssetRow }
	>();
	for (const row of documents) local.set(pathKey(row.relativePath!), { kind: 'markdown', row });
	for (const row of assets) local.set(pathKey(row.path), { kind: 'asset', row });
	const diskKeys = new Set<string>();
	for (const entry of snapshot.entries) {
		const key = pathKey(entry.relativePath);
		if (diskKeys.has(key)) throw new Error('Duplicate native project path');
		diskKeys.add(key);
	}
	const report: NativeProjectReport = { succeeded: [], failed: [] };
	for (const entry of snapshot.entries) {
		const path = projectPath(entry.relativePath);
		const known = local.get(pathKey(path));
		try {
			if (!known) {
				await addDiskEntry(projectId, entry);
				baseline[path] = entry.revision;
				await storeBaseline(projectId, baseline);
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
				report.succeeded.push(path);
				continue;
			}
			const base = baseline[path];
			const localDirty = base ? localRevision !== base : localRevision !== entry.revision;
			const externalChanged = base !== entry.revision;
			if (!externalChanged) continue;
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
			report.succeeded.push(path);
		} catch (error) {
			report.failed.push({ path, operation: 'refresh', message: String(error) });
		}
	}
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
	const snapshot = await currentSnapshot(projectId);
	const session = sessions.get(projectId)!;
	const disk = new Map<string, NativeProjectEntry>();
	for (const entry of snapshot.entries) {
		const key = pathKey(entry.relativePath);
		if (disk.has(key)) throw new Error('Duplicate native project path');
		disk.set(key, entry);
	}
	const baseline = await loadBaseline(projectId);
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
				report.succeeded.push(path);
				continue;
			}
			if (entry && baseline[path] !== entry.revision) {
				const resolved = await resolveAssetConflict(projectId, session.token, row, entry, baseline);
				if (resolved === 'cancelled') throw new Error('Conflict review was cancelled');
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
			report.succeeded.push(path);
		} catch (error) {
			report.failed.push({ path, operation: 'save', message: String(error) });
		}
	}
	if (report.failed.length)
		throw new NativeProjectOperationError('Native project save failed', report);
	return report;
}

export function saveNativeProject(projectId: string): Promise<NativeProjectReport> {
	return runProjectOperation(projectId, () => saveNativeProjectInternal(projectId));
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

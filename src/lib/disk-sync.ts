import {
	ImportSession,
	ImportReadError,
	validateMarkdownContent,
	readUtf8File,
	type ImportOptions,
	type ImportReport
} from './import-limits';
// §6.9 / P2.7 - Disk synchronization via FSA (browser) or path links (Tauri).
//
// Groups `openFromDisk`, `saveToDisk`, `saveActiveToDisk`, `unlinkFromDisk`
// and `refreshBrokenLinks` around `fsa.ts` + `broken-links.ts` + `disk-tauri.ts`.
//
// The module stays pure (no Svelte runes, no direct store access):
// all state mutations go through callbacks injected by FilesStore.
// This makes it testable without mounting the full store.
//
// Expected callbacks:
//  - `getFile(id)` → FileItem | undefined   (read from this.files)
//  - `onCreate(name, content)` → FileItem   (delegates to createNew)
//  - `scheduleSave(id)` → void              (schedules Dexie persistence)

import { browser } from '$app/env';
import { IMPORT_LIMITS } from './config';
import { isDesktop } from './desktop';
import {
	checkHandle,
	deleteHandle,
	getFsaLink,
	getHandle,
	getPathLink,
	getPathLinkWithEpoch,
	isFSASupported,
	listDiskLinks,
	isSameFileHandle,
	pickAndOpen,
	pickSaveTarget,
	requestPermission,
	revisionForFile,
	revisionForText,
	saveHandle,
	savePathLink,
	writeHandle
} from './fsa';
import { computeBrokenLinks } from './broken-links';
import {
	tauriCheckPath,
	tauriForgetPath,
	tauriRenamePath,
	tauriOpenNativeGrants,
	tauriPickAndOpen,
	tauriPickDirectoryAndOpen,
	tauriPickSaveTarget,
	tauriReadMeta,
	tauriReadPath,
	tauriSaveExportText,
	tauriWritePath,
	type NativeDiskGrant
} from './disk-tauri';
import { t } from '#lib/i18n/index.js';
import { notify } from './notify.svelte';
import { diskConflictStore } from './disk-conflict.svelte';
import { createCheckpoint } from './version-history';
import { reportError } from './report';
import { reportPersistenceError } from './storage';
import type { FileItem } from './types';
import { getDiskLinkEpoch } from './db';
import { pathBasename } from './disk-link';
import { isBinaryDocument } from './document-kind';
import { isDiskLinkingAvailable } from './disk-linking';
export { isDiskLinkingAvailable } from './disk-linking';

/** Dependencies injected by FilesStore - zero Svelte imports here. */
export interface DiskSyncDeps {
	/** Read access to a FileItem by id. */
	getFile: (id: string) => FileItem | undefined;
	getFiles?: () => FileItem[];
	onActivate?: (id: string) => void;
	/** Creates a new file in the store (delegates to `createNew`). */
	onCreate: (name: string, content: string) => FileItem;
	/** Schedules Dexie persistence of the file (delegates to `scheduleSave`). */
	scheduleSave: (id: string) => void;
	/** Applies the exact disk name through the store so metadata and persistence stay synchronized. */
	onSyncName?: (id: string, name: string) => void;
	onUpdateContent?: (id: string, content: string) => void;
	onImportRollback?: (id: string) => void;
}

/**
 * Opens one or more Markdown files from the local file system via the File
 * System Access API (browser) or native dialogs (desktop). Each file is created
 * in the store and its disk link is persisted in IDB (`mdsh-fs`).
 *
 * No-op if neither backend is available or if the user cancels.
 *
 * §D - Protect each file read as in `FilesStore.importFiles`. If reading,
 * creation, or handle storage fails, log the error and skip that file.
 * Continue to open other selected files. Show the result in an info toast.
 * Return only the files that opened successfully.
 */
export async function openFromDisk(
	deps: DiskSyncDeps,
	options: ImportOptions = {}
): Promise<FileItem[]> {
	if (!browser) return [];
	if (isDesktop()) return openFromDiskDesktop(deps, options);
	if (!isFSASupported()) return [];
	return openFromDiskFsa(deps, options);
}

async function openFromDiskFsa(deps: DiskSyncDeps, options: ImportOptions): Promise<FileItem[]> {
	const picked = await pickAndOpen();
	const session = new ImportSession(options);
	const created: FileItem[] = [];
	let failed = 0;
	for (const { handle, file } of picked) {
		if (!(await session.pause())) break;
		let item: FileItem | undefined;
		try {
			const content = await session.read(file);
			if (content === null) {
				if (session.cancelled) break;

				reportError(
					`open file "${file.name}"`,
					new ImportReadError(session.report.issues.at(-1)!.reason)
				);
				failed++;
				continue;
			}
			const epoch = await getDiskLinkEpoch();
			item = deps.onCreate(file.name, content);
			item.linkedToDisk = true;
			// §C2 - Records the disk state (mtime + size) at open time. Serves as a
			// reference to detect an external modification before a future write.
			item.diskLastModified = file.lastModified;
			item.diskSize = file.size;
			await saveHandle(item.id, handle, await revisionForFile(file), epoch);
			pendingDiskLinkWrites.delete(item.id);
			created.push(item);
			session.accept();
		} catch (err) {
			if (item) deps.onImportRollback?.(item.id);
			// §D - An unreadable file must not fail the whole selection.
			reportError(`open file "${file.name}"`, err);
			failed += 1;
			session.fail(file.name, err instanceof ImportReadError ? err.reason : 'read');
		}
	}
	// §D - Partial summary: if some files were skipped while others were
	// successfully opened, the user is told explicitly (info toast).
	if (failed > 0 && created.length > 0) {
		notify.info(t('disk.openPartial', { n: created.length, failed }));
	}
	session.publish();
	return created;
}

async function openFromDiskDesktop(
	deps: DiskSyncDeps,
	options: ImportOptions
): Promise<FileItem[]> {
	const result = await tauriPickAndOpen(options);
	return (await ingestDesktopOpens(result.files, deps, result.failed, options, result.report))
		.files;
}

/** Opens a bounded directory selection through the native desktop capability backend. */
export async function openDirectoryFromDisk(
	deps: DiskSyncDeps,
	options: ImportOptions = {}
): Promise<FileItem[]> {
	if (!browser || !isDesktop()) return [];
	const result = await tauriPickDirectoryAndOpen(options);
	return (await ingestDesktopOpens(result.files, deps, result.failed, options, result.report))
		.files;
}

/**
 * Opens absolute paths from argv / file association (desktop only).
 * Same store outcome as a dialog open (tab + path link).
 */
export async function openPathsFromDesktop(
	grants: NativeDiskGrant[],
	deps: DiskSyncDeps,
	options: ImportOptions = {}
): Promise<DesktopIngestResult> {
	if (!browser || !isDesktop() || grants.length === 0) return { files: [], processedTokens: [] };
	const result = await tauriOpenNativeGrants(grants, options);
	const opened = await ingestDesktopOpens(
		result.files,
		deps,
		result.failed,
		options,
		result.report
	);
	return { files: opened.files, processedTokens: opened.processedTokens };
}

interface DesktopIngestResult {
	files: FileItem[];
	processedTokens: string[];
}

async function ingestDesktopOpens(
	picked: Array<{
		name: string;
		content: string;
		path: string;
		lastModified: number;
		size: number;
		revision: string;
		token?: string;
		link: { kind: 'path'; path: string };
	}>,
	deps: DiskSyncDeps,
	initialFailed = 0,
	options: ImportOptions = {},
	readReport?: ImportReport
): Promise<DesktopIngestResult> {
	const created: FileItem[] = [];
	const processedTokens: string[] = [];
	let failed = initialFailed;
	const session = new ImportSession(options);
	session.report.failed = initialFailed;
	if (readReport) {
		session.report.issues = [...readReport.issues];
		session.report.cancelled = readReport.cancelled;
		session.report.bytes = readReport.bytes;
	}
	session.report.processed = initialFailed;
	session.publish();
	const epoch = await getDiskLinkEpoch();
	const files = deps.getFiles?.() ?? [];
	const filesById = new Map(files.map((file) => [file.id, file]));
	const pathIndex = new Map<string, string>();
	let links: Awaited<ReturnType<typeof listDiskLinks>>;
	try {
		links = await listDiskLinks();
	} catch (error) {
		// An unreadable registry is not an empty registry. Creating drafts now
		// would duplicate every already linked path. Leave the launch tokens
		// unacknowledged so a later retry can activate the original document.
		reportError('disk link registry', error);
		notify.error(t('page.openFromDiskError'));
		session.publish();
		return { files: [], processedTokens: [] };
	}
	for (const link of links) {
		if (link.kind !== 'path' || !filesById.has(link.id) || pathIndex.has(link.path)) continue;
		// Several retained owners can share one path. Prefer a live document.
		pathIndex.set(link.path, link.id);
	}
	for (const file of picked) {
		if (!(await session.pause())) break;
		let createdItem: FileItem | undefined;
		try {
			const existingId = pathIndex.get(file.path);
			const existing = existingId ? filesById.get(existingId) : undefined;
			if (existing) {
				const previous = await getPathLinkWithEpoch(existing.id);
				const revision =
					existing.diskRevision ??
					previous?.revision ??
					(existing.content === file.content ? file.revision : undefined);
				await savePathLink(existing.id, file.link, epoch, revision);
				deps.onActivate?.(existing.id);
				if (existing.diskRevision === undefined && existing.content === file.content) {
					existing.diskLastModified = file.lastModified;
					existing.diskSize = file.size;
					existing.diskRevision = file.revision;
					deps.scheduleSave(existing.id);
				}
				if (existing.name !== file.name) deps.onSyncName?.(existing.id, file.name);
				created.push(existing);
				const token = file.token;
				if (token) processedTokens.push(token);
				session.accept();
				continue;
			}
			if (!readReport) session.reserve(file.size);
			validateMarkdownContent(file.content);
			const item = deps.onCreate(file.name, file.content);
			createdItem = item;
			item.linkedToDisk = true;
			item.diskLastModified = file.lastModified;
			item.diskSize = file.size;
			item.diskRevision = file.revision;
			await savePathLink(item.id, file.link, epoch, file.revision);
			pendingDiskLinkWrites.delete(item.id);
			created.push(item);
			if (file.token) processedTokens.push(file.token);
			session.accept();
		} catch (err) {
			if (createdItem) deps.onImportRollback?.(createdItem.id);
			reportError(`open file "${file.name}"`, err);
			failed += 1;
			session.fail(file.name, err instanceof ImportReadError ? err.reason : 'read');
		}
	}
	if (failed > 0) {
		if (created.length > 0) {
			notify.info(t('disk.openPartial', { n: created.length, failed }));
		} else {
			notify.error(t('page.openFromDiskError'));
		}
	}
	session.publish();
	return { files: created, processedTokens };
}

/** The two facts of a linked save stay separate. */
export type DiskSaveOutcome = 'saved' | 'written-link-unsaved' | 'failed';

export interface DiskSaveResult {
	/** `written-link-unsaved` means the bytes reached the file, not the link. */
	outcome: DiskSaveOutcome;
	/** True when the selected disk file received the bytes. */
	written: boolean;
	/** True when the link and its revision reached the disk-link database. */
	linkPersisted: boolean;
}

function savedResult(): DiskSaveResult {
	return { outcome: 'saved', written: true, linkPersisted: true };
}

function writtenLinkUnsavedResult(): DiskSaveResult {
	return { outcome: 'written-link-unsaved', written: true, linkPersisted: false };
}

function failedResult(): DiskSaveResult {
	return { outcome: 'failed', written: false, linkPersisted: false };
}

/**
 * A process-local intent for a file write whose link record did not persist.
 * The record is small and holds no document content. It lets the next save
 * accept its own exact disk revision as the baseline. A restart drops it, so
 * the next save asks the user again instead of silently adopting a baseline.
 */
interface PendingDiskLinkWrite {
	kind: 'fsa' | 'path';
	revision: string;
	epoch: string;
	handle?: FileSystemFileHandle;
	path?: string;
}

const pendingDiskLinkWrites = new Map<string, PendingDiskLinkWrite>();

/** Drops the process-local link intent for one document. */
export function forgetPendingDiskLinkWrite(id: string): void {
	pendingDiskLinkWrites.delete(id);
}

/**
 * Saves a file to disk via FSA or path link. If a link already exists (file
 * already linked), reuses it (with a permission check on FSA). Otherwise, opens
 * a native save dialog.
 *
 * Updates `linkedToDisk`, `brokenLink`, `dirty` on the FileItem, then calls
 * `scheduleSave` to persist the state to Dexie.
 *
 * @returns `true` only for a completed linked save. A physical write whose link
 *   record could not persist returns `false`; use `saveToDiskResult` to tell
 *   that case apart from a failed write.
 */
export async function saveToDisk(id: string, deps: DiskSyncDeps): Promise<boolean> {
	return (await saveToDiskResult(id, deps)).outcome === 'saved';
}

/** Typed form of `saveToDisk` for callers that must separate write and link. */
export async function saveToDiskResult(id: string, deps: DiskSyncDeps): Promise<DiskSaveResult> {
	if (!browser) return failedResult();
	const file = deps.getFile(id);
	if (!file) return failedResult();
	markDiskLinkChanged(id);

	try {
		if (isBinaryDocument(file)) {
			const { exportMarkdown } = await import('./services/export');
			return (await exportMarkdown(file)) ? savedResult() : failedResult();
		}
		if (!isDiskLinkingAvailable()) return failedResult();
		if (isDesktop()) return await saveToDiskDesktop(id, file, deps);
		return await saveToDiskFsa(id, file, deps);
	} catch (error) {
		reportError('disk save', error, { notifyUser: t('disk.saveFailed', { name: file.name }) });
		return failedResult();
	}
}

async function saveToDiskFsa(
	id: string,
	file: FileItem,
	deps: DiskSyncDeps
): Promise<DiskSaveResult> {
	if (!isFSASupported()) return failedResult();
	const content = file.content;
	const name = file.name;
	let existingLink: Awaited<ReturnType<typeof getFsaLink>>;
	let epoch: string;
	try {
		existingLink = await getFsaLink(id);
		epoch = existingLink?.epoch ?? (await getDiskLinkEpoch());
	} catch (err) {
		reportPersistenceError(err, 'load');
		return failedResult();
	}
	let handle = existingLink?.handle ?? null;
	const hadLink = handle !== null;
	let reviewedRevision: string | null = null;
	if (handle && existingLink) {
		const ok = await requestPermission(handle, 'readwrite');
		if (!ok) {
			notify.error(t('disk.permissionDenied', { name }));
			return failedResult();
		}
		let onDiskRevision: string;
		let onDiskFile: File;
		try {
			onDiskFile = await handle.getFile();
			onDiskRevision = await revisionForFile(onDiskFile);
		} catch (err) {
			file.brokenLink = true;
			notify.error(t('disk.saveFailed', { name }));
			reportError('disk revision check', err);
			return failedResult();
		}
		if (existingLink.revision === null || onDiskRevision !== existingLink.revision) {
			const pending = pendingDiskLinkWrites.get(id);
			const pendingMatches =
				pending?.kind === 'fsa' &&
				pending.epoch === epoch &&
				pending.revision === onDiskRevision &&
				pending.handle !== undefined &&
				(await isSameFileHandle(pending.handle, handle));
			if (pendingMatches) {
				// The bytes on disk are the ones this session wrote before the link
				// record failed. An exact content revision is the only baseline this
				// path accepts without a new decision.
				let currentRevision: string;
				try {
					currentRevision = await revisionForText(content);
				} catch (err) {
					notify.error(t('disk.saveFailed', { name }));
					reportError('disk revision', err);
					return failedResult();
				}
				if (currentRevision === onDiskRevision) {
					try {
						await saveHandle(id, handle, onDiskRevision, epoch);
					} catch (err) {
						file.diskLastModified = onDiskFile.lastModified;
						file.diskSize = onDiskFile.size;
						return fsaLinkPersistenceFailure(
							id,
							file,
							handle,
							onDiskRevision,
							epoch,
							hadLink,
							err,
							deps
						);
					}
					pendingDiskLinkWrites.delete(id);
					file.linkedToDisk = true;
					file.brokenLink = false;
					const current = deps.getFile(id);
					if (current?.content === content) current.dirty = false;
					file.diskLastModified = onDiskFile.lastModified;
					file.diskSize = onDiskFile.size;
					deps.scheduleSave(id);
					notify.success(t('disk.saved', { name: handle.name || name }));
					return savedResult();
				}
				// A later local edit still follows this session's own write. The
				// outer branch below keeps `onDiskRevision` as the write baseline.
			} else {
				let diskContent: string;
				try {
					diskContent = await readUtf8File(onDiskFile, IMPORT_LIMITS.maxFileBytes, undefined, true);
					validateMarkdownContent(diskContent);
				} catch (error) {
					reportError('disk comparison read', error, {
						notifyUser: t('disk.saveFailed', { name })
					});
					return failedResult();
				}
				const resolution = await diskConflictStore.resolve({
					fileId: id,
					name,
					localContent: content,
					diskContent
				});
				if (resolution === 'cancel') {
					notify.info(t('disk.saveCancelled', { name }));
					return failedResult();
				}

				if (
					!(await checkpointDiskBranch(id, name, resolution === 'reload' ? content : diskContent))
				)
					return failedResult();

				if (
					!sameDiskSource(id, file, content, name, deps) ||
					(await revisionForFile(await handle.getFile())) !== onDiskRevision
				) {
					notify.error(t('files.otherTabChanges'));
					return failedResult();
				}
				if (resolution === 'reload') {
					try {
						await saveHandle(id, handle, onDiskRevision, epoch);
					} catch (error) {
						reportPersistenceError(error, 'save');
						return failedResult();
					}
					pendingDiskLinkWrites.delete(id);
					if (!sameDiskSource(id, file, content, name, deps)) return failedResult();
					applyDiskContent(id, file, diskContent, deps);
					file.diskLastModified = onDiskFile.lastModified;
					file.diskSize = onDiskFile.size;
					return savedResult();
				}
			}
		}
		reviewedRevision = onDiskRevision;
	} else {
		const picked = await pickSaveTarget(name);
		if (!picked) return failedResult();
		handle = picked;
	}
	let writtenRevision: string;
	try {
		writtenRevision = await revisionForText(content);
	} catch (err) {
		notify.error(t('disk.saveFailed', { name }));
		reportError('disk revision', err);
		return failedResult();
	}
	try {
		if (reviewedRevision && (await revisionForFile(await handle.getFile())) !== reviewedRevision) {
			notify.error(t('files.otherTabChanges'));
			return failedResult();
		}
		await writeHandle(handle, content);
	} catch (err) {
		// §6.9 / J3 - Write refused / file not found: we flag the link as broken,
		// notify (toast - the failure was silent, the caller had no catch) and
		// return false. The sidebar also displays the ⚠ badge to unlink or
		// re-target.
		file.brokenLink = true;
		notify.error(t('disk.saveFailed', { name }));
		reportError('saveToDisk', err);
		return failedResult();
	}
	let linkPersisted = false;
	try {
		await saveHandle(id, handle, writtenRevision, epoch);
		linkPersisted = true;
		pendingDiskLinkWrites.delete(id);
	} catch (err) {
		pendingDiskLinkWrites.set(id, {
			kind: 'fsa',
			handle,
			revision: writtenRevision,
			epoch
		});
		reportPersistenceError(err, 'save');
	}
	file.linkedToDisk = linkPersisted ? true : hadLink;
	file.brokenLink = !linkPersisted;
	const current = deps.getFile(id);
	if (linkPersisted && current?.content === content) current.dirty = false;
	if (
		file.linkedToDisk &&
		!hadLink &&
		current === file &&
		current.name === name &&
		typeof handle.name === 'string' &&
		handle.name.length > 0 &&
		handle.name !== name
	) {
		deps.onSyncName?.(id, handle.name);
	}
	// §C2 - Refreshes the anti-overwrite reference after a successful write: the
	// disk file now reflects our content, its new mtime becomes the baseline.
	// Without this, the next save would re-trigger the divergence.
	try {
		const written = await handle.getFile();
		file.diskLastModified = written.lastModified;
		file.diskSize = written.size;
	} catch {
		// Re-read impossible right after the write (rare): we invalidate the
		// baseline rather than keep a stale one that would yield a false positive.
		file.diskLastModified = undefined;
		file.diskSize = undefined;
	}
	deps.scheduleSave(id);
	if (!linkPersisted) {
		// The bytes reached the file, but the durable link and anti-overwrite
		// revision did not. Keep the draft dirty and let the user retry the link.
		file.dirty = true;
		return writtenLinkUnsavedResult();
	}
	notify.success(t('disk.saved', { name: handle.name || name }));
	return savedResult();
}

function fsaLinkPersistenceFailure(
	id: string,
	file: FileItem,
	handle: FileSystemFileHandle,
	revision: string,
	epoch: string,
	hadLink: boolean,
	err: unknown,
	deps: DiskSyncDeps
): DiskSaveResult {
	pendingDiskLinkWrites.set(id, { kind: 'fsa', handle, revision, epoch });
	file.linkedToDisk = hadLink;
	file.brokenLink = true;
	file.dirty = true;
	reportPersistenceError(err, 'save');
	deps.scheduleSave(id);
	return writtenLinkUnsavedResult();
}

async function saveToDiskDesktop(
	id: string,
	file: FileItem,
	deps: DiskSyncDeps
): Promise<DiskSaveResult> {
	const content = file.content;
	const name = file.name;
	let existingLink: Awaited<ReturnType<typeof getPathLinkWithEpoch>>;
	let epoch: string;
	try {
		existingLink = await getPathLinkWithEpoch(id);
		epoch = existingLink?.epoch ?? (await getDiskLinkEpoch());
	} catch (err) {
		reportPersistenceError(err, 'load');
		return failedResult();
	}
	let pathRec = existingLink?.record ?? null;
	let expectedRevision = file.diskRevision ?? existingLink?.revision ?? null;
	// A durable path stays owned until a different target replaces it. A picked
	// path is not durable until `savePathLink` resolves.
	let durablePath = pathRec?.path ?? null;
	const hadDurablePath = pathRec !== null;
	if (!pathRec) {
		const picked = await tauriPickSaveTarget(name);
		if (!picked) return failedResult();
		pathRec = picked;
		const selected = await tauriReadMeta(pathRec.path);
		expectedRevision = selected?.revision ?? null;
	}
	// A previous save in this session wrote the file but could not store its
	// revision. Accept that exact revision as the baseline without a new write
	// or a false external-change dialog.
	const pending = pendingDiskLinkWrites.get(id);
	if (
		hadDurablePath &&
		pending?.kind === 'path' &&
		pending.epoch === epoch &&
		pending.path === pathRec.path
	) {
		const currentMeta = await tauriReadMeta(pathRec.path).catch(() => null);
		if (currentMeta && currentMeta.revision === pending.revision) {
			const diskContent = await tauriReadPath(pathRec.path)
				.then((read) => read.content)
				.catch(() => null);
			if (diskContent === content) {
				try {
					await savePathLink(id, pathRec, epoch, currentMeta.revision);
				} catch (err) {
					return desktopLinkPersistenceFailure(
						id,
						file,
						pathRec,
						currentMeta.revision,
						epoch,
						durablePath,
						err,
						deps
					);
				}
				pendingDiskLinkWrites.delete(id);
				file.linkedToDisk = true;
				file.brokenLink = false;
				file.diskRevision = currentMeta.revision;
				file.diskLastModified = currentMeta.lastModified;
				file.diskSize = currentMeta.size;
				const current = deps.getFile(id);
				if (current?.content === content) current.dirty = false;
				deps.scheduleSave(id);
				notify.success(t('disk.saved', { name: pathBasename(pathRec.path) }));
				return savedResult();
			}
			// The user edited after the pending write. Its bytes are still the
			// baseline, so the new write must not look like an external change.
			expectedRevision = currentMeta.revision;
		}
	}
	let written: Awaited<ReturnType<typeof tauriWritePath>>;
	try {
		written = await tauriWritePath(pathRec.path, content, expectedRevision, false);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.includes('disk conflict')) {
			try {
				const external = await tauriReadPath(pathRec.path);
				const resolution = await diskConflictStore.resolve({
					fileId: id,
					name,
					localContent: content,
					diskContent: external.content
				});
				if (resolution === 'cancel') {
					notify.info(t('disk.saveCancelled', { name }));
					return failedResult();
				}

				if (
					!(await checkpointDiskBranch(
						id,
						name,
						resolution === 'reload' ? content : external.content
					))
				)
					return failedResult();

				if (!sameDiskSource(id, file, content, name, deps)) {
					notify.error(t('files.otherTabChanges'));
					return failedResult();
				}
				if (resolution === 'reload') {
					const currentDisk = await tauriReadPath(pathRec.path);
					if (currentDisk.stat.revision !== external.stat.revision) {
						notify.error(t('files.otherTabChanges'));
						return failedResult();
					}
					try {
						await savePathLink(id, pathRec, epoch, external.stat.revision);
					} catch (error) {
						reportPersistenceError(error, 'save');
						return failedResult();
					}
					pendingDiskLinkWrites.delete(id);
					if (!sameDiskSource(id, file, content, name, deps)) return failedResult();
					applyDiskContent(id, file, external.content, deps);
					file.diskRevision = external.stat.revision;
					file.diskLastModified = external.stat.lastModified;
					file.diskSize = external.stat.size;
					return savedResult();
				}
				written = await tauriWritePath(pathRec.path, content, external.stat.revision, false);
			} catch (retryError) {
				return reportDesktopWriteFailure(file, retryError);
			}
		} else if (message.includes('capability expired')) {
			const picked = await tauriPickSaveTarget(name);
			if (!picked) return failedResult();
			if (durablePath !== null && picked.path !== durablePath) {
				try {
					await deleteHandle(id);
					durablePath = null;
					pendingDiskLinkWrites.delete(id);
					file.linkedToDisk = false;
				} catch (deleteError) {
					reportPersistenceError(deleteError, 'save');
					return failedResult();
				}
			}
			pathRec = picked;
			const selected = await tauriReadMeta(pathRec.path);
			try {
				written = await tauriWritePath(pathRec.path, content, selected?.revision ?? null, false);
			} catch (retryError) {
				return reportDesktopWriteFailure(file, retryError);
			}
		} else {
			return reportDesktopWriteFailure(file, err);
		}
	}
	try {
		await savePathLink(id, pathRec, epoch, written.revision);
		pendingDiskLinkWrites.delete(id);
	} catch (err) {
		return desktopLinkPersistenceFailure(
			id,
			file,
			pathRec,
			written.revision,
			epoch,
			durablePath,
			err,
			deps
		);
	}
	file.linkedToDisk = true;
	file.brokenLink = false;
	const current = deps.getFile(id);
	if (current?.content === content) current.dirty = false;
	file.diskLastModified = written.lastModified;
	file.diskSize = written.size;
	file.diskRevision = written.revision;
	const linkedName = pathBasename(pathRec.path);
	if (current === file && current.name === name && linkedName !== name) {
		deps.onSyncName?.(id, linkedName);
	}
	deps.scheduleSave(id);
	notify.success(t('disk.saved', { name: linkedName }));
	return savedResult();
}

function desktopLinkPersistenceFailure(
	id: string,
	file: FileItem,
	pathRec: { kind: 'path'; path: string },
	revision: string,
	epoch: string,
	durablePath: string | null,
	err: unknown,
	deps: DiskSyncDeps
): DiskSaveResult {
	pendingDiskLinkWrites.set(id, { kind: 'path', path: pathRec.path, revision, epoch });
	file.linkedToDisk = durablePath !== null;
	file.brokenLink = true;
	file.dirty = true;
	reportPersistenceError(err, 'save');
	deps.scheduleSave(id);
	return writtenLinkUnsavedResult();
}

function reportDesktopWriteFailure(file: FileItem, err: unknown): DiskSaveResult {
	file.brokenLink = true;
	notify.error(t('disk.saveFailed', { name: file.name }));
	reportError('saveToDisk', err);
	return failedResult();
}

/**
 * Writes the current content to a new target. The existing disk link, its
 * revision, and the source file stay unchanged. A target that resolves to the
 * linked source is refused so Save As cannot overwrite the original.
 */
export async function saveAsToDisk(id: string, deps: DiskSyncDeps): Promise<boolean> {
	if (!browser) return false;
	const file = deps.getFile(id);
	if (!file) return false;
	markDiskLinkChanged(id);
	try {
		if (isBinaryDocument(file)) {
			const { exportMarkdown } = await import('./services/export');
			return await exportMarkdown(file);
		}
		if (!isDiskLinkingAvailable()) return false;
		return isDesktop() ? await saveAsDesktop(id, file) : await saveAsFsa(id, file);
	} catch (error) {
		reportError('disk save as', error, { notifyUser: t('disk.saveAsFailed', { name: file.name }) });
		return false;
	}
}

async function saveAsFsa(id: string, file: FileItem): Promise<boolean> {
	if (!isFSASupported()) return false;
	const existing = await getFsaLink(id);
	const picked = await pickSaveTarget(file.name);
	if (!picked) {
		notify.info(t('disk.saveAsCancelled', { name: file.name }));
		return false;
	}
	if (existing && (await isSameFileHandle(existing.handle, picked))) {
		notify.error(t('disk.saveAsSameFile', { name: file.name }));
		return false;
	}
	await writeHandle(picked, file.content);
	notify.success(t('disk.savedAs', { name: picked.name || file.name }));
	return true;
}

async function saveAsDesktop(id: string, file: FileItem): Promise<boolean> {
	const existing = await getPathLink(id);
	let savedPath: string | null;
	try {
		savedPath = await tauriSaveExportText(file.content, file.name, existing?.path);
	} catch (error) {
		if (error instanceof Error && error.message.includes('save as source')) {
			notify.error(t('disk.saveAsSameFile', { name: file.name }));
			return false;
		}
		throw error;
	}
	if (!savedPath) {
		notify.info(t('disk.saveAsCancelled', { name: file.name }));
		return false;
	}
	notify.success(t('disk.savedAs', { name: pathBasename(savedPath) }));
	return true;
}

async function checkpointDiskBranch(id: string, name: string, content: string): Promise<boolean> {
	try {
		await createCheckpoint({ id, name, content });
		return true;
	} catch (error) {
		reportPersistenceError(error, 'save');
		return false;
	}
}

function sameDiskSource(
	id: string,
	file: FileItem,
	content: string,
	name: string,
	deps: DiskSyncDeps
): boolean {
	const current = deps.getFile(id);
	return current === file && current.content === content && current.name === name;
}

function applyDiskContent(id: string, file: FileItem, content: string, deps: DiskSyncDeps): void {
	if (deps.onUpdateContent) deps.onUpdateContent(id, content);
	else {
		file.content = content;
		file.updatedAt = Date.now();
	}
	file.dirty = false;
	file.brokenLink = false;
	deps.scheduleSave(id);
}

/**
 * Unlinks a file from its disk link. Deletes the FSA handle / path record from
 * IDB (`mdsh-fs`), then sets `linkedToDisk = false` on the FileItem and schedules
 * a save to persist this state.
 *
 * Always remove the IDB handle first - DiskLinksPanel relies on this guarantee
 * for orphans (handle stored without a file in the store).
 */
export async function unlinkFromDisk(id: string, deps: DiskSyncDeps): Promise<void> {
	markDiskLinkChanged(id);
	if (isDesktop()) {
		const link = await getPathLink(id);
		if (link) await tauriForgetPath(link.path);
	}
	await deleteHandle(id);
	pendingDiskLinkWrites.delete(id);
	const file = deps.getFile(id);
	if (!file) return;
	file.linkedToDisk = false;
	// Intentional unlink: clear the broken-link badge (sidebar keys on brokenLink alone).
	file.brokenLink = false;
	deps.scheduleSave(id);
}

/** Rename a linked file before the store commits its display name. */
export async function renameOnDisk(id: string, name: string, deps: DiskSyncDeps): Promise<boolean> {
	const file = deps.getFile(id);
	if (!browser || !file) return false;
	markDiskLinkChanged(id);
	try {
		if (!isDesktop()) {
			// Standard browser handles cannot rename files outside the private file system.
			await unlinkFromDisk(id, deps);
			notify.info(t('disk.renameUnlinked'));
			return true;
		}
		const link = await getPathLinkWithEpoch(id);
		if (!link) throw new Error('Disk link is missing');
		const renamed = await tauriRenamePath(
			link.record.path,
			name,
			file.diskRevision ?? link.revision ?? null
		);
		try {
			await savePathLink(
				id,
				{ kind: 'path', path: renamed.path },
				link.epoch,
				renamed.stat?.revision
			);
		} catch (error) {
			await tauriRenamePath(
				renamed.path,
				pathBasename(link.record.path),
				renamed.stat?.revision ?? null
			);
			throw error;
		}
		pendingDiskLinkWrites.delete(id);
		file.diskRevision = renamed.stat?.revision;
		file.brokenLink = false;
		return true;
	} catch (error) {
		reportError('rename disk file', error, {
			notifyUser: t('disk.renameFailed', { name: file.name })
		});
		return false;
	}
}

let brokenLinkScan = 0;
const linkVersions = new Map<string, number>();

/** Invalidates every pending health check, for example after a full reload. */
export function invalidateBrokenLinkChecks(): void {
	brokenLinkScan += 1;
}

/** Marks one document's link as changed so older checks cannot publish. */
export function markDiskLinkChanged(id: string): void {
	linkVersions.set(id, (linkVersions.get(id) ?? 0) + 1);
}

function linkVersion(id: string): number {
	return linkVersions.get(id) ?? 0;
}

function sameHandle(
	current: FileSystemFileHandle,
	checked: FileSystemFileHandle
): Promise<boolean> | boolean {
	if (current === checked) return true;
	if (typeof current.isSameEntry === 'function') return current.isSameEntry(checked);
	return current.name === checked.name && current.kind === checked.kind;
}

/**
 * Checks all `linkedToDisk` files: if the disk link is no longer resolvable
 * (file moved/deleted), flags `brokenLink: true` on the FileItem. If the link
 * no longer exists in IDB, also resets `linkedToDisk` to false.
 *
 * A result publishes only while its scan and the checked link are still
 * current, so a slower old path check cannot revoke a repaired link.
 */
export async function refreshBrokenLinks(
	files: readonly FileItem[],
	getFileMutable: (id: string) => FileItem | undefined
): Promise<void> {
	if (!browser || !isDiskLinkingAvailable()) return;
	const scan = ++brokenLinkScan;
	const versions = new Map(
		files.filter((file) => file.linkedToDisk).map((file) => [file.id, linkVersion(file.id)])
	);
	const updates = await computeBrokenLinks(files, {
		getHandleFn: getHandle,
		checkHandleFn: checkHandle,
		getPathLinkFn: getPathLink,
		checkPathFn: tauriCheckPath
	});
	if (scan !== brokenLinkScan) return;
	for (const u of updates) {
		if (versions.get(u.id) !== linkVersion(u.id)) continue;
		const file = getFileMutable(u.id);
		if (!file || !file.linkedToDisk) continue;
		// A written file whose link revision did not persist still needs a
		// visible repair state. A health check on the old link cannot clear it.
		if (pendingDiskLinkWrites.has(u.id)) {
			file.brokenLink = true;
			continue;
		}
		if (u.link.kind === 'path') {
			const current = await getPathLink(u.id).catch(() => null);
			if (!current || current.path !== u.link.path) continue;
		} else {
			const current = await getHandle(u.id).catch(() => null);
			if (u.link.handle) {
				if (!current || !(await sameHandle(current, u.link.handle))) continue;
			} else if (current) {
				// The IDB handle was restored or replaced after the check.
				continue;
			}
		}
		if (!file.linkedToDisk) continue;
		file.brokenLink = u.brokenLink;
		// If the handle no longer exists in IDB, we also unlink on the state side:
		// the file stays in the sidebar but loses its "linked" indicator.
		if (u.handleMissing) file.linkedToDisk = false;
	}
}

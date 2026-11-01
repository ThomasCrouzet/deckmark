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

/** True when either Chromium FSA or the Tauri desktop shell can link files to disk. */
export function isDiskLinkingAvailable(): boolean {
	return isFSASupported() || isDesktop();
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
	for (const file of picked) {
		if (!(await session.pause())) break;
		let createdItem: FileItem | undefined;
		try {
			const epoch = await getDiskLinkEpoch();
			let existing: FileItem | undefined;
			for (const candidate of deps.getFiles?.() ?? []) {
				if ((await getPathLink(candidate.id))?.path === file.path) {
					existing = candidate;
					break;
				}
			}
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
				const token = file.token ?? picked.find((entry) => entry.path === file.path)?.token;
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

/**
 * Saves a file to disk via FSA or path link. If a link already exists (file
 * already linked), reuses it (with a permission check on FSA). Otherwise, opens
 * a native save dialog.
 *
 * Updates `linkedToDisk`, `brokenLink`, `dirty` on the FileItem, then calls
 * `scheduleSave` to persist the state to Dexie.
 *
 * @returns `true` if the write succeeded, `false` otherwise (backend absent,
 *   cancelled, permission denied, or write failure). A toast confirms success
 *   or reports the failure (§J3) - the error is no longer propagated to the caller.
 */
export async function saveToDisk(id: string, deps: DiskSyncDeps): Promise<boolean> {
	if (!browser || !isDiskLinkingAvailable()) return false;
	const file = deps.getFile(id);
	if (!file) return false;

	try {
		if (isDesktop()) return await saveToDiskDesktop(id, file, deps);
		return await saveToDiskFsa(id, file, deps);
	} catch (error) {
		reportError('disk save', error, { notifyUser: t('disk.saveFailed', { name: file.name }) });
		return false;
	}
}

async function saveToDiskFsa(id: string, file: FileItem, deps: DiskSyncDeps): Promise<boolean> {
	if (!isFSASupported()) return false;
	const content = file.content;
	const name = file.name;
	let existingLink: Awaited<ReturnType<typeof getFsaLink>>;
	let epoch: string;
	try {
		existingLink = await getFsaLink(id);
		epoch = existingLink?.epoch ?? (await getDiskLinkEpoch());
	} catch (err) {
		reportPersistenceError(err, 'load');
		return false;
	}
	let handle = existingLink?.handle ?? null;
	const hadLink = handle !== null;
	let reviewedRevision: string | null = null;
	if (handle && existingLink) {
		const ok = await requestPermission(handle, 'readwrite');
		if (!ok) return false;
		let onDiskRevision: string;
		let onDiskFile: File;
		try {
			onDiskFile = await handle.getFile();
			onDiskRevision = await revisionForFile(onDiskFile);
		} catch (err) {
			file.brokenLink = true;
			notify.error(t('disk.saveFailed', { name }));
			reportError('disk revision check', err);
			return false;
		}
		if (existingLink.revision === null || onDiskRevision !== existingLink.revision) {
			let diskContent: string;
			try {
				diskContent = await readUtf8File(onDiskFile, IMPORT_LIMITS.maxFileBytes, undefined, true);
				validateMarkdownContent(diskContent);
			} catch (error) {
				reportError('disk comparison read', error, { notifyUser: t('disk.saveFailed', { name }) });
				return false;
			}
			const resolution = await diskConflictStore.resolve({
				name,
				localContent: content,
				diskContent
			});
			if (resolution === 'cancel') {
				notify.info(t('disk.saveCancelled', { name }));
				return false;
			}

			if (!(await checkpointDiskBranch(id, name, resolution === 'reload' ? content : diskContent)))
				return false;

			if (
				!sameDiskSource(id, file, content, name, deps) ||
				(await revisionForFile(await handle.getFile())) !== onDiskRevision
			) {
				notify.error(t('files.otherTabChanges'));
				return false;
			}
			if (resolution === 'reload') {
				try {
					await saveHandle(id, handle, onDiskRevision, epoch);
				} catch (error) {
					reportPersistenceError(error, 'save');
					return false;
				}
				if (!sameDiskSource(id, file, content, name, deps)) return false;
				applyDiskContent(id, file, diskContent, deps);
				file.diskLastModified = onDiskFile.lastModified;
				file.diskSize = onDiskFile.size;
				return true;
			}
		}
		reviewedRevision = onDiskRevision;
	} else {
		const picked = await pickSaveTarget(name);
		if (!picked) return false;
		handle = picked;
	}
	let writtenRevision: string;
	try {
		writtenRevision = await revisionForText(content);
	} catch (err) {
		notify.error(t('disk.saveFailed', { name }));
		reportError('disk revision', err);
		return false;
	}
	try {
		if (reviewedRevision && (await revisionForFile(await handle.getFile())) !== reviewedRevision) {
			notify.error(t('files.otherTabChanges'));
			return false;
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
		return false;
	}
	try {
		await saveHandle(id, handle, writtenRevision, epoch);
		file.linkedToDisk = true;
	} catch (err) {
		file.linkedToDisk = hadLink;
		reportPersistenceError(err, 'save');
	}
	file.brokenLink = false;
	const current = deps.getFile(id);
	if (current?.content === content) current.dirty = false;
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
	notify.success(t('disk.saved', { name: handle.name || name }));
	return true;
}

async function saveToDiskDesktop(id: string, file: FileItem, deps: DiskSyncDeps): Promise<boolean> {
	const content = file.content;
	const name = file.name;
	let existingLink: Awaited<ReturnType<typeof getPathLinkWithEpoch>>;
	let epoch: string;
	try {
		existingLink = await getPathLinkWithEpoch(id);
		epoch = existingLink?.epoch ?? (await getDiskLinkEpoch());
	} catch (err) {
		reportPersistenceError(err, 'load');
		return false;
	}
	let pathRec = existingLink?.record ?? null;
	let expectedRevision = file.diskRevision ?? existingLink?.revision ?? null;
	let persistedPath = pathRec?.path ?? null;
	if (!pathRec) {
		const picked = await tauriPickSaveTarget(name);
		if (!picked) return false;
		pathRec = picked;
		const selected = await tauriReadMeta(pathRec.path);
		file.diskRevision = selected?.revision;
		expectedRevision = selected?.revision ?? null;
	}
	let written;
	try {
		written = await tauriWritePath(pathRec.path, content, expectedRevision, false);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.includes('disk conflict')) {
			try {
				const external = await tauriReadPath(pathRec.path);
				const resolution = await diskConflictStore.resolve({
					name,
					localContent: content,
					diskContent: external.content
				});
				if (resolution === 'cancel') {
					notify.info(t('disk.saveCancelled', { name }));
					return false;
				}

				if (
					!(await checkpointDiskBranch(
						id,
						name,
						resolution === 'reload' ? content : external.content
					))
				)
					return false;

				if (!sameDiskSource(id, file, content, name, deps)) {
					notify.error(t('files.otherTabChanges'));
					return false;
				}
				if (resolution === 'reload') {
					const currentDisk = await tauriReadPath(pathRec.path);
					if (currentDisk.stat.revision !== external.stat.revision) {
						notify.error(t('files.otherTabChanges'));
						return false;
					}
					try {
						await savePathLink(id, pathRec, epoch, external.stat.revision);
					} catch (error) {
						reportPersistenceError(error, 'save');
						return false;
					}
					if (!sameDiskSource(id, file, content, name, deps)) return false;
					applyDiskContent(id, file, external.content, deps);
					file.diskRevision = external.stat.revision;
					file.diskLastModified = external.stat.lastModified;
					file.diskSize = external.stat.size;
					return true;
				}
				written = await tauriWritePath(pathRec.path, content, external.stat.revision, false);
			} catch (retryError) {
				return reportDesktopWriteFailure(file, retryError);
			}
		} else if (message.includes('capability expired')) {
			const picked = await tauriPickSaveTarget(name);
			if (!picked) return false;
			if (persistedPath !== null && picked.path !== persistedPath) {
				try {
					await deleteHandle(id);
					persistedPath = null;
					file.linkedToDisk = false;
				} catch (deleteError) {
					reportPersistenceError(deleteError, 'save');
					return false;
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
		persistedPath = pathRec.path;
	} catch (err) {
		reportPersistenceError(err, 'save');
	}
	file.linkedToDisk = persistedPath !== null;
	file.brokenLink = false;
	const current = deps.getFile(id);
	if (current?.content === content) current.dirty = false;
	file.diskLastModified = written.lastModified;
	file.diskSize = written.size;
	file.diskRevision = written.revision;
	const linkedName = pathBasename(pathRec.path);
	if (
		persistedPath === pathRec.path &&
		current === file &&
		current.name === name &&
		linkedName !== name
	) {
		deps.onSyncName?.(id, linkedName);
	}
	deps.scheduleSave(id);
	notify.success(t('disk.saved', { name: linkedName }));
	return true;
}

function reportDesktopWriteFailure(file: FileItem, err: unknown): false {
	file.brokenLink = true;
	notify.error(t('disk.saveFailed', { name: file.name }));
	reportError('saveToDisk', err);
	return false;
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
	if (isDesktop()) {
		const link = await getPathLink(id);
		if (link) await tauriForgetPath(link.path);
	}
	await deleteHandle(id);
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

/**
 * Checks all `linkedToDisk` files: if the disk link is no longer resolvable
 * (file moved/deleted), flags `brokenLink: true` on the FileItem. If the link
 * no longer exists in IDB, also resets `linkedToDisk` to false.
 *
 * Pure delegation to `computeBrokenLinks` (testable helper). No-op on SSR
 * when neither FSA nor desktop is available.
 */
export async function refreshBrokenLinks(
	files: readonly FileItem[],
	getFileMutable: (id: string) => FileItem | undefined
): Promise<void> {
	if (!browser || !isDiskLinkingAvailable()) return;
	const updates = await computeBrokenLinks(files, {
		getHandleFn: getHandle,
		checkHandleFn: checkHandle,
		getPathLinkFn: getPathLink,
		checkPathFn: tauriCheckPath
	});
	for (const u of updates) {
		const file = getFileMutable(u.id);
		if (!file) continue;
		file.brokenLink = u.brokenLink;
		// If the handle no longer exists in IDB, we also unlink on the state side:
		// the file stays in the sidebar but loses its "linked" indicator.
		if (u.handleMissing) file.linkedToDisk = false;
	}
}

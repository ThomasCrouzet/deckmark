import { ImportSession, type ImportOptions, type ImportReport } from './import-limits';
import { IMPORT_LIMITS } from './config';
import { browser } from '$app/env';
import { t } from '#lib/i18n/index.js';
import { getDiskLinkEpoch, LEGACY_DISK_LINK_EPOCH } from './db';
import {
	isPathLinkRecord,
	isStoredFsaLinkRecord,
	pathBasename,
	type PathLinkRecord,
	type StoredPathLinkRecord
} from './disk-link';

export interface StoredHandle {
	id: string;
	handle: FileSystemFileHandle;
}

export interface FsaLinkRecord {
	handle: FileSystemFileHandle;
	revision: string | null;
	epoch: string;
}

export interface PathLinkWithEpoch {
	record: PathLinkRecord;
	epoch: string;
	revision?: string;
}

/** Unified disk link entry for DiskLinksPanel / broken-link checks. */
export type StoredDiskLink =
	| {
			id: string;
			kind: 'fsa';
			handle: FileSystemFileHandle;
			label: string;
	  }
	| { id: string; kind: 'path'; path: string; label: string };

const HANDLE_DB = 'mdsh-fs';
const HANDLE_STORE = 'handles';

// §A2.7 - IDB connection cache. Previously each saveHandle / getHandle /
// deleteHandle opened + closed the DB → N open/close cycles on load plus a
// listHandles that reopened it for nothing. We keep a single live connection
// (IDB's `onclose` nullifies it if the DB is versioned outside the app, which
// should not happen for mdsh-fs).
let _handleDb: IDBDatabase | null = null;
let _handleDbPromise: Promise<IDBDatabase> | null = null;

function openHandleDB(): Promise<IDBDatabase> {
	if (_handleDb) return Promise.resolve(_handleDb);
	if (_handleDbPromise) return _handleDbPromise;
	_handleDbPromise = new Promise((resolve, reject) => {
		const req = indexedDB.open(HANDLE_DB, 1);
		req.onupgradeneeded = () => {
			req.result.createObjectStore(HANDLE_STORE);
		};
		req.onsuccess = () => {
			_handleDb = req.result;
			// If the DB is closed by another tab (versionchange) or aborted, we
			// invalidate the cache to force a clean reopen on the next call.
			_handleDb.onclose = () => {
				_handleDb = null;
				_handleDbPromise = null;
			};
			_handleDb.onversionchange = () => {
				_handleDb?.close();
				_handleDb = null;
				_handleDbPromise = null;
			};
			resolve(_handleDb);
		};
		req.onerror = () => {
			_handleDbPromise = null;
			reject(req.error);
		};
	});
	return _handleDbPromise;
}

export function isFSASupported(): boolean {
	return browser && 'showOpenFilePicker' in window && 'showSaveFilePicker' in window;
}

/** §2.3 - Directory picker support (Chromium only, like the rest of FSA). */
export function isDirectoryPickerSupported(): boolean {
	return browser && 'showDirectoryPicker' in window;
}

const MD_FILE_RE = /\.(md|markdown|mdx|txt)$/i;

async function collectMarkdownFiles(
	dir: MdshDirectoryHandle,
	out: Array<{ name: string; content: string }>,
	depth: number,
	session: ImportSession
): Promise<void> {
	if (depth > IMPORT_LIMITS.maxDepth) {
		session.fail(dir.name, 'depth');
		return;
	}
	for await (const entry of dir.values()) {
		if (!(await session.pause())) return;
		if (session.report.imported >= IMPORT_LIMITS.maxFiles) {
			session.fail(entry.name, 'file-count');
			return;
		}
		if (entry.kind === 'file') {
			if (!MD_FILE_RE.test(entry.name)) {
				session.skip();
				continue;
			}
			let file: File;
			try {
				file = await entry.getFile();
			} catch {
				session.fail(entry.name, 'read');
				continue;
			}
			const content = await session.read(file);
			if (content !== null) {
				out.push({ name: entry.name, content });
				session.accept();
			}
		} else {
			if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
			await collectMarkdownFiles(entry, out, depth + 1, session);
		}
	}
}

export async function pickDirectoryFiles(options: ImportOptions = {}): Promise<{
	files: Array<{ name: string; content: string }>;
	truncated: boolean;
	report: ImportReport;
}> {
	const session = new ImportSession(options);
	const files: Array<{ name: string; content: string }> = [];
	if (isDirectoryPickerSupported() && window.showDirectoryPicker && !session.cancelled) {
		try {
			const dir = await window.showDirectoryPicker({ mode: 'read' });
			await collectMarkdownFiles(dir, files, 0, session);
		} catch (err) {
			if ((err as Error).name !== 'AbortError') throw err;
			session.report.cancelled = true;
		}
	}
	return {
		files,
		truncated: session.report.failed > 0 || session.cancelled,
		report: session.publish()
	};
}

export async function saveHandle(
	id: string,
	handle: FileSystemFileHandle,
	revision: string | null = null,
	capturedEpoch?: string
): Promise<void> {
	if (!browser) return;
	const epoch = capturedEpoch ?? (await getDiskLinkEpoch());
	const db = await openHandleDB();
	await new Promise<void>((resolve, reject) => {
		const tx = db.transaction(HANDLE_STORE, 'readwrite');
		tx.objectStore(HANDLE_STORE).put({ kind: 'fsa', handle, revision, epoch }, id);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

/** Persists a path-based disk link (desktop). Overwrites any prior FSA handle. */
export async function savePathLink(
	id: string,
	record: PathLinkRecord,
	capturedEpoch?: string,
	revision?: string
): Promise<void> {
	if (!browser) return;
	const epoch = capturedEpoch ?? (await getDiskLinkEpoch());
	const db = await openHandleDB();
	await new Promise<void>((resolve, reject) => {
		const tx = db.transaction(HANDLE_STORE, 'readwrite');
		tx.objectStore(HANDLE_STORE).put({ ...record, epoch, ...(revision ? { revision } : {}) }, id);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

async function getStoredLink(id: string): Promise<unknown> {
	const db = await openHandleDB();
	return new Promise<unknown>((resolve, reject) => {
		const tx = db.transaction(HANDLE_STORE, 'readonly');
		const req = tx.objectStore(HANDLE_STORE).get(id);
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

function matchesEpoch(value: unknown, epoch: string): boolean {
	if (isStoredFsaLinkRecord(value)) return value.epoch === epoch;
	if (isPathLinkRecord(value)) {
		const stored = value as StoredPathLinkRecord;

		return (
			stored.epoch === epoch || (stored.epoch === undefined && epoch === LEGACY_DISK_LINK_EPOCH)
		);
	}
	return value != null && epoch === LEGACY_DISK_LINK_EPOCH;
}

export async function getFsaLink(id: string): Promise<FsaLinkRecord | null> {
	if (!browser) return null;
	const [value, epoch] = await Promise.all([getStoredLink(id), getDiskLinkEpoch()]);
	if (!matchesEpoch(value, epoch) || isPathLinkRecord(value)) return null;
	if (isStoredFsaLinkRecord(value)) {
		return { handle: value.handle, revision: value.revision, epoch: value.epoch };
	}
	return { handle: value as FileSystemFileHandle, revision: null, epoch };
}

export async function getHandle(id: string): Promise<FileSystemFileHandle | null> {
	return (await getFsaLink(id))?.handle ?? null;
}

export async function getPathLink(id: string): Promise<PathLinkRecord | null> {
	return (await getPathLinkWithEpoch(id))?.record ?? null;
}

export async function getPathLinkWithEpoch(id: string): Promise<PathLinkWithEpoch | null> {
	if (!browser) return null;
	const [value, epoch] = await Promise.all([getStoredLink(id), getDiskLinkEpoch()]);
	if (!matchesEpoch(value, epoch) || !isPathLinkRecord(value)) return null;
	const revision = (value as StoredPathLinkRecord).revision;
	return {
		record: { kind: 'path', path: value.path },
		epoch,
		...(typeof revision === 'string' ? { revision } : {})
	};
}

export async function revisionForText(content: string): Promise<string> {
	const bytes = new TextEncoder().encode(content);
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, '0')
	).join('')}`;
}

export async function revisionForFile(file: File): Promise<string> {
	let buffer: ArrayBuffer;
	if (typeof file.arrayBuffer === 'function') {
		buffer = await file.arrayBuffer();
	} else {
		buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(reader.result as ArrayBuffer);
			reader.onerror = () => reject(reader.error);
			reader.readAsArrayBuffer(file);
		});
	}
	const digest = await crypto.subtle.digest('SHA-256', buffer);
	return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, '0')
	).join('')}`;
}

export async function deleteHandle(id: string): Promise<void> {
	if (!browser) return;
	const db = await openHandleDB();
	await new Promise<void>((resolve, reject) => {
		const tx = db.transaction(HANDLE_STORE, 'readwrite');
		tx.objectStore(HANDLE_STORE).delete(id);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

export async function requestPermission(
	handle: FileSystemFileHandle,
	mode: 'read' | 'readwrite' = 'readwrite'
): Promise<boolean> {
	if (!handle.queryPermission || !handle.requestPermission) return false;
	const opts = { mode };
	const query = await handle.queryPermission(opts);
	if (query === 'granted') return true;
	const request = await handle.requestPermission(opts);
	return request === 'granted';
}

export async function pickAndOpen(): Promise<Array<{ handle: FileSystemFileHandle; file: File }>> {
	if (!isFSASupported() || !window.showOpenFilePicker) return [];
	try {
		const handles = await window.showOpenFilePicker({
			multiple: true,
			types: [
				{
					description: t('disk.fileFilter'),
					accept: {
						'text/markdown': ['.md', '.markdown', '.mdx'],
						'text/plain': ['.txt']
					}
				}
			]
		});
		const out: Array<{ handle: FileSystemFileHandle; file: File }> = [];
		for (const h of handles) {
			const file = await h.getFile();
			out.push({ handle: h, file });
		}
		return out;
	} catch (err) {
		if ((err as Error).name === 'AbortError') return [];
		throw err;
	}
}

export async function pickSaveTarget(suggestedName: string): Promise<FileSystemFileHandle | null> {
	if (!isFSASupported() || !window.showSaveFilePicker) return null;
	try {
		return await window.showSaveFilePicker({
			suggestedName,
			types: [
				{
					description: t('disk.fileFilter'),
					accept: { 'text/markdown': ['.md'] }
				}
			]
		});
	} catch (err) {
		if ((err as Error).name === 'AbortError') return null;
		throw err;
	}
}

export async function writeHandle(handle: FileSystemFileHandle, content: string): Promise<void> {
	if (!handle.createWritable) throw new Error('createWritable not supported');
	const writable = await handle.createWritable();
	await writable.write(content);
	await writable.close();
}

/**
 * Lists all `FileSystemFileHandle`s stored in IDB (`mdsh-fs.handles`).
 * Returns a `{ id, handle }` array ordered by IDB's internal order (insertion
 * order for an object store without an index).
 *
 * Propagates IndexedDB errors so callers can show a retry action.
 */
export async function listHandles(): Promise<Array<{ id: string; handle: FileSystemFileHandle }>> {
	const all = await listDiskLinks();
	return all
		.filter((e): e is Extract<StoredDiskLink, { kind: 'fsa' }> => e.kind === 'fsa')
		.map(({ id, handle }) => ({ id, handle }));
}

/**
 * Lists every disk link (FSA handles + desktop path records) stored in IDB.
 * Propagates IndexedDB errors so callers do not confuse a load failure with
 * an empty link collection.
 */
export async function listDiskLinks(): Promise<StoredDiskLink[]> {
	if (!browser) return [];
	const [db, epoch] = await Promise.all([openHandleDB(), getDiskLinkEpoch()]);
	const entries = await new Promise<StoredDiskLink[]>((resolve, reject) => {
		const tx = db.transaction(HANDLE_STORE, 'readonly');
		const store = tx.objectStore(HANDLE_STORE);
		const out: StoredDiskLink[] = [];
		const req = store.openCursor();
		req.onsuccess = () => {
			const cursor = req.result;
			if (cursor) {
				const id = String(cursor.key);
				const value = cursor.value;
				if (!matchesEpoch(value, epoch)) {
					cursor.continue();
					return;
				}
				if (isPathLinkRecord(value)) {
					out.push({
						id,
						kind: 'path',
						path: value.path,
						label: pathBasename(value.path) || value.path
					});
				} else if (value != null) {
					const handle = isStoredFsaLinkRecord(value)
						? value.handle
						: (value as FileSystemFileHandle);
					const name = typeof handle.name === 'string' && handle.name.length > 0 ? handle.name : id;
					out.push({ id, kind: 'fsa', handle, label: name });
				}
				cursor.continue();
			} else {
				resolve(out);
			}
		};
		req.onerror = () => reject(req.error);
	});
	return entries;
}

/**
 * Checks whether a handle still points to an accessible file.
 *
 * - `'ok'`: readwrite permission already granted and `getFile()` succeeds.
 * - `'permission-needed'`: the handle is valid but the user must re-authorize
 *   access (revocation after reload on Chrome, for example).
 * - `'broken'`: `getFile()` throws NotFoundError or other - file
 *   moved/deleted/disk ejected. The user must unlink.
 *
 * No side-effect (no user prompt): we use `queryPermission`, which returns the
 * current state without showing a dialog. The UI's "Check" button must be able
 * to run repeatedly without bothering the user.
 */
export async function checkHandle(
	handle: FileSystemFileHandle
): Promise<'ok' | 'permission-needed' | 'broken'> {
	if (!handle.queryPermission) return 'broken';
	try {
		const perm = await handle.queryPermission({ mode: 'readwrite' });
		if (perm !== 'granted') return 'permission-needed';
	} catch {
		return 'broken';
	}
	// Permission OK; we try to read the file to validate it still exists.
	// Without this call, a file deleted after authorization would pass as 'ok'
	// until the next write.
	try {
		await handle.getFile();
		return 'ok';
	} catch {
		return 'broken';
	}
}

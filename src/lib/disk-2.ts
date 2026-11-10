import { db } from './db';
import {
	getFsaLink,
	getPathLinkWithEpoch,
	isSameFileHandle,
	listDiskLinks,
	saveHandle,
	savePathLink
} from './fsa';
import type { PathLinkRecord } from './disk-link';

/**
 * Cross-tab fence for the disk-link store. The `mdsh` and `mdsh-fs` databases
 * cannot share one transaction, so a lock and a durable per-link generation
 * decide which operation may still act on a link record.
 *
 * Every link write takes the document lock (and the path lock for path links).
 * Cleanup and unlink take the same locks before they read, delete or revoke.
 */
const LINK_LOCK_PREFIX = 'mdsh-disk-link:';
const PATH_LOCK_PREFIX = 'mdsh-disk-path:';
const GENERATION_PREFIX = 'disk-link-generation:';

const fallbackTails = new Map<string, Promise<void>>();

async function withFallbackLock<T>(name: string, run: () => Promise<T>): Promise<T> {
	const previous = fallbackTails.get(name) ?? Promise.resolve();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const tail = previous.then(() => gate);
	fallbackTails.set(name, tail);
	await previous.catch(() => {});
	try {
		return await run();
	} finally {
		release();
		if (fallbackTails.get(name) === tail) fallbackTails.delete(name);
	}
}

async function withNamedLock<T>(name: string, run: () => Promise<T>): Promise<T> {
	const locks =
		typeof navigator !== 'undefined' && 'locks' in navigator ? navigator.locks : undefined;
	if (!locks) return withFallbackLock(name, run);
	return locks.request(name, { mode: 'exclusive' }, run);
}

/** Serializes every writer and cleanup job for one document id. */
export function withDiskLinkLock<T>(id: string, run: () => Promise<T>): Promise<T> {
	return withNamedLock(`${LINK_LOCK_PREFIX}${id}`, run);
}

/** Serializes operations that can revoke a shared native path grant. */
export function withDiskLinkPathLock<T>(path: string, run: () => Promise<T>): Promise<T> {
	return withNamedLock(`${PATH_LOCK_PREFIX}${path}`, run);
}

/** Durable operation generation for one link record. */
export async function readDiskLinkGeneration(id: string): Promise<number> {
	const row = await db.metadata.get(`${GENERATION_PREFIX}${id}`);
	const value = Number(row?.value);
	return Number.isFinite(value) ? value : 0;
}

/** Marks a new link write before its record reaches `mdsh-fs`. */
export async function bumpDiskLinkGeneration(id: string): Promise<number> {
	return db.transaction('rw', db.metadata, async () => {
		const key = `${GENERATION_PREFIX}${id}`;
		const row = await db.metadata.get(key);
		const next = (Number(row?.value) || 0) + 1;
		await db.metadata.put({ key, value: String(next) });
		return next;
	});
}

export type DiskLinkSnapshot =
	| { kind: 'path'; path: string; epoch: string; revision?: string }
	| { kind: 'fsa'; handle: FileSystemFileHandle; epoch: string; revision: string | null };

/** Captures the exact link record that an operation may later delete or revoke. */
export async function readDiskLinkSnapshot(id: string): Promise<DiskLinkSnapshot | null> {
	const path = await getPathLinkWithEpoch(id);
	if (path) {
		return {
			kind: 'path',
			path: path.record.path,
			epoch: path.epoch,
			...(path.revision ? { revision: path.revision } : {})
		};
	}
	const fsa = await getFsaLink(id);
	if (!fsa) return null;
	return { kind: 'fsa', handle: fsa.handle, epoch: fsa.epoch, revision: fsa.revision };
}

/** True while the stored link is still the one captured by the caller. */
export async function isDiskLinkSnapshotCurrent(
	id: string,
	snapshot: DiskLinkSnapshot
): Promise<boolean> {
	const current = await readDiskLinkSnapshot(id);
	if (!current || current.kind !== snapshot.kind) return false;
	if (current.epoch !== snapshot.epoch) return false;
	if (current.kind === 'path' && snapshot.kind === 'path') {
		return current.path === snapshot.path && current.revision === snapshot.revision;
	}
	if (current.kind === 'fsa' && snapshot.kind === 'fsa') {
		return (
			current.revision === snapshot.revision &&
			(await isSameFileHandle(current.handle, snapshot.handle))
		);
	}
	return false;
}

/** True when any document still holds a link to the native path. */
export async function pathHasLink(path: string): Promise<boolean> {
	return (await listDiskLinks()).some((link) => link.kind === 'path' && link.path === path);
}

/**
 * Revokes a native path grant only after every queued relink had a chance to
 * write its record. The path lock is acquired again after the caller released
 * the document lock, so a writer that started before the unlink finishes first.
 */
export async function revokeUnownedPath(
	path: string,
	revoke: (path: string) => Promise<void>
): Promise<void> {
	await withDiskLinkPathLock(path, async () => {
		if (await pathHasLink(path)) return;
		await revoke(path);
	});
}

/** Writes an FSA link under the cross-tab document fence. */
export async function saveFencedHandle(
	id: string,
	handle: FileSystemFileHandle,
	revision: string | null,
	epoch: string
): Promise<void> {
	return withDiskLinkLock(id, async () => {
		await bumpDiskLinkGeneration(id);
		await saveHandle(id, handle, revision, epoch);
	});
}

/** Writes a native path link under the document and path fences. */
export async function saveFencedPathLink(
	id: string,
	record: PathLinkRecord,
	epoch: string,
	revision?: string
): Promise<void> {
	return withDiskLinkLock(id, () =>
		withDiskLinkPathLock(record.path, async () => {
			await bumpDiskLinkGeneration(id);
			await savePathLink(id, record, epoch, revision);
		})
	);
}

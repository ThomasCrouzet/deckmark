import { db } from './db';
import { deleteHandle } from './fsa';
import { isDesktop } from './desktop';
import { tauriForgetPath } from './disk-tauri';
import {
	isDiskLinkSnapshotCurrent,
	readDiskLinkGeneration,
	readDiskLinkSnapshot,
	revokeUnownedPath,
	withDiskLinkLock
} from './disk-2';

let cleanupTail = Promise.resolve();

async function hasOwner(id: string): Promise<boolean> {
	return db.transaction('r', db.drafts, db.trashed, async () => {
		return Boolean((await db.drafts.get(id)) ?? (await db.trashed.get(id)));
	});
}

async function removeUnownedLink(id: string): Promise<void> {
	let pathToRevoke: string | null = null;
	await withDiskLinkLock(id, async () => {
		if (await hasOwner(id)) return;
		const generation = await readDiskLinkGeneration(id);
		const snapshot = await readDiskLinkSnapshot(id);
		if (!snapshot) {
			// No usable record for the current epoch. Remove any stale record that
			// an older epoch left behind, unless a new write rotated the generation.
			if ((await readDiskLinkGeneration(id)) !== generation) return;
			await deleteHandle(id);
			return;
		}
		// A restore, import or relink can win between the first owner read and
		// this step. Recheck the owner, the durable generation and the exact
		// record before the delete.
		if (await hasOwner(id)) return;
		if ((await readDiskLinkGeneration(id)) !== generation) return;
		if (!(await isDiskLinkSnapshotCurrent(id, snapshot))) return;
		await deleteHandle(id);
		if (snapshot.kind === 'path' && isDesktop()) pathToRevoke = snapshot.path;
	});
	// The document lock is released before the grant is revoked, so a relink
	// that was already queued on this path writes its record first.
	if (pathToRevoke) await revokeUnownedPath(pathToRevoke, tauriForgetPath);
}

/** Removes a disk link after its document leaves the trash. */
export function deleteUnownedDiskLink(id: string): Promise<void> {
	// Process links in order so the last shared link revokes the native grant.
	const cleanup = cleanupTail.then(() => removeUnownedLink(id));
	// A failed link must not block later cleanup. The caller reports the error.
	cleanupTail = cleanup.catch(() => {});
	return cleanup;
}

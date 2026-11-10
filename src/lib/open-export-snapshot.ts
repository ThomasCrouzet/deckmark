import type { FileItem } from './types';

/**
 * Captures the open-tab membership, hydrates exactly those ids, and returns a
 * coherent snapshot for Export Open. A missing or unreadable body returns null
 * so the caller refuses to build an incomplete archive.
 */
export async function openExportSnapshot(
	files: readonly FileItem[],
	ensureContent: (ids: string[]) => Promise<void>
): Promise<FileItem[] | null> {
	const ids = files.map((file) => file.id);
	if (ids.length === 0) return [];
	try {
		await ensureContent(ids);
	} catch {
		return null;
	}
	const openIds = new Set(ids);
	const snapshot = files.filter((file) => openIds.has(file.id));
	return snapshot.some((file) => file.contentDeferred) ? null : snapshot;
}

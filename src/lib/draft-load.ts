// Loads the durable draft library without materializing every body.
//
// This module is imported on demand by the store. It keeps the manifest scan,
// the body budget, and the full-row fallback out of the boot bundle.

import { db, type DraftRow } from './db';
import { isFSASupported, listDiskLinks } from './fsa';
import { isDesktop } from './desktop';
import {
	draftItemFromManifest,
	draftItemFromRow,
	readDraftManifests,
	selectInlineContentIds
} from './draft-manifest';
import type { FileItem } from './types';

export interface LoadedDraftLibrary {
	files: FileItem[];
	closedFiles: FileItem[];
	activeId: string | null;
	/** Rows whose durable baseline the save queue must track. */
	persistedRows: DraftRow[];
}

export async function loadDraftLibrary(
	preferredActiveId: string | null,
	fallbackActiveId: string | null
): Promise<LoadedDraftLibrary> {
	const linkedIds = new Set<string>();
	if (isFSASupported() || isDesktop()) {
		const links = await listDiskLinks();
		for (const link of links) {
			if (link.kind === 'path' || isFSASupported()) linkedIds.add(link.id);
		}
	}

	let manifests = await readDraftManifests();
	let items: FileItem[] = [];
	let activeIds: string[] = [];
	let persistedRows: DraftRow[] = [];
	if (manifests) {
		try {
			const inlineIds = selectInlineContentIds(manifests);
			const rows = (await db.drafts.bulkGet([...inlineIds])).filter(
				(row): row is DraftRow => row !== undefined
			);
			const byId = new Map(rows.map((row) => [row.id, row]));
			// An open tab is always hydrated. If a row vanished between the count
			// and the read, use the full-row path so the view cannot show an empty
			// active document.
			if (manifests.some((manifest) => manifest.open && !byId.has(manifest.id)))
				throw new Error('draft-manifest-stale');
			items = manifests
				.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
				.map((manifest) => {
					const row = byId.get(manifest.id);
					return row
						? draftItemFromRow(row, linkedIds.has(row.id))
						: draftItemFromManifest(manifest, linkedIds.has(manifest.id));
				});
			activeIds = manifests.filter((manifest) => manifest.open).map((manifest) => manifest.id);
			persistedRows = rows;
		} catch {
			manifests = null;
		}
	}
	if (!manifests) {
		const rows = await db.drafts.orderBy('order').toArray();
		items = rows.map((row) => draftItemFromRow(row, linkedIds.has(row.id)));
		activeIds = rows.filter((row) => row.open !== false).map((row) => row.id);
		persistedRows = rows;
	}

	const openIds = new Set(activeIds);
	const files = items.filter((item) => openIds.has(item.id));
	const closedFiles = items.filter((item) => !openIds.has(item.id));
	const requestedActiveId =
		preferredActiveId && files.some((file) => file.id === preferredActiveId)
			? preferredActiveId
			: fallbackActiveId;
	const activeId =
		requestedActiveId && files.some((file) => file.id === requestedActiveId)
			? requestedActiveId
			: (files[0]?.id ?? null);
	return { files, closedFiles, activeId, persistedRows };
}

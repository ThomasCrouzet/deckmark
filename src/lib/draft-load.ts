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
	readDraftMetadata,
	selectActiveManifestId,
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

	// The projection hooks stay out of the boot bundle. Install them before
	// publishing any row, then fill projections written before this version.
	const hooks = await import('./draft-metadata');
	hooks.installDraftMetadataHooks();
	const snippetHooks = await import('./snippet-hooks');
	snippetHooks.installSnippetHooks();
	const trashHooks = await import('./trash-summary-hooks');
	trashHooks.installTrashSummaryHooks();
	void trashHooks.backfillTrashSummaries().catch(() => undefined);
	let manifests = await readDraftManifests();
	const metadata = manifests ? await readDraftMetadata() : null;
	if (manifests && !metadata) {
		// The projection is incomplete (for example rows written by another
		// client or before this version). Keep the full-row fallback for this
		// boot and fill the projection in the background for the next one.
		manifests = null;
		void hooks.backfillDraftMetadata().catch(() => undefined);
	}
	let items: FileItem[] = [];
	let activeIds: string[] = [];
	let persistedRows: DraftRow[] = [];
	let activeCandidate: string | null = null;
	if (manifests) {
		try {
			// The active tab is the only open body that must be resident at boot.
			// Its identity comes from the preference and the manifest projection
			// before any record read.
			activeCandidate = selectActiveManifestId(manifests, preferredActiveId, fallbackActiveId);
			const inlineIds = selectInlineContentIds(manifests, activeCandidate);
			const rows = (await db.drafts.bulkGet([...inlineIds])).filter(
				(row): row is DraftRow => row !== undefined
			);
			const byId = new Map(rows.map((row) => [row.id, row]));
			// The active tab is always hydrated. If its row vanished between the
			// count and the read, use the full-row path so the view cannot show an
			// empty active document.
			if (activeCandidate && !byId.has(activeCandidate)) throw new Error('draft-manifest-stale');
			items = manifests
				.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
				.map((manifest) => {
					const row = byId.get(manifest.id);
					return row
						? draftItemFromRow(row, linkedIds.has(row.id))
						: draftItemFromManifest(
								manifest,
								linkedIds.has(manifest.id),
								metadata?.get(manifest.id)
							);
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
		activeCandidate ??
		(preferredActiveId && files.some((file) => file.id === preferredActiveId)
			? preferredActiveId
			: fallbackActiveId);
	const activeId =
		requestedActiveId && files.some((file) => file.id === requestedActiveId)
			? requestedActiveId
			: (files[0]?.id ?? null);
	return { files, closedFiles, activeId, persistedRows };
}

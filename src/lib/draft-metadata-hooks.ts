// Installs the durable metadata projection hooks outside the boot bundle.
//
// The hook must be synchronous, so it stays in this lazy module together with
// the frontmatter parser. `backfillDraftMetadata` migrates rows written before
// the projection existed.

import { db, type DraftRow } from './db';
import { encodeDraftMetadata } from './draft-metadata';

let installed = false;

export function installDraftMetadataHooks(): void {
	if (installed) return;
	installed = true;
	db.drafts.hook('creating', (_primaryKey, row) => {
		row.metadata = encodeDraftMetadata(row);
	});
	db.drafts.hook('updating', (modifications, _primaryKey, row) => {
		return { metadata: encodeDraftMetadata({ ...row, ...modifications } as DraftRow) };
	});
}

/** Fills missing projections once, without retaining the row bodies. */
export async function backfillDraftMetadata(): Promise<void> {
	installDraftMetadataHooks();
	await db.transaction('rw', db.drafts, async () => {
		await db.drafts.toCollection().modify((row) => {
			row.metadata = encodeDraftMetadata(row);
		});
	});
}

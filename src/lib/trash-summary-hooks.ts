// Installs the metadata-only trash projection outside the boot bundle.

import { db, type TrashedRow } from './db';
import { encodeTrashSummary } from './trash-summary';

let installed = false;

export function installTrashSummaryHooks(): void {
	if (installed) return;
	installed = true;
	db.trashed.hook('creating', (_primaryKey, row) => {
		row.summary = encodeTrashSummary(row);
	});
	db.trashed.hook('updating', (modifications, _primaryKey, row) => ({
		summary: encodeTrashSummary({ ...row, ...modifications } as TrashedRow)
	}));
}

export async function backfillTrashSummaries(): Promise<void> {
	installTrashSummaryHooks();
	await db.transaction('rw', db.trashed, async () => {
		await db.trashed.toCollection().modify((row) => {
			row.summary = encodeTrashSummary(row);
		});
	});
}

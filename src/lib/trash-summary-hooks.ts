// Installs the metadata-only trash projection outside the boot bundle.

import { db, type TrashedRow } from './db';
import { decodeTrashSummary, encodeTrashSummary } from './trash-summary';

let installed = false;

export function installTrashSummaryHooks(): void {
	if (installed) return;
	installed = true;
	db.trashed.hook('creating', (_primaryKey, row) => {
		row.summary = encodeTrashSummary(row);
	});
	db.trashed.hook('updating', (modifications, _primaryKey, row) => {
		const touches = ['file', 'order', 'trashedAt'].some((key) =>
			Object.prototype.hasOwnProperty.call(modifications, key)
		);
		if (!touches) return undefined;
		return { summary: encodeTrashSummary({ ...row, ...modifications } as TrashedRow) };
	});
}

async function missingTrashSummaryIds(): Promise<string[]> {
	const idb = db.backendDB();
	return new Promise<string[]>((resolve, reject) => {
		let transaction: IDBTransaction;
		try {
			transaction = idb.transaction('trashed', 'readonly');
		} catch (error) {
			reject(error);
			return;
		}
		const store = transaction.objectStore('trashed');
		const all: string[] = [];
		const projected = new Set<string>();
		const allRequest = store.openKeyCursor();
		allRequest.onerror = () => reject(allRequest.error);
		allRequest.onsuccess = () => {
			const cursor = allRequest.result;
			if (!cursor) return;
			all.push(String(cursor.primaryKey));
			cursor.continue();
		};
		const projectedRequest = store.index('summary').openKeyCursor();
		projectedRequest.onerror = () => reject(projectedRequest.error);
		projectedRequest.onsuccess = () => {
			const cursor = projectedRequest.result;
			if (!cursor) return;
			const summary = decodeTrashSummary(cursor.key);
			if (summary) projected.add(summary.id);
			cursor.continue();
		};
		transaction.oncomplete = () => resolve(all.filter((id) => !projected.has(id)));
		transaction.onerror = () => reject(transaction.error);
		transaction.onabort = () => reject(transaction.error);
	});
}

export async function backfillTrashSummaries(): Promise<void> {
	installTrashSummaryHooks();
	const ids = await missingTrashSummaryIds();
	for (const id of ids) {
		await db.transaction('rw', db.trashed, async () => {
			const row = await db.trashed.get(id);
			if (!row) return;
			// Only the summary key is written; file bytes and trash order stay intact.
			await db.trashed.update(id, { summary: encodeTrashSummary(row) });
		});
	}
}

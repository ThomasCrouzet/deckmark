// Lazy metadata-only trash reader. Keeps the summary codec out of the boot bundle.

import { db } from './db';
import { decodeTrashSummary, type TrashSummary } from './trash-summary';

export async function readTrashSummaries(): Promise<TrashSummary[] | null> {
	try {
		const expected = await db.trashed.count();
		const idb = db.backendDB();
		return await new Promise<TrashSummary[] | null>((resolve, reject) => {
			let transaction: IDBTransaction;
			try {
				transaction = idb.transaction('trashed', 'readonly');
			} catch (error) {
				reject(error);
				return;
			}
			const summaries: TrashSummary[] = [];
			const request = transaction.objectStore('trashed').index('summary').openKeyCursor();
			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				const cursor = request.result;
				if (!cursor) return;
				const summary = decodeTrashSummary(cursor.key);
				if (summary) summaries.push(summary);
				cursor.continue();
			};
			transaction.oncomplete = () => resolve(summaries.length === expected ? summaries : null);
			transaction.onerror = () => reject(transaction.error);
			transaction.onabort = () => reject(transaction.error);
		});
	} catch {
		return null;
	}
}

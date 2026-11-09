// Snippet code-hash hooks must be installed after Dexie opens the schema that
// owns the snippets table. Registering them before open loses them when the
// table object is replaced by the upgrade.

import { db, type SnippetRow } from './db';
import { hashSnippetCode } from './snippet-hash';

let installed = false;

export function installSnippetHooks(): void {
	if (installed) return;
	installed = true;
	db.snippets.hook('creating', (_primaryKey, row) => {
		row.codeHash = hashSnippetCode(row.code);
	});
	db.snippets.hook('updating', (modifications, _primaryKey, row) => ({
		codeHash: hashSnippetCode(({ ...row, ...modifications } as SnippetRow).code)
	}));
}

export async function backfillSnippetHashes(): Promise<void> {
	installSnippetHooks();
	await db.transaction('rw', db.snippets, async () => {
		await db.snippets.toCollection().modify((row) => {
			row.codeHash = hashSnippetCode(row.code);
		});
	});
}

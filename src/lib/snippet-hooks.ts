// Snippet code-hash hooks must be installed after Dexie opens the schema that
// owns the snippets table. Registering them before open loses them when the
// table object is replaced by the upgrade.

import { db, type SnippetRow } from './db';
import { hashSnippetCode } from './snippet-hash';
import { encodeSnippetManifest } from './snippet-manifest-key';

let installed = false;

export function installSnippetHooks(): void {
	if (installed) return;
	installed = true;
	db.snippets.hook('creating', (_primaryKey, row) => {
		row.codeHash = hashSnippetCode(row.code);
		row.manifest = encodeSnippetManifest(row);
	});
	db.snippets.hook('updating', (modifications, _primaryKey, row) => {
		const merged = { ...row, ...modifications } as SnippetRow;
		// A favorite or title update must not rehash an unchanged large body.
		if (Object.hasOwn(modifications, 'code')) merged.codeHash = hashSnippetCode(merged.code);
		return {
			...(Object.hasOwn(modifications, 'code') ? { codeHash: merged.codeHash } : {}),
			manifest: encodeSnippetManifest(merged)
		};
	});
}

export async function backfillSnippetHashes(): Promise<void> {
	installSnippetHooks();
	await db.transaction('rw', db.snippets, async () => {
		await db.snippets.toCollection().modify((row) => {
			row.codeHash = hashSnippetCode(row.code);
		});
	});
}

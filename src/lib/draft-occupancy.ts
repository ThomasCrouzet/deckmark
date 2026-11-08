// Metadata-only reads for conflict naming inside an active Dexie transaction.
//
// A single conflicting note must not materialize every draft body or project
// asset payload. The manifest and compound path indexes expose the fields that
// the deterministic conflict variant needs.

import Dexie from 'dexie';
import { decodeDraftManifest } from './draft-manifest';
import { pathKey } from './project-paths';

export interface ConflictOccupancy {
	names: string[];
	maxOrder: number;
	/** Lower-cased project paths reserved by drafts and assets. */
	occupied: Set<string>;
}

/**
 * Returns null when no Dexie transaction is active. The caller then keeps the
 * previous full-row fallback so behavior cannot silently degrade.
 */
export async function conflictOccupancy(projectId?: string): Promise<ConflictOccupancy | null> {
	const transaction = Dexie.currentTransaction;
	if (!transaction?.idbtrans) return null;
	try {
		const store = transaction.idbtrans.objectStore('drafts');
		const names: string[] = [];
		let maxOrder = -1;
		const occupied = new Set<string>();
		await new Promise<void>((resolve, reject) => {
			const request = store.index('manifest').openKeyCursor();
			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				const cursor = request.result;
				if (!cursor) {
					resolve();
					return;
				}
				const manifest = decodeDraftManifest(cursor.key);
				if (manifest) {
					names.push(manifest.name);
					maxOrder = Math.max(maxOrder, manifest.order);
					if (projectId && manifest.projectId === projectId && manifest.relativePath)
						occupied.add(pathKey(manifest.relativePath).toLowerCase());
				}
				cursor.continue();
			};
		});
		if (projectId) {
			await new Promise<void>((resolve, reject) => {
				const request = store.index('[projectId+path]').openKeyCursor();
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const cursor = request.result;
					if (!cursor) {
						resolve();
						return;
					}
					const key = cursor.key;
					if (Array.isArray(key) && key[0] === projectId && typeof key[1] === 'string')
						occupied.add(pathKey(key[1]).toLowerCase());
					cursor.continue();
				};
			});
		}
		return { names, maxOrder, occupied };
	} catch {
		return null;
	}
}

// Reads the draft metadata projection without loading document bodies.

import { db, type DraftRow } from './db';
import { DRAFT_CONTENT } from './config';
import type { FileItem } from './types';
import { DRAFT_MANIFEST_VERSION, type DraftManifest } from './draft-manifest-key';
import { decodeDraftMetadata, type DraftMetadata } from './draft-metadata-codec';

/**
 * Returns one metadata row per draft, or `null` when the projection is not
 * complete. A caller that receives `null` must use the full-row load path.
 *
 * The index key cursor returns index keys and primary keys only. It never
 * reads `content` or binary `data` from the record.
 */
export async function readDraftManifests(): Promise<DraftManifest[] | null> {
	try {
		const expected = await db.drafts.count();
		const idb = db.backendDB();
		const manifests = await new Promise<DraftManifest[]>((resolve, reject) => {
			let transaction: IDBTransaction;
			try {
				transaction = idb.transaction('drafts', 'readonly');
			} catch (error) {
				reject(error);
				return;
			}
			const values: DraftManifest[] = [];
			const request = transaction.objectStore('drafts').index('manifest').openKeyCursor();
			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				const cursor = request.result;
				if (!cursor) return;
				const manifest = decodeDraftManifest(cursor.key);
				if (manifest) values.push(manifest);
				cursor.continue();
			};
			transaction.oncomplete = () => resolve(values);
			transaction.onerror = () => reject(transaction.error);
			transaction.onabort = () => reject(transaction.error);
		});
		return manifests.length === expected ? manifests : null;
	} catch {
		return null;
	}
}

/**
 * Reads the derived metadata projection without loading document bodies.
 * Returns null when the projection is incomplete; the caller then parses the
 * bodies it loads normally.
 */
export async function readDraftMetadata(): Promise<Map<string, DraftMetadata> | null> {
	try {
		const expected = await db.drafts.count();
		const idb = db.backendDB();
		const metadata = await new Promise<Map<string, DraftMetadata>>((resolve, reject) => {
			let transaction: IDBTransaction;
			try {
				transaction = idb.transaction('drafts', 'readonly');
			} catch (error) {
				reject(error);
				return;
			}
			const values = new Map<string, DraftMetadata>();
			const request = transaction.objectStore('drafts').index('metadata').openKeyCursor();
			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				const cursor = request.result;
				if (!cursor) return;
				const decoded = decodeDraftMetadata(cursor.key);
				if (decoded) values.set(decoded.id, decoded);
				cursor.continue();
			};
			transaction.oncomplete = () => resolve(values);
			transaction.onerror = () => reject(transaction.error);
			transaction.onabort = () => reject(transaction.error);
		});
		return metadata.size === expected ? metadata : null;
	} catch {
		return null;
	}
}

/** Parses an index key. Returns null for an unknown or damaged value. */
export function decodeDraftManifest(key: unknown): DraftManifest | null {
	if (typeof key !== 'string') return null;
	let value: unknown;
	try {
		value = JSON.parse(key);
	} catch {
		return null;
	}
	if (!Array.isArray(value) || value.length !== 15) return null;
	const [
		version,
		id,
		name,
		projectId,
		relativePath,
		createdAt,
		updatedAt,
		order,
		kind,
		mime,
		origin,
		sourceFileId,
		open,
		contentLength,
		hasData
	] = value;
	if (version !== DRAFT_MANIFEST_VERSION) return null;
	if (
		typeof id !== 'string' ||
		typeof name !== 'string' ||
		typeof projectId !== 'string' ||
		typeof relativePath !== 'string' ||
		typeof createdAt !== 'number' ||
		typeof updatedAt !== 'number' ||
		typeof order !== 'number' ||
		typeof kind !== 'string' ||
		typeof mime !== 'string' ||
		typeof origin !== 'string' ||
		typeof sourceFileId !== 'string' ||
		(open !== 0 && open !== 1) ||
		typeof contentLength !== 'number' ||
		(hasData !== 0 && hasData !== 1)
	)
		return null;

	return {
		id,
		name,
		...(projectId ? { projectId } : {}),
		...(relativePath ? { relativePath } : {}),
		createdAt,
		updatedAt,
		order,
		...(kind ? { kind: kind as NonNullable<DraftRow['kind']> } : {}),
		...(mime ? { mime } : {}),
		...(origin ? { origin: origin as NonNullable<DraftRow['origin']> } : {}),
		...(sourceFileId ? { sourceFileId } : {}),
		open: open === 1,
		contentLength,
		hasData: hasData === 1
	};
}

export function draftItemFromRow(row: DraftRow, linkedToDisk: boolean): FileItem {
	return {
		id: row.id,
		name: row.name,
		content: row.content,
		...(row.projectId ? { projectId: row.projectId, relativePath: row.relativePath } : {}),
		...(row.origin ? { origin: row.origin } : {}),
		...(row.sourceFileId ? { sourceFileId: row.sourceFileId } : {}),
		...(row.kind ? { kind: row.kind } : {}),
		...(row.mime ? { mime: row.mime } : {}),
		...(row.data ? { data: row.data } : {}),
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		dirty: false,
		linkedToDisk
	};
}

export function draftItemFromManifest(
	manifest: DraftManifest,
	linkedToDisk: boolean,
	derivedMetadata?: DraftMetadata
): FileItem {
	return {
		id: manifest.id,
		name: manifest.name,
		content: '',
		...(manifest.projectId
			? { projectId: manifest.projectId, relativePath: manifest.relativePath }
			: {}),
		...(manifest.origin ? { origin: manifest.origin } : {}),
		...(manifest.sourceFileId ? { sourceFileId: manifest.sourceFileId } : {}),
		...(manifest.kind ? { kind: manifest.kind } : {}),
		...(manifest.mime ? { mime: manifest.mime } : {}),
		createdAt: manifest.createdAt,
		updatedAt: manifest.updatedAt,
		dirty: false,
		linkedToDisk,
		...(derivedMetadata ? { derivedMetadata } : {}),
		contentDeferred: true
	};
}

/** Keeps the startup body budget bounded while preserving tab order. */
export function selectInlineContentIds(manifests: readonly DraftManifest[]): Set<string> {
	const ids = new Set<string>();
	let used = 0;
	for (const manifest of [...manifests].sort(
		(a, b) => a.order - b.order || a.id.localeCompare(b.id)
	)) {
		if (manifest.open) {
			ids.add(manifest.id);
			continue;
		}
		if (manifest.hasData) continue;
		if (manifest.contentLength > DRAFT_CONTENT.maxInlineChars) continue;
		if (used + manifest.contentLength > DRAFT_CONTENT.closedBudgetChars) continue;
		ids.add(manifest.id);
		used += manifest.contentLength;
	}
	return ids;
}

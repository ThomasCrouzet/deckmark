// Encoder for the durable derived metadata projection.
//
// The codec lives in `draft-metadata-codec.ts` so readers do not pull the
// frontmatter and wiki scanners into the boot bundle.

import { db, type DraftRow } from './db';
import { documentKindForFile, type DocumentKind } from './document-kind';
import { stripMdExtension } from './file-names';
import { fastFrontmatter } from './metadata-derive';
export const DRAFT_METADATA_VERSION = 2;

export interface DraftMetadata {
	id: string;
	contentHash: string;
	contentLength: number;
	title: string;
	documentTitle: string;
	/** Derived kind for a metadata-only item whose row has no stored kind. */
	kind?: DocumentKind;
	tags: string[];
	targets: string[];
	/** The body defines or includes a linked block. */
	hasBlocks: boolean;
	hasIncludes: boolean;
}

/** Decodes a metadata index key. Returns null for unknown or damaged values. */
export function decodeDraftMetadata(key: unknown): DraftMetadata | null {
	if (typeof key !== 'string') return null;
	let value: unknown;
	try {
		value = JSON.parse(key);
	} catch {
		return null;
	}
	if (!Array.isArray(value) || (value.length !== 10 && value.length !== 11)) return null;
	const [
		version,
		id,
		contentHash,
		contentLength,
		title,
		documentTitle,
		tags,
		targets,
		hasBlocks,
		hasIncludes,
		kind
	] = value;
	if (version !== DRAFT_METADATA_VERSION) return null;
	if (
		typeof id !== 'string' ||
		typeof contentHash !== 'string' ||
		typeof contentLength !== 'number' ||
		typeof title !== 'string' ||
		typeof documentTitle !== 'string' ||
		!Array.isArray(tags) ||
		!tags.every((tag) => typeof tag === 'string') ||
		!Array.isArray(targets) ||
		!targets.every((target) => typeof target === 'string') ||
		(hasBlocks !== 0 && hasBlocks !== 1) ||
		(hasIncludes !== 0 && hasIncludes !== 1) ||
		(kind !== undefined &&
			kind !== '' &&
			kind !== 'note' &&
			kind !== 'presentation' &&
			kind !== 'code' &&
			kind !== 'image' &&
			kind !== 'pdf')
	)
		return null;
	return {
		id,
		contentHash,
		contentLength,
		title,
		documentTitle,
		...(typeof kind === 'string' && kind ? { kind: kind as DocumentKind } : {}),
		tags,
		targets,
		hasBlocks: hasBlocks === 1,
		hasIncludes: hasIncludes === 1
	};
}

function hashContent(content: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < content.length; index++) {
		hash ^= content.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(36);
}

function splitFrontmatter(content: string): { raw: string; body: string } {
	const prefix = content.startsWith('\uFEFF') ? '\uFEFF' : '';
	const source = content.slice(prefix.length);
	const match = /^(---\s*\r?\n[\s\S]*?\r?\n---(?:\r?\n|$))/.exec(source);
	return { raw: match?.[1] ?? '', body: source.slice(match?.[0].length ?? 0) };
}

function isNoteRow(row: DraftRow): boolean {
	if (row.kind) return row.kind === 'note';
	return /\.(?:md|markdown|mdx)$/i.test(row.name);
}

function collectTargets(line: string, targets: Set<string>): void {
	if (/^(?: {4}|\t)/.test(line)) return;
	const searchable = line.replace(/`[^`\n]*`/g, '');
	for (const match of searchable.matchAll(/\[\[([^[\]|\n]+)(?:\|[^[\]\n]*)?\]\]/g)) {
		const target = match[1]?.trim();
		if (target) targets.add(target);
	}
}

/** One pass over lines avoids several full-document replacement copies. */
function textTargets(content: string): string[] {
	const { body } = splitFrontmatter(content);
	const targets = new Set<string>();
	let fence = '';
	let unclosed: string[] = [];
	for (const line of body.split(/\r?\n/)) {
		const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
		if (fence) {
			if (
				marker &&
				marker[0] === fence[0] &&
				marker.length >= fence.length &&
				line.trim() === marker
			) {
				fence = '';
				unclosed = [];
			} else if (marker) continue;
			else unclosed.push(line);
			continue;
		}
		if (marker) {
			fence = marker;
			unclosed = [];
			continue;
		}
		collectTargets(line, targets);
	}
	// Keep the existing behaviour for an unfinished fence: only the marker line
	// is removed, so visible-looking targets below it still count.
	if (fence) for (const line of unclosed) collectTargets(line, targets);
	return [...targets];
}

function fallbackTitle(name: string, body: string): string {
	const heading = /^[ \t]*#[ \t]+(.+?)[ \t]*$/m.exec(body)?.[1]?.trim();
	if (heading) return heading;
	// Code and binary names keep their extension, like the live metadata
	// projection. Only Markdown extensions are display suffixes.
	return stripMdExtension(name) || name;
}

export function draftMetadataFor(row: DraftRow): DraftMetadata {
	const { raw, body } = splitFrontmatter(row.content);
	const fast = raw ? fastFrontmatter(raw) : {};
	const fallback = fallbackTitle(row.name, body);
	const title = fast.title?.trim() || fallback;
	const note = isNoteRow(row);
	const kind = row.kind ?? documentKindForFile({ name: row.name, content: row.content });
	let hasBlocks = false;
	let hasIncludes = false;
	for (const match of row.content.matchAll(/<!--\s*mdsh-(block|include)\b/g)) {
		if (match[1] === 'block') hasBlocks = true;
		else hasIncludes = true;
		if (hasBlocks && hasIncludes) break;
	}
	return {
		id: row.id,
		contentHash: hashContent(row.content),
		contentLength: row.content.length,
		title,
		documentTitle: title,
		kind,
		tags: note ? (fast.tags ?? []) : [],
		targets: note ? textTargets(row.content) : [],
		hasBlocks,
		hasIncludes
	};
}

/** Encodes the metadata index key. Keep the field order stable. */
export function encodeDraftMetadata(row: DraftRow): string {
	const metadata = draftMetadataFor(row);
	return JSON.stringify([
		DRAFT_METADATA_VERSION,
		metadata.id,
		metadata.contentHash,
		metadata.contentLength,
		metadata.title,
		metadata.documentTitle,
		metadata.tags,
		metadata.targets,
		metadata.hasBlocks ? 1 : 0,
		metadata.hasIncludes ? 1 : 0,
		metadata.kind ?? ''
	]);
}

let installed = false;

export function installDraftMetadataHooks(): void {
	if (installed) return;
	installed = true;
	db.drafts.hook('creating', (_primaryKey, row) => {
		row.metadata = encodeDraftMetadata(row);
	});
	db.drafts.hook('updating', (modifications, _primaryKey, row) => {
		const touchesSource = ['content', 'name', 'kind'].some((key) =>
			Object.prototype.hasOwnProperty.call(modifications, key)
		);
		if (!touchesSource) return undefined;
		return { metadata: encodeDraftMetadata({ ...row, ...modifications } as DraftRow) };
	});
}

/** Lists ids without a projection using metadata-only key cursors. */
async function missingDraftMetadataIds(): Promise<string[]> {
	const idb = db.backendDB();
	return new Promise<string[]>((resolve, reject) => {
		let transaction: IDBTransaction;
		try {
			transaction = idb.transaction('drafts', 'readonly');
		} catch (error) {
			reject(error);
			return;
		}
		const store = transaction.objectStore('drafts');
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
		const projectedRequest = store.index('metadata').openKeyCursor();
		projectedRequest.onerror = () => reject(projectedRequest.error);
		projectedRequest.onsuccess = () => {
			const cursor = projectedRequest.result;
			if (!cursor) return;
			const metadata = decodeDraftMetadata(cursor.key);
			if (metadata) projected.add(metadata.id);
			cursor.continue();
		};
		transaction.oncomplete = () => resolve(all.filter((id) => !projected.has(id)));
		transaction.onerror = () => reject(transaction.error);
		transaction.onabort = () => reject(transaction.error);
	});
}

/** Fills only missing projections, with metadata-only transaction updates. */
export async function backfillDraftMetadata(): Promise<void> {
	installDraftMetadataHooks();
	const ids = await missingDraftMetadataIds();
	for (let offset = 0; offset < ids.length; offset += 25) {
		const batch = ids.slice(offset, offset + 25);
		await db.transaction('rw', db.drafts, async () => {
			const rows = await db.drafts.bulkGet(batch);
			for (const row of rows) {
				if (!row) continue;
				// Never write content, name, order or open state from a stale read.
				await db.drafts.update(row.id, { metadata: encodeDraftMetadata(row) });
			}
		});
		if (offset + 25 < ids.length) {
			await new Promise<void>((resolve) => {
				if (typeof requestIdleCallback === 'function')
					requestIdleCallback(() => resolve(), { timeout: 200 });
				else setTimeout(resolve, 50);
			});
		}
	}
}

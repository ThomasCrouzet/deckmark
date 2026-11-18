// On-demand body reads for documents whose metadata is already in memory.
//
// The store imports this module only when it must hydrate a body or build a
// search snapshot, so the boot bundle keeps no body-handling code.

import { db, type DraftRow } from './db';
import type { FileItem } from './types';
import { DOCUMENT_MEMORY, utf16Bytes } from './document-memory';

export interface SearchCorpusFile {
	id: string;
	name: string;
	content: string;
}

/** Copies a durable row into an existing deferred item. */
export function applyDraftContent(file: FileItem, row: DraftRow): void {
	file.content = row.content;
	if (row.data) file.data = row.data;
	else delete file.data;
	file.name = row.name;
	if (row.kind) file.kind = row.kind;
	else delete file.kind;
	if (row.mime) file.mime = row.mime;
	else delete file.mime;
	if (row.projectId) file.projectId = row.projectId;
	else delete file.projectId;
	if (row.relativePath) file.relativePath = row.relativePath;
	else delete file.relativePath;
	file.updatedAt = row.updatedAt;
	file.contentDeferred = false;
}

/** Reads the exact bodies that the search worker needs and keeps them out of the store. */
export async function buildSearchCorpus(files: readonly FileItem[]): Promise<SearchCorpusFile[]> {
	const deferred = files.filter((file) => file.contentDeferred);
	const rows = await db.drafts.bulkGet(deferred.map((file) => file.id));
	const contentById = new Map(
		rows.filter((row): row is DraftRow => row !== undefined).map((row) => [row.id, row.content])
	);
	const corpus: SearchCorpusFile[] = [];
	for (const file of files) {
		if (!file.contentDeferred) {
			corpus.push({ id: file.id, name: file.name, content: file.content });
			continue;
		}
		const content = contentById.get(file.id);
		// A missing durable row must not become an empty valid note. Omit it so
		// the caller can fail closed and retry the next read.
		if (content === undefined) continue;
		corpus.push({ id: file.id, name: file.name, content });
	}
	return corpus;
}

/**
 * Keeps closed bodies within a logical UTF-16 byte budget. A body is cleared
 * only after its durable row exists, no operation pins it and no local write
 * is pending or failed. The derived metadata keeps titles, tags and backlinks.
 *
 * `file.dirty` is a disk status, not a memory pin. A note that still needs a
 * disk save can release its body once the local revision is durable. The disk
 * flag stays on the item so the status remains honest.
 */
export async function reclaimClosedBodies(options: {
	files: readonly FileItem[];
	closedFiles: FileItem[];
	isPending: (id: string) => boolean;
	isPinned: (id: string) => boolean;
	/** True when the exact in-memory source is durable and no write is pending. */
	isDurable: (file: FileItem) => boolean;
	rowFor: (file: FileItem) => DraftRow;
	budget?: number;
	/** Releases the other source owners of the cleared document. */
	onEvict?: (file: FileItem, chars: number) => void;
}): Promise<number> {
	const budget = options.budget ?? DOCUMENT_MEMORY.closedBodyBytes;
	let retained = 0;
	for (const file of options.files) retained += utf16Bytes(bodyChars(file));
	for (const file of options.closedFiles) retained += utf16Bytes(bodyChars(file));
	if (retained <= budget) return 0;
	const { draftMetadataFor } = await import('./draft-metadata');
	let evicted = 0;
	for (const file of options.closedFiles) {
		if (retained <= budget) break;
		const chars = bodyChars(file);
		if (chars === 0) continue;
		if (options.isPending(file.id) || options.isPinned(file.id)) continue;
		if (!options.isDurable(file)) continue;
		file.derivedMetadata ??= draftMetadataFor(options.rowFor(file));
		file.content = '';
		delete file.data;
		file.contentDeferred = true;
		retained -= utf16Bytes(chars);
		evicted += 1;
		options.onEvict?.(file, chars);
	}
	return evicted;
}

/** Logical characters of the source that a library item holds. */
export function bodyChars(file: FileItem): number {
	return file.content.length + (file.data?.length ?? 0);
}

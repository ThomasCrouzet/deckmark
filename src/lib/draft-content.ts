// On-demand body reads for documents whose metadata is already in memory.
//
// The store imports this module only when it must hydrate a body or build a
// search snapshot, so the boot bundle keeps no body-handling code.

import { db, type DraftRow } from './db';
import type { FileItem } from './types';

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
	return files.map((file) => ({
		id: file.id,
		name: file.name,
		content: file.contentDeferred ? (contentById.get(file.id) ?? file.content) : file.content
	}));
}

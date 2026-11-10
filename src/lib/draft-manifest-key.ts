// Metadata projection stored in a compound index on the `drafts` table.
//
// The index key carries only the fields that the library needs at startup.
// The document body and binary data stay in the record. IndexedDB updates the
// index in the same transaction as the record, so no second table can drift.
//
// A key cursor reads these values without fetching the record body. This is
// the part that keeps a large library out of the startup JS heap.

import type { DraftRow } from './db';
import { documentKindForFile } from './document-kind';

export const DRAFT_MANIFEST_VERSION = 1;

export interface DraftManifest {
	id: string;
	name: string;
	projectId?: string;
	relativePath?: string;
	createdAt: number;
	updatedAt: number;
	order: number;
	kind?: DraftRow['kind'];
	mime?: string;
	origin?: DraftRow['origin'];
	sourceFileId?: string;
	open: boolean;
	contentLength: number;
	hasData: boolean;
}

type EncodedManifest = [
	number,
	string,
	string,
	string,
	string,
	number,
	number,
	number,
	string,
	string,
	string,
	string,
	0 | 1,
	number,
	0 | 1
];

/**
 * Returns the compact index key for a draft. The caller must apply the same
 * projection on every write and during the schema upgrade.
 */
export function encodeDraftManifest(
	row: Pick<
		DraftRow,
		| 'id'
		| 'name'
		| 'projectId'
		| 'relativePath'
		| 'createdAt'
		| 'updatedAt'
		| 'order'
		| 'kind'
		| 'mime'
		| 'origin'
		| 'sourceFileId'
		| 'open'
		| 'content'
		| 'data'
	>
): string {
	const encoded: EncodedManifest = [
		DRAFT_MANIFEST_VERSION,
		row.id,
		row.name,
		row.projectId ?? '',
		row.relativePath ?? '',
		row.createdAt,
		row.updatedAt,
		row.order,
		row.kind ?? documentKindForFile(row),
		row.mime ?? '',
		row.origin ?? '',
		row.sourceFileId ?? '',
		row.open === false ? 0 : 1,
		row.content.length,
		row.data ? 1 : 0
	];
	return JSON.stringify(encoded);
}

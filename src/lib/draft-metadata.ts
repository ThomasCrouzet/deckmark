// Durable derived metadata for deferred draft bodies.
//
// The compact manifest key stays small. This second index stores the title,
// tags and wiki targets that the metadata index needs before a closed body is
// hydrated. The draft hook writes the key in the same draft transaction.

import type { DraftRow } from './db';
import { documentKindForFile } from './document-kind';
import { deriveMetadata } from './metadata-derive';

export const DRAFT_METADATA_VERSION = 1;

export interface DraftMetadata {
	id: string;
	contentHash: string;
	contentLength: number;
	title: string;
	documentTitle: string;
	tags: string[];
	targets: string[];
}

function hashContent(content: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < content.length; index++) {
		hash ^= content.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(36);
}

export function draftMetadataFor(row: DraftRow): DraftMetadata {
	const values = deriveMetadata({
		name: row.name,
		content: row.content,
		isNote: documentKindForFile(row) === 'note'
	});
	return {
		id: row.id,
		contentHash: hashContent(row.content),
		contentLength: row.content.length,
		title: values.title,
		documentTitle: values.documentTitle,
		tags: values.tags,
		targets: values.targets
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
		metadata.targets
	]);
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
	if (!Array.isArray(value) || value.length !== 8) return null;
	const [version, id, contentHash, contentLength, title, documentTitle, tags, targets] = value;
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
		!targets.every((target) => typeof target === 'string')
	)
		return null;
	return {
		id,
		contentHash,
		contentLength,
		title,
		documentTitle,
		tags,
		targets
	};
}

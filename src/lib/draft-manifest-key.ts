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
const METRICS = import.meta.env.VITE_SOURCE_FIDELITY_METRICS === '1';

/** Local evidence for the projection hooks. Inert in a normal build. */
export function recordDraftProjection(
	projection: 'manifest' | 'metadata',
	reused: boolean,
	bytes: number,
	startedAt: number
): void {
	if (!METRICS || typeof performance === 'undefined') return;
	performance.measure(`mdsh:draft-${projection}`, {
		start: startedAt,
		end: performance.now(),
		detail: { reused, bytes: reused ? 0 : bytes }
	});
}

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
	contentBytes: number;
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
	0 | 1,
	number
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
		| 'manifest'
	>
): string {
	const startedAt = METRICS ? performance.now() : 0;
	const derived = draftManifestDerived(row);
	const key = encodeDraftManifestFrom(row, derived);
	recordDraftProjection('manifest', false, row.content.length, startedAt);
	return key;
}

/** Content-derived values that a later write can reuse. */
export interface DraftManifestDerived {
	kind: NonNullable<DraftRow['kind']>;
	contentLength: number;
	contentBytes: number;
	hasData: boolean;
}

type ManifestSource = Parameters<typeof encodeDraftManifest>[0];

/** Computes the values that change only with content, kind, location or data. */
export function draftManifestDerived(row: ManifestSource): DraftManifestDerived {
	return {
		kind: row.kind ?? documentKindForFile(row),
		contentLength: row.content.length,
		contentBytes: row.projectId ? new TextEncoder().encode(row.content).byteLength : 0,
		hasData: Boolean(row.data)
	};
}

function encodeDraftManifestFrom(row: ManifestSource, derived: DraftManifestDerived): string {
	const encoded: EncodedManifest = [
		DRAFT_MANIFEST_VERSION,
		row.id,
		row.name,
		row.projectId ?? '',
		row.relativePath ?? '',
		row.createdAt,
		row.updatedAt,
		row.order,
		row.kind ?? derived.kind,
		row.mime ?? '',
		row.origin ?? '',
		row.sourceFileId ?? '',
		row.open === false ? 0 : 1,
		derived.contentLength,
		derived.hasData ? 1 : 0,
		derived.contentBytes
	];
	return JSON.stringify(encoded);
}

/** Updates the key. The caller passes the Dexie modifications. */
export function encodeDraftManifestUpdate(
	row: ManifestSource,
	modifications: Partial<DraftRow>
): string {
	const startedAt = METRICS ? performance.now() : 0;
	const merged = { ...row, ...modifications } as ManifestSource;
	// Dexie lists a field only when its value changed. The durable manifest key
	// then still describes the same content, kind, location and data, so its
	// content-derived slots stay valid. Rebuild only the small scalar slots.
	const unchanged = contentDerivedUnchanged(modifications);
	const decoded = unchanged ? decodeDraftManifestDerived(row.manifest) : null;
	const derived = decoded ?? draftManifestDerived(merged);
	const key = encodeDraftManifestFrom(merged, derived);
	recordDraftProjection('manifest', Boolean(decoded), merged.content.length, startedAt);
	return key;
}

const CONTENT_DERIVED_FIELDS = ['content', 'name', 'kind', 'projectId', 'data'] as const;

function contentDerivedUnchanged(modifications: Partial<DraftRow>): boolean {
	return CONTENT_DERIVED_FIELDS.every(
		(field) => !Object.prototype.hasOwnProperty.call(modifications, field)
	);
}

/** Reads the content-derived slots of an existing key without the document body. */
function decodeDraftManifestDerived(key: unknown): DraftManifestDerived | null {
	if (typeof key !== 'string') return null;
	let value: unknown;
	try {
		value = JSON.parse(key);
	} catch {
		return null;
	}
	if (!Array.isArray(value) || value.length !== 16 || value[0] !== DRAFT_MANIFEST_VERSION)
		return null;
	const kind = value[8];
	const contentLength = value[13];
	const hasData = value[14];
	const contentBytes = value[15];
	if (
		typeof kind !== 'string' ||
		typeof contentLength !== 'number' ||
		(hasData !== 0 && hasData !== 1) ||
		typeof contentBytes !== 'number'
	)
		return null;
	return {
		kind: kind as DraftManifestDerived['kind'],
		contentLength,
		contentBytes,
		hasData: hasData === 1
	};
}

// Encoder for the durable derived metadata projection.
//
// The projection is a pure function of the source, the name and the kind. A
// save can reuse it when the accepted edit chain is contiguous and touches only
// plain body lines: the title, tags, wiki targets and block markers cannot
// change there. Every other edit runs the complete scanner. A reuse decision
// never rests on the 32-bit fingerprint alone.

import { db, type DraftRow } from './db';
import { stripMdExtension } from './file-names';
import { fastFrontmatter } from './metadata-derive';
import { documentKindForFile } from './document-kind';
import { stripFrontmatter } from './frontmatter-fields';
import {
	composeEditSpans,
	metadataEditReuse,
	spansOfEdits,
	type TextEditSpan
} from './metadata-delta';
import type { DocumentEdits } from './document-revisions';
import {
	encodeContentFingerprint,
	fingerprintContent,
	fingerprintEdit,
	type ContentFingerprint
} from './content-fingerprint';
import {
	decodeDraftManifestDerived,
	draftManifestDerived,
	encodeDraftManifest,
	encodeDraftManifestFrom,
	type DraftManifestDerived
} from './draft-manifest-key';
import { draftProjection } from './meta-index';

export const DRAFT_METADATA_VERSION = 3;

// The fingerprint state rides in the same index key so a boot can seed the
// incremental path without a second source scan.
const METADATA_SLOTS = 12;

export interface DraftMetadata {
	id: string;
	contentHash: string;
	contentLength: number;
	title: string;
	documentTitle: string;
	tags: string[];
	targets: string[];
	/** The body defines or includes a linked block. */
	hasBlocks: boolean;
	hasIncludes: boolean;
}

type ProjectionMode = 'full' | 'incremental' | 'reused';

/** One durable projection decision for a write. */
interface ProjectionDecision {
	derived: DraftManifestDerived;
	mode: ProjectionMode;
	/** Source bytes that the decision had to read. */
	scanned: number;
}

/** One immutable source revision with its complete projection. */
export interface DraftProjection {
	metadata: DraftMetadata;
	fingerprint: ContentFingerprint;
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
	if (!Array.isArray(value) || value.length !== METADATA_SLOTS) return null;
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
		hasIncludes
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
		(hasIncludes !== 0 && hasIncludes !== 1)
	)
		return null;
	return {
		id,
		contentHash,
		contentLength,
		title,
		documentTitle,
		tags,
		targets,
		hasBlocks: hasBlocks === 1,
		hasIncludes: hasIncludes === 1
	};
}

/** Reads the fingerprint state of a metadata key, or null when it is unusable. */
export function decodeDraftMetadataFingerprint(key: unknown): ContentFingerprint | null {
	if (typeof key !== 'string') return null;
	let value: unknown;
	try {
		value = JSON.parse(key);
	} catch {
		return null;
	}
	if (!Array.isArray(value) || value.length !== METADATA_SLOTS) return null;
	if (value[0] !== DRAFT_METADATA_VERSION) return null;
	const hash = value[10];
	const lines = value[11];
	const length = value[3];
	if (typeof hash !== 'number' || typeof lines !== 'number' || typeof length !== 'number')
		return null;
	if (hash < 0 || lines < 1 || length < 0) return null;
	return { hash, length, lines };
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

/** Complete projection of one row. Cost is proportional to the source length. */
export function projectionFor(row: DraftRow): DraftProjection {
	const { raw, body } = splitFrontmatter(row.content);
	const fast = raw ? fastFrontmatter(raw) : {};
	const fallback = fallbackTitle(row.name, body);
	const title = fast.title?.trim() || fallback;
	const note = isNoteRow(row);
	let hasBlocks = false;
	let hasIncludes = false;
	for (const match of row.content.matchAll(/<!--\s*mdsh-(block|include)\b/g)) {
		if (match[1] === 'block') hasBlocks = true;
		else hasIncludes = true;
		if (hasBlocks && hasIncludes) break;
	}
	const fingerprint = fingerprintContent(row.content);
	return {
		metadata: {
			id: row.id,
			contentHash: encodeContentFingerprint(fingerprint),
			contentLength: row.content.length,
			title,
			documentTitle: title,
			tags: note ? (fast.tags ?? []) : [],
			targets: note ? textTargets(row.content) : [],
			hasBlocks,
			hasIncludes
		},
		fingerprint
	};
}

export function draftMetadataFor(row: DraftRow): DraftMetadata {
	return projectionFor(row).metadata;
}

/** Encodes the metadata index key. Keep the field order stable. */
export function encodeDraftMetadataKey(
	metadata: DraftMetadata,
	fingerprint: ContentFingerprint
): string {
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
		fingerprint.hash,
		fingerprint.lines
	]);
}

/** Encodes the metadata index key from a complete projection. */
export function encodeDraftMetadata(row: DraftRow): string {
	const projection = projectionFor(row);
	return encodeDraftMetadataKey(projection.metadata, projection.fingerprint);
}

const ENCODER = new TextEncoder();

function utf8Bytes(text: string): number {
	return ENCODER.encode(text).byteLength;
}

/** One immutable source revision with its complete projection. */
interface DurableProjectionState {
	readonly name: string;
	readonly kind: string | undefined;
	readonly projectId: string | undefined;
	readonly data: string | undefined;
	readonly content: string;
	readonly metadata: DraftMetadata;
	readonly metadataKey: string;
	readonly fingerprint: ContentFingerprint;
	readonly manifestDerived: DraftManifestDerived;
}

/** The latest projection per document. A few entries cover the open tabs. */
const LIMIT = 8;
const states = new Map<string, DurableProjectionState>();

function rememberProjection(id: string, state: DurableProjectionState): void {
	states.delete(id);
	states.set(id, state);
	while (states.size > LIMIT) {
		const oldest = states.keys().next().value;
		if (oldest === undefined) break;
		states.delete(oldest);
	}
}

function sameSubject(state: DurableProjectionState, row: DraftRow): boolean {
	return (
		state.name === row.name &&
		state.kind === row.kind &&
		state.projectId === row.projectId &&
		state.data === row.data
	);
}

/**
 * Applies one accepted edit range to the previous projection. Returns null when
 * the range is not exactly the published source or when the edit can change a
 * scanned field.
 */
function reviseProjection(
	state: DurableProjectionState,
	row: DraftRow,
	span: TextEditSpan
): { projection: DraftProjection; manifestDerived: DraftManifestDerived; scanned: number } | null {
	const previous = state.content;
	const next = row.content;
	if (
		!Number.isInteger(span.from) ||
		!Number.isInteger(span.to) ||
		span.from < 0 ||
		span.to < span.from ||
		span.to > previous.length
	)
		return null;
	if (next.length !== previous.length - (span.to - span.from) + span.insert.length) return null;
	if (next.slice(span.from, span.from + span.insert.length) !== span.insert) return null;
	const frontmatterEnd = stripFrontmatter(previous).raw.length;
	if (!metadataEditReuse(previous, next, frontmatterEnd, [span])) return null;

	const fingerprint = fingerprintEdit(state.fingerprint, previous, next, span.from, span.to);
	const removed = previous.slice(span.from, span.to);
	const metadata: DraftMetadata = {
		...state.metadata,
		contentHash: encodeContentFingerprint(fingerprint),
		contentLength: next.length
	};
	const manifestDerived: DraftManifestDerived = {
		kind: state.manifestDerived.kind,
		contentLength: next.length,
		contentBytes: row.projectId
			? state.manifestDerived.contentBytes + utf8Bytes(span.insert) - utf8Bytes(removed)
			: 0,
		binaryBytes: state.manifestDerived.binaryBytes,
		hasData: state.manifestDerived.hasData
	};
	// The line boundary lookup plus the changed line is the work this edit does.
	const oldLineStart = span.from === 0 ? 0 : previous.lastIndexOf('\n', span.from - 1) + 1;
	const oldLineEnd = previous.indexOf('\n', span.to);
	const newLineStart = span.from === 0 ? 0 : next.lastIndexOf('\n', span.from - 1) + 1;
	const newLineEnd = next.indexOf('\n', span.from + span.insert.length);
	const scanned =
		frontmatterEnd +
		(span.from - oldLineStart) +
		(span.to - span.from) +
		span.insert.length +
		(oldLineEnd === -1 ? previous.length : oldLineEnd) -
		span.to +
		(span.from - newLineStart) +
		(newLineEnd === -1 ? next.length : newLineEnd) -
		(span.from + span.insert.length);
	return {
		projection: { metadata, fingerprint },
		manifestDerived,
		scanned: Math.max(1, scanned)
	};
}

interface EditRecord {
	edits: DocumentEdits;
}

/** Accepted edit chains, coalesced until the next save. */
const editChains = new Map<string, EditRecord[]>();
const CHAIN_LIMIT = 256;

/**
 * Records one accepted editor change. The chain is consumed by the next save
 * that publishes a matching source. A content check validates the result, so a
 * short or long chain can never select a wrong projection.
 */
function recordDraftEdit(id: string, edits: DocumentEdits): void {
	const chain = editChains.get(id) ?? [];
	chain.push({ edits });
	if (chain.length > CHAIN_LIMIT) editChains.delete(id);
	else editChains.set(id, chain);
}

/** Checks a composed edit against the exact previous and next sources. */
function verifySpans(previous: string, next: string, spans: readonly TextEditSpan[]): boolean {
	let delta = 0;
	let length = previous.length;
	for (const span of spans) {
		if (
			!Number.isInteger(span.from) ||
			!Number.isInteger(span.to) ||
			span.from < 0 ||
			span.to < span.from ||
			span.to > previous.length
		)
			return false;
		const at = span.from + delta;
		if (next.slice(at, at + span.insert.length) !== span.insert) return false;
		const change = span.insert.length - (span.to - span.from);
		length += change;
		delta += change;
	}
	return length === next.length;
}

/**
 * Selects the chain prefix that ends at the source being written. Edits
 * accepted after the flush stay in the chain for the next save.
 */
function spansForSave(
	id: string,
	previous: string,
	next: string
): { spans: TextEditSpan[]; consumed: number } | null {
	const chain = editChains.get(id);
	if (!chain?.length) return null;
	const lists: TextEditSpan[][] = [];
	const lengths: number[] = [];
	let length = previous.length;
	for (let index = 0; index < chain.length; index++) {
		// A portable source span needs the text that its own edit produced. Only
		// the last record can use the source of this write.
		const spans = spansOfEdits(chain[index]!.edits, index === chain.length - 1 ? next : undefined);
		if (!spans) return null;
		lists.push([...spans]);
		for (const span of spans) length += span.insert.length - (span.to - span.from);
		lengths.push(length);
	}
	for (let index = 0; index < lengths.length; index++) {
		if (lengths[index] !== next.length) continue;
		const composed = composeEditSpans(lists.slice(0, index + 1));
		if ('rejected' in composed) continue;
		if (verifySpans(previous, next, composed.spans))
			return { spans: [...composed.spans], consumed: index + 1 };
	}
	return null;
}

/** Seeds the incremental path from the durable row without a source scan. */
function seedProjection(row: DraftRow): DurableProjectionState | null {
	if (typeof row.content !== 'string' || !row.metadata || !row.manifest) return null;
	const metadata = decodeDraftMetadata(row.metadata);
	const fingerprint = decodeDraftMetadataFingerprint(row.metadata);
	if (!metadata || !fingerprint) return null;
	if (metadata.id !== row.id || metadata.contentLength !== row.content.length) return null;
	if (fingerprint.length !== row.content.length) return null;
	const manifestDerived = decodeDraftManifestDerived(row.manifest);
	if (!manifestDerived || manifestDerived.contentLength !== row.content.length) return null;
	const expectedKind = row.kind ?? documentKindForFile(row);
	if (manifestDerived.kind !== expectedKind) return null;
	const state: DurableProjectionState = {
		name: row.name,
		kind: row.kind,
		projectId: row.projectId,
		data: row.data,
		content: row.content,
		metadata,
		metadataKey: row.metadata,
		fingerprint,
		manifestDerived
	};
	rememberProjection(row.id, state);
	return state;
}

const SOURCE_FIELDS = ['content', 'name', 'kind', 'projectId', 'data'] as const;

/**
 * Resolves the durable projection for one write. `row` is the current durable
 * row and `modifications` is the Dexie change set. The manifest encoder and the
 * metadata hook share one decision for the same published source.
 */
function resolveDraftProjection(
	row: DraftRow,
	modifications: Partial<DraftRow>
): ProjectionDecision | null {
	const merged = { ...row, ...modifications } as DraftRow;
	if (!SOURCE_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(modifications, field)))
		return null;
	const previous = states.get(merged.id) ?? seedProjection(row);
	if (previous && sameSubject(previous, merged)) {
		if (previous.content === merged.content) {
			editChains.delete(merged.id);
			return { derived: previous.manifestDerived, mode: 'reused', scanned: 0 };
		}
		const composed = spansForSave(merged.id, previous.content, merged.content);
		if (composed?.spans.length === 1) {
			const revised = reviseProjection(previous, merged, composed.spans[0]!);
			if (revised) {
				const state: DurableProjectionState = {
					name: merged.name,
					kind: merged.kind,
					projectId: merged.projectId,
					data: merged.data,
					content: merged.content,
					metadata: revised.projection.metadata,
					metadataKey: encodeDraftMetadataKey(
						revised.projection.metadata,
						revised.projection.fingerprint
					),
					fingerprint: revised.projection.fingerprint,
					manifestDerived: revised.manifestDerived
				};
				rememberProjection(merged.id, state);
				const remaining = editChains.get(merged.id)?.slice(composed.consumed) ?? [];
				if (remaining.length) editChains.set(merged.id, remaining);
				else editChains.delete(merged.id);
				return {
					derived: revised.manifestDerived,
					mode: 'incremental',
					scanned: revised.scanned
				};
			}
		}
	}
	const projection = projectionFor(merged);
	rememberProjection(merged.id, {
		name: merged.name,
		kind: merged.kind,
		projectId: merged.projectId,
		data: merged.data,
		content: merged.content,
		metadata: projection.metadata,
		metadataKey: encodeDraftMetadataKey(projection.metadata, projection.fingerprint),
		fingerprint: projection.fingerprint,
		manifestDerived: draftManifestDerived(merged)
	});
	editChains.delete(merged.id);
	return {
		derived: draftManifestDerived(merged),
		mode: 'full',
		scanned: merged.content.length
	};
}

const METRICS = import.meta.env.VITE_SOURCE_FIDELITY_METRICS === '1';

/** Local evidence for the projection hooks. Inert in a normal build. */
function recordMeasure(
	projection: 'manifest' | 'metadata',
	mode: ProjectionMode,
	scanned: number,
	startedAt: number
): void {
	if (!METRICS || typeof performance === 'undefined') return;
	performance.measure(`mdsh:draft-${projection}`, {
		start: startedAt,
		end: performance.now(),
		detail: { reused: mode === 'reused', bytes: mode === 'reused' ? 0 : scanned, mode }
	});
}

const MANIFEST_SOURCE_FIELDS = ['content', 'name', 'kind', 'projectId', 'data'] as const;

/** Content-derived manifest values for one write, with the durable fallback. */
function manifestDerivedFor(
	row: DraftRow,
	modifications: Partial<DraftRow>,
	decision: ProjectionDecision | null
): DraftManifestDerived {
	if (decision) return decision.derived;
	const unchanged = MANIFEST_SOURCE_FIELDS.every(
		(field) => !Object.prototype.hasOwnProperty.call(modifications, field)
	);
	return (
		(unchanged ? decodeDraftManifestDerived(row.manifest) : null) ??
		draftManifestDerived({ ...row, ...modifications } as DraftRow)
	);
}

let installed = false;

export function installDraftMetadataHooks(): void {
	if (installed) return;
	installed = true;
	// The boot encoder and the index keep two lazy slots. Without these values
	// they keep the complete fallback: never a wrong key.
	draftProjection.record = recordDraftEdit;
	const metrics = import.meta.env.VITE_SOURCE_FIDELITY_METRICS === '1';
	db.drafts.hook('creating', (_primaryKey, row) => {
		const manifestStartedAt = metrics ? performance.now() : 0;
		row.manifest = encodeDraftManifest(row);
		if (metrics)
			performance.measure('mdsh:draft-manifest', {
				start: manifestStartedAt,
				end: performance.now(),
				detail: { reused: false, bytes: row.content.length, mode: 'full' }
			});
		const startedAt = metrics ? performance.now() : 0;
		const projection = projectionFor(row);
		row.metadata = encodeDraftMetadataKey(projection.metadata, projection.fingerprint);
		recordMeasure('metadata', 'full', row.content.length, startedAt);
	});
	db.drafts.hook('updating', (modifications, _primaryKey, row) => {
		const startedAt = metrics ? performance.now() : 0;
		const changes = modifications as Partial<DraftRow>;
		const manifestStartedAt = metrics ? performance.now() : 0;
		const decision = resolveDraftProjection(row as DraftRow, changes);
		// Both durable keys belong to one write and one projection decision.
		const manifest = encodeDraftManifestFrom(
			{ ...row, ...changes } as DraftRow,
			manifestDerivedFor(row as DraftRow, changes, decision)
		);
		recordMeasure(
			'manifest',
			decision?.mode ?? 'reused',
			decision?.scanned ?? 0,
			manifestStartedAt
		);
		const touchesMetadata = ['content', 'name', 'kind'].some((key) =>
			Object.prototype.hasOwnProperty.call(changes, key)
		);
		if (!touchesMetadata) {
			// Dexie omits fields whose value did not change. Reusing the durable
			// key keeps an unchanged save free of a hash and a link scan.
			recordMeasure('metadata', decision?.mode ?? 'reused', decision?.scanned ?? 0, startedAt);
			return { manifest };
		}
		const mode = decision?.mode ?? 'full';
		recordMeasure('metadata', mode, decision?.scanned ?? row.content.length, startedAt);
		const state = states.get(row.id);
		return state ? { manifest, metadata: state.metadataKey } : { manifest };
	});
}

/** Test-build seam: recomputes the complete projection from the durable row. */
if (import.meta.env.VITE_SOURCE_FIDELITY_METRICS === '1' && typeof window !== 'undefined') {
	(
		window as unknown as {
			__MDSH_PROJECTION_PROBE__: {
				recompute(id: string): Promise<{
					metadata: string;
					manifest: string;
					contentLength: number;
				} | null>;
				seed(row: { id: string; name: string; content: string; updatedAt: number }): Promise<void>;
			};
		}
	).__MDSH_PROJECTION_PROBE__ = {
		async recompute(id: string) {
			const row = await db.drafts.get(id);
			if (!row) return null;
			const projection = projectionFor(row);
			return {
				metadata: encodeDraftMetadataKey(projection.metadata, projection.fingerprint),
				manifest: encodeDraftManifestFrom(row, draftManifestDerived(row)),
				contentLength: row.content.length
			};
		},
		// A large fixture goes through the real hooks once, without a slow
		// keyboard insert. The reload then seeds the incremental path.
		async seed(row: { id: string; name: string; content: string; updatedAt: number }) {
			await db.drafts.put({
				id: row.id,
				name: row.name,
				content: row.content,
				createdAt: 1,
				updatedAt: row.updatedAt,
				order: 0,
				open: true,
				kind: 'note'
			});
		}
	};
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

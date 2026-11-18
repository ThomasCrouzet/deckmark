import { type MetadataSnapshot, type MetadataSource, type MetadataValues } from './metadata-derive';
import { updateMetadata } from './metadata-update';
import type { MetadataEdit } from './metadata-delta';
import { applySourceTextSpans } from './source-text-spans';
import { DOCUMENT_MEMORY, utf16Bytes } from './document-memory';

export type { MetadataEdit } from './metadata-delta';

export type MetadataRequest =
	| {
			kind: 'full';
			id: string;
			revision: number;
			/** Document revision of the posted content. */
			documentRevision: number;
			source: MetadataSource;
	  }
	| {
			kind: 'delta';
			id: string;
			revision: number;
			/** Document revision after the edits. */
			documentRevision: number;
			/** Document revision the Worker baseline must hold. */
			base: number;
			name: string;
			isNote: boolean;
			/** Expected content length after the edits. */
			length: number;
			edits: readonly MetadataEdit[];
	  }
	/** Releases the baseline of a closed durable document. No response. */
	| { kind: 'forget'; id: string };

/** A request that runs a metadata job and returns a response. */
export type MetadataJobRequest = Exclude<MetadataRequest, { kind: 'forget' }>;

export interface MetadataResponse {
	id: string;
	revision: number;
	/** Document revision of the content now held as the per-file baseline. */
	documentRevision: number;
	values?: MetadataValues;
	incremental: boolean;
	mode: 'full' | 'delta' | 'rejected' | 'fallback';
	workerMs: number;
}

interface Baseline {
	revision: number;
	snapshot: MetadataSnapshot;
	/** Estimated UTF-16 bytes of the retained source and derived values. */
	bytes: number;
}

// Keep a bounded cache, not a second copy of the whole library. The budget is
// in estimated UTF-16 bytes, so a few large notes cannot fill it. One baseline
// stays even above the budget so the document in use keeps its delta chain.
const BASELINE_BYTE_LIMIT = DOCUMENT_MEMORY.metadataBaselineBytes;
const BASELINE_ENTRY_LIMIT = DOCUMENT_MEMORY.metadataBaselineEntries;
const BASELINE_OVERHEAD_BYTES = 1024;
const baselines = new Map<string, Baseline>();
let baselineBytes = 0;

function snapshotBytes(snapshot: MetadataSnapshot): number {
	const derived =
		snapshot.title.length +
		snapshot.documentTitle.length +
		snapshot.tags.reduce((total, tag) => total + tag.length, 0) +
		snapshot.targets.reduce((total, target) => total + target.length, 0);
	return utf16Bytes(snapshot.content.length + derived) + BASELINE_OVERHEAD_BYTES;
}

function forget(id: string): boolean {
	const entry = baselines.get(id);
	if (!entry) return false;
	baselines.delete(id);
	baselineBytes -= entry.bytes;
	return true;
}

function remember(id: string, revision: number, snapshot: MetadataSnapshot): void {
	forget(id);
	const bytes = snapshotBytes(snapshot);
	baselines.set(id, { revision, snapshot, bytes });
	baselineBytes += bytes;
	while (
		baselines.size > 1 &&
		(baselines.size > BASELINE_ENTRY_LIMIT || baselineBytes > BASELINE_BYTE_LIMIT)
	) {
		forget(baselines.keys().next().value!);
	}
}

/** Applies spans against the baseline text, or returns null for a bad range. */
function applyEdits(base: string, edits: readonly MetadataEdit[], length: number): string | null {
	const content = applySourceTextSpans(base, edits);
	return content !== null && content.length === length ? content : null;
}

self.addEventListener('message', (event: MessageEvent<MetadataRequest>) => {
	const started = performance.now();
	const request = event.data;
	if (request.kind === 'forget') {
		forget(request.id);
		return;
	}
	const previous = baselines.get(request.id);
	let response: MetadataResponse;
	if (request.kind === 'delta') {
		const content =
			previous &&
			previous.revision === request.base &&
			previous.snapshot.name === request.name &&
			previous.snapshot.isNote === request.isNote
				? applyEdits(previous.snapshot.content, request.edits, request.length)
				: null;
		if (content === null) {
			response = {
				id: request.id,
				revision: request.revision,
				documentRevision: -1,
				incremental: false,
				mode: 'rejected',
				workerMs: performance.now() - started
			};
		} else {
			const source: MetadataSource = {
				name: request.name,
				content,
				isNote: request.isNote
			};
			const result = updateMetadata(previous!.snapshot, source, request.edits);
			remember(request.id, request.documentRevision, result.snapshot);
			const { title, documentTitle, tags, targets } = result.snapshot;
			response = {
				id: request.id,
				revision: request.revision,
				documentRevision: request.documentRevision,
				values: { title, documentTitle, tags, targets },
				incremental: result.incremental,
				mode: 'delta',
				workerMs: performance.now() - started
			};
		}
	} else {
		const result = updateMetadata(previous?.snapshot, request.source);
		remember(request.id, request.documentRevision, result.snapshot);
		const { title, documentTitle, tags, targets } = result.snapshot;
		response = {
			id: request.id,
			revision: request.revision,
			documentRevision: request.documentRevision,
			values: { title, documentTitle, tags, targets },
			incremental: result.incremental,
			mode: 'full',
			workerMs: performance.now() - started
		};
	}
	(self as unknown as Worker).postMessage(response);
});

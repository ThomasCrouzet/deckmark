import {
	updateMetadata,
	type MetadataEdit,
	type MetadataSnapshot,
	type MetadataSource,
	type MetadataValues
} from './metadata-derive';

export type { MetadataEdit } from './metadata-derive';

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
	  };

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
}

// Keep a small bounded cache, not a second copy of the whole library.
const BASELINE_LIMIT = 16;
const baselines = new Map<string, Baseline>();

function remember(id: string, revision: number, snapshot: MetadataSnapshot): void {
	baselines.delete(id);
	baselines.set(id, { revision, snapshot });
	while (baselines.size > BASELINE_LIMIT) baselines.delete(baselines.keys().next().value!);
}

/** Applies spans against the baseline text, or returns null for a bad range. */
function applyEdits(base: string, edits: readonly MetadataEdit[], length: number): string | null {
	let content = base;
	let delta = 0;
	for (const edit of edits) {
		const from = edit.from + delta;
		const to = edit.to + delta;
		if (
			!Number.isInteger(from) ||
			!Number.isInteger(to) ||
			from < 0 ||
			to < from ||
			to > content.length
		)
			return null;
		content = content.slice(0, from) + edit.insert + content.slice(to);
		delta += edit.insert.length - (edit.to - edit.from);
	}
	return content.length === length ? content : null;
}

self.addEventListener('message', (event: MessageEvent<MetadataRequest>) => {
	const started = performance.now();
	const request = event.data;
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

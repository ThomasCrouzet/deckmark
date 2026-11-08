import {
	updateMetadata,
	type MetadataSnapshot,
	type MetadataSource,
	type MetadataValues
} from './metadata-derive';

export interface MetadataRequest {
	id: string;
	revision: number;
	source: MetadataSource;
}

export interface MetadataResponse {
	id: string;
	revision: number;
	values: MetadataValues;
	incremental: boolean;
}

// Keep a small bounded cache, not a second copy of the whole library.
const BASELINE_LIMIT = 16;
const baselines = new Map<string, MetadataSnapshot>();
self.addEventListener('message', (event: MessageEvent<MetadataRequest>) => {
	const { id, revision, source } = event.data;
	const result = updateMetadata(baselines.get(id), source);
	baselines.delete(id);
	baselines.set(id, result.snapshot);
	while (baselines.size > BASELINE_LIMIT) baselines.delete(baselines.keys().next().value!);
	const { title, documentTitle, tags, targets } = result.snapshot;
	const response: MetadataResponse = {
		id,
		revision,
		values: { title, documentTitle, tags, targets },
		incremental: result.incremental
	};
	(self as unknown as Worker).postMessage(response);
});

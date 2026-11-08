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

// Keep one source, not a second copy of the library in the worker.
let previous: { id: string; snapshot: MetadataSnapshot } | undefined;
self.addEventListener('message', (event: MessageEvent<MetadataRequest>) => {
	const { id, revision, source } = event.data;
	const result = updateMetadata(previous?.id === id ? previous.snapshot : undefined, source);
	previous = { id, snapshot: result.snapshot };
	const { title, documentTitle, tags, targets } = result.snapshot;
	const response: MetadataResponse = {
		id,
		revision,
		values: { title, documentTitle, tags, targets },
		incremental: result.incremental
	};
	(self as unknown as Worker).postMessage(response);
});

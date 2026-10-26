// Cross-file search worker - offloads the O(N×L) loop off the main thread.
// Matcher logic lives in `#lib/search-core.js` (unit-tested). This file only holds
// the corpus cache + message bridge.
//
// Corpus sync: the main thread may send `files` only when the snapshot changed
// (fingerprint). Omitting `files` reuses the last corpus held in the worker.

import type { Hit } from '#lib/types.js';
import { matchInCorpus, type SearchFile } from '#lib/search-core.js';

export type { SearchFile };

export interface SearchRequest {
	id: number;
	/** When present, replaces the worker's corpus. When omitted, the previous
	 *  corpus is reused (incremental search after the first full sync). */
	files?: SearchFile[];
	query: string;
	caseSensitive: boolean;
	wholeWord: boolean;
	useRegex: boolean;
}

export interface SearchResponse {
	id: number;
	hits: Hit[];
	regexError: string | null;
}

/** Last corpus received from the main thread (persists across search messages). */
let corpus: SearchFile[] = [];

function search(req: SearchRequest): SearchResponse {
	if (req.files) corpus = req.files;
	const { hits, regexError } = matchInCorpus(corpus, {
		query: req.query,
		caseSensitive: req.caseSensitive,
		wholeWord: req.wholeWord,
		useRegex: req.useRegex
	});
	return { id: req.id, hits, regexError };
}

self.addEventListener('message', (e: MessageEvent<SearchRequest>) => {
	const response = search(e.data);
	(self as unknown as Worker).postMessage(response);
});

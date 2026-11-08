import { describe, expect, it } from 'vitest';
import { MetaIndex } from './meta-index';
import { WikiLinkIndex } from './wiki-link-index';
import { matchInCorpus } from './search-core';
import type { FileItem } from './types';

function corpus(size: number): FileItem[] {
	return Array.from({ length: size }, (_, index) => ({
		id: `doc-${index}`,
		name: `Document ${index}.md`,
		content: `---\ntags: [group-${index % 12}, benchmark]\n---\n# Document ${index}\n\n${'Local-first searchable paragraph. '.repeat(80)}\n\n[[Document ${(index + 1) % size}]]`,
		createdAt: index,
		updatedAt: index,
		dirty: false
	}));
}

describe('corpus performance budget', () => {
	it('indexes and searches 300 representative documents within budget', () => {
		const files = corpus(300);
		const index = new MetaIndex(() => files, undefined, WikiLinkIndex);
		const startedAt = performance.now();
		expect(index.allTags).toHaveLength(13);
		expect(index.backlinks('doc-0')).toHaveLength(1);
		const result = matchInCorpus(files, {
			query: 'searchable paragraph',
			caseSensitive: false,
			wholeWord: false,
			useRegex: false
		});
		const elapsedMs = performance.now() - startedAt;
		expect(result.regexError).toBeNull();
		expect(result.hits.length).toBeGreaterThan(0);
		expect(elapsedMs).toBeLessThan(1500);
	});
});

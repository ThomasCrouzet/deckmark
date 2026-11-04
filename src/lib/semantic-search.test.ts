import { describe, expect, it } from 'vitest';
import { cosine, embed, indexFiles, search, trainCooccurrenceModel } from './semantic-search';
import type { FileItem } from './types';

const now = Date.now();
function file(id: string, name: string, content: string): FileItem {
	return { id, name, content, createdAt: now, updatedAt: now, dirty: false };
}

describe('local semantic index', () => {
	it('reuses unchanged rows and rebuilds changed ones', () => {
		const files = [file('a', 'a.md', 'Documentation guide')];
		const first = indexFiles(files, [], null);
		const reused = indexFiles(files, first, null);
		expect(reused[0]).toBe(first[0]);
		files[0]!.content = 'Different content';
		const rebuilt = indexFiles(files, first, null);
		expect(rebuilt[0]?.contentHash).not.toBe(first[0]?.contentHash);
	});

	it('ranks related word forms and reports a line', () => {
		const rows = indexFiles(
			[
				file('a', 'guide.md', 'Line one\nDocumentation for the editor\nLast line'),
				file('b', 'other.md', 'Unrelated cooking recipe')
			],
			[],
			null
		);
		const hits = search(rows, 'document');
		expect(hits[0]?.draftId).toBe('a');
		expect(hits[0]?.line).toBe(1);
		expect(hits[0]?.path).toBe('guide.md');
	});

	it('skips secret and binary files', () => {
		const rows = indexFiles(
			[file('a', '.env', 'TOKEN=secret'), { ...file('b', 'image.png', ''), kind: 'image' }],
			[],
			null
		);
		expect(rows).toHaveLength(0);
	});

	it('trains a selectable co-occurrence model from local text', () => {
		const model = trainCooccurrenceModel([
			'documentation guide for the editor. documentation explains the editor.',
			'cooking recipe for bread.'
		]);
		expect(model.modelId).toBe('cooccurrence-v1');
		expect(cosine(model.embed('guide'), model.embed('documentation'))).toBeGreaterThan(
			cosine(model.embed('guide'), model.embed('recipe'))
		);
		const rows = indexFiles(
			[
				file('a', 'guide.md', 'Documentation guide for the editor.'),
				file('b', 'recipe.md', 'Cooking recipe for bread.')
			],
			[],
			null,
			model
		);
		expect(rows.every((row) => row.modelId === 'cooccurrence-v1')).toBe(true);
		expect(search(rows, 'guide', model)[0]?.draftId).toBe('a');
	});

	it('normalizes vectors', () => {
		const vector = embed('one two two');
		const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
		expect(norm).toBeCloseTo(1);
	});
});

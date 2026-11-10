import { describe, expect, it } from 'vitest';
import { contentHash } from './ai/patches';
import type { FileItem } from './types';
import {
	compatibleRows,
	cosine,
	embed,
	indexFiles,
	search,
	trainCooccurrenceModel
} from './semantic-search';

const now = Date.now();
function file(id: string, name: string, content: string, projectId?: string): FileItem {
	return {
		id,
		name,
		content,
		...(projectId ? { projectId } : {}),
		createdAt: now,
		updatedAt: now,
		dirty: false
	};
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

	it('rebuilds rows when the trained model revision changes', () => {
		const files = [file('a', 'guide.md', 'Documentation guide for the editor.')];
		const corpusA = trainCooccurrenceModel([files[0]!.content], 'corpus-a');
		const corpusB = trainCooccurrenceModel([files[0]!.content], 'corpus-b');
		const first = indexFiles(files, [], null, corpusA);
		expect(indexFiles(files, first, null, corpusA)[0]).toBe(first[0]);
		const rebuilt = indexFiles(files, first, null, corpusB);
		expect(rebuilt[0]).not.toBe(first[0]);
		expect(rebuilt[0]?.modelRevision).toBe('corpus-b');
	});

	it('does not score rows from another trained revision', () => {
		const files = [file('a', 'guide.md', 'Documentation guide for the editor.')];
		const corpusA = trainCooccurrenceModel([files[0]!.content], 'corpus-a');
		const corpusB = trainCooccurrenceModel([files[0]!.content], 'corpus-b');
		const rowsA = indexFiles(files, [], null, corpusA);
		expect(search(rowsA, 'guide', corpusB)).toEqual([]);
		expect(search(rowsA, 'guide', corpusA)).toHaveLength(1);
	});

	it('scores only rows with a current model revision and source hash', () => {
		const files = [
			file('a', 'guide.md', 'Documentation guide for the editor.'),
			file('b', 'recipe.md', 'Cooking recipe for bread.')
		];
		const corpus = trainCooccurrenceModel(
			files.map((entry) => entry.content),
			'corpus-a'
		);
		const rows = indexFiles(files, [], null, corpus);
		const current = new Map(files.map((entry) => [entry.id, contentHash(entry.content)]));

		const all = compatibleRows(rows, corpus, (row) => current.get(row.draftId) === row.contentHash);
		expect(all).toMatchObject({ stale: 0, incompatible: 0 });
		expect(all.rows).toHaveLength(2);

		const edited = new Map(current).set('a', 'edited-hash');
		const filtered = compatibleRows(
			rows,
			corpus,
			(row) => edited.get(row.draftId) === row.contentHash
		);
		expect(filtered.rows.map((row) => row.draftId)).toEqual(['b']);
		expect(filtered.stale).toBe(1);
		expect(filtered.incompatible).toBe(0);

		const otherCorpus = trainCooccurrenceModel(
			files.map((entry) => entry.content),
			'corpus-b'
		);
		const mismatched = compatibleRows(rows, otherCorpus, () => true);
		expect(mismatched.rows).toEqual([]);
		expect(mismatched.incompatible).toBe(2);
		expect(mismatched.stale).toBe(0);
	});

	it('matches a fresh index after an A to B to A corpus transition', () => {
		const files = [file('a', 'guide.md', 'Documentation guide for the editor.')];
		const corpusA = trainCooccurrenceModel([files[0]!.content], 'corpus-a');
		const corpusB = trainCooccurrenceModel(['Cooking recipe for bread.'], 'corpus-b');
		const rowsA = indexFiles(files, [], null, corpusA);
		expect(search(rowsA, 'guide', corpusA)).toHaveLength(1);

		files[0]!.content = 'Cooking recipe for bread.';
		expect(search(rowsA, 'guide', corpusB)).toEqual([]);
		const rowsB = indexFiles(files, rowsA, null, corpusB);
		expect(search(rowsB, 'guide', corpusB)).toEqual([]);
		expect(search(rowsB, 'recipe', corpusB)).toHaveLength(1);

		files[0]!.content = 'Documentation guide for the editor.';
		expect(search(rowsB, 'guide', corpusA)).toEqual([]);
		const rowsAgain = indexFiles(files, rowsB, null, corpusA);
		const fresh = indexFiles(files, [], null, corpusA);
		expect(search(rowsAgain, 'guide', corpusA)).toEqual(search(fresh, 'guide', corpusA));
		expect(search(rowsAgain, 'guide', corpusA)[0]?.draftId).toBe('a');
	});

	it('normalizes vectors', () => {
		const vector = embed('one two two');
		const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
		expect(norm).toBeCloseTo(1);
	});
});

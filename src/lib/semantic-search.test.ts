import Dexie from 'dexie';
import { describe, expect, it } from 'vitest';
import { contentHash } from './ai/patches';
import type { FileItem } from './types';
import type { SemanticIndexRow } from './db';
import {
	clearScope,
	compatibleRows,
	corpusRevision,
	cosine,
	cachedCooccurrenceEmbedder,
	embed,
	indexFiles,
	revisionHash,
	scopeRowId,
	scopedRows,
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

	it('rebuilds a row when two documents share the 32-bit content digest', () => {
		const entry = file('same', 'same.md', '4c6d3c14');
		// Deterministic collision fixture: the shared digest alone cannot tell
		// these two sources apart.
		expect(contentHash('4c6d3c14')).toBe(contentHash('34749a0f'));
		const first = indexFiles([entry], [], null);
		expect(first[0]?.chunks[0]?.text).toBe('4c6d3c14');

		entry.content = '34749a0f';
		expect(revisionHash(entry.content)).not.toBe(revisionHash('4c6d3c14'));
		const rebuilt = indexFiles([entry], first, null);
		expect(rebuilt[0]).not.toBe(first[0]);
		expect(rebuilt[0]?.sourceRevision).not.toBe(first[0]?.sourceRevision);
		expect(rebuilt[0]?.chunks[0]?.text).toBe('34749a0f');
		expect(rebuilt[0]?.vector).not.toEqual(first[0]?.vector);

		// The preview and query vector follow the new source, matching a fresh
		// index with no previous row.
		const fresh = indexFiles([entry], [], null);
		expect(search(rebuilt, '34749a0f')).toEqual(search(fresh, '34749a0f'));
		expect(search(rebuilt, '34749a0f')[0]?.text).toBe('34749a0f');
		expect(search(first, '4c6d3c14')[0]?.text).toBe('4c6d3c14');
	});

	it('keys a trained model by the exact corpus revision, not a digest', () => {
		const left = [{ id: 'same', content: '4c6d3c14' }];
		const right = [{ id: 'same', content: '34749a0f' }];
		expect(contentHash(left[0]!.content)).toBe(contentHash(right[0]!.content));
		expect(corpusRevision('library', left)).not.toBe(corpusRevision('library', right));

		// Same caller key with different text must never reuse the trained
		// coordinate space.
		const modelA = cachedCooccurrenceEmbedder('adversarial-key', [left[0]!.content]);
		const modelB = cachedCooccurrenceEmbedder('adversarial-key', [right[0]!.content]);
		expect(modelA.revision).not.toBe(modelB.revision);
		expect(modelA.embed('4c6d3c14')).not.toEqual(modelB.embed('4c6d3c14'));
	});

	it('matches a fresh index after a colliding A to B to A corpus transition', () => {
		const entry = file('same', 'same.md', '4c6d3c14');
		const corpusA = cachedCooccurrenceEmbedder(corpusRevision('library', [entry]), ['4c6d3c14']);
		const rowsA = indexFiles([entry], [], null, corpusA);
		expect(search(rowsA, '4c6d3c14', corpusA)[0]?.text).toBe('4c6d3c14');

		entry.content = '34749a0f';
		const corpusB = cachedCooccurrenceEmbedder(corpusRevision('library', [entry]), ['34749a0f']);
		expect(corpusB.revision).not.toBe(corpusA.revision);
		expect(search(rowsA, '34749a0f', corpusB)).toEqual([]);
		const rowsB = indexFiles([entry], rowsA, null, corpusB);
		expect(rowsB[0]?.chunks[0]?.text).toBe('34749a0f');

		entry.content = '4c6d3c14';
		const corpusAgain = cachedCooccurrenceEmbedder(corpusRevision('library', [entry]), [
			'4c6d3c14'
		]);
		expect(corpusAgain.revision).toBe(corpusA.revision);
		const rowsAgain = indexFiles([entry], rowsB, null, corpusAgain);
		const fresh = indexFiles([entry], [], null, corpusA);
		expect(search(rowsAgain, '4c6d3c14', corpusAgain)).toEqual(search(fresh, '4c6d3c14', corpusA));
		expect(search(rowsAgain, '34749a0f', corpusAgain)).toEqual(search(fresh, '34749a0f', corpusA));
	});

	it('normalizes vectors', () => {
		const vector = embed('one two two');
		const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
		expect(norm).toBeCloseTo(1);
	});
});

describe('scoped index rows', () => {
	function row(index: number, projectId: string | null): SemanticIndexRow {
		return {
			id: scopeRowId(projectId, `draft-${index}`),
			projectId,
			draftId: `draft-${index}`,
			path: `doc-${index}.md`,
			contentHash: `hash-${index}`,
			modelId: 'feature-hash-v1',
			modelRevision: 'feature-hash-v1',
			vector: [],
			chunks: [],
			updatedAt: now
		};
	}

	it('reads and clears only the selected library or project scope', async () => {
		const database = new Dexie(`semantic-scope-${Date.now()}`);
		database.version(1).stores({ semanticIndex: 'id, projectId, draftId' });
		try {
			const table = database.table<SemanticIndexRow, string>('semanticIndex');
			await table.bulkPut([row(1, null), row(2, 'project-a'), row(3, 'project-b')]);

			expect((await scopedRows(table, null)).map((entry) => entry.id)).toEqual(['library:draft-1']);
			expect((await scopedRows(table, 'project-a')).map((entry) => entry.id)).toEqual([
				'project-a:draft-2'
			]);

			expect(await clearScope(table, 'project-a')).toBe(1);
			expect((await table.toArray()).map((entry) => entry.id).sort()).toEqual([
				'library:draft-1',
				'project-b:draft-3'
			]);

			expect(await clearScope(table, null)).toBe(1);
			expect((await table.toArray()).map((entry) => entry.id)).toEqual(['project-b:draft-3']);

			expect(await clearScope(table, 'project-b')).toBe(1);
			expect(await table.count()).toBe(0);
		} finally {
			await database.delete();
		}
	});

	it.each([300, 900, 3000])('keeps %i rows scoped and excludes stale source rows', async (size) => {
		const database = new Dexie(`semantic-scale-${size}-${Date.now()}`);
		database.version(1).stores({ semanticIndex: 'id, projectId, draftId' });
		try {
			const table = database.table<SemanticIndexRow, string>('semanticIndex');
			const entries = Array.from({ length: size }, (_, index) =>
				row(index, index % 2 === 0 ? 'project-a' : 'project-b')
			);
			await table.bulkPut(entries);
			const scoped = await scopedRows(table, 'project-a');
			expect(scoped).toHaveLength(size / 2);
			expect(scoped.every((entry) => entry.projectId === 'project-a')).toBe(true);

			const current = new Map(scoped.map((entry) => [entry.draftId, entry.contentHash]));
			current.set(scoped[0]!.draftId, 'edited');
			const compatible = compatibleRows(
				scoped,
				{ modelId: 'feature-hash-v1', revision: 'feature-hash-v1', dims: 384, embed },
				(entry) => current.get(entry.draftId) === entry.contentHash
			);
			expect(compatible.rows).toHaveLength(size / 2 - 1);
			expect(compatible.stale).toBe(1);
			expect(compatible.incompatible).toBe(0);
		} finally {
			await database.delete();
		}
	});
});

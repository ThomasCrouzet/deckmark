import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, type SnippetRow } from './db';
import { snippetsStore } from './snippets.svelte';
import { hashSnippetCode } from './snippet-hash';

function snippetRow(id: string, overrides: Partial<SnippetRow> = {}): SnippetRow {
	return {
		id,
		title: `Snippet ${id}`,
		code: 'version one',
		language: 'javascript',
		tags: ['demo'],
		favorite: false,
		createdAt: 1,
		updatedAt: 1,
		...overrides
	};
}

describe('snippet duplicate index', () => {
	beforeEach(async () => {
		await db.snippets.clear();
		await snippetsStore.reload();
	});

	it('stores a code hash and rejects an identical snippet', async () => {
		const first = await snippetsStore.save({
			title: 'Greeting',
			code: 'def greet(name):',
			language: 'python',
			tags: []
		});
		expect(first.ok).toBe(true);
		const [row] = await db.snippets.toArray();
		expect(row?.codeHash).toBe(hashSnippetCode('def greet(name):'));

		const duplicate = await snippetsStore.save({
			title: 'Greeting copy',
			code: 'def greet(name):',
			language: 'python',
			tags: []
		});
		expect(duplicate.ok).toBe(false);
		expect(await db.snippets.count()).toBe(1);
	});

	it('lists metadata only and toggles a favorite without rewriting the body', async () => {
		const saved = await snippetsStore.save({
			title: 'Large',
			code: `${'const value = 1;\n'.repeat(1000)}`,
			language: 'javascript',
			tags: ['demo']
		});
		await snippetsStore.reload();
		expect(saved.ok).toBe(true);
		const listed = snippetsStore.rows[0]!;
		expect(listed.contentDeferred).toBe(true);
		expect(listed.code).toBe('');
		const put = vi.spyOn(db.snippets, 'put');
		await snippetsStore.toggleFavorite(listed.id);
		expect(put).not.toHaveBeenCalled();
		expect(snippetsStore.rows[0]?.favorite).toBe(true);
		expect(snippetsStore.rows[0]?.code).toBe('');
		expect(await snippetsStore.contentFor(listed.id)).toContain('const value = 1;');
		expect(snippetsStore.rows[0]?.code).toContain('const value = 1;');
		put.mockRestore();
	});
});

describe('portable snippet import', () => {
	beforeEach(async () => {
		await db.snippets.clear();
		await snippetsStore.reload();
	});

	it('keeps a newer local snippet and preserves the import as a variant', async () => {
		const local = snippetRow('same', { code: 'version two', updatedAt: 2 });
		await db.snippets.put(local);
		const report = await snippetsStore.importRows([snippetRow('same')]);
		expect(report).toEqual({ added: 0, preserved: 1, unchanged: 0, replaced: 0 });
		expect((await db.snippets.get('same'))?.code).toBe('version two');
		expect(await db.snippets.count()).toBe(2);
		const variant = (await db.snippets.toArray()).find((row) => row.id !== 'same');
		expect(variant).toMatchObject({ title: 'Snippet same', code: 'version one' });
	});

	it('treats an exact duplicate as idempotent', async () => {
		await db.snippets.put(snippetRow('exact'));
		const report = await snippetsStore.importRows([snippetRow('exact')]);
		expect(report).toEqual({ added: 0, preserved: 0, unchanged: 1, replaced: 0 });
		expect(await db.snippets.count()).toBe(1);
	});

	it('preserves a metadata-only conflict and adds unrelated rows', async () => {
		await db.snippets.put(snippetRow('meta', { favorite: true }));
		const report = await snippetsStore.importRows([snippetRow('meta'), snippetRow('unrelated')]);
		expect(report).toEqual({ added: 1, preserved: 1, unchanged: 0, replaced: 0 });
		expect((await db.snippets.get('meta'))?.favorite).toBe(true);
		expect(await db.snippets.count()).toBe(3);
	});

	it('rolls back every row when the transaction write fails', async () => {
		const put = vi.spyOn(db.snippets, 'bulkPut').mockRejectedValue(new Error('quota'));
		await expect(snippetsStore.importRows([snippetRow('new')])).rejects.toThrow('quota');
		put.mockRestore();
		expect(await db.snippets.count()).toBe(0);
		expect(snippetsStore.rows).toHaveLength(0);
	});
});

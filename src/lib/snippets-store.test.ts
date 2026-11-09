import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from './db';
import { snippetsStore } from './snippets.svelte';
import { hashSnippetCode } from './snippet-hash';

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

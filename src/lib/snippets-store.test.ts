import { beforeEach, describe, expect, it } from 'vitest';
import { db } from './db';
import { snippetsStore } from './snippets.svelte';
import { hashSnippetCode } from './snippet-hash';

describe('snippet duplicate index', () => {
	beforeEach(async () => {
		await db.snippets.clear();
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
});

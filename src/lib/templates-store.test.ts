import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db } from './db';
import { templatesStore } from './templates.svelte';

beforeEach(async () => {
	await db.templates.clear();
	templatesStore.userTemplates = [];
	templatesStore.loaded = false;
});
afterEach(async () => {
	vi.restoreAllMocks();
	await db.templates.clear();
});

describe('templatesStore', () => {
	it('keeps the document kind for presentation templates', async () => {
		const saved = await templatesStore.save('Deck', '# Deck', 'presentation');
		expect(saved?.kind).toBe('presentation');
		expect(await db.templates.get(saved!.id)).toMatchObject({ kind: 'presentation' });
		expect(templatesStore.resolve(saved!.id)).toMatchObject({ kind: 'presentation' });
	});

	it('treats an older template row without kind as a note', async () => {
		const now = Date.now();
		templatesStore.userTemplates = [
			{
				id: 'legacy',
				name: 'Legacy',
				content: '# Note',
				builtin: false,
				createdAt: now,
				updatedAt: now
			}
		];
		expect(templatesStore.choices.find((choice) => choice.id === 'legacy')?.kind).toBe('note');
		expect(templatesStore.resolve('legacy')?.kind).toBe('note');
	});

	it('updates a template only after its new content is durable', async () => {
		const template = await templatesStore.save('Before', 'old');
		expect(await templatesStore.update(template!.id, 'After', 'new')).toBe(true);
		expect(await db.templates.get(template!.id)).toMatchObject({ name: 'After', content: 'new' });
		vi.spyOn(db.templates, 'put').mockRejectedValueOnce(new Error('Full'));
		expect(await templatesStore.update(template!.id, 'Lost', 'lost')).toBe(false);
		expect(templatesStore.userTemplates[0]).toMatchObject({ name: 'After', content: 'new' });
		expect(await templatesStore.update('missing', 'Name', '')).toBe(false);
	});
});

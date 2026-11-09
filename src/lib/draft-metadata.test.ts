import { beforeEach, describe, expect, it } from 'vitest';
import { db, type DraftRow } from './db';
import { readDraftMetadata } from './draft-manifest';
import { installDraftMetadataHooks } from './draft-metadata-hooks';

function row(overrides: Partial<DraftRow> = {}): DraftRow {
	return {
		id: 'meta-note',
		name: 'meta-note.md',
		content: '---\ntitle: Durable title\ntags:\n  - alpha\n  - beta\n---\n\n[[Target]]\n',
		createdAt: 1,
		updatedAt: 1,
		order: 0,
		...overrides
	};
}

describe('durable draft metadata', () => {
	beforeEach(async () => {
		installDraftMetadataHooks();
		await db.drafts.clear();
	});

	it('writes title, tags and targets in the draft transaction', async () => {
		await db.drafts.put(row());
		const metadata = await readDraftMetadata();
		expect(metadata?.get('meta-note')).toMatchObject({
			title: 'Durable title',
			tags: ['alpha', 'beta'],
			targets: ['Target']
		});
	});

	it('updates the projection when content changes', async () => {
		await db.drafts.put(row());
		await db.drafts.update('meta-note', {
			content: '---\ntitle: Next\ntags: [gamma]\n---\n',
			updatedAt: 2
		});
		const metadata = await readDraftMetadata();
		expect(metadata?.get('meta-note')).toMatchObject({
			title: 'Next',
			tags: ['gamma'],
			targets: []
		});
	});
});

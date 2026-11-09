import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, type DraftRow } from './db';
import { readDraftMetadata } from './draft-manifest';
import { backfillDraftMetadata, installDraftMetadataHooks } from './draft-metadata';

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

	it('ignores fenced, indented and inline-code targets in one pass', async () => {
		await db.drafts.put(
			row({
				content:
					'[[Visible]]\n\n```md\n[[Fenced]]\n```\n\n    [[Indented]]\n\n`[[Inline]]`\n\n[[Last]]'
			})
		);
		const metadata = await readDraftMetadata();
		expect(metadata?.get('meta-note')?.targets).toEqual(['Visible', 'Last']);
	});

	it('keeps targets below an unfinished fence like the previous scanner', async () => {
		await db.drafts.put(row({ content: '```md\n[[Still visible]]\n' }));
		const metadata = await readDraftMetadata();
		expect(metadata?.get('meta-note')?.targets).toEqual(['Still visible']);
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

describe('metadata backfill safety', () => {
	beforeEach(async () => {
		installDraftMetadataHooks();
		await db.drafts.clear();
	});

	it('updates only missing projections and never rewrites the row body', async () => {
		await db.drafts.put(row());
		await db.drafts.update('meta-note', { metadata: '' });
		const bulkPut = vi.spyOn(db.drafts, 'bulkPut');
		await backfillDraftMetadata();
		expect(bulkPut).not.toHaveBeenCalled();
		const stored = await db.drafts.get('meta-note');
		expect(stored?.content).toContain('Durable title');
		expect(stored?.metadata).toBeDefined();
		bulkPut.mockRestore();
	});

	it('does nothing when every projection is current', async () => {
		await db.drafts.put(row());
		const update = vi.spyOn(db.drafts, 'update');
		await backfillDraftMetadata();
		expect(update).not.toHaveBeenCalled();
		update.mockRestore();
	});
});

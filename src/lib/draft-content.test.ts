import { beforeEach, describe, expect, it } from 'vitest';
import { db } from './db';
import { buildSearchCorpus } from './draft-content';
import type { FileItem } from './types';

// Failure risk: a draft row can disappear or change between the metadata index
// load and the bulk body read. A browser workflow cannot remove one row exactly
// inside that window, so these cases call the real bulk reader with real
// IndexedDB rows. They keep the placeholder and partial-batch boundaries.

function deferred(id: string, name = 'doc.md'): FileItem {
	return {
		id,
		name,
		content: '',
		createdAt: 1,
		updatedAt: 1,
		dirty: false,
		kind: 'note',
		contentDeferred: true,
		derivedMetadata: {
			id,
			contentHash: 'hash',
			contentLength: 4,
			title: '',
			documentTitle: '',
			tags: [],
			targets: [],
			hasBlocks: false,
			hasIncludes: false
		}
	};
}

beforeEach(async () => {
	await db.drafts.clear();
});

describe('deferred search corpus', () => {
	it('omits a deferred file without a durable row instead of its placeholder', async () => {
		const corpus = await buildSearchCorpus([deferred('removed')]);
		expect(corpus).toEqual([]);
	});

	it('returns only the entries backed by an exact draft row', async () => {
		await db.drafts.put({
			id: 'present',
			name: 'present.md',
			content: '---\ntitle: Present\n---\n',
			createdAt: 1,
			updatedAt: 1,
			order: 0
		});
		const resident: FileItem = {
			id: 'resident',
			name: 'resident.md',
			content: '---\ntitle: Resident\n---\n',
			createdAt: 1,
			updatedAt: 1,
			dirty: false,
			kind: 'note'
		};
		const corpus = await buildSearchCorpus([deferred('present'), deferred('removed'), resident]);
		expect(corpus).toEqual([
			{ id: 'present', name: 'doc.md', content: '---\ntitle: Present\n---\n' },
			{ id: 'resident', name: 'resident.md', content: '---\ntitle: Resident\n---\n' }
		]);
	});
});

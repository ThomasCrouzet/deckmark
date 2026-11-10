import { beforeEach, describe, expect, it } from 'vitest';
import { db } from './db';
import {
	buildCollection,
	clearCollectionCache,
	filterRows,
	groupRows,
	sortRows,
	type CollectionBuildStats
} from './collection';
import type { FileItem } from './types';

// The collection cache must not treat the 32-bit FNV-1a hint as exact source
// equality. A browser workflow can change a note and read the table, but it
// cannot cheaply force two equal-length sources with the same hash. These
// isolated cases keep the concrete collision and the projection identity.

function file(id: string, content: string, updatedAt = 1, name = 'doc.md'): FileItem {
	return {
		id,
		name,
		content,
		createdAt: 1,
		updatedAt,
		dirty: false,
		kind: 'note'
	};
}

function fnv36(content: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < content.length; index++) {
		hash ^= content.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(36);
}

function deferred(fileId: string, content: string, updatedAt = 1, name = 'doc.md'): FileItem {
	return {
		id: fileId,
		name,
		content: '',
		createdAt: 1,
		updatedAt,
		dirty: false,
		kind: 'note',
		contentDeferred: true,
		derivedMetadata: {
			id: fileId,
			contentHash: fnv36(content),
			contentLength: content.length,
			title: '',
			documentTitle: '',
			tags: [],
			targets: [],
			hasBlocks: false,
			hasIncludes: false
		}
	};
}

function statsOf(): { stats: CollectionBuildStats | null } {
	return { stats: null };
}

beforeEach(async () => {
	clearCollectionCache();
	await db.metadata.clear();
});

describe('collection cache identity', () => {
	it('does not reuse a parsed row across an equal-length hash collision', async () => {
		const first = '---\ntitle: 3d63b530\n---\n';
		const second = '---\ntitle: 5705511b\n---\n';
		expect(first.length).toBe(second.length);
		expect(fnv36(first)).toBe(fnv36(second));

		const target = file('same-id', first);
		expect((await buildCollection([target], { persist: false }))[0]?.title).toBe('3d63b530');
		target.content = second;
		target.updatedAt += 1;
		expect((await buildCollection([target], { persist: false }))[0]?.title).toBe('5705511b');
	});

	it('reuses unchanged resident rows and reparses only the changed one', async () => {
		const files = [
			file('a', '---\ntitle: Alpha\n---\n'),
			file('b', '---\ntitle: Beta\n---\n'),
			file('c', '---\ntitle: Gamma\n---\n')
		];
		const first = statsOf();
		await buildCollection(files, { persist: false, onStats: (value) => (first.stats = value) });
		expect(first.stats).toMatchObject({ parsed: 3, reused: 0 });

		files[1]!.content = '---\ntitle: Beta changed\n---\n';
		const second = statsOf();
		const rows = await buildCollection(files, {
			persist: false,
			onStats: (value) => (second.stats = value)
		});
		expect(second.stats).toMatchObject({ parsed: 1, reused: 2 });
		expect(rows.find((row) => row.id === 'b')?.title).toBe('Beta changed');
		expect(rows.map((row) => row.title)).toEqual(['Alpha', 'Beta changed', 'Gamma']);
	});

	it('updates the fallback title when only the file name changes', async () => {
		const target = file('a', 'No front matter.\n', 1, 'Old name.md');
		expect((await buildCollection([target], { persist: false }))[0]?.title).toBe('Old name');
		target.name = 'New name.md';
		expect((await buildCollection([target], { persist: false }))[0]?.title).toBe('New name');
	});

	it('reuses a durable projection and rejects it when the revision changes', async () => {
		const content = '---\ntitle: Deferred\n---\n';
		const target = deferred('deferred-id', content);
		const reads: string[] = [];
		const first = statsOf();
		await buildCollection([target], {
			persist: false,
			readBodies: async (files) => {
				reads.push(...files.map((entry) => entry.id));
				return new Map([[target.id, content]]);
			},
			onStats: (value) => (first.stats = value)
		});
		expect(first.stats).toMatchObject({ parsed: 1, bodyReads: 1 });

		const second = statsOf();
		await buildCollection([target], {
			persist: false,
			readBodies: async () => {
				throw new Error('The unchanged projection must not read the body');
			},
			onStats: (value) => (second.stats = value)
		});
		expect(second.stats).toMatchObject({ parsed: 0, reused: 1, bodyReads: 0 });

		const changed = '---\ntitle: Changed\n---\n';
		target.updatedAt = 2;
		target.derivedMetadata = {
			...target.derivedMetadata!,
			contentHash: fnv36(changed),
			contentLength: changed.length
		};
		const third = statsOf();
		const rows = await buildCollection([target], {
			persist: false,
			readBodies: async () => new Map([[target.id, changed]]),
			onStats: (value) => (third.stats = value)
		});
		expect(third.stats).toMatchObject({ parsed: 1, bodyReads: 1 });
		expect(rows[0]?.title).toBe('Changed');
	});

	it('persists a durable projection and reuses it without the body', async () => {
		const content = '---\ntitle: Stored\nstatus: active\n---\n';
		const target = deferred('stored-id', content);
		await buildCollection([target], {
			readBodies: async () => new Map([[target.id, content]])
		});
		await expect(db.metadata.get('collection-row:stored-id')).resolves.toBeDefined();
		clearCollectionCache();

		const reused = statsOf();
		const rows = await buildCollection([target], {
			readBodies: async () => {
				throw new Error('The stored projection must not read the body');
			},
			onStats: (value) => (reused.stats = value)
		});
		expect(reused.stats).toMatchObject({ parsed: 0, reused: 1, bodyReads: 0 });
		expect(rows[0]?.values.status).toBe('active');
	});

	it('keeps filter, sort and group results correct after a same-id update', async () => {
		const target = file('same-id', '---\ntitle: First\nstatus: old\npriority: 1\n---\n');
		const other = file('other', '---\ntitle: Second\nstatus: old\npriority: 2\n---\n');
		await buildCollection([target, other], { persist: false });
		target.content = '---\ntitle: Renamed\nstatus: new\npriority: 5\n---\n';
		target.updatedAt = 2;
		const rows = await buildCollection([target, other], { persist: false });

		expect(filterRows(rows, 'renamed').map((row) => row.id)).toEqual(['same-id']);
		expect(filterRows(rows, 'second').map((row) => row.id)).toEqual(['other']);
		expect(sortRows(rows, 'priority', 'desc').map((row) => row.id)).toEqual(['same-id', 'other']);
		expect(groupRows(rows, 'status').map((group) => group.key)).toEqual(['new', 'old']);
	});
});

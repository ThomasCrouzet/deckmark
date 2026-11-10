import { beforeEach, describe, expect, it } from 'vitest';
import { db } from './db';
import {
	buildCollection,
	clearCollectionCache,
	collectionColumns,
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

	it('round-trips non-finite YAML numbers through the durable projection', async () => {
		const content =
			'---\ntitle: Numeric\nscore: .nan\ncapacity: .inf\nfloor: -.inf\n---\n\n# Numeric\n';
		const target = deferred('numeric-id', content);
		const first = await buildCollection([target], {
			readBodies: async () => new Map([[target.id, content]])
		});
		expect(first[0]?.values).toMatchObject({
			score: 'NaN',
			capacity: 'Infinity',
			floor: '-Infinity'
		});
		const stored = await db.metadata.get('collection-row:numeric-id');
		expect(stored?.value).toContain('"score":"NaN"');
		expect(stored?.value).not.toContain('"score":null');

		clearCollectionCache();
		const reused = statsOf();
		const rows = await buildCollection([target], {
			readBodies: async () => {
				throw new Error('The stored non-finite projection must not read the body');
			},
			onStats: (value) => (reused.stats = value)
		});
		expect(reused.stats).toMatchObject({ parsed: 0, reused: 1, bodyReads: 0 });
		expect(rows[0]?.values).toMatchObject({
			score: 'NaN',
			capacity: 'Infinity',
			floor: '-Infinity'
		});
		expect(collectionColumns(rows)).toEqual(['capacity', 'floor', 'score', 'title']);
		expect(() => sortRows(rows, 'score', 'asc')).not.toThrow();
		expect(filterRows(rows, 'nan').map((row) => row.id)).toEqual(['numeric-id']);
		expect(groupRows(rows, 'capacity').map((group) => group.key)).toEqual(['Infinity']);
	});

	it('sorts and groups a mixed column with non-finite tokens and finite values', async () => {
		const files = [
			file('nan', '---\ntitle: NaN note\nscore: .nan\n---\n'),
			file('inf', '---\ntitle: Inf note\nscore: .inf\n---\n'),
			file('number', '---\ntitle: Number note\nscore: 7\n---\n'),
			file('text', '---\ntitle: Text note\nscore: high\n---\n')
		];
		const rows = await buildCollection(files, { persist: false });
		expect(() => sortRows(rows, 'score', 'asc')).not.toThrow();
		expect(() => sortRows(rows, 'score', 'desc')).not.toThrow();
		expect(() => groupRows(rows, 'score')).not.toThrow();
		expect(sortRows(rows, 'score', 'asc')).toHaveLength(files.length);
	});

	it('treats malformed and invalid stored projections as cache misses', async () => {
		const content = '---\ntitle: Recovered\nscore: 4\nlabels: [a, b]\n---\n\n# Body\n';
		const invalidValues = [{ score: null }, { labels: [1, { a: 1 }] }, { labels: [true] }];
		const variants = ['{"v":2,"revision":"broken"', ...invalidValues.map(() => '')];
		for (const [index, invalid] of invalidValues.entries()) {
			clearCollectionCache();
			const target = deferred(`invalid-${index}`, content);
			const first = await buildCollection([target], {
				readBodies: async () => new Map([[target.id, content]])
			});
			expect(first[0]?.title).toBe('Recovered');
			const stored = await db.metadata.get(`collection-row:${target.id}`);
			if (!stored) throw new Error('The projection was not written');
			const row = JSON.parse(stored.value) as Record<string, unknown>;
			variants[index + 1] = JSON.stringify({ ...row, values: invalid });
			await db.metadata.put({
				key: `collection-row:${target.id}`,
				value: variants[index + 1]!
			});
		}
		for (const [index, storedValue] of variants.entries()) {
			clearCollectionCache();
			const target = deferred(`invalid-${index}`, content);
			await db.metadata.put({ key: `collection-row:${target.id}`, value: storedValue });
			const parsed = statsOf();
			const rows = await buildCollection([target], {
				readBodies: async () => new Map([[target.id, content]]),
				onStats: (value) => (parsed.stats = value)
			});
			expect(parsed.stats, String(index)).toMatchObject({ parsed: 1, bodyReads: 1 });
			expect(rows[0]?.title, String(index)).toBe('Recovered');
			expect(rows[0]?.values, String(index)).toMatchObject({ score: 4, labels: ['a', 'b'] });
		}
	});
});

describe('collection body freshness', () => {
	function revise(target: FileItem, content: string, updatedAt: number) {
		target.updatedAt = updatedAt;
		target.derivedMetadata = {
			...target.derivedMetadata!,
			contentHash: fnv36(content),
			contentLength: content.length
		};
	}

	it('does not restamp an old projection when its newer body is missing', async () => {
		const first = '---\ntitle: Alpha\nstatus: old\n---\n';
		const second = '---\ntitle: Beta\nstatus: new\n---\n';
		const target = deferred('freshness-id', first);
		await buildCollection([target], {
			readBodies: async () => new Map([[target.id, first]])
		});
		const storedBefore = await db.metadata.get('collection-row:freshness-id');
		const before = JSON.parse(storedBefore!.value) as { revision: string; title: string };

		revise(target, second, 2);
		const missing = statsOf();
		const rows = await buildCollection([target], {
			readBodies: async () => new Map(),
			onStats: (value) => (missing.stats = value)
		});
		expect(rows).toEqual([]);
		expect(missing.stats).toMatchObject({ parsed: 0, reused: 0, bodyReads: 1, missing: 1 });
		const storedAfter = await db.metadata.get('collection-row:freshness-id');
		const after = JSON.parse(storedAfter!.value) as { revision: string; title: string };
		expect(after.title).toBe('Alpha');
		expect(after.revision).toBe(before.revision);

		clearCollectionCache();
		await expect(
			buildCollection([target], {
				readBodies: async () => {
					throw new Error('The changed source must be read again');
				}
			})
		).rejects.toThrow('The changed source must be read again');

		const recovered = await buildCollection([target], {
			readBodies: async () => new Map([[target.id, second]])
		});
		expect(recovered.map((row) => row.title)).toEqual(['Beta']);
		expect(recovered[0]?.values.status).toBe('new');
	});

	it('skips only the missing entries in a partial body batch', async () => {
		const firstA = '---\ntitle: Alpha\n---\n';
		const firstB = '---\ntitle: Beta\n---\n';
		const secondA = '---\ntitle: Alpha new\n---\n';
		const secondB = '---\ntitle: Beta new\n---\n';
		const a = deferred('partial-a', firstA);
		const b = deferred('partial-b', firstB);
		await buildCollection([a, b], {
			readBodies: async () =>
				new Map([
					[a.id, firstA],
					[b.id, firstB]
				])
		});
		revise(a, secondA, 2);
		revise(b, secondB, 2);
		const stats = statsOf();
		const rows = await buildCollection([a, b], {
			readBodies: async () => new Map([[a.id, secondA]]),
			onStats: (value) => (stats.stats = value)
		});
		expect(rows.map((row) => row.title)).toEqual(['Alpha new']);
		expect(stats.stats).toMatchObject({ missing: 1 });

		const storedB = await db.metadata.get('collection-row:partial-b');
		const parsedB = JSON.parse(storedB!.value) as { title: string };
		expect(parsedB.title).toBe('Beta');
	});

	it('discards a stale body that does not match the captured revision', async () => {
		const first = '---\ntitle: Alpha\nstatus: old\n---\n';
		const second = '---\ntitle: Beta\nstatus: new\n---\n';
		const target = deferred('stale-body-id', first);
		await buildCollection([target], {
			readBodies: async () => new Map([[target.id, first]])
		});
		revise(target, second, 2);
		const stats = statsOf();
		const rows = await buildCollection([target], {
			readBodies: async () => new Map([[target.id, first]]),
			onStats: (value) => (stats.stats = value)
		});
		expect(rows).toEqual([]);
		expect(stats.stats).toMatchObject({ missing: 1 });

		const recovered = await buildCollection([target], {
			readBodies: async () => new Map([[target.id, second]])
		});
		expect(recovered[0]?.title).toBe('Beta');
	});

	it('does not build a removed draft from its deferred placeholder', async () => {
		await db.drafts.clear();
		const target = deferred('removed-draft', '---\ntitle: Removed\n---\n');
		const stats = statsOf();
		const rows = await buildCollection([target], {
			persist: false,
			onStats: (value) => (stats.stats = value)
		});
		expect(rows).toEqual([]);
		expect(stats.stats).toMatchObject({ parsed: 0, reused: 0, missing: 1 });
	});
});

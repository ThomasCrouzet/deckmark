import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db } from './db';
import type { DraftRow, TrashedRow } from './db';
import { TIMERS } from './config';
import {
	loadTrashRows,
	moveToTrash,
	restoreFromTrash,
	purgePermanently,
	persistReorder
} from './trash';
import { recordVersion } from './version-history';
import { backfillTrashSummaries, installTrashSummaryHooks } from './trash-summary-hooks';

// Use a fixed epoch timestamp to make undo calculations deterministic.
const T0 = 1_000_000_000_000;

/** Fabrique une row `drafts` minimale. */
function draftRow(id: string, order = 0): DraftRow {
	return {
		id,
		name: `${id}.md`,
		content: `contenu ${id}`,
		createdAt: T0,
		updatedAt: T0,
		order
	};
}

/** Fabrique une row `trashed` minimale. */
function trashedRow(id: string, trashedAt: number, order = 0): TrashedRow {
	return { id, file: draftRow(id, order), order, trashedAt };
}

/** Fabrique une image binaire dont seuls les octets distinguent les branches. */
function binaryRow(id: string, data: string, updatedAt = T0): DraftRow {
	return {
		id,
		name: `${id}.png`,
		content: '',
		kind: 'image',
		mime: 'image/png',
		data,
		createdAt: T0,
		updatedAt,
		order: 0
	};
}

beforeEach(async () => {
	installTrashSummaryHooks();
	await db.drafts.clear();
	await db.trashed.clear();
	await db.versions.clear();
});
afterEach(async () => {
	vi.restoreAllMocks();
	await db.drafts.clear();
	await db.trashed.clear();
	await db.versions.clear();
});

describe('loadTrashRows', () => {
	it('deletes an expired entry from the database and result', async () => {
		// The item entered the trash exactly trashRetentionMs ago, so remainingMs = 0 and it is purged.
		await db.trashed.put(trashedRow('expired', T0 - TIMERS.trashRetentionMs, 0));

		const results = await loadTrashRows(T0);

		expect(results).toEqual([]);
		expect(await db.trashed.get('expired')).toBeUndefined();
	});

	it('deletes an old entry and keeps a recent entry', async () => {
		await db.trashed.bulkPut([
			trashedRow('old', T0 - TIMERS.trashRetentionMs - 10_000, 0),
			trashedRow('fresh', T0 - 1000, 1)
		]);

		const results = await loadTrashRows(T0);

		expect(results.map((r) => r.entry.file.id)).toEqual(['fresh']);
		expect(results[0]!.remainingMs).toBe(TIMERS.trashRetentionMs - 1000); // 4000
		expect(await db.trashed.get('old')).toBeUndefined();
		expect(await db.trashed.get('fresh')).toBeTruthy();
	});
});

describe('large trash loading', () => {
	it('keeps a large trash metadata-only until restore', async () => {
		await db.trashed.bulkPut(
			Array.from({ length: 70 }, (_value, index) => trashedRow(`large-${index}`, T0, index))
		);
		const results = await loadTrashRows(T0);
		expect(results).toHaveLength(70);
		expect(results[0]!.entry.file.content).toBe('');
		expect(results[0]!.entry.file.contentDeferred).toBe(true);
	});
});

describe('restoreFromTrash', () => {
	it('keeps a durable variant when the same ID exists', async () => {
		await db.trashed.put(trashedRow('r', T0));
		await db.drafts.put({ ...draftRow('r'), content: 'nouvelle branche' });
		await restoreFromTrash('r', draftRow('r'));
		expect((await db.drafts.get('r'))?.content).toBe('contenu r');
		const variant = (await db.drafts.toArray()).find((row) => row.id !== 'r');
		expect(variant?.content).toBe('nouvelle branche');
		expect(variant?.open).toBe(false);
	});

	it('writes the draft row and deletes the trash row in one transaction', async () => {
		await db.trashed.put(trashedRow('r1', T0, 0));
		const row = draftRow('r1', 0);

		const ok = await restoreFromTrash('r1', row);

		expect(ok).toBe(true);
		expect(await db.trashed.get('r1')).toBeUndefined();
		expect(await db.drafts.get('r1')).toMatchObject(row);
	});
});

describe('revision-safe trash variants', () => {
	it('preserves a concurrent binary branch when only the data payload differs', async () => {
		await db.drafts.put(binaryRow('image', 'data:image/png;base64,B', 2));

		expect(
			await moveToTrash('image', binaryRow('image', 'data:image/png;base64,A', 1), 0, T0)
		).toBe(true);

		expect((await db.trashed.get('image'))?.file.data).toBe('data:image/png;base64,A');
		const variants = (await db.drafts.toArray()).filter((row) => row.id !== 'image');
		expect(variants).toHaveLength(1);
		expect(variants[0]).toMatchObject({
			kind: 'image',
			mime: 'image/png',
			data: 'data:image/png;base64,B',
			open: false
		});
	});

	it('preserves a concurrent branch when only the MIME type differs', async () => {
		const durable = { ...binaryRow('mime', 'data:image/png;base64,A'), mime: 'image/webp' };
		await db.drafts.put(durable);

		await moveToTrash('mime', binaryRow('mime', 'data:image/png;base64,A'), 0, T0);

		const variant = (await db.drafts.toArray()).find((row) => row.id !== 'mime');
		expect(variant).toMatchObject({ mime: 'image/webp', data: 'data:image/png;base64,A' });
	});

	it('preserves a concurrent branch when only the project location differs', async () => {
		const durable: DraftRow = {
			...draftRow('location'),
			content: 'same',
			projectId: 'project-one',
			relativePath: 'docs/location.md'
		};
		await db.drafts.put(durable);

		await moveToTrash(
			'location',
			{
				...draftRow('location'),
				content: 'same',
				projectId: 'project-two',
				relativePath: 'old/location.md'
			},
			0,
			T0
		);

		const variant = (await db.drafts.toArray()).find((row) => row.id !== 'location');
		expect(variant).toMatchObject({ projectId: 'project-one' });
		expect(variant?.relativePath).toMatch(/^docs\/location/);
	});

	it('does not create a variant for identical content with a stale timestamp', async () => {
		await db.drafts.put({ ...draftRow('identical'), updatedAt: 9 });

		await moveToTrash('identical', { ...draftRow('identical'), updatedAt: 1 }, 0, T0);

		expect(await db.drafts.toArray()).toEqual([]);
		expect((await db.trashed.get('identical'))?.file.updatedAt).toBe(1);
	});

	it('keeps the exact binary branch when the trash transaction fails', async () => {
		await db.drafts.put(binaryRow('safe-binary', 'data:image/png;base64,B', 2));
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(db.trashed, 'put').mockRejectedValue(new Error('quota'));

		expect(
			await moveToTrash(
				'safe-binary',
				binaryRow('safe-binary', 'data:image/png;base64,A', 1),
				0,
				T0
			)
		).toBe(false);
		expect(await db.drafts.get('safe-binary')).toMatchObject({
			data: 'data:image/png;base64,B'
		});
		expect(await db.trashed.get('safe-binary')).toBeUndefined();
	});
});

describe('purgePermanently', () => {
	it('also deletes file history without orphan snapshots', async () => {
		await db.trashed.put(trashedRow('p3', T0, 0));
		await recordVersion({ id: 'p3', name: 'p3.md', content: 'du contenu' }, T0);
		expect(await db.versions.where('draftId').equals('p3').count()).toBe(1);

		await purgePermanently('p3');

		expect(await db.trashed.get('p3')).toBeUndefined();
		expect(await db.versions.where('draftId').equals('p3').count()).toBe(0);
	});
});

describe('persistReorder', () => {
	it('writes each draft order from its array index', async () => {
		await db.drafts.bulkPut([draftRow('a', 0), draftRow('b', 1), draftRow('c', 2)]);

		// Set the new order to c, a, b, with order values 0, 1, and 2.
		await persistReorder(['c', 'a', 'b']);

		expect((await db.drafts.get('c'))!.order).toBe(0);
		expect((await db.drafts.get('a'))!.order).toBe(1);
		expect((await db.drafts.get('b'))!.order).toBe(2);
	});

	it('changes only order and keeps content and name', async () => {
		await db.drafts.put(draftRow('a', 5));

		await persistReorder(['a']);

		const row = await db.drafts.get('a');
		expect(row).toMatchObject({
			id: 'a',
			name: 'a.md',
			content: 'contenu a',
			createdAt: T0,
			updatedAt: T0,
			order: 0
		});
	});
});

describe('trash persistence failures and conflicts', () => {
	it('keeps both branches when deletion meets a remote write', async () => {
		await db.drafts.put({ ...draftRow('same'), content: 'remote' });
		expect(await moveToTrash('same', { ...draftRow('same'), content: 'local' }, 0, T0)).toBe(true);
		expect((await db.trashed.get('same'))?.file.content).toBe('local');
		expect(await db.drafts.toArray()).toEqual([
			expect.objectContaining({ content: 'remote', open: false })
		]);
	});
	it('cancels all deletion when the trash transaction fails', async () => {
		await db.drafts.put(draftRow('safe'));
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(db.trashed, 'put').mockRejectedValue(new Error('quota'));
		expect(await moveToTrash('safe', draftRow('safe'), 0, T0)).toBe(false);
		expect(await db.drafts.get('safe')).toBeDefined();
	});
	it('keeps the trash entry when restoration fails', async () => {
		await db.trashed.put(trashedRow('safe', T0));
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(db.drafts, 'put').mockRejectedValue(new Error('quota'));
		expect(await restoreFromTrash('safe', draftRow('safe'))).toBe(false);
		expect(await db.trashed.get('safe')).toBeDefined();
	});
	it('keeps a failed expired purge recoverable during load', async () => {
		await db.trashed.put(trashedRow('safe', T0));
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(db.trashed, 'delete').mockRejectedValue(new Error('storage'));
		const result = await loadTrashRows(T0 + TIMERS.trashRetentionMs + 1);
		expect(result.map((row) => row.entry.file.id)).toEqual(['safe']);
		expect(await db.trashed.get('safe')).toBeDefined();
	});
	it('does not return a false timestamp after reorder failure', async () => {
		await db.drafts.put(draftRow('safe'));
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(db.drafts, 'update').mockRejectedValue(new Error('storage'));
		expect(await persistReorder(['safe'])).toBeNull();
	});
	it('keeps history and a live document that share the purged ID', async () => {
		await db.drafts.put(draftRow('safe'));
		await db.trashed.put(trashedRow('safe', T0));
		await recordVersion({ id: 'safe', name: 'safe.md', content: 'history' }, T0);
		await purgePermanently('safe');
		expect(await db.drafts.get('safe')).toBeDefined();
		expect(await db.versions.where('draftId').equals('safe').count()).toBe(1);
	});
});

describe('trash summary backfill', () => {
	it('does nothing when every summary is current', async () => {
		installTrashSummaryHooks();
		await db.trashed.put(trashedRow('summary-ok', T0));
		const update = vi.spyOn(db.trashed, 'update');
		await backfillTrashSummaries();
		expect(update).not.toHaveBeenCalled();
		update.mockRestore();
	});
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db, type VersionRow } from './db';
import {
	VERSION_LIMITS,
	deleteVersionsFor,
	listVersions,
	pruneVersions,
	recordVersion,
	createCheckpoint,
	createCheckpoints
} from './version-history';

beforeEach(async () => {
	await db.versions.clear();
});
afterEach(async () => {
	await db.versions.clear();
});

const T0 = 1_000_000_000_000;

interface PerfDetail {
	kind: 'counter' | 'duration';
	name: string;
	value?: number;
}

/** Captures the inert save/history metrics emitted by the observed build. */
function collectPerf() {
	const details: PerfDetail[] = [];
	const listener = (event: Event) => {
		details.push((event as CustomEvent<PerfDetail>).detail);
	};
	window.addEventListener('deckmark:editor-perf', listener);
	(window as { __MDSH_EDITOR_PERF__?: boolean }).__MDSH_EDITOR_PERF__ = true;
	return {
		counters: () =>
			details.filter((detail) => detail.kind === 'counter').map((detail) => detail.name),
		stop: () => {
			window.removeEventListener('deckmark:editor-perf', listener);
			delete (window as { __MDSH_EDITOR_PERF__?: boolean }).__MDSH_EDITOR_PERF__;
		}
	};
}

describe('explicit checkpoints', () => {
	it('archives an immediate state during throttling and accepts an empty document', async () => {
		await recordVersion({ id: 'd', name: 'd.md', content: 'initial' }, T0);
		await createCheckpoint({ id: 'd', name: 'd.md', content: 'avant remplacement' }, T0 + 1);
		await createCheckpoint({ id: 'd', name: 'd.md', content: '' }, T0 + 2);
		expect((await listVersions('d')).map((version) => version.content)).toEqual([
			'',
			'avant remplacement',
			'initial'
		]);
	});

	it('cancels all batch checkpoints after a write failure', async () => {
		const realPut = db.versions.put.bind(db.versions);
		const spy = vi.spyOn(db.versions, 'put').mockImplementation((row) => {
			if (row.draftId === 'b') throw new Error('quota');
			return realPut(row);
		});
		try {
			await expect(
				createCheckpoints(
					[
						{ id: 'a', name: 'a.md', content: 'a' },
						{ id: 'b', name: 'b.md', content: 'b' }
					],
					T0
				)
			).rejects.toThrow('quota');
			expect(await db.versions.count()).toBe(0);
		} finally {
			spy.mockRestore();
		}
	});
});

describe('recordVersion', () => {
	it('does not duplicate content from the last snapshot', async () => {
		await recordVersion({ id: 'd1', name: 'a.md', content: 'same' }, T0);
		const ok = await recordVersion(
			{ id: 'd1', name: 'a.md', content: 'same' },
			T0 + VERSION_LIMITS.minIntervalMs + 1
		);
		expect(ok).toBe(false);
		expect(await db.versions.where('draftId').equals('d1').count()).toBe(1);
	});

	it('rejects a snapshot during the throttle interval', async () => {
		await recordVersion({ id: 'd1', name: 'a.md', content: 'v1' }, T0);
		const ok = await recordVersion({ id: 'd1', name: 'a.md', content: 'v2' }, T0 + 1000);
		expect(ok).toBe(false);
		expect(await db.versions.count()).toBe(1);
	});

	it('accepts a snapshot after the minimum interval', async () => {
		await recordVersion({ id: 'd1', name: 'a.md', content: 'v1' }, T0);
		const ok = await recordVersion(
			{ id: 'd1', name: 'a.md', content: 'v2' },
			T0 + VERSION_LIMITS.minIntervalMs + 1
		);
		expect(ok).toBe(true);
		expect(await db.versions.where('draftId').equals('d1').count()).toBe(2);
	});

	it('rejects a throttled snapshot without reading the latest content body', async () => {
		await recordVersion({ id: 'd1', name: 'a.md', content: 'v1' }, T0);
		const perf = collectPerf();
		try {
			const ok = await recordVersion({ id: 'd1', name: 'a.md', content: 'v2' }, T0 + 1000);
			expect(ok).toBe(false);
			expect(perf.counters()).toContain('history.latest-key');
			expect(perf.counters()).not.toContain('history.latest-body');
			expect(await db.versions.where('draftId').equals('d1').count()).toBe(1);
		} finally {
			perf.stop();
		}
	});

	it('reads the latest body when the throttle permits a candidate', async () => {
		await recordVersion({ id: 'd1', name: 'a.md', content: 'v1' }, T0);
		const perf = collectPerf();
		try {
			const ok = await recordVersion(
				{ id: 'd1', name: 'a.md', content: 'v2' },
				T0 + VERSION_LIMITS.minIntervalMs + 1
			);
			expect(ok).toBe(true);
			expect(perf.counters()).toContain('history.latest-key');
			expect(perf.counters()).toContain('history.latest-body');
		} finally {
			perf.stop();
		}
	});
});

describe('pruneVersions', () => {
	it('deletes versions older than maxAge', async () => {
		const now = T0 + VERSION_LIMITS.maxAgeMs + 2000;
		await db.versions.bulkPut([
			// At T0, 'old' is maxAge + 2000 old, so it is expired.
			{ id: 'old', draftId: 'd1', name: 'a', content: 'x', createdAt: T0 },
			// At now - 1000, 'recent' is 1000 ms old, so keep it.
			{ id: 'recent', draftId: 'd1', name: 'a', content: 'y', createdAt: now - 1000 }
		]);
		const deleted = await pruneVersions('d1', now);
		expect(deleted).toBe(1);
		const ids = (await db.versions.where('draftId').equals('d1').toArray()).map((v) => v.id);
		expect(ids).toEqual(['recent']);
	});

	it('keeps only the latest maxPerDraft versions', async () => {
		const rows = Array.from({ length: VERSION_LIMITS.maxPerDraft + 5 }, (_, i) => ({
			id: `v${i}`,
			draftId: 'd1',
			name: 'a',
			content: `c${i}`,
			createdAt: T0 + i * 1000
		}));
		await db.versions.bulkPut(rows);
		await pruneVersions('d1', T0 + rows.length * 1000);
		expect(await db.versions.where('draftId').equals('d1').count()).toBe(
			VERSION_LIMITS.maxPerDraft
		);
		// The oldest version, v0, must be removed. The newest version must remain.
		expect(await db.versions.get('v0')).toBeUndefined();
		expect(await db.versions.get(`v${rows.length - 1}`)).toBeTruthy();
	});

	it('keeps the exact maxAge boundary and removes the older row only', async () => {
		const now = T0 + VERSION_LIMITS.maxAgeMs + 10_000;
		await db.versions.bulkPut([
			{
				id: 'older',
				draftId: 'd1',
				name: 'a',
				content: 'x',
				createdAt: now - VERSION_LIMITS.maxAgeMs - 1
			},
			{
				id: 'boundary',
				draftId: 'd1',
				name: 'a',
				content: 'y',
				createdAt: now - VERSION_LIMITS.maxAgeMs
			},
			{ id: 'future', draftId: 'd1', name: 'a', content: 'z', createdAt: now + 1000 }
		]);
		expect(await pruneVersions('d1', now)).toBe(1);
		expect(await db.versions.get('older')).toBeUndefined();
		expect(await db.versions.get('boundary')).toBeTruthy();
		expect(await db.versions.get('future')).toBeTruthy();
	});

	it('removes equal-timestamp rows in primary-key order', async () => {
		const rows = Array.from({ length: VERSION_LIMITS.maxPerDraft + 1 }, (_, index) => ({
			id: `v${String(index).padStart(2, '0')}`,
			draftId: 'd1',
			name: 'a',
			content: `c${index}`,
			createdAt: T0
		})).reverse();
		await db.versions.bulkPut(rows);
		expect(await pruneVersions('d1', T0)).toBe(1);
		expect(await db.versions.get('v00')).toBeUndefined();
		expect(await db.versions.get('v01')).toBeTruthy();
		expect(await db.versions.get('v30')).toBeTruthy();
	});

	it('uses the current full-row fallback when a row is absent from the compound index', async () => {
		const now = T0 + VERSION_LIMITS.maxAgeMs + 10_000;
		await db.versions.bulkPut([
			{
				id: 'expired',
				draftId: 'd1',
				name: 'a',
				content: 'x',
				createdAt: now - VERSION_LIMITS.maxAgeMs - 1
			},
			{ id: 'recent', draftId: 'd1', name: 'a', content: 'y', createdAt: now - 1000 }
		]);
		await db.versions.put({
			id: 'malformed',
			draftId: 'd1',
			name: 'a',
			content: 'z'
		} as unknown as VersionRow);
		expect(await pruneVersions('d1', now)).toBe(1);
		expect(await db.versions.get('expired')).toBeUndefined();
		expect(await db.versions.get('recent')).toBeTruthy();
		expect(await db.versions.get('malformed')).toBeTruthy();
	});

	it('prunes without deleting when every row is inside the limits', async () => {
		await db.versions.bulkPut([
			{ id: 'a', draftId: 'd1', name: 'n', content: '1', createdAt: T0 },
			{ id: 'b', draftId: 'd1', name: 'n', content: '2', createdAt: T0 + 1000 },
			{ id: 'c', draftId: 'd1', name: 'n', content: '3', createdAt: T0 + 2000 }
		]);
		expect(await pruneVersions('d1', T0 + 3000)).toBe(0);
		expect(await db.versions.where('draftId').equals('d1').count()).toBe(3);
	});
});

describe('listVersions', () => {
	it('isolates versions by draftId', async () => {
		await db.versions.bulkPut([
			{ id: 'a', draftId: 'd1', name: 'n', content: '1', createdAt: T0 },
			{ id: 'b', draftId: 'd2', name: 'n', content: '2', createdAt: T0 }
		]);
		expect((await listVersions('d1')).map((v) => v.id)).toEqual(['a']);
	});
});

describe('deleteVersionsFor', () => {
	it('deletes all history for a file', async () => {
		await db.versions.bulkPut([
			{ id: 'a', draftId: 'd1', name: 'n', content: '1', createdAt: T0 },
			{ id: 'b', draftId: 'd1', name: 'n', content: '2', createdAt: T0 + 1 },
			{ id: 'c', draftId: 'd2', name: 'n', content: '3', createdAt: T0 }
		]);
		await deleteVersionsFor('d1');
		expect(await db.versions.where('draftId').equals('d1').count()).toBe(0);
		expect(await db.versions.where('draftId').equals('d2').count()).toBe(1);
	});
});

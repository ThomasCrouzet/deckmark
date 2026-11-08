import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SaveQueue, SaveQueueFlushError, type SaveQueueCallbacks } from './save-queue';
import { db } from './db';
import type { DraftRow } from './db';

function row(id: string): DraftRow {
	return { id, name: `${id}.md`, content: 'x', createdAt: 0, updatedAt: 0, order: 0 };
}

const noopCb = { onPendingChange: () => {}, onSaved: () => {}, onError: () => {} };

function createQueue(callbacks: SaveQueueCallbacks): SaveQueue {
	return new SaveQueue(callbacks, (row) => db.drafts.put(row));
}

describe('SaveQueue', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('replaces a pending schedule with one write', async () => {
		const put = vi.spyOn(db.drafts, 'put').mockResolvedValue('a' as never);
		const q = createQueue(noopCb);
		q.schedule('a', () => row('a'));
		await vi.advanceTimersByTimeAsync(200);
		q.schedule('a', () => row('a')); // reset du timer
		await vi.advanceTimersByTimeAsync(200); // 400 ms depuis le 1er appel, mais re-armé
		expect(put).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(200); // 400 ms depuis le reset
		expect(put).toHaveBeenCalledOnce();
	});

	it('sends reverse-delete errors to onError', async () => {
		vi.useRealTimers();
		let resolvePut: ((value: string) => void) | undefined;
		const pendingPut = new Promise<string>((resolve) => {
			resolvePut = resolve;
		});
		const put = vi
			.spyOn(db.drafts, 'put')
			.mockReturnValue(pendingPut as ReturnType<typeof db.drafts.put>);
		const del = vi.spyOn(db.drafts, 'delete').mockRejectedValue(new Error('delete failed'));
		const onError = vi.fn();
		try {
			const q = createQueue({ ...noopCb, onError });
			q.schedule('a', () => row('a'));
			q.flush((id) => row(id));
			q.discard('a');
			resolvePut?.('a');
			await vi.waitFor(() => expect(onError).toHaveBeenCalled());
			expect(del).toHaveBeenCalledWith('a');
		} finally {
			resolvePut?.('x');
			put.mockRestore();
			del.mockRestore();
			vi.useFakeTimers();
		}
	});

	it('keeps the pending indicator until a flushed write finishes', async () => {
		let resolvePut: ((value: string) => void) | undefined;
		const pendingPut = new Promise<string>((resolve) => {
			resolvePut = resolve;
		});
		vi.spyOn(db.drafts, 'put').mockReturnValue(pendingPut as ReturnType<typeof db.drafts.put>);
		const states: boolean[] = [];
		const q = createQueue({ ...noopCb, onPendingChange: (pending) => states.push(pending) });
		q.schedule('a', () => row('a'));

		q.flush((id) => row(id));

		expect(states.at(-1)).toBe(true);
		resolvePut?.('a');
		await vi.waitFor(() => expect(states.at(-1)).toBe(false));
	});

	it('keeps has true while put is active', async () => {
		let resolvePut: ((value: string) => void) | undefined;
		const pendingPut = new Promise<string>((resolve) => {
			resolvePut = resolve;
		});
		vi.spyOn(db.drafts, 'put').mockReturnValue(pendingPut as ReturnType<typeof db.drafts.put>);
		const q = createQueue(noopCb);
		q.schedule('a', () => row('a'));
		expect(q.has('a')).toBe(true); // timer armé
		await vi.advanceTimersByTimeAsync(400);
		// Timer cleared, put still in flight - cross-tab guards must still see pending.
		expect(q.has('a')).toBe(true);
		resolvePut?.('a');
		await vi.waitFor(() => expect(q.has('a')).toBe(false));
	});

	it('flushAwait reports a Dexie rejection without an unhandled rejection', async () => {
		const error = new DOMException('plein', 'QuotaExceededError');
		vi.spyOn(db.drafts, 'put').mockRejectedValue(error);
		const onError = vi.fn();
		const unhandled = vi.fn();
		window.addEventListener('unhandledrejection', unhandled);
		try {
			const q = createQueue({ ...noopCb, onError });
			q.schedule('a', () => ({ ...row('a'), content: 'latest' }));
			await expect(q.flushAwait((id) => row(id))).rejects.toMatchObject({
				name: 'SaveQueueFlushError',
				failures: [{ id: 'a', error }]
			} satisfies Partial<SaveQueueFlushError>);
			expect(onError).toHaveBeenCalled();
			await Promise.resolve();
			expect(unhandled).not.toHaveBeenCalled();
		} finally {
			window.removeEventListener('unhandledrejection', unhandled);
		}
	});

	it('recovers when IndexedDB returns while preserving per-document serialization', async () => {
		const put = vi
			.spyOn(db.drafts, 'put')
			.mockRejectedValueOnce(new Error('temporary'))
			.mockResolvedValue('a' as never);
		const onSaved = vi.fn();
		const q = createQueue({ ...noopCb, onSaved });
		const latest = { ...row('a'), content: 'latest', updatedAt: 2 };
		q.schedule('a', () => latest);
		await expect(q.flushAwait(() => latest)).rejects.toBeInstanceOf(SaveQueueFlushError);
		expect(q.has('a')).toBe(true);
		expect(q.hasDurabilityFailure('a')).toBe(true);
		await expect(q.flushAwait(() => latest)).resolves.toBeUndefined();
		expect(put).toHaveBeenCalledTimes(2);
		expect(put.mock.calls.at(-1)?.[0]).toMatchObject({ content: 'latest', updatedAt: 2 });
		expect(onSaved).toHaveBeenCalledOnce();
		expect(q.hasDurabilityFailure('a')).toBe(false);
	});

	it('prevents an active put from restoring a discarded draft', async () => {
		let resolvePut: ((value: string) => void) | undefined;
		const pendingPut = new Promise<string>((resolve) => {
			resolvePut = resolve;
		});
		const put = vi
			.spyOn(db.drafts, 'put')
			.mockReturnValue(pendingPut as ReturnType<typeof db.drafts.put>);
		const del = vi.spyOn(db.drafts, 'delete').mockResolvedValue(undefined as never);
		const onSaved = vi.fn();
		const q = createQueue({ ...noopCb, onSaved });
		q.schedule('a', () => row('a'));
		await vi.advanceTimersByTimeAsync(400);
		expect(put).toHaveBeenCalledOnce();
		// User closes/trash while put is in flight.
		q.discard('a');
		resolvePut?.('a');
		await vi.waitFor(() => expect(del).toHaveBeenCalledWith('a'));
		expect(onSaved).not.toHaveBeenCalled();
	});

	it('skips a write without deleting the row after invalidate', async () => {
		const put = vi.spyOn(db.drafts, 'put').mockResolvedValue('a' as never);
		const del = vi.spyOn(db.drafts, 'delete').mockResolvedValue(undefined as never);
		const onSaved = vi.fn();
		const q = createQueue({ ...noopCb, onSaved });
		q.schedule('a', () => row('a'));
		// Invalidate before the timer fires - no put, no delete (unlike discard).
		q.invalidate('a');
		await vi.advanceTimersByTimeAsync(400);
		expect(put).not.toHaveBeenCalled();
		expect(del).not.toHaveBeenCalled();
		expect(onSaved).not.toHaveBeenCalled();
	});

	it('prevents reverse-delete of a restored row after discard and rearm', async () => {
		// Race: discard mid-put → restore rewrites drafts → put settles and must
		// NOT delete the restored row (Undo trash while put was in flight).
		// Real timers: await chain + deferred put must not hang under fake timers.
		vi.useRealTimers();
		let resolvePut: ((value: string) => void) | undefined;
		const pendingPut = new Promise<string>((resolve) => {
			resolvePut = resolve;
		});
		const put = vi
			.spyOn(db.drafts, 'put')
			.mockReturnValue(pendingPut as ReturnType<typeof db.drafts.put>);
		const del = vi.spyOn(db.drafts, 'delete').mockResolvedValue(undefined as never);
		try {
			const q = createQueue(noopCb);
			// Arm a timer then flush so put starts without waiting for debounce.
			q.schedule('a', () => row('a'));
			q.flush((id) => row(id));
			expect(put).toHaveBeenCalledOnce();
			q.discard('a');
			// Undo-restore path: wait for the discarded put, then rearm.
			const settleP = q.settleAndRearm('a');
			resolvePut?.('a');
			await settleP;
			// Simulate restoreFromTrash writing the draft back after rearm.
			put.mockRestore();
			del.mockRestore();
			await db.drafts.put(row('a'));
			await Promise.resolve();
			await Promise.resolve();
			// Row must survive after rearm (the bug was reverse-delete after restore).
			expect(await db.drafts.get('a')).toBeTruthy();
		} finally {
			resolvePut?.('released');
			try {
				put.mockRestore();
				del.mockRestore();
			} catch {
				// already restored
			}
			vi.useFakeTimers();
		}
	});

	it('ignores a stale snapshot from a superseded put', async () => {
		const order: string[] = [];
		let gate: Promise<void> = Promise.resolve();
		let releaseGate: (() => void) | undefined;
		gate = new Promise<void>((resolve) => {
			releaseGate = resolve;
		});
		const put = vi.spyOn(db.drafts, 'put').mockImplementation(((r: { content: string }) => {
			const row = r;
			// First put waits on the gate so the second can enqueue first.
			const done = (async () => {
				if (row.content === 'old') await gate;
				order.push(row.content);
				return row.content;
			})();
			return done as ReturnType<typeof db.drafts.put>;
		}) as typeof db.drafts.put);
		const q = createQueue(noopCb);
		q.schedule('a', () => ({ ...row('a'), content: 'old' }));
		await vi.advanceTimersByTimeAsync(400);
		q.schedule('a', () => ({ ...row('a'), content: 'new' }));
		await vi.advanceTimersByTimeAsync(400);
		releaseGate?.();
		await vi.waitFor(() => expect(q.has('a')).toBe(false));
		// With generation skip: old may be skipped entirely, or run then new.
		// Final durable content path must include 'new' and not end on 'old' alone.
		expect(
			order.includes('new') ||
				put.mock.calls.some((c) => (c[0] as { content: string }).content === 'new')
		).toBe(true);
		if (order.length > 0) {
			expect(order.at(-1)).not.toBe('old');
		}
	});
});

describe('SaveQueue with IndexedDB and actual conflicts', () => {
	beforeEach(async () => {
		vi.useRealTimers();
		await Promise.all([db.drafts.clear(), db.versions.clear()]);
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.all([db.drafts.clear(), db.versions.clear()]);
	});

	it('keeps concurrent branches and their durable document copies', async () => {
		const initial = { ...row('a'), content: 'initial', updatedAt: 1 };
		await db.drafts.put(initial);
		const preserved = vi.fn();
		const first = new SaveQueue(noopCb);
		const second = new SaveQueue({ ...noopCb, onConflictPreserved: preserved });
		first.trackPersisted(initial);
		second.trackPersisted(initial);
		const remote = { ...initial, content: 'REMOTE A', updatedAt: 2 };
		first.persist(remote);
		await first.flushAwait(() => remote);
		const local = { ...initial, content: 'LOCAL B', updatedAt: 3 };
		second.persist(local);
		await second.flushAwait(() => local);
		expect((await db.drafts.get('a'))?.content).toBe('LOCAL B');
		const variants = await db.drafts.toArray();
		expect(variants.map((draft) => draft.content).sort()).toEqual(['LOCAL B', 'REMOTE A']);
		expect(variants.find((draft) => draft.id !== 'a')?.open).toBe(false);
		expect(preserved).toHaveBeenCalledOnce();
		expect((await db.versions.toArray()).map((version) => version.content)).toContain('REMOTE A');
	});

	it('preserves a branch when only the content length differs', async () => {
		const initial = { ...row('a'), content: 'same', updatedAt: 1 };
		await db.drafts.put(initial);
		const q = new SaveQueue(noopCb);
		q.trackPersisted(initial);
		await db.drafts.put({
			...initial,
			content: 'remote-content-with-a-different-length',
			updatedAt: 1
		});
		const local = { ...initial, content: 'local', updatedAt: 2 };
		q.persist(local);
		await q.flushAwait(() => local);
		expect((await db.drafts.get('a'))?.content).toBe('local');
		expect((await db.drafts.toArray()).map((draft) => draft.content).sort()).toEqual([
			'local',
			'remote-content-with-a-different-length'
		]);
		expect((await db.versions.toArray()).map((version) => version.content)).toContain(
			'remote-content-with-a-different-length'
		);
	});

	it('preserves a branch when equal lengths hide different content', async () => {
		const initial = { ...row('a'), content: 'aaaa', updatedAt: 1 };
		await db.drafts.put(initial);
		const q = new SaveQueue(noopCb);
		q.trackPersisted(initial);
		await db.drafts.put({ ...initial, content: 'bbbb', updatedAt: 1 });
		const local = { ...initial, content: 'cccc', updatedAt: 2 };
		q.persist(local);
		await q.flushAwait(() => local);
		expect((await db.drafts.get('a'))?.content).toBe('cccc');
		expect((await db.drafts.toArray()).map((draft) => draft.content).sort()).toEqual([
			'bbbb',
			'cccc'
		]);
		expect((await db.versions.toArray()).map((version) => version.content)).toContain('bbbb');
	});

	it('rejects overwrite when remote branch preservation fails', async () => {
		const initial = { ...row('a'), content: 'initial', updatedAt: 1 };
		await db.drafts.put(initial);
		const q = new SaveQueue(noopCb);
		q.trackPersisted(initial);
		await db.drafts.put({ ...initial, content: 'remote', updatedAt: 2 });
		const put = vi.spyOn(db.versions, 'put').mockRejectedValue(new Error('quota'));
		const local = { ...initial, content: 'local', updatedAt: 3 };
		q.persist(local);
		await expect(q.flushAwait(() => local)).rejects.toBeInstanceOf(SaveQueueFlushError);
		expect((await db.drafts.get('a'))?.content).toBe('remote');
		expect(await db.drafts.count()).toBe(1);
		expect(q.has('a')).toBe(true);
		put.mockRestore();
		await q.flushAwait(() => local);
		expect((await db.drafts.toArray()).map((draft) => draft.content).sort()).toEqual([
			'local',
			'remote'
		]);
	});
});

describe('barrier during continuous writes', () => {
	it('fails within a limit when each write has a later change', async () => {
		let writing = true;
		const current = row('continuous');
		const queue = new SaveQueue(
			{
				...noopCb,
				onSaved: () => {
					if (writing) queue.schedule(current.id, () => current);
				}
			},
			async () => {}
		);
		queue.persist(current);
		await expect(queue.flushAwait(() => current)).rejects.toBeInstanceOf(SaveQueueFlushError);
		writing = false;
		await queue.flushAwait(() => current);
		expect(queue.has(current.id)).toBe(false);
	});
});

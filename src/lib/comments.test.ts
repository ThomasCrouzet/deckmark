import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	commentReport,
	createAnchor,
	resolveCommentAnchor,
	resolveCommentAnchors,
	shiftCommentAnchors
} from './comments';
import type { CommentRow } from './db';

function comment(quote: string, from: number, to: number): CommentRow {
	const now = Date.now();
	return {
		id: 'c',
		draftId: 'd',
		quote,
		from,
		to,
		body: 'note',
		author: 'me',
		status: 'open',
		createdAt: now,
		updatedAt: now
	};
}

describe('comment anchors', () => {
	it('keeps exact anchors', () => {
		expect(resolveCommentAnchor('Hello world', comment('world', 6, 11))).toEqual({
			state: 'attached',
			from: 6,
			to: 11
		});
	});

	it('moves a unique quote', () => {
		expect(resolveCommentAnchor('Intro. world', comment('world', 6, 11))).toEqual({
			state: 'moved',
			from: 7,
			to: 12
		});
	});

	it('reports ambiguous and detached anchors', () => {
		expect(resolveCommentAnchor('world world', comment('world', 0, 5)).state).toBe('attached');
		expect(resolveCommentAnchor('a world b world', comment('world', 0, 5)).state).toBe('ambiguous');
		expect(resolveCommentAnchor('nothing', comment('world', 0, 5)).state).toBe('detached');
	});

	it('shifts anchors by one edit without rescanning unchanged quotes', () => {
		const before = 'Intro. world and tail';
		const after = 'New intro. world and tail';
		const first = { c: resolveCommentAnchor(before, comment('world', 7, 12)) };
		expect(shiftCommentAnchors(before, after, [comment('world', 7, 12)], first)).toEqual({
			c: { state: 'moved', from: 11, to: 16 }
		});
	});

	it('creates anchors only for a unique passage', () => {
		expect(createAnchor('one two', 'two')).toEqual({ from: 4, to: 7, quote: 'two' });
		expect(createAnchor('two two', 'two')).toBeNull();
	});

	it('matches the full-scan oracle on repeated, Unicode and multiline quotes', () => {
		const content =
			'# Guide\n\nRépétée phrase. Deuxième phrase.\n\nRépétée phrase.\n\nLigne A\nLigne B\n\n😀 emoji tail';
		const rows: CommentRow[] = [
			{ ...comment('Répétée phrase.', 8, 24), id: 'repeat' },
			{ ...comment('Ligne A\nLigne B', 58, 73), id: 'multiline' },
			{ ...comment('😀 emoji tail', 75, 88), id: 'emoji' },
			{ ...comment('missing', 0, 7), id: 'missing' },
			{ ...comment('', 0, 0), id: 'empty' }
		];
		const batch = resolveCommentAnchors(content, rows);
		for (const row of rows) expect(batch[row.id]).toEqual(resolveCommentAnchor(content, row));
	});

	it('batches the fallback lookup instead of one whole-note search per comment', () => {
		const content = 'alpha beta gamma '.repeat(20_000);
		const rows: CommentRow[] = [];
		for (let index = 0; index < 2_000; index += 1) {
			const quote = `unique quote ${index}`;
			rows.push({ ...comment(quote, index, index + quote.length), id: `c${index}` });
		}
		const spy = vi.spyOn(String.prototype, 'indexOf');
		try {
			const result = resolveCommentAnchors(content, rows);
			expect(spy.mock.calls.length).toBe(0);
			expect(Object.keys(result)).toHaveLength(rows.length);
			for (const row of rows) expect(result[row.id]?.state).toBe('detached');
		} finally {
			spy.mockRestore();
		}
	});

	it('shifts many anchors without a whole-note search per comment', () => {
		const before = 'Intro. '.padEnd(2_000, 'x') + 'tail';
		const after = 'New intro. '.padEnd(2_010, 'x') + 'tail';
		const rows: CommentRow[] = [];
		for (let index = 0; index < 500; index += 1) {
			const quote = `quote ${index}`;
			rows.push({ ...comment(quote, 100 + index, 100 + index + quote.length), id: `c${index}` });
		}
		const previous = Object.fromEntries(
			rows.map((row) => [row.id, resolveCommentAnchor(before, row)])
		);
		const spy = vi.spyOn(String.prototype, 'indexOf');
		try {
			const shifted = shiftCommentAnchors(before, after, rows, previous);
			expect(spy.mock.calls.length).toBe(0);
			expect(Object.keys(shifted)).toHaveLength(rows.length);
		} finally {
			spy.mockRestore();
		}
	});

	it('agrees with the oracle after deterministic random edits and collisions', () => {
		let seed = 0x2f6e2b1;
		const random = () => {
			seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
			return seed / 0x1_0000_0000;
		};
		const alphabet = ['a', 'b', ' ', '\n', 'é', '😀', '#', '`'];
		let content = '';
		for (let index = 0; index < 400; index += 1)
			content += alphabet[Math.floor(random() * alphabet.length)];
		const rows: CommentRow[] = [];
		for (let index = 0; index < 120; index += 1) {
			const from = Math.floor(random() * Math.max(1, content.length - 12));
			const length = 1 + Math.floor(random() * 12);
			const quote = random() < 0.25 ? content.slice(from, from + length) : `q${index}`;
			rows.push({ ...comment(quote, from, from + quote.length), id: `c${index}` });
		}
		for (let step = 0; step < 25; step += 1) {
			const at = Math.floor(random() * content.length);
			const length = Math.floor(random() * 6);
			const insert = random() < 0.6;
			const next = insert
				? content.slice(0, at) + 'ab\n😀' + content.slice(at)
				: content.slice(0, at) + content.slice(at + length);
			const batch = resolveCommentAnchors(next, rows);
			for (const row of rows) expect(batch[row.id]).toEqual(resolveCommentAnchor(next, row));
			const previous = resolveCommentAnchors(content, rows);
			const shifted = shiftCommentAnchors(content, next, rows, previous);
			for (const row of rows) expect(shifted[row.id]).toEqual(resolveCommentAnchor(next, row));
			content = next;
		}
	});

	it('uses the batch anchor state in the exported report', () => {
		const content = 'one two two';
		const rows = [
			{ ...comment('one', 0, 3), id: 'one' },
			{ ...comment('two', 0, 3), id: 'two' }
		];
		const report = JSON.parse(commentReport(rows, content)) as {
			comments: Array<{ id: string; anchor: { state: string; from: number; to: number } }>;
		};
		expect(report.comments[0]?.anchor).toEqual({ state: 'attached', from: 0, to: 3 });
		expect(report.comments[1]?.anchor).toEqual({ state: 'ambiguous', from: 0, to: 3 });
	});

	afterEach(() => vi.restoreAllMocks());
});

import { describe, expect, it } from 'vitest';
import { createAnchor, resolveCommentAnchor, shiftCommentAnchors } from './comments';
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
});

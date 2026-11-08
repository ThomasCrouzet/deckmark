import { beforeEach, describe, expect, it } from 'vitest';
import { Text } from '@codemirror/state';
import { EditorStateCache } from './editor-state';
import { EditorHistoryCache } from './editor-history-cache';

function snapshot(content: string, estimatedBytes: number) {
	return { content, doc: Text.of(content.split('\n')), history: {}, estimatedBytes };
}

describe('EditorStateCache navigation', () => {
	beforeEach(() => sessionStorage.clear());

	it('restores positions from sessionStorage without persisting source history', () => {
		const first = new EditorStateCache();
		first.setPosition('draft-a', 'source', { anchor: 1, head: 1, scrollTop: 12 });

		const restored = new EditorStateCache();
		expect(restored.getPosition('draft-a', 'source')?.scrollTop).toBe(12);
	});

	it('evicts the least recently used draft', () => {
		const cache = new EditorStateCache(2);
		cache.setPosition('draft-a', 'source', { anchor: 0, head: 0, scrollTop: 1 });
		cache.setPosition('draft-b', 'source', { anchor: 0, head: 0, scrollTop: 2 });
		cache.getPosition('draft-a', 'source');
		cache.setPosition('draft-c', 'source', { anchor: 0, head: 0, scrollTop: 3 });

		expect(cache.getPosition('draft-a', 'source')).toBeDefined();
		expect(cache.getPosition('draft-b', 'source')).toBeUndefined();
		expect(cache.getPosition('draft-c', 'source')).toBeDefined();
	});

	it('bounds navigation keys independently of history pressure', () => {
		const cache = new EditorStateCache(3);
		const position = { anchor: 0, head: 0, scrollTop: 0 };
		cache.setPosition('a', 'source', position);
		cache.setPosition('b', 'source', position);
		cache.setPosition('c', 'source', position);
		cache.setPosition('x'.repeat(1025), 'source', position);
		expect(cache.size).toBe(3);
		expect(cache.getPosition('x'.repeat(1025), 'source')).toBeUndefined();
	});

	it('normalizes positions and returns defensive copies', () => {
		const cache = new EditorStateCache();
		cache.setPosition('draft-a', 'wysiwyg', {
			anchor: -3.7,
			head: Number.NaN,
			scrollTop: Number.POSITIVE_INFINITY
		});

		const position = cache.getPosition('draft-a', 'wysiwyg');
		expect(position).toEqual({ anchor: 0, head: 0, scrollTop: 0 });
		if (position) position.anchor = 12;
		expect(cache.getPosition('draft-a', 'wysiwyg')?.anchor).toBe(0);
	});

	it('ignores malformed persisted entries', () => {
		sessionStorage.setItem('mdsh:editor-view-state', '{bad json');
		expect(new EditorStateCache().size).toBe(0);

		sessionStorage.setItem(
			'mdsh:editor-view-state',
			JSON.stringify([
				null,
				{},
				{ fileId: '', positions: {} },
				{ fileId: 'bad-positions', positions: 'text' },
				{
					fileId: 'mixed',
					positions: {
						source: { anchor: 4, head: 4, scrollTop: 10 },
						read: { anchor: 'bad', head: 0, scrollTop: 20 }
					}
				}
			])
		);
		const cache = new EditorStateCache();
		expect(cache.size).toBe(1);
		expect(cache.getPosition('mixed', 'source')).toEqual({
			anchor: 4,
			head: 4,
			scrollTop: 10
		});
		expect(cache.getPosition('mixed', 'read')).toBeUndefined();
	});
});

describe('EditorHistoryCache', () => {
	it('evicts history by bytes without deleting navigation and releases replaced charges', () => {
		const history = new EditorHistoryCache(3, 1000);
		const navigation = new EditorStateCache(3);
		const position = { anchor: 4, head: 1, scrollTop: 120 };
		history.set('a', snapshot('alpha', 600));
		navigation.setPosition('a', 'source', position);
		history.set('b', snapshot('beta', 300));
		navigation.setPosition('b', 'source', position);
		history.get('a');
		history.set('c', snapshot('charlie', 300));
		navigation.setPosition('c', 'source', position);
		expect(history.get('b')).toBeUndefined();
		expect(navigation.getPosition('b', 'source')).toEqual(position);
		expect(history.sourceBytes).toBe(900);
		history.set('a', snapshot('updated', 200));
		expect(history.sourceBytes).toBe(500);
		history.delete('c');
		expect(history.sourceBytes).toBe(200);
		history.clear();
		expect(history.sourceBytes).toBe(0);
		expect(history.sourceSize).toBe(0);
	});

	it('bounds history count separately from positions and rejects oversized or invalid charges', () => {
		const cache = new EditorHistoryCache(2, 1000);
		for (const id of ['a', 'b', 'c']) cache.set(id, snapshot(id, 100));
		expect(cache.sourceSize).toBe(2);
		expect(cache.get('a')).toBeUndefined();
		for (const bytes of [1001, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
			cache.set('c', snapshot('new', bytes));
			expect(cache.get('c')).toBeUndefined();
			expect(cache.sourceBytes).toBe(100);
		}
	});

	it('keeps history pressure independent of navigation reads', () => {
		const history = new EditorHistoryCache(2, 1000);
		const navigation = new EditorStateCache(3);
		const position = { anchor: 0, head: 0, scrollTop: 0 };
		history.set('a', snapshot('a', 400));
		navigation.setPosition('a', 'source', position);
		history.set('b', snapshot('b', 400));
		navigation.setPosition('b', 'source', position);
		navigation.getPosition('a', 'source');
		history.set('c', snapshot('c', 400));
		navigation.setPosition('c', 'source', position);
		expect(history.get('a')).toBeUndefined();
		expect(navigation.getPosition('a', 'source')).toEqual(position);
	});
});

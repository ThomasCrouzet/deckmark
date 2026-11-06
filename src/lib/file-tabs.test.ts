import { describe, expect, it } from 'vitest';
import {
	ACTIVE_HISTORY_LIMIT,
	cycleOpenTab,
	nextActiveAfterDetach,
	nextActiveAfterRemoval,
	previousOpenTab,
	rememberActiveTab,
	reorderedOpenIds
} from './file-tabs';

describe('rememberActiveTab', () => {
	it('moves the previous tab to the end without duplicates', () => {
		expect(rememberActiveTab(['a', 'b', 'c'], 'b')).toEqual(['a', 'c', 'b']);
	});

	it('keeps only the most recent tabs', () => {
		const history = Array.from({ length: ACTIVE_HISTORY_LIMIT + 3 }, (_, index) => `tab-${index}`);
		const next = rememberActiveTab(history, 'last');
		expect(next).toHaveLength(ACTIVE_HISTORY_LIMIT);
		expect(next.at(-1)).toBe('last');
		expect(next).not.toContain('tab-0');
	});

	it('returns a copy when no tab is active', () => {
		const history = ['a', 'b'];
		const next = rememberActiveTab(history, null);
		expect(next).toEqual(history);
		expect(next).not.toBe(history);
	});

	it('does not mutate the input history', () => {
		const history = ['a', 'b'];
		rememberActiveTab(history, 'a');
		expect(history).toEqual(['a', 'b']);
	});
});

describe('previousOpenTab', () => {
	it('returns the most recent tab that is still open', () => {
		expect(previousOpenTab(['a', 'b', 'c'], 'c', (id) => id !== 'b')).toBe('a');
	});

	it('skips the closing tab and closed tabs', () => {
		expect(previousOpenTab(['a', 'closed', 'b'], 'b', (id) => id === 'a' || id === 'b')).toBe('a');
	});

	it('returns null when no recorded tab remains open', () => {
		expect(previousOpenTab(['a', 'b'], 'c', () => false)).toBeNull();
	});
});

describe('nextActiveAfterDetach', () => {
	it('uses the previous tab history before the positional neighbour', () => {
		expect(
			nextActiveAfterDetach(['first', 'second'], ['first'], 'third', { id: 'third', index: 2 })
		).toBe('first');
	});

	it('falls back to the tab at the removed position', () => {
		expect(nextActiveAfterDetach(['first', 'second'], [], 'third', { id: 'third', index: 2 })).toBe(
			'second'
		);
	});

	it('returns null after the last open tab closes', () => {
		expect(nextActiveAfterDetach([], [], 'only', { id: 'only', index: 0 })).toBeNull();
	});

	it('keeps the active tab when another tab closes', () => {
		expect(
			nextActiveAfterDetach(['first', 'second'], ['first'], 'first', { id: 'third', index: 2 })
		).toBe('first');
	});
});

describe('nextActiveAfterRemoval', () => {
	it('selects the next open tab after the active one', () => {
		expect(nextActiveAfterRemoval(['first', 'active', 'next'], 'active', new Set(['active']))).toBe(
			'next'
		);
	});

	it('selects the previous open tab when the active tab is last', () => {
		expect(
			nextActiveAfterRemoval(['first', 'previous', 'active'], 'active', new Set(['active']))
		).toBe('previous');
	});

	it('skips every removed neighbour', () => {
		expect(
			nextActiveAfterRemoval(
				['active', 'removed', 'kept'],
				'active',
				new Set(['active', 'removed'])
			)
		).toBe('kept');
	});

	it('keeps the active tab when it is not removed', () => {
		expect(nextActiveAfterRemoval(['first', 'active'], 'active', new Set(['first']))).toBe(
			'active'
		);
	});

	it('returns null when every open tab is removed', () => {
		expect(
			nextActiveAfterRemoval(['first', 'active'], 'active', new Set(['first', 'active']))
		).toBeNull();
	});
});

describe('reorderedOpenIds', () => {
	it('applies the requested prefix and keeps unmatched tabs in order', () => {
		expect(reorderedOpenIds(['a', 'b', 'c'], ['c', 'a'])).toEqual(['c', 'a', 'b']);
	});

	it('ignores unknown and duplicate ids', () => {
		expect(reorderedOpenIds(['a', 'b'], ['missing', 'b', 'b', 'a'])).toEqual(['b', 'a']);
	});

	it('returns null when the order does not change', () => {
		expect(reorderedOpenIds(['a', 'b'], ['a', 'b'])).toBeNull();
	});

	it('returns null for an empty request or a single tab', () => {
		expect(reorderedOpenIds(['a', 'b'], [])).toBeNull();
		expect(reorderedOpenIds(['a'], ['a'])).toBeNull();
	});
});

describe('cycleOpenTab', () => {
	it('wraps forward and backward', () => {
		expect(cycleOpenTab(['a', 'b', 'c'], 'c', 1)).toBe('a');
		expect(cycleOpenTab(['a', 'b', 'c'], 'a', -1)).toBe('c');
	});

	it('returns the adjacent tab', () => {
		expect(cycleOpenTab(['a', 'b', 'c'], 'b', 1)).toBe('c');
	});

	it('returns null for fewer than two tabs or an unknown active tab', () => {
		expect(cycleOpenTab(['a'], 'a', 1)).toBeNull();
		expect(cycleOpenTab(['a', 'b'], 'missing', 1)).toBeNull();
	});
});

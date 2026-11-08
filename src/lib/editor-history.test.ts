import { describe, expect, it } from 'vitest';
import { EditorState, StateEffect } from '@codemirror/state';
import { history, invertedEffects } from '@codemirror/commands';
import { advanceHistoryBytes, initialHistoryBytes } from './editor-history';
import { EDITOR_STATE_CACHE_BYTES } from './editor-history-constants';

describe('inactive native history accounting', () => {
	it('keeps accumulated charges through recache, including removed text and selection events', () => {
		const state = EditorState.create({ doc: 'old\ntext\n', extensions: history() });
		const initial = initialHistoryBytes(11, state);
		const removal = state.update({ changes: { from: 0, to: 8, insert: 'x' } });
		const removed = advanceHistoryBytes(initial, [removal]);
		expect(removed).toBeGreaterThan(initial + 2 * 8);
		const selection = removal.state.update({ selection: { anchor: 1, head: 0 } });
		const recached = advanceHistoryBytes(removed, [selection]);
		expect(recached).toBeGreaterThan(removed);
		const next = selection.state.update({ changes: { from: 0, insert: 'y' } });
		expect(advanceHistoryBytes(recached, [next])).toBeGreaterThan(recached);
	});

	it('refuses unknown retained effect payloads and saturates without walking history', () => {
		const effect = StateEffect.define<unknown>();
		const state = EditorState.create({
			doc: 'text',
			extensions: [history(), invertedEffects.of(() => [effect.of({ large: 'payload' })])]
		});
		expect(initialHistoryBytes(4, state)).toBeGreaterThan(EDITOR_STATE_CACHE_BYTES);
		const change = state.update({ changes: { from: 0, insert: 'x' } });
		expect(advanceHistoryBytes(100, [change])).toBeGreaterThan(EDITOR_STATE_CACHE_BYTES);
		expect(advanceHistoryBytes(EDITOR_STATE_CACHE_BYTES + 1, [change])).toBe(
			EDITOR_STATE_CACHE_BYTES + 1
		);
	});
});

import { EditorState } from '@codemirror/state';
import { describe, expect, it, vi } from 'vitest';
import { SourceText } from './source-text.js';
import { applySourceChanges } from './text-changes.js';

function start(source: string) {
	const state = EditorState.create({ doc: source });
	return { state, text: SourceText.create(source, state.doc) };
}

describe('incremental source bytes', () => {
	it('keeps mixed separators, BOM, literal markers and immutable pending snapshots', () => {
		const source =
			'\ufeff# Note\r\n\r```html\n<!-- mdsh-presentation -->\r\n```\n\\<!-- escaped -->\rEnd';
		const initial = start(source);
		const first = initial.state.update({ changes: { from: 3, insert: 'new ' } });
		const pending = initial.text.apply(first.changes, first.newDoc);
		const second = first.state.update({ changes: { from: first.newDoc.length, insert: '!' } });
		const latest = pending.apply(second.changes, second.newDoc);
		expect(latest.getText()).toBe(source.slice(0, 3) + 'new ' + source.slice(3) + '!');
		expect(pending.getText()).toBe(source.slice(0, 3) + 'new ' + source.slice(3));
		expect(initial.text.getText()).toBe(source);
		expect([initial.text.revision, pending.revision, latest.revision]).toEqual([0, 1, 2]);
	});

	it('keeps exact separators around multi-range edits and chooses the next local separator', () => {
		const source = '\ufeffa\r\nb\rc\nd\r\ne';
		const initial = start(source);
		const transaction = initial.state.update({
			changes: [
				{ from: 1, to: 2, insert: 'A\nB' },
				{ from: 4, to: 6, insert: 'C\nD' },
				{ from: initial.state.doc.length, insert: '\nlast' }
			]
		});
		expect(initial.text.apply(transaction.changes, transaction.newDoc).getText()).toBe(
			applySourceChanges(source, initial.state, transaction.changes)
		);
	});

	it('matches the raw conversion oracle over seeded insertions, deletions and replacements', () => {
		let raw = '\ufeffa\r\nb\rc\nd\r\n\r\ntail';
		let { state, text } = start(raw);
		let seed = 306;
		const random = (limit: number) => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			return seed % limit;
		};
		for (let index = 0; index < 300; index += 1) {
			const from = random(state.doc.length + 1);
			const to = from + random(state.doc.length - from + 1);
			const insert = ['x', '\n', 'a\nb\nc', '', '😀'][random(5)]!;
			const transaction = state.update({ changes: { from, to, insert } });
			raw = applySourceChanges(raw, state, transaction.changes);
			text = text.apply(transaction.changes, transaction.newDoc);
			state = transaction.state;
			expect(text.getText(), `change ${index}`).toBe(raw);
		}
	});

	for (const size of [1_000_000, 5_000_000]) {
		for (const ending of ['\n', '\r\n']) {
			it(`edits all positions without reading a raw snapshot in ${size} bytes with ${JSON.stringify(ending)}`, () => {
				const line = `ordinary line${ending}`;
				const raw = line.repeat(Math.ceil(size / line.length));
				let { state, text } = start(raw);
				for (const fraction of [0, 0.5, 1]) {
					const from = Math.floor(state.doc.length * fraction);
					const previous = text;
					const materialize = vi.spyOn(previous, 'getText').mockImplementation(() => {
						throw new Error('Applying an edit must not materialize raw text');
					});
					const transaction = state.update({ changes: { from, insert: 'x' } });
					text = previous.apply(transaction.changes, transaction.newDoc);
					materialize.mockRestore();
					expect(text.getText()).toBe(
						applySourceChanges(previous.getText(), state, transaction.changes)
					);
					state = transaction.state;
				}
			});
		}
	}
});

import { describe, expect, it, vi } from 'vitest';
import { EditorState, type StateField } from '@codemirror/state';
import { imageData } from './source-extensions';

interface FieldValue {
	spans: Array<{ from: number; to: number }>;
}

const RANGE = /(data:image\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*,|blob:)([^\s)"'<>]{32,})/gi;

function ranges(text: string): Array<{ from: number; to: number }> {
	const found: Array<{ from: number; to: number }> = [];
	for (const match of text.matchAll(RANGE)) {
		const from = match.index + match[1]!.length;
		found.push({ from, to: from + match[2]!.length });
	}
	return found;
}

const imageField = imageData() as unknown as StateField<FieldValue>;

function fieldOf(state: EditorState): FieldValue {
	return state.field(imageField);
}

function spansOf(state: EditorState): Array<{ from: number; to: number }> {
	return fieldOf(state)
		.spans.map(({ from, to }) => ({ from, to }))
		.sort((a, b) => a.from - b.from);
}

const URI = `data:image/png;base64,${'A'.repeat(64)}`;

describe('image data decorations', () => {
	it('keeps spans when text is typed elsewhere without scanning the full document', () => {
		let state = EditorState.create({
			doc: `before ${URI} after`,
			extensions: [imageField]
		});
		const toString = vi.spyOn(Object.getPrototypeOf(state.doc), 'toString');
		for (let index = 0; index < 20; index++) {
			state = state.update({ changes: { from: 0, insert: 'x' } }).state;
		}
		expect(toString).not.toHaveBeenCalled();
		toString.mockRestore();
		expect(spansOf(state)).toEqual(ranges(state.doc.toString()));
		expect(spansOf(state)).toHaveLength(1);
	});

	it('updates a span after an edit inside its payload', () => {
		let state = EditorState.create({
			doc: `![alt](${URI})`,
			extensions: [imageField]
		});
		const before = spansOf(state)[0]!;
		state = state.update({
			changes: { from: before.from + 4, insert: 'BBBB' }
		}).state;
		expect(spansOf(state)).toEqual(ranges(state.doc.toString()));
		expect(spansOf(state)[0]!.to).toBe(before.to + 4);
	});

	it('rescans a line that joins two data URIs', () => {
		let state = EditorState.create({
			doc: `${URI}\n${URI}`,
			extensions: [imageField]
		});
		expect(spansOf(state)).toHaveLength(2);
		state = state.update({ changes: { from: URI.length, to: URI.length + 1 } }).state;
		expect(state.doc.toString()).toBe(`${URI}${URI}`);
		expect(spansOf(state)).toEqual(ranges(state.doc.toString()));
	});

	it('restores spans after undo', () => {
		const base = `text ${URI}`;
		const initial = EditorState.create({ doc: base, extensions: [imageField] });
		const change = initial.update({ changes: { from: 0, to: 1, insert: '' } });
		let state = change.state;
		expect(spansOf(state)).toEqual(ranges(state.doc.toString()));
		state = state.update({ changes: change.changes.invert(initial.doc) }).state;
		expect(state.doc.toString()).toBe(base);
		expect(spansOf(state)).toEqual(ranges(base));
	});
});

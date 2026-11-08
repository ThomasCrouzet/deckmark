import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { externalDocumentChange } from './external-changes';

type ObjectChange = { from: number; to?: number; insert?: string };

function change(source: string, incoming: string) {
	const state = EditorState.create({ doc: source });
	const spec = externalDocumentChange(state, incoming) as ObjectChange | null;
	const updated = spec ? state.update({ changes: spec }).state.doc.toString() : source;
	return {
		spec,
		updated,
		from: spec?.from ?? 0,
		to: spec?.to ?? 0,
		insert: spec?.insert ?? ''
	};
}

describe('external document changes', () => {
	it('returns null when the native text is already equal', () => {
		expect(change('same\r\ntext', 'same\r\ntext').spec).toBeNull();
	});

	it('uses a bounded change for a tiny edit in the middle', () => {
		const source = 'alpha\nbeta\ngamma\n';
		const incoming = source.replace('beta', 'BETA');
		const result = change(source, incoming);
		expect(result.updated).toBe(incoming);
		expect(result.from).toBe(source.indexOf('beta'));
		expect(result.to).toBe(source.indexOf('beta') + 4);
		expect(result.insert).toBe('BETA');
	});

	it('keeps a bounded change at a high ratio in a small document', () => {
		const source = `A${'x'.repeat(50)}Z`;
		const incoming = `A${'y'.repeat(50)}Z`;
		const result = change(source, incoming);
		expect(result.updated).toBe(incoming);
		expect(result.from).toBe(1);
		expect(result.to).toBe(51);
	});

	it('applies pure insertions and deletions', () => {
		const inserted = change('abcdef', 'abcXYZdef');
		expect(inserted.updated).toBe('abcXYZdef');
		expect(inserted.from).toBe(3);
		expect(inserted.to).toBe(3);
		expect(inserted.insert).toBe('XYZ');

		const deleted = change('abcXYZdef', 'abcdef');
		expect(deleted.updated).toBe('abcdef');
		expect(deleted.from).toBe(3);
		expect(deleted.to).toBe(6);
		expect(deleted.insert).toBe('');
	});

	it('returns null when only the raw line ending differs', () => {
		expect(change('same\ntext', 'same\r\ntext').spec).toBeNull();
		expect(change('same\ntext', 'same\rtext').spec).toBeNull();
	});

	it('normalizes CRLF into native LF text without splitting the line', () => {
		const result = change('a\r\nb', 'a\rXb');
		expect(result.updated).toBe('a\nXb');
		expect(result.from).toBe(2);
		expect(result.to).toBe(2);
		expect(result.insert).toBe('X');
	});

	it('does not split a surrogate pair at either change boundary', () => {
		const result = change('a😀b', 'a😃b');
		expect(result.updated).toBe('a😃b');
		expect(result.from).toBe(1);
		expect(result.to).toBe(3);
		expect(result.insert).toBe('😃');
	});

	it('falls back to a whole replacement for a large changed region', () => {
		const body = 'x'.repeat(1_200_000);
		const incomingBody = 'y'.repeat(1_200_000);
		const source = `A${body}Z`;
		const incoming = `A${incomingBody}Z`;
		const result = change(source, incoming);
		expect(result.updated).toBe(incoming);
		expect(result.from).toBe(0);
		expect(result.to).toBe(source.length);
		expect(result.insert).toBe(incoming);
	});
});

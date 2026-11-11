import { describe, expect, it } from 'vitest';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { createIncrementalMarkdown, updateIncrementalMarkdown } from './markdown-incremental';

interface FakeBlock {
	type: { name: string };
	text: string;
}

interface FakeDoc {
	children: FakeBlock[];
}

function paragraph(text: string): FakeBlock {
	return { type: { name: 'paragraph' }, text };
}

function heading(text: string): FakeBlock {
	return { type: { name: 'heading' }, text };
}

function imageBlock(text: string): FakeBlock {
	return { type: { name: 'image-block' }, text };
}

function docOf(...children: FakeBlock[]): ProseNode {
	const doc: FakeDoc = { children };
	return Object.assign(doc, {
		attrs: {},
		type: { create: (_attrs: unknown, blocks: FakeBlock[]) => docOf(...blocks) },
		childCount: children.length,
		child(index: number) {
			return children[index] as unknown as ProseNode;
		}
	}) as unknown as ProseNode;
}

function serialize(node: ProseNode): string {
	const value = node as unknown as FakeBlock | FakeDoc;
	if (!('children' in value)) return value.text;
	// The real serializer omits a trailing empty paragraph, for example one
	// that the editor keeps after a table.
	const children = [...value.children];
	while (children.length > 0 && children[children.length - 1]!.text === '') children.pop();
	return children.map((entry) => entry.text).join('\n\n') + '\n';
}

describe('incremental Markdown serialization', () => {
	it('reconstructs the full serializer output exactly', () => {
		const doc = docOf(paragraph('# First'), paragraph('Body'));
		const state = createIncrementalMarkdown(doc, serialize);
		expect(state.markdown).toBe(serialize(doc));
	});

	it('re-serializes only the changed top-level block', () => {
		const first = paragraph('First');
		const second = paragraph('Second');
		const state = createIncrementalMarkdown(docOf(first, second), serialize);
		const changed = paragraph('Changed');
		const next = docOf(first, changed);
		let calls = 0;
		const counting = (node: ProseNode) => {
			calls += 1;
			return serialize(node);
		};
		const result = updateIncrementalMarkdown(state, next, counting);
		expect(result.full).toBe(false);
		expect(result.changed).toEqual({ start: 1, end: 2, previousEnd: 2 });
		expect(result.scope).toEqual({
			previousFrom: 'First\n\n'.length,
			previousTo: 'First\n\n'.length + 'Second'.length,
			nextFrom: 'First\n\n'.length,
			nextTo: 'First\n\n'.length + 'Changed'.length
		});
		expect(calls).toBe(1);
		expect(result.state.markdown).toBe(serialize(next));
	});

	it('keeps plain-block insertions and removals local', () => {
		const first = paragraph('First');
		const second = paragraph('Second');
		const third = paragraph('Third');
		const state = createIncrementalMarkdown(docOf(first, second), serialize);
		const appended = updateIncrementalMarkdown(state, docOf(first, second, third), serialize);
		expect(appended.full).toBe(false);
		expect(appended.state.markdown).toBe(serialize(docOf(first, second, third)));
		const prepended = updateIncrementalMarkdown(
			appended.state,
			docOf(paragraph('Zero'), first, second, third),
			serialize
		);
		expect(prepended.full).toBe(false);
		expect(prepended.state.markdown).toBe(
			serialize(docOf(paragraph('Zero'), first, second, third))
		);
		const deleted = updateIncrementalMarkdown(
			prepended.state,
			docOf(paragraph('Zero'), first, third),
			serialize
		);
		expect(deleted.full).toBe(false);
		expect(deleted.state.markdown).toBe(serialize(docOf(paragraph('Zero'), first, third)));
	});

	it('keeps the first characters of a represented empty paragraph local', () => {
		const first = paragraph('First');
		const empty = paragraph('');
		const last = paragraph('Last');
		const state = createIncrementalMarkdown(docOf(first, empty, last), serialize);
		expect(state.markdown).toBe('First\n\n\n\nLast\n');
		const typed = updateIncrementalMarkdown(state, docOf(first, paragraph('N'), last), serialize);
		expect(typed.full).toBe(false);
		expect(typed.state.markdown).toBe('First\n\nN\n\nLast\n');
		const emptied = updateIncrementalMarkdown(typed.state, docOf(first, empty, last), serialize);
		expect(emptied.full).toBe(false);
		expect(emptied.state.markdown).toBe('First\n\n\n\nLast\n');
	});

	it('materializes a trailing empty paragraph without the full serializer', () => {
		const first = paragraph('First');
		const state = createIncrementalMarkdown(docOf(first, paragraph('')), serialize);
		expect(state.markdown).toBe('First\n');
		expect(state.silent).toEqual([false, true]);
		const typed = updateIncrementalMarkdown(state, docOf(first, paragraph('N')), serialize);
		expect(typed.full).toBe(false);
		expect(typed.state.markdown).toBe('First\n\nN\n');
		expect(typed.scope).toEqual({
			previousFrom: 'First'.length,
			previousTo: 'First'.length,
			nextFrom: 'First'.length,
			nextTo: 'First\n\nN'.length,
			insert: true
		});
	});

	it('keeps a split beside an unchanged image block local', () => {
		const first = paragraph('First');
		const image = imageBlock('![Figure](data:image/png;base64,AAAA)');
		const last = paragraph('Last');
		const state = createIncrementalMarkdown(docOf(first, image, last), serialize);
		// Insert a paragraph between the first paragraph and the image.
		const added = paragraph('New');
		const next = docOf(first, added, image, last);
		let calls = 0;
		const counting = (node: ProseNode) => {
			calls += 1;
			return serialize(node);
		};
		const result = updateIncrementalMarkdown(state, next, counting);
		expect(result.full).toBe(false);
		expect(result.state.markdown).toBe(serialize(next));
		// Only the inserted paragraph is serialized. The unchanged image block
		// is reused from the cache.
		expect(calls).toBe(1);
		expect(result.scope).toEqual({
			previousFrom: 'First'.length,
			previousTo: 'First'.length,
			nextFrom: 'First'.length,
			nextTo: 'First\n\nNew'.length,
			insert: true
		});
	});

	it('inserts a paragraph before a silent trailing paragraph', () => {
		const first = paragraph('First');
		const image = imageBlock('![Figure](data:image/png;base64,AAAA)');
		const empty = paragraph('');
		const state = createIncrementalMarkdown(docOf(first, image, empty), serialize);
		expect(state.silent).toEqual([false, false, true]);
		expect(state.prefixes).toEqual(['', '\n\n', '']);

		// The editor can add a paragraph before the trailing silent paragraph
		// when a caret reaches the end after an image. The silent block owns no
		// bytes and must not reject the insertion separator.
		const added = paragraph('New');
		let calls = 0;
		const counting = (node: ProseNode) => {
			calls += 1;
			return serialize(node);
		};
		const result = updateIncrementalMarkdown(state, docOf(first, image, added, empty), counting);
		expect(result.full).toBe(false);
		expect(result.state.markdown).toBe(serialize(docOf(first, image, added, empty)));
		expect(calls).toBe(1);
		expect(result.scope).toEqual({
			previousFrom: 'First\n\n![Figure](data:image/png;base64,AAAA)'.length,
			previousTo: 'First\n\n![Figure](data:image/png;base64,AAAA)'.length,
			nextFrom: 'First\n\n![Figure](data:image/png;base64,AAAA)'.length,
			nextTo: 'First\n\n![Figure](data:image/png;base64,AAAA)\n\nNew'.length,
			insert: true
		});
	});

	it('falls back when a block type changes', () => {
		const first = paragraph('First');
		const second = paragraph('Second');
		const state = createIncrementalMarkdown(docOf(first, second), serialize);
		expect(updateIncrementalMarkdown(state, docOf(heading('First'), second), serialize).full).toBe(
			true
		);
	});
});

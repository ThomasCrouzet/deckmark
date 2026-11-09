import { describe, expect, it } from 'vitest';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { createIncrementalMarkdown, updateIncrementalMarkdown } from './markdown-incremental';

interface FakeBlock {
	type: string;
	text: string;
}

interface FakeDoc {
	children: FakeBlock[];
}

function docOf(...children: FakeBlock[]): ProseNode {
	const doc: FakeDoc = { children };
	return Object.assign(doc, {
		type: { create: (_attrs: unknown, blocks: FakeBlock[]) => docOf(...blocks) },
		childCount: children.length,
		child(index: number) {
			return children[index] as unknown as ProseNode;
		}
	}) as unknown as ProseNode;
}

function serialize(node: ProseNode): string {
	const value = node as unknown as FakeBlock | FakeDoc;
	return 'children' in value
		? value.children.map((entry) => entry.text).join('\n\n') + '\n'
		: value.text;
}

describe('incremental Markdown serialization', () => {
	it('reconstructs the full serializer output exactly', () => {
		const doc = docOf({ type: 'p', text: '# First' }, { type: 'p', text: 'Body' });
		const state = createIncrementalMarkdown(doc, serialize);
		expect(state.markdown).toBe(serialize(doc));
	});

	it('re-serializes only the changed top-level block', () => {
		const first = { type: 'p', text: 'First' };
		const second = { type: 'p', text: 'Second' };
		const state = createIncrementalMarkdown(docOf(first, second), serialize);
		const changed = { ...second, text: 'Changed' };
		const next = docOf(first, changed);
		let calls = 0;
		const counting = (node: ProseNode) => {
			calls += 1;
			return serialize(node);
		};
		const result = updateIncrementalMarkdown(state, next, counting);
		expect(result.full).toBe(false);
		expect(calls).toBe(1);
		expect(result.state.markdown).toBe(serialize(next));
	});

	it('falls back when a block type changes or blocks are inserted', () => {
		const first = { type: 'p', text: 'First' };
		const second = { type: 'p', text: 'Second' };
		const state = createIncrementalMarkdown(docOf(first, second), serialize);
		expect(
			updateIncrementalMarkdown(state, docOf({ type: 'h1', text: 'First' }, second), serialize).full
		).toBe(true);
		expect(
			updateIncrementalMarkdown(
				state,
				docOf(first, second, { type: 'p', text: 'Third' }),
				serialize
			).full
		).toBe(true);
	});
});

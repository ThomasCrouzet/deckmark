// Incremental Milkdown Markdown serialization.
//
// The Milkdown serializer walks every top-level block. On a multi-megabyte
// note a one-character edit can take seconds and blocks the next keystroke.
// Unchanged ProseMirror nodes are structurally shared, so their serialized
// strings can be reused. Block boundaries and separators stay in the exact
// form produced by the full serializer.

import type { Node as ProseNode } from '@milkdown/kit/prose/model';

export interface IncrementalMarkdownState {
	doc: ProseNode;
	blocks: readonly ProseNode[];
	prefixes: readonly string[];
	blockMarkdown: readonly string[];
	suffix: string;
	markdown: string;
}

type Serialize = (node: ProseNode) => string;

function join(state: IncrementalMarkdownState): string {
	let result = '';
	for (let index = 0; index < state.blockMarkdown.length; index += 1)
		result += state.prefixes[index]! + state.blockMarkdown[index]!;
	return result + state.suffix;
}

/** Splits one full serialization into reusable top-level block strings. */
export function createIncrementalMarkdown(
	doc: ProseNode,
	serialize: Serialize
): IncrementalMarkdownState {
	const full = serialize(doc);
	const blocks: ProseNode[] = [];
	const blockMarkdown: string[] = [];
	const prefixes: string[] = [];
	let cursor = 0;
	for (let index = 0; index < doc.childCount; index += 1) {
		const block = doc.child(index);
		const markdown = serialize(doc.type.create(doc.attrs, [block])).replace(/\n$/, '');
		const found = full.indexOf(markdown, cursor);
		if (found < 0) {
			// The full serializer owns a global reconstruction this block cannot
			// reproduce. Keep the full string and refuse incremental updates.
			return {
				doc,
				blocks: [],
				prefixes: [],
				blockMarkdown: [],
				suffix: '',
				markdown: full
			};
		}
		prefixes.push(full.slice(cursor, found));
		blocks.push(block);
		blockMarkdown.push(markdown);
		cursor = found + markdown.length;
	}
	const state: IncrementalMarkdownState = {
		doc,
		blocks,
		prefixes,
		blockMarkdown,
		suffix: full.slice(cursor),
		markdown: full
	};
	return state;
}

export interface IncrementalMarkdownResult {
	state: IncrementalMarkdownState;
	/** True when the update had to serialize the complete document. */
	full: boolean;
}

/**
 * Reuses every unchanged top-level block. A changed type or child count falls
 * back to one full serialization instead of guessing a separator.
 */
export function updateIncrementalMarkdown(
	state: IncrementalMarkdownState,
	doc: ProseNode,
	serialize: Serialize
): IncrementalMarkdownResult {
	if (doc === state.doc) return { state, full: false };
	if (state.blocks.length === 0 || doc.childCount !== state.doc.childCount) {
		return { state: createIncrementalMarkdown(doc, serialize), full: true };
	}
	const count = doc.childCount;
	let start = 0;
	while (start < count && doc.child(start) === state.doc.child(start)) start += 1;
	let oldEnd = count;
	let newEnd = count;
	while (
		oldEnd > start &&
		newEnd > start &&
		doc.child(newEnd - 1) === state.doc.child(oldEnd - 1)
	) {
		oldEnd -= 1;
		newEnd -= 1;
	}
	if (oldEnd !== newEnd) return { state: createIncrementalMarkdown(doc, serialize), full: true };
	const blockMarkdown = [...state.blockMarkdown];
	const blocks = [...state.blocks];
	for (let index = start; index < newEnd; index += 1) {
		const next = doc.child(index);
		const previous = state.doc.child(index);
		if (next === previous) continue;
		if (next.type !== previous.type || state.blockMarkdown[index] === '') {
			return { state: createIncrementalMarkdown(doc, serialize), full: true };
		}
		blocks[index] = next;
		blockMarkdown[index] = serialize(doc.type.create(doc.attrs, [next])).replace(/\n$/, '');
		if (blockMarkdown[index] === '') {
			return { state: createIncrementalMarkdown(doc, serialize), full: true };
		}
	}
	const next: IncrementalMarkdownState = {
		doc,
		blocks,
		prefixes: state.prefixes,
		blockMarkdown,
		suffix: state.suffix,
		markdown: ''
	};
	next.markdown = join(next);
	return { state: next, full: false };
}

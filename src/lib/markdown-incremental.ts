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
	/** True for an empty block that the full serializer omits. */
	silent: readonly boolean[];
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

/** Content span of one top-level block inside its joined Markdown. */
function blockSpan(state: IncrementalMarkdownState, index: number): { from: number; to: number } {
	let from = state.prefixes[index]?.length ?? 0;
	for (let cursor = 0; cursor < index; cursor += 1)
		from += (state.prefixes[cursor]?.length ?? 0) + (state.blockMarkdown[cursor]?.length ?? 0);
	return { from, to: from + (state.blockMarkdown[index]?.length ?? 0) };
}

/** Splits one full serialization into reusable top-level block strings. */
export function createIncrementalMarkdown(
	doc: ProseNode,
	serialize: Serialize
): IncrementalMarkdownState {
	const full = serialize(doc);
	const blocks: ProseNode[] = [];
	const blockMarkdown: string[] = [];
	for (let index = 0; index < doc.childCount; index += 1) {
		const block = doc.child(index);
		blocks.push(block);
		blockMarkdown.push(serializeBlock(doc, block, serialize));
	}
	// Empty blocks own no bytes. Give each one the canonical plain-block
	// separator so a later first character can replace it in place.
	let separator: string | null = null;
	for (let index = 1; index < blockMarkdown.length && !separator; index += 1) {
		if (!blockMarkdown[index - 1] && !blockMarkdown[index]) continue;
		separator = pairSeparator(
			doc,
			blocks[index - 1]!,
			blocks[index]!,
			blockMarkdown[index - 1]!,
			blockMarkdown[index]!,
			serialize
		);
	}
	const prefixes: string[] = [];
	const silent: boolean[] = [];
	let cursor = 0;
	for (let index = 0; index < blockMarkdown.length; index += 1) {
		const markdown = blockMarkdown[index]!;
		if (!markdown) {
			if (separator && full.startsWith(separator, cursor)) {
				prefixes.push(separator);
				cursor += separator.length;
				silent.push(false);
			} else {
				// The serializer dropped this empty block, for example a trailing
				// empty paragraph after a table. A later first character must take
				// the full path so it is not glued to the previous block.
				prefixes.push('');
				silent.push(true);
			}
			continue;
		}
		const found = full.indexOf(markdown, cursor);
		if (found < 0) {
			// The full serializer owns a global reconstruction this block cannot
			// reproduce. Keep the full string and refuse incremental updates.
			return {
				doc,
				blocks: [],
				prefixes: [],
				blockMarkdown: [],
				silent: [],
				suffix: '',
				markdown: full
			};
		}
		prefixes.push(full.slice(cursor, found));
		silent.push(false);
		cursor = found + markdown.length;
	}
	return {
		doc,
		blocks,
		prefixes,
		blockMarkdown,
		silent,
		suffix: full.slice(cursor),
		markdown: full
	};
}

export interface IncrementalBlockChange {
	/** First changed top-level block index in both documents. */
	start: number;
	/** Exclusive end index of the changed blocks in both documents. */
	end: number;
	/** Exclusive end index of the changed blocks in the previous document. */
	previousEnd: number;
}

export interface IncrementalBlockScope {
	/** Changed block span in the previous joined Markdown. */
	previousFrom: number;
	previousTo: number;
	/** Changed block span in the new joined Markdown. */
	nextFrom: number;
	nextTo: number;
}

export interface IncrementalMarkdownResult {
	state: IncrementalMarkdownState;
	/** True when the update had to serialize the complete document. */
	full: boolean;
	/** One contiguous changed top-level block range when the update was local. */
	changed?: IncrementalBlockChange | undefined;
	/** Exact Markdown span of the single changed block. */
	scope?: IncrementalBlockScope | undefined;
}

const SUPPORTED_TYPES = new Set(['paragraph', 'heading']);

function serializeBlock(doc: ProseNode, node: ProseNode, serialize: Serialize): string {
	return serialize(doc.type.create(doc.attrs, [node])).replace(/\n$/, '');
}

/**
 * Derive the canonical separator between two top-level plain blocks from the
 * real serializer. The cached strings must be the complete pieces around it.
 */
function pairSeparator(
	doc: ProseNode,
	left: ProseNode,
	right: ProseNode,
	leftMarkdown: string,
	rightMarkdown: string,
	serialize: Serialize
): string | null {
	const pair = serialize(doc.type.create(doc.attrs, [left, right])).replace(/\n$/, '');
	if (!pair.startsWith(leftMarkdown) || !pair.endsWith(rightMarkdown)) return null;
	const separator = pair.slice(leftMarkdown.length, pair.length - rightMarkdown.length);
	return separator.length > 0 ? separator : null;
}

/**
 * Rebuilds a changed contiguous top-level span without serializing the whole
 * note. The span and its two boundary pairs are serialized, then the result is
 * accepted only when the cached plain blocks and the canonical separators
 * agree. Anything else falls back to the full serializer.
 */
function updateStructuralSpan(
	state: IncrementalMarkdownState,
	doc: ProseNode,
	serialize: Serialize,
	start: number,
	oldEnd: number,
	newEnd: number
): IncrementalMarkdownState | null {
	const oldCount = state.blocks.length;
	const leading = state.prefixes[0] ?? '';
	if (oldCount === 0) return null;
	const removed = state.blocks.slice(start, oldEnd);
	const inserted = Array.from({ length: newEnd - start }, (_, index) => doc.child(start + index));
	if (
		!removed.every((node) => SUPPORTED_TYPES.has(node.type.name)) ||
		!inserted.every((node) => SUPPORTED_TYPES.has(node.type.name))
	)
		return null;
	const left = start > 0 ? state.blocks[start - 1] : null;
	const right = oldEnd < oldCount ? state.blocks[oldEnd] : null;
	if (
		(left && !SUPPORTED_TYPES.has(left.type.name)) ||
		(right && !SUPPORTED_TYPES.has(right.type.name))
	)
		return null;
	// Find one canonical plain-block separator in the accepted document.
	let separator: string | null = null;
	for (let index = 1; index < oldCount; index += 1) {
		const before = state.blocks[index - 1]!;
		const after = state.blocks[index]!;
		if (!SUPPORTED_TYPES.has(before.type.name) || !SUPPORTED_TYPES.has(after.type.name)) continue;
		separator = pairSeparator(
			doc,
			before,
			after,
			state.blockMarkdown[index - 1]!,
			state.blockMarkdown[index]!,
			serialize
		);
		if (separator) break;
	}
	if (!separator) return null;
	const insertedMarkdown = inserted.map((node) => serializeBlock(doc, node, serialize));
	if (
		insertedMarkdown.some((markdown) => markdown === '') ||
		state.blockMarkdown.slice(start, oldEnd).some((markdown) => markdown === '')
	)
		return null;
	const span = serialize(doc.type.create(doc.attrs, inserted)).replace(/\n$/, '');
	// The span must be the exact canonical join of its blocks.
	if (span !== insertedMarkdown.join(separator)) return null;
	if (left) {
		const pair = pairSeparator(
			doc,
			left,
			inserted[0]!,
			state.blockMarkdown[start - 1]!,
			insertedMarkdown[0]!,
			serialize
		);
		if (pair !== separator) return null;
	}
	const lastNew = inserted[inserted.length - 1] ?? left;
	if (right) {
		if (!lastNew) return null;
		const lastMarkdown =
			inserted.length > 0
				? insertedMarkdown[inserted.length - 1]!
				: state.blockMarkdown[oldEnd - 1]!;
		const pair = pairSeparator(
			doc,
			lastNew,
			right,
			lastMarkdown,
			state.blockMarkdown[oldEnd]!,
			serialize
		);
		if (pair !== separator) return null;
	}
	// Existing separators at both boundaries must be the canonical one.
	if (left && start < oldCount && state.prefixes[start] !== separator) return null;
	if (right && oldEnd > 0 && state.prefixes[oldEnd] !== separator) return null;
	const prefixes: string[] = [];
	for (let index = 0; index < start; index += 1) prefixes.push(state.prefixes[index]!);
	const pushPrefix = (value: string) => {
		prefixes.push(prefixes.length === 0 ? leading : value);
	};
	for (let index = 0; index < inserted.length; index += 1) pushPrefix(separator);
	if (right) {
		pushPrefix(separator);
		for (let index = oldEnd + 1; index < oldCount; index += 1)
			prefixes.push(state.prefixes[index]!);
	}
	const blockTexts = [
		...state.blockMarkdown.slice(0, start),
		...insertedMarkdown,
		...state.blockMarkdown.slice(oldEnd)
	];
	const next: IncrementalMarkdownState = {
		doc,
		blocks: [...state.blocks.slice(0, start), ...inserted, ...state.blocks.slice(oldEnd)],
		prefixes,
		blockMarkdown: blockTexts,
		silent: [
			...state.silent.slice(0, start),
			...inserted.map(() => false),
			...state.silent.slice(oldEnd)
		],
		suffix: state.suffix,
		markdown: ''
	};
	if (next.prefixes.length !== next.blockMarkdown.length) return null;
	next.markdown = join(next);
	return next;
}

/**
 * Reuses every unchanged top-level block. Text changes stay local, and a
 * contiguous plain-block insertion or removal is rebuilt from the changed span
 * plus one neighbor on each side. Other structural changes keep the full
 * serializer.
 */
export function updateIncrementalMarkdown(
	state: IncrementalMarkdownState,
	doc: ProseNode,
	serialize: Serialize
): IncrementalMarkdownResult {
	if (doc === state.doc) return { state, full: false };
	if (state.blocks.length === 0) {
		return { state: createIncrementalMarkdown(doc, serialize), full: true };
	}
	const count = doc.childCount;
	let start = 0;
	while (
		start < count &&
		start < state.blocks.length &&
		doc.child(start) === state.doc.child(start)
	)
		start += 1;
	let oldEnd = state.blocks.length;
	let newEnd = count;
	while (
		oldEnd > start &&
		newEnd > start &&
		doc.child(newEnd - 1) === state.doc.child(oldEnd - 1)
	) {
		oldEnd -= 1;
		newEnd -= 1;
	}
	if (oldEnd !== newEnd) {
		const structural = updateStructuralSpan(state, doc, serialize, start, oldEnd, newEnd);
		if (structural) {
			return {
				state: structural,
				full: false,
				changed: { start, end: newEnd, previousEnd: oldEnd }
			};
		}
		return { state: createIncrementalMarkdown(doc, serialize), full: true };
	}
	const blockMarkdown = [...state.blockMarkdown];
	const blocks = [...state.blocks];
	for (let index = start; index < newEnd; index += 1) {
		const next = doc.child(index);
		const previous = state.doc.child(index);
		if (next === previous) continue;
		if (next.type.name !== previous.type.name || state.silent[index]) {
			return { state: createIncrementalMarkdown(doc, serialize), full: true };
		}
		blocks[index] = next;
		blockMarkdown[index] = serializeBlock(doc, next, serialize);
	}
	const next: IncrementalMarkdownState = {
		doc,
		blocks,
		prefixes: state.prefixes,
		blockMarkdown,
		silent: state.silent,
		suffix: state.suffix,
		markdown: ''
	};
	next.markdown = join(next);
	const single = start < newEnd && newEnd - start === 1 && oldEnd - start === 1;
	return {
		state: next,
		full: false,
		changed: start < newEnd ? { start, end: newEnd, previousEnd: oldEnd } : undefined,
		scope: single
			? (() => {
					const previous = blockSpan(state, start);
					const current = blockSpan(next, start);
					return {
						previousFrom: previous.from,
						previousTo: previous.to,
						nextFrom: current.from,
						nextTo: current.to
					};
				})()
			: undefined
	};
}

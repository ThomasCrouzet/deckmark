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
	/**
	 * True when the change only inserts blocks, so `previousFrom` and
	 * `previousTo` are the same insertion point and the new span keeps the
	 * leading separator that the inserted block owns.
	 */
	insert?: boolean;
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

const PLAIN_TYPES = new Set(['paragraph', 'heading']);

function isPlainBlock(node: ProseNode): boolean {
	return PLAIN_TYPES.has(node.type.name);
}

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
 * Reuse one separator that the full serializer already produced between two
 * plain blocks. Prose and headings share one block separator, so a later
 * boundary that touches an image does not serialize that image again.
 */
function cachedSeparator(state: IncrementalMarkdownState): string | null {
	let fallback: string | null = null;
	for (let index = 1; index < state.prefixes.length; index += 1) {
		const prefix = state.prefixes[index]!;
		if (!prefix) continue;
		if (isPlainBlock(state.blocks[index - 1]!) && isPlainBlock(state.blocks[index]!)) return prefix;
		fallback ??= prefix;
	}
	return fallback;
}

/**
 * Read the separator out of the serialization of exactly two plain blocks when
 * the cached state has no usable plain boundary, for example a one-block note.
 */
function spanSeparator(span: string, first: string, last: string): string | null {
	if (!last || !span.endsWith(last)) return null;
	if (first && !span.startsWith(first)) return null;
	const separator = span.slice(first.length, span.length - last.length);
	return separator.length > 0 ? separator : null;
}

interface StructuralSpan {
	state: IncrementalMarkdownState;
	scope?: IncrementalBlockScope | undefined;
}

/** Build the next state from a validated changed top-level span. */
function buildStructuralState(
	state: IncrementalMarkdownState,
	doc: ProseNode,
	start: number,
	oldEnd: number,
	inserted: readonly ProseNode[],
	insertedMarkdown: readonly string[],
	separator: string,
	kept: number
): IncrementalMarkdownState {
	const oldCount = state.blocks.length;
	const right = oldEnd < oldCount;
	const prefixes: string[] = state.prefixes.slice(0, start) as string[];
	const leading = state.prefixes[0] ?? '';
	for (let index = 0; index < inserted.length; index += 1) {
		if (index >= kept) prefixes.push('');
		else if (index === 0 && start === 0) prefixes.push(leading);
		else prefixes.push(separator);
	}
	if (right) {
		// A silent block owns no bytes, so its cached empty prefix stays. A
		// visible neighbor keeps the validated separator.
		prefixes.push(state.silent[oldEnd] ? (state.prefixes[oldEnd] ?? '') : separator);
		for (let index = oldEnd + 1; index < oldCount; index += 1)
			prefixes.push(state.prefixes[index]!);
	}
	const next: IncrementalMarkdownState = {
		doc,
		blocks: [...state.blocks.slice(0, start), ...inserted, ...state.blocks.slice(oldEnd)],
		prefixes,
		blockMarkdown: [
			...state.blockMarkdown.slice(0, start),
			...insertedMarkdown,
			...state.blockMarkdown.slice(oldEnd)
		],
		silent: [
			...state.silent.slice(0, start),
			...inserted.map((_, index) => index >= kept),
			...state.silent.slice(oldEnd)
		],
		suffix: state.suffix,
		markdown: ''
	};
	next.markdown = join(next);
	return next;
}

/**
 * Map the changed span for the downstream image and source layers. A replacing
 * change keeps the block separator, so its span is content only. An inserting
 * change owns the new leading separator, so its span starts before that
 * separator and the consumers reproduce the exact inserted bytes.
 */
function structuralScope(
	state: IncrementalMarkdownState,
	next: IncrementalMarkdownState,
	start: number,
	oldEnd: number,
	newEnd: number,
	kept: number
): IncrementalBlockScope | undefined {
	if (oldEnd === start) {
		const from = start > 0 ? blockSpan(state, start - 1).to : 0;
		const last = start + kept - 1;
		return {
			previousFrom: from,
			previousTo: from,
			nextFrom: from,
			nextTo: kept > 0 ? blockSpan(next, last).to : from,
			insert: true
		};
	}
	if (newEnd === start) return undefined;
	const previous = blockSpan(state, start);
	return {
		previousFrom: previous.from,
		previousTo: blockSpan(state, oldEnd - 1).to,
		nextFrom: blockSpan(next, start).from,
		nextTo: blockSpan(next, newEnd - 1).to
	};
}

/**
 * Rebuilds a changed contiguous top-level span without serializing the whole
 * note. Only the changed plain blocks are serialized. An unchanged neighbor of
 * any type, including an image block, is reused from the cache. The result is
 * accepted only when the cached separators and the changed span agree with the
 * real serializer. Anything else falls back to the full serializer.
 */
function updateStructuralSpan(
	state: IncrementalMarkdownState,
	doc: ProseNode,
	serialize: Serialize,
	start: number,
	oldEnd: number,
	newEnd: number
): StructuralSpan | null {
	const oldCount = state.blocks.length;
	if (oldCount === 0) return null;
	const removed = state.blocks.slice(start, oldEnd);
	const inserted = Array.from({ length: newEnd - start }, (_, index) => doc.child(start + index));
	if (!removed.every(isPlainBlock) || !inserted.every(isPlainBlock)) return null;
	const left = start > 0 ? state.blocks[start - 1]! : null;
	const right = oldEnd < oldCount ? state.blocks[oldEnd]! : null;
	const insertedMarkdown = inserted.map((node) => serializeBlock(doc, node, serialize));
	// The serializer drops trailing empty paragraphs at the document end.
	let kept = inserted.length;
	if (!right) while (kept > 0 && insertedMarkdown[kept - 1] === '') kept -= 1;
	if (kept === 0 && !right) {
		// Empty paragraphs at the end own no bytes yet. The next first character
		// gives them a separator and a content span.
		const next = buildStructuralState(state, doc, start, oldEnd, inserted, insertedMarkdown, '', 0);
		return { state: next, scope: structuralScope(state, next, start, oldEnd, newEnd, 0) };
	}
	let separator = cachedSeparator(state);
	// The span oracle cannot include a trailing empty block that a following
	// block keeps in the document, because the serializer trims it when it is
	// serialized alone. Validate the non-empty prefix of the span instead.
	let validated = kept;
	while (validated > 0 && insertedMarkdown[validated - 1] === '') validated -= 1;
	if (validated > 1) {
		const marks = insertedMarkdown.slice(0, validated);
		const span = serialize(doc.type.create(doc.attrs, inserted.slice(0, validated))).replace(
			/\n$/,
			''
		);
		if (separator === null && marks.length === 2)
			separator = spanSeparator(span, marks[0]!, marks[1]!);
		if (separator === null || span !== marks.join(separator)) return null;
	}
	if (separator === null) {
		if (left)
			separator = pairSeparator(
				doc,
				left,
				inserted[0]!,
				state.blockMarkdown[start - 1]!,
				insertedMarkdown[0]!,
				serialize
			);
		if (separator === null && right)
			separator = pairSeparator(
				doc,
				inserted[inserted.length - 1]!,
				right,
				insertedMarkdown[inserted.length - 1]!,
				state.blockMarkdown[oldEnd]!,
				serialize
			);
		if (separator === null) return null;
	}
	// Cached boundaries inside and beside the change must use one separator. A
	// silent right block owns no bytes, so its empty prefix cannot constrain it.
	if (left && oldEnd > start && state.prefixes[start] !== separator) return null;
	if (right && oldEnd > 0 && !state.silent[oldEnd] && state.prefixes[oldEnd] !== separator)
		return null;
	const next = buildStructuralState(
		state,
		doc,
		start,
		oldEnd,
		inserted,
		insertedMarkdown,
		separator,
		kept
	);
	return { state: next, scope: structuralScope(state, next, start, oldEnd, newEnd, kept) };
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
				state: structural.state,
				full: false,
				changed: { start, end: newEnd, previousEnd: oldEnd },
				scope: structural.scope
			};
		}
		return { state: createIncrementalMarkdown(doc, serialize), full: true };
	}
	const blockMarkdown = [...state.blockMarkdown];
	const blocks = [...state.blocks];
	let prefixes = state.prefixes;
	let silent = state.silent;
	let materialized: number | null = null;
	for (let index = start; index < newEnd; index += 1) {
		const next = doc.child(index);
		const previous = state.doc.child(index);
		if (next === previous) continue;
		if (next.type.name !== previous.type.name) {
			return { state: createIncrementalMarkdown(doc, serialize), full: true };
		}
		const markdown = serializeBlock(doc, next, serialize);
		if (state.silent[index]) {
			if (markdown === '') {
				blocks[index] = next;
				continue;
			}
			// The serializer dropped this empty trailing paragraph. The first
			// character gives it the canonical separator and a content span.
			const left = index > 0 ? state.blocks[index - 1]! : null;
			let separator = cachedSeparator(state);
			if (separator === null && left)
				separator = pairSeparator(
					doc,
					left,
					next,
					state.blockMarkdown[index - 1]!,
					markdown,
					serialize
				);
			if (separator === null) separator = '';
			if (prefixes === state.prefixes) prefixes = [...state.prefixes] as string[];
			if (silent === state.silent) silent = [...state.silent];
			(prefixes as string[])[index] = index === 0 ? (state.prefixes[0] ?? '') : separator;
			(silent as boolean[])[index] = false;
			materialized = index;
		}
		blocks[index] = next;
		blockMarkdown[index] = markdown;
	}
	const next: IncrementalMarkdownState = {
		doc,
		blocks,
		prefixes,
		blockMarkdown,
		silent,
		suffix: state.suffix,
		markdown: ''
	};
	next.markdown = join(next);
	const single = start < newEnd && newEnd - start === 1 && oldEnd - start === 1;
	const previousSpan = single ? blockSpan(state, start) : null;
	const currentSpan = single ? blockSpan(next, start) : null;
	return {
		state: next,
		full: false,
		changed: start < newEnd ? { start, end: newEnd, previousEnd: oldEnd } : undefined,
		scope:
			previousSpan && currentSpan
				? materialized === start
					? {
							previousFrom: previousSpan.from,
							previousTo: previousSpan.from,
							nextFrom: previousSpan.from,
							nextTo: currentSpan.to,
							insert: true
						}
					: {
							previousFrom: previousSpan.from,
							previousTo: previousSpan.to,
							nextFrom: currentSpan.from,
							nextTo: currentSpan.to
						}
				: undefined
	};
}

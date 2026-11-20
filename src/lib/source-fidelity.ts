import { recordSourceFidelityPath, type SourceFidelityPath } from './source-fidelity-diagnostics';
import { measureEditorStage, recordEditorCounter } from './editor-perf';
import type { SourceEditHint } from './source-edit';

interface MarkdownNode {
	type: string;
	value?: string | undefined;
	children?: MarkdownNode[] | undefined;
	position?:
		{ start: { offset?: number | undefined }; end: { offset?: number | undefined } } | undefined;
}

interface Patch {
	start: number;
	end: number;
	value: string;
}

interface ScopedRestore {
	result: string;
	/** First replaced baseline block, and how many blocks it spans. */
	blockIndex: number;
	blockCount: number;
	/** First replaced source block, and how many blocks it spans. */
	sourceIndex: number;
	sourceCount: number;
	markdownStart: number;
	sourceStart: number;
	markdownDelta: number;
	sourceDelta: number;
	markdownNodes: MarkdownNode[];
	sourceNodes: MarkdownNode[];
	/** Output range that the accepted change replaced, in source bytes. */
	previousFrom: number;
	previousTo: number;
	nextFrom: number;
	nextTo: number;
}

/**
 * A block span from the editor transaction stream. The incremental serializer
 * knows which top-level block changed and its exact Markdown offsets. This hint
 * removes the whole-document prefix and suffix comparison that otherwise
 * locates the block. A span that does not align with the accepted baseline is
 * stale, so the caller must ignore it.
 */
/** Exact changed span that the restore accepted, in accepted source bytes. */
export interface SourceFidelitySpan {
	previousFrom: number;
	previousTo: number;
	nextFrom: number;
	nextTo: number;
}

export interface SourceFidelityHint extends SourceEditHint {
	previousFrom: number;
	previousTo: number;
	nextFrom: number;
	nextTo: number;
	/** True when the change only inserts blocks at the given point. */
	insert?: boolean;
}

type Parse = (markdown: string) => MarkdownNode;

interface ContainerTarget {
	from: number;
	block: MarkdownNode;
	original: MarkdownNode;
	blockStart: number;
	sourceFrom: number;
	sourceTo: number;
	blockRaw: string;
	trimmed: string;
	delta: number;
}

interface ContainerLeaf {
	leafPath: number[];
	parentPath: number[];
	oldValue: string;
	newValue: string;
	nextLeafRaw: string;
	nextParentText: string;
	markdownBlock: MarkdownNode;
}

/** Container blocks that can hold an unchanged text leaf at any depth. */
const CONTAINER_TYPES = new Set(['list', 'table', 'blockquote']);

/** Fenced code blocks whose body edit stays line-local. */
const FENCE_TYPES = new Set(['code']);

/**
 * Largest block that a scoped route may parse for its semantic check. A larger
 * block keeps the whole-document route, which is the documented fallback.
 */
const BOUNDED_BLOCK_CHARS = 262_144;

function start(node: MarkdownNode): number {
	return node.position?.start.offset ?? 0;
}

function end(node: MarkdownNode): number {
	return node.position?.end.offset ?? 0;
}

/** Move a parsed subtree to its place in a newer document snapshot. */
function shift(node: MarkdownNode, delta: number): MarkdownNode {
	if (!delta) return node;
	const startOffset = node.position?.start.offset;
	const endOffset = node.position?.end.offset;
	if (startOffset !== undefined) node.position!.start.offset = startOffset + delta;
	if (endOffset !== undefined) node.position!.end.offset = endOffset + delta;
	for (const child of node.children ?? []) shift(child, delta);
	return node;
}

/** Follow a child-index path from one parsed node. */
function nodeAtPath(root: MarkdownNode, path: number[]): MarkdownNode | null {
	let node: MarkdownNode | undefined = root;
	for (const index of path) {
		node = node?.children?.[index];
		if (!node) return null;
	}
	return node ?? null;
}

function properties(node: MarkdownNode): string {
	return JSON.stringify(
		Object.fromEntries(
			Object.entries(node)
				.filter(([key]) => !['position', 'children'].includes(key))
				.map(([key, value]) => [
					key,
					key === 'value' && typeof value === 'string' ? value.replaceAll('\r\n', '\n') : value
				])
		)
	);
}

function equal(a: MarkdownNode, b: MarkdownNode): boolean {
	return (
		properties(a) === properties(b) &&
		(a.children?.length ?? 0) === (b.children?.length ?? 0) &&
		(a.children ?? []).every((child, index) => equal(child, b.children![index]!))
	);
}

/**
 * True when two trees have the same node types and child counts at every
 * depth. A source container can differ from the serializer form in alignment,
 * padding or markers while its leaf paths still match, so the positional route
 * accepts that difference and the semantic check decides the rest.
 *
 * A table also differs in row width. A source line after the table that holds
 * no blank separator parses as a row, and later rows can hold fewer cells than
 * the header. The serializer pads every row to the header column count, so the
 * source form of a short row has fewer cells. The row order still matches, and
 * a cell that exists only in the serializer form resolves to no source leaf,
 * which keeps the full route. Accept only that direction: a source row with
 * more cells than the serializer row has no positional counterpart.
 */
function sameShape(a: MarkdownNode, b: MarkdownNode): boolean {
	if (a.type !== b.type) return false;
	const left = a.children ?? [];
	const right = b.children ?? [];
	if (left.length !== right.length && (a.type !== 'tableRow' || right.length > left.length))
		return false;
	for (let index = 0; index < Math.min(left.length, right.length); index += 1)
		if (!sameShape(left[index]!, right[index]!)) return false;
	return true;
}

/** Inline content of a table cell without its delimiter pipes and padding. */
function cellContent(raw: string): string {
	const left = raw.indexOf('|');
	const right = raw.lastIndexOf('|');
	if (left < 0 || right <= left) return raw;
	return raw.slice(left + 1, right).trim();
}

/**
 * Fence marker lines and the raw body of one fenced code block. The body keeps
 * its final line ending so a patch never rewrites a line-ending byte.
 */
function fenceParts(raw: string): { open: string; close: string; content: string } | null {
	const openEnd = raw.indexOf('\n');
	if (openEnd < 0) return null;
	const open = raw.slice(0, openEnd).replace(/\r$/, '');
	if (!/^ {0,3}(?:`{3,}|~{3,})/.test(open)) return null;
	const lastNewline = raw.lastIndexOf('\n');
	if (lastNewline < openEnd) return null;
	const close = raw.slice(lastNewline + 1).replace(/\r$/, '');
	if (!/^ {0,3}(?:`{3,}|~{3,})\s*$/.test(close)) return null;
	return { open, close, content: raw.slice(openEnd + 1, lastNewline + 1) };
}

/** Decoded code body without its final line ending. */
function fenceBody(content: string): string {
	return content.replaceAll('\r\n', '\n').replace(/\n$/, '');
}

function apply(source: string, patches: Patch[]): string {
	const sorted = patches.toSorted((left, right) => left.start - right.start);
	const chunks: string[] = [];
	let cursor = 0;
	for (const patch of sorted) {
		if (patch.start < cursor) return applyLegacy(source, patches);
		chunks.push(source.slice(cursor, patch.start), patch.value);
		cursor = patch.end;
	}
	chunks.push(source.slice(cursor));
	return chunks.join('');
}

/** Fallback for an unexpected overlapping patch set. */
function applyLegacy(source: string, patches: Patch[]): string {
	let result = source;
	for (const patch of patches.toSorted((a, b) => b.start - a.start)) {
		result = result.slice(0, patch.start) + patch.value + result.slice(patch.end);
	}
	return result;
}

function changeRange(
	before: string,
	after: string
): { from: number; oldTo: number; newTo: number } {
	let from = 0;
	while (from < before.length && from < after.length && before[from] === after[from]) from++;
	let suffix = 0;
	while (
		suffix < before.length - from &&
		suffix < after.length - from &&
		before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
	)
		suffix++;
	return { from, oldTo: before.length - suffix, newTo: after.length - suffix };
}

interface TextChange {
	from: number;
	oldTo: number;
	newFrom: number;
	newTo: number;
}

/** Keep unchanged text between separate edits in the same Markdown leaf. */
function textChanges(before: string, after: string): TextChange[] {
	const range = changeRange(before, after);
	const tokenize = (value: string) =>
		[...value.matchAll(/\s+|[\p{L}\p{N}_]+|[^\s]/gu)].map((match) => ({
			value: match[0],
			end: range.from + match.index + match[0].length
		}));
	const oldTokens = tokenize(before.slice(range.from, range.oldTo));
	const newTokens = tokenize(after.slice(range.from, range.newTo));
	const width = newTokens.length + 1;
	if ((oldTokens.length + 1) * width > 300_000) return [{ ...range, newFrom: range.from }];
	const matrix = new Uint32Array((oldTokens.length + 1) * width);
	for (let a = oldTokens.length - 1; a >= 0; a--) {
		for (let b = newTokens.length - 1; b >= 0; b--) {
			matrix[a * width + b] =
				oldTokens[a]!.value === newTokens[b]!.value
					? matrix[(a + 1) * width + b + 1]! + 1
					: Math.max(matrix[(a + 1) * width + b]!, matrix[a * width + b + 1]!);
		}
	}
	const changes: TextChange[] = [];
	let a = 0;
	let b = 0;
	let oldAt = range.from;
	let newAt = range.from;
	let pending: TextChange | null = null;
	const flush = () => {
		if (pending) changes.push({ ...pending, oldTo: oldAt, newTo: newAt });
		pending = null;
	};
	while (a < oldTokens.length || b < newTokens.length) {
		if (
			a < oldTokens.length &&
			b < newTokens.length &&
			oldTokens[a]!.value === newTokens[b]!.value
		) {
			flush();
			oldAt = oldTokens[a++]!.end;
			newAt = newTokens[b++]!.end;
		} else {
			pending ??= { from: oldAt, oldTo: oldAt, newFrom: newAt, newTo: newAt };
			if (
				b < newTokens.length &&
				(a === oldTokens.length || matrix[a * width + b + 1]! >= matrix[(a + 1) * width + b]!)
			)
				newAt = newTokens[b++]!.end;
			else oldAt = oldTokens[a++]!.end;
		}
	}
	flush();
	return changes;
}

/** Map decoded text boundaries to source offsets. */
function textRange(
	raw: string,
	value: string,
	from: number,
	to: number,
	code = false
): { from: number; to: number } | null {
	if (raw === value) return { from, to };
	let rawFrom = from === value.length ? raw.length : -1;
	let rawTo = to === value.length ? raw.length : -1;
	let cursor = 0;
	let decoder: HTMLTextAreaElement | undefined;
	const pattern = code
		? /\r\n|[\s\S]/g
		: /\\[!-/:-@[-`{-~]|&(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);|\r\n|[\s\S]/gi;
	for (const unit of raw.matchAll(pattern)) {
		let text = unit[0];
		if (!code && text.startsWith('\\') && text.length === 2) text = text.slice(1);
		else if (text === '\r\n') text = '\n';
		else if (
			!code &&
			text.startsWith('&') &&
			text.endsWith(';') &&
			typeof document !== 'undefined'
		) {
			decoder ??= document.createElement('textarea');
			decoder.innerHTML = text;
			text = decoder.value;
		}
		for (let index = 0; index < text.length; index++) {
			if (text[index] !== value[cursor]) {
				// A text span can include its parent markers and indentation.
				if (/[\s>]/.test(text[index]!)) continue;
				return null;
			}
			if (cursor === from) rawFrom = unit.index;
			if (cursor === to) rawTo = unit.index;
			cursor++;
		}
	}
	return cursor === value.length && rawFrom >= 0 && rawTo >= 0
		? { from: rawFrom, to: rawTo }
		: null;
}

/** Keep original syntax outside the nodes that a visual edit changes. */
export class SourceFidelity {
	private original: MarkdownNode;
	private baseline: MarkdownNode;
	private cachedMarkdown: string;
	private cachedSource: string;
	private mappedOriginals: MarkdownNode[] | null = null;
	/**
	 * Output span of the latest accepted scoped restore. It is the shared
	 * changed-span record that the metadata and statistics consumers reuse.
	 */
	lastScopedSpan: SourceFidelitySpan | null = null;

	constructor(
		private source: string,
		private markdown: string,
		private parse: Parse,
		private normalize: (markdown: string) => string
	) {
		this.original = parse(source);
		this.baseline = parse(markdown);
		this.cachedMarkdown = markdown;
		this.cachedSource = source;
	}

	/**
	 * Restore original syntax for `markdown`.
	 *
	 * `commit` is false for a transaction that the note guard may reject. In that
	 * case the caches stay on the last accepted document, so a later flush cannot
	 * serve source text for a document that was never applied.
	 */
	restore(markdown: string, commit = true, hint?: SourceFidelityHint): string {
		this.lastScopedSpan = null;
		if (markdown === this.cachedMarkdown) return this.cachedSource;
		if (markdown === this.markdown) return this.source;
		const scoped = measureEditorStage('sourceFidelityScopeAttempt', () =>
			this.restoreTextBlock(markdown, hint)
		);
		if (scoped !== null) {
			if (commit) {
				this.cachedMarkdown = markdown;
				this.cachedSource = scoped.result;
				this.acceptScoped(markdown, scoped);
				this.lastScopedSpan = {
					previousFrom: scoped.previousFrom,
					previousTo: scoped.previousTo,
					nextFrom: scoped.nextFrom,
					nextTo: scoped.nextTo
				};
			}
			recordEditorCounter('sourceFidelityScoped');
			recordSourceFidelityPath('fastPath');
			return scoped.result;
		}
		recordEditorCounter('sourceFidelityFull');
		recordEditorCounter(`sourceFidelityFullReason:${this.fullRouteReason(markdown, hint)}`);
		return measureEditorStage('sourceFidelityFull', () => this.restoreFull(markdown, commit));
	}

	/**
	 * Coarse class for a rejected local restore. The value names the changed
	 * top-level block or the missing edit hint. It is evidence for a measurement
	 * report, not an exact internal predicate.
	 *
	 * The reason is positional: it names only the block that the changed span
	 * intersects. A container elsewhere in the note never names the fallback.
	 */
	private fullRouteReason(markdown: string, hint?: SourceFidelityHint): string {
		const before = this.baseline.children ?? [];
		let from: number;
		let to: number;
		if (hint) {
			from = hint.previousFrom;
			to = hint.previousTo;
		} else {
			const range = changeRange(this.markdown, markdown);
			from = range.from;
			to = range.oldTo;
		}
		const block = before.find(
			(node) => end(node) > from || (from === to && end(node) >= from && start(node) <= from)
		);
		if (!block || start(block) > to) return 'no-baseline-block';
		if (block.type === 'list') return 'container-list';
		if (block.type === 'table') return 'container-table';
		if (block.type === 'blockquote') return 'container-blockquote';
		if (block.type === 'code' || block.type === 'fence') return 'container-code';
		if (block.type === 'html') return 'container-html';
		if (block.type === 'paragraph' || block.type === 'heading') {
			if (!hint) return 'missing-edit-hint';
			if (this.originalBlocks() === null) return 'block-count-mismatch';
			return 'unsupported-change-shape';
		}
		return `block-${block.type}`;
	}

	private findChangedBlock(markdown: string): number {
		const before = this.baseline.children ?? [];
		const range = changeRange(this.markdown, markdown);
		let low = 0;
		let high = before.length;
		while (low < high) {
			const middle = (low + high) >>> 1;
			if (end(before[middle]!) < range.from) low = middle + 1;
			else high = middle;
		}
		return low;
	}

	/** Decoded text of a plain paragraph or heading, or null for any other block. */
	private plainText(node: MarkdownNode): string | null {
		if (node.type !== 'paragraph' && node.type !== 'heading') return null;
		if (!node.position || node.children?.length !== 1 || node.children[0]?.type !== 'text')
			return null;
		return (node.children[0].value ?? '').replaceAll('\r\n', '\n');
	}

	private originalBlocks(): MarkdownNode[] | null {
		if (this.mappedOriginals) return this.mappedOriginals;
		const originals = (this.original.children ?? []).filter((node) => node.type !== 'definition');
		if (originals.length !== (this.baseline.children ?? []).length) return null;
		this.mappedOriginals = originals;
		return originals;
	}

	private originalIndex(node: MarkdownNode): number {
		return (this.original.children ?? []).indexOf(node);
	}

	/** True when a link definition starts inside the given source range. */
	private definitionBetween(from: number, to: number): boolean {
		return (this.original.children ?? []).some(
			(node) => node.type === 'definition' && start(node) >= from && start(node) < to
		);
	}

	/** True when a bracket label in `text` names a document definition. */
	private bracketResolvesDefinition(text: string): boolean {
		const labels = new Set(
			(this.original.children ?? [])
				.filter((node) => node.type === 'definition')
				.map((node) =>
					((node as { identifier?: string }).identifier ?? '')
						.trim()
						.replace(/\s+/g, ' ')
						.toLowerCase()
				)
				.filter(Boolean)
		);
		if (!labels.size) return false;
		for (const match of text.matchAll(/\[([^[\]]*)\]/g)) {
			const label = match[1]!.trim().replace(/\s+/g, ' ').toLowerCase();
			if (label && labels.has(label)) return true;
		}
		return false;
	}

	/** First baseline block whose start offset is not before `offset`. */
	private findBlockStart(before: MarkdownNode[], offset: number): number {
		let low = 0;
		let high = before.length;
		while (low < high) {
			const middle = (low + high) >>> 1;
			if (start(before[middle]!) < offset) low = middle + 1;
			else high = middle;
		}
		return low;
	}

	private restoreTextBlock(markdown: string, hint?: SourceFidelityHint): ScopedRestore | null {
		const before = this.baseline.children ?? [];
		const originals = this.originalBlocks();
		if (!originals) return null;
		if (hint) {
			const scoped = hint.insert
				? this.restoreInsertedBlocks(markdown, hint, before, originals)
				: this.restoreReplacedBlocks(markdown, hint, before, originals);
			if (scoped) return scoped;
			// A new paragraph can own no bytes in the accepted baseline while its
			// first character arrives, so the edit is an insertion at a gap.
			if (!hint.insert && hint.previousTo === hint.previousFrom) {
				const inserted = this.restoreInsertedBlocks(markdown, hint, before, originals);
				if (inserted) return inserted;
			}
		}
		const container = this.restoreContainerBlock(markdown, hint, before, originals);
		if (container) return container;
		const fence = this.restoreFenceBlock(markdown, hint, before, originals);
		if (fence) return fence;
		return this.restoreSingleBlock(markdown, hint?.insert ? undefined : hint, before, originals);
	}

	/**
	 * Patch one ordinary text edit inside a large list, table or block quote.
	 * The first strategy diffs the changed Markdown bytes. It covers a list
	 * whose serializer output is local. A table serializer can re-pad every
	 * cell of a changed row, so the second strategy parses only the changed
	 * container and diffs its tree. Both strategies parse one paragraph or one
	 * cell for the semantic check. The complete note is never parsed.
	 */
	private restoreContainerBlock(
		markdown: string,
		hint: SourceFidelityHint | undefined,
		before: MarkdownNode[],
		originals: MarkdownNode[]
	): ScopedRestore | null {
		const target = this.containerTarget(markdown, hint, before, originals, CONTAINER_TYPES);
		if (!target) return null;
		const local = this.restoreContainerBytes(target);
		if (local) return this.commitContainer(target, local);
		const tree = this.restoreContainerTree(target);
		if (tree) return this.commitContainer(target, tree);
		return null;
	}

	/**
	 * Patch one edit inside a fenced code body. A code body is literal text, so
	 * the change is line-local and cannot change block structure outside the
	 * fence. The changed fence alone is parsed for its semantic check.
	 */
	private restoreFenceBlock(
		markdown: string,
		hint: SourceFidelityHint | undefined,
		before: MarkdownNode[],
		originals: MarkdownNode[]
	): ScopedRestore | null {
		const target = this.containerTarget(markdown, hint, before, originals, FENCE_TYPES);
		if (!target || !target.block.position) return null;
		const beforeFence = fenceParts(target.blockRaw);
		const afterFence = fenceParts(target.trimmed);
		if (!beforeFence || !afterFence) return null;
		// A changed fence line, info string or indentation keeps the full route
		// because it can change how the block parses.
		if (beforeFence.open !== afterFence.open || beforeFence.close !== afterFence.close) return null;
		const oldValue = (target.block.value ?? '').replaceAll('\r\n', '\n');
		const newValue = fenceBody(afterFence.content);
		if (oldValue === newValue) return null;
		if (fenceBody(beforeFence.content) !== oldValue) return null;
		const sourceRaw = this.source.slice(target.sourceFrom, target.sourceTo);
		const sourceFence = fenceParts(sourceRaw);
		if (!sourceFence || fenceBody(sourceFence.content) !== oldValue) return null;
		const patches: Patch[] = [];
		for (const change of textChanges(oldValue, newValue)) {
			const sourceOffsets = textRange(
				sourceFence.content,
				oldValue,
				change.from,
				change.oldTo,
				true
			);
			const nextOffsets = textRange(
				afterFence.content,
				newValue,
				change.newFrom,
				change.newTo,
				true
			);
			if (!sourceOffsets || !nextOffsets) return null;
			patches.push({
				start: sourceOffsets.from,
				end: sourceOffsets.to,
				value: this.lineEndings(afterFence.content.slice(nextOffsets.from, nextOffsets.to))
			});
		}
		if (!patches.length) return null;
		const openEnd = sourceRaw.indexOf('\n');
		const candidateBlock =
			sourceRaw.slice(0, openEnd + 1) +
			apply(sourceFence.content, patches) +
			sourceRaw.slice(openEnd + 1 + sourceFence.content.length);
		let candidate: MarkdownNode;
		try {
			const tree = this.parse(candidateBlock);
			const blocks = (tree.children ?? []).filter((node) => node.type !== 'definition');
			if (blocks.length !== 1) return null;
			candidate = blocks[0]!;
		} catch {
			return null;
		}
		if (candidate.type !== target.block.type) return null;
		if ((candidate.value ?? '').replaceAll('\r\n', '\n') !== newValue) return null;
		if (start(candidate) !== 0 || end(candidate) !== candidateBlock.length) return null;
		const sourceIndex = this.originalIndex(target.original);
		if (sourceIndex < 0) return null;
		const result =
			this.source.slice(0, target.sourceFrom) + candidateBlock + this.source.slice(target.sourceTo);
		const afterTree = this.parse(target.trimmed);
		const markdownNodes = (afterTree.children ?? []).filter((node) => node.type !== 'definition');
		if (markdownNodes.length !== 1) return null;
		recordEditorCounter('sourceFidelityScopedFence');
		return {
			result,
			blockIndex: target.from,
			blockCount: 1,
			sourceIndex,
			sourceCount: 1,
			markdownStart: target.blockStart,
			sourceStart: target.sourceFrom,
			markdownDelta: target.delta,
			sourceDelta: result.length - this.source.length,
			markdownNodes,
			sourceNodes: [candidate],
			previousFrom: target.sourceFrom,
			previousTo: target.sourceTo,
			nextFrom: target.sourceFrom,
			nextTo: target.sourceFrom + candidateBlock.length
		};
	}

	/** Locate and validate the one changed container block. */
	private containerTarget(
		markdown: string,
		hint: SourceFidelityHint | undefined,
		before: MarkdownNode[],
		originals: MarkdownNode[],
		types: Set<string>
	): ContainerTarget | null {
		const delta = markdown.length - this.markdown.length;
		let from: number;
		if (hint) {
			if (hint.nextFrom !== hint.previousFrom) return null;
			if (hint.nextTo - hint.nextFrom !== hint.previousTo - hint.previousFrom + delta) return null;
			from = this.findBlockStart(before, hint.previousFrom);
		} else {
			const range = changeRange(this.markdown, markdown);
			from = this.findChangedBlock(markdown);
			const candidate = before[from];
			if (!candidate || range.from < start(candidate) || range.oldTo > end(candidate)) return null;
		}
		const block = before[from];
		const original = originals[from];
		if (!block || !original || !block.position || !original.position) return null;
		if (!types.has(block.type)) return null;
		// The source container must keep the same leaf layout as the baseline.
		// Its bytes may differ in markers, padding or alignment, and the
		// semantic check on the changed parent decides the rest.
		if (original.type !== block.type || !sameShape(block, original)) return null;
		const blockStart = start(block);
		const blockEnd = end(block);
		const sourceFrom = start(original);
		const sourceTo = end(original);
		const blockRaw = this.markdown.slice(blockStart, blockEnd);
		let nextText: string;
		if (hint) {
			if (blockStart !== hint.previousFrom || blockEnd !== hint.previousTo) return null;
			if (markdown.slice(0, hint.nextFrom) !== this.markdown.slice(0, hint.previousFrom))
				return null;
			if (markdown.slice(hint.nextTo) !== this.markdown.slice(hint.previousTo)) return null;
			nextText = markdown.slice(hint.nextFrom, hint.nextTo);
		} else {
			nextText = markdown.slice(blockStart, blockEnd + delta);
			if (markdown.slice(0, blockStart) !== this.markdown.slice(0, blockStart)) return null;
			if (markdown.slice(blockEnd + delta) !== this.markdown.slice(blockEnd)) return null;
		}
		const trimmed = nextText.replace(/\s+$/, '');
		if (trimmed.length - blockRaw.length !== delta) return null;
		return {
			from,
			block,
			original,
			blockStart,
			sourceFrom,
			sourceTo,
			blockRaw,
			trimmed,
			delta
		};
	}

	/** Diff the changed Markdown bytes of one container. */
	private restoreContainerBytes(target: ContainerTarget): ContainerLeaf | null {
		const range = changeRange(target.blockRaw, target.trimmed);
		if (range.oldTo > target.blockRaw.length || range.newTo > target.trimmed.length) return null;
		const leaves: Array<{
			leaf: MarkdownNode;
			parentPath: number[];
			path: number[];
			from: number;
			to: number;
		}> = [];
		const walk = (
			node: MarkdownNode,
			path: number[],
			ancestors: Array<{ node: MarkdownNode; path: number[] }>
		): void => {
			if (node.type === 'text' || node.type === 'inlineCode') {
				const frame = ancestors.findLast((entry) =>
					['paragraph', 'heading', 'tableCell'].includes(entry.node.type)
				);
				if (frame)
					leaves.push({
						leaf: node,
						parentPath: frame.path,
						path,
						from: start(node) - target.blockStart,
						to: end(node) - target.blockStart
					});
				return;
			}
			(node.children ?? []).forEach((child, index) =>
				walk(child, [...path, index], [...ancestors, { node, path }])
			);
		};
		walk(target.block, [], []);
		const matches = leaves.filter((entry) => range.from >= entry.from && range.oldTo <= entry.to);
		if (matches.length !== 1) return null;
		const match = matches[0]!;
		if (match.leaf.type !== 'text') return null;
		const parentStart = start(nodeAtPath(target.block, match.parentPath)!) - target.blockStart;
		const parentEnd = end(nodeAtPath(target.block, match.parentPath)!) - target.blockStart;
		if (range.from < parentStart || range.oldTo > parentEnd) return null;
		const nextParentText = target.trimmed.slice(parentStart, parentEnd + target.delta);
		const oldValue = (match.leaf.value ?? '').replaceAll('\r\n', '\n');
		const nextLeafRaw = target.trimmed.slice(match.from, match.to + target.delta);
		const newValue = this.decodeText(nextLeafRaw);
		if (oldValue === newValue) return null;
		const markdownBlock = this.cloneChangedBlock(
			target.block,
			match.leaf,
			newValue,
			target.blockStart + match.from + nextLeafRaw.length,
			target.delta,
			target.blockStart
		);
		return {
			leafPath: match.path,
			parentPath: match.parentPath,
			oldValue,
			newValue,
			nextLeafRaw,
			nextParentText,
			markdownBlock
		};
	}

	/**
	 * Parse one changed container and diff its tree. A table serializer can
	 * re-pad unchanged cells, so the byte diff can cover the complete table
	 * while the tree differs in one text leaf.
	 */
	private restoreContainerTree(target: ContainerTarget): ContainerLeaf | null {
		if (target.blockRaw.length > BOUNDED_BLOCK_CHARS || target.trimmed.length > BOUNDED_BLOCK_CHARS)
			return null;
		let tree: MarkdownNode;
		try {
			tree = this.parse(target.trimmed);
		} catch {
			return null;
		}
		const blocks = (tree.children ?? []).filter((node) => node.type !== 'definition');
		if (blocks.length !== 1) return null;
		const afterBlock = blocks[0]!;
		if (afterBlock.type !== target.block.type) return null;
		if (start(afterBlock) !== 0 || end(afterBlock) !== target.trimmed.length) return null;
		const change = this.changedTextLeaf(target.block, afterBlock);
		if (!change || change.before.type !== 'text' || change.after.type !== 'text') return null;
		const parent = nodeAtPath(target.block, change.parentPath);
		const afterParent = nodeAtPath(afterBlock, change.parentPath);
		if (!parent || !afterParent) return null;
		const parentRaw = this.markdown.slice(start(parent), end(parent));
		const nextParentText = target.trimmed.slice(start(afterParent), end(afterParent));
		if (parentRaw.length > 65_536 || nextParentText.length > 65_536) return null;
		const oldValue = (change.before.value ?? '').replaceAll('\r\n', '\n');
		const newValue = (change.after.value ?? '').replaceAll('\r\n', '\n');
		if (oldValue === newValue) return null;
		const nextLeafRaw = target.trimmed.slice(start(change.after), end(change.after));
		return {
			leafPath: change.path,
			parentPath: change.parentPath,
			oldValue,
			newValue,
			nextLeafRaw,
			nextParentText,
			markdownBlock: afterBlock
		};
	}

	/**
	 * Find the one changed text leaf in two trees. Any other structural or
	 * property change rejects the local route.
	 */
	private changedTextLeaf(
		before: MarkdownNode,
		after: MarkdownNode
	): {
		before: MarkdownNode;
		after: MarkdownNode;
		path: number[];
		parentPath: number[];
	} | null {
		let found: {
			before: MarkdownNode;
			after: MarkdownNode;
			path: number[];
			parentPath: number[];
		} | null = null;
		let invalid = false;
		const visit = (
			left: MarkdownNode,
			right: MarkdownNode,
			path: number[],
			ancestors: Array<{ node: MarkdownNode; path: number[] }>
		): void => {
			if (invalid) return;
			if (left.type !== right.type) {
				invalid = true;
				return;
			}
			const leftChildren = left.children ?? [];
			const rightChildren = right.children ?? [];
			if (leftChildren.length === 0 || rightChildren.length === 0) {
				if (leftChildren.length !== rightChildren.length) {
					invalid = true;
					return;
				}
				if (left.type !== 'text') {
					if (properties(left) !== properties(right)) invalid = true;
					return;
				}
				if ((left.value ?? '') === (right.value ?? '')) return;
				if (found) {
					invalid = true;
					return;
				}
				const frame = ancestors.findLast((entry) =>
					['paragraph', 'heading', 'tableCell'].includes(entry.node.type)
				);
				if (!frame) {
					invalid = true;
					return;
				}
				found = { before: left, after: right, path, parentPath: frame.path };
				return;
			}
			if (properties(left) !== properties(right) || leftChildren.length !== rightChildren.length) {
				invalid = true;
				return;
			}
			leftChildren.forEach((child, index) =>
				visit(child, rightChildren[index]!, [...path, index], [...ancestors, { node: left, path }])
			);
		};
		visit(before, after, [], []);
		return invalid ? null : found;
	}

	/** Build the exact source result for one validated container leaf edit. */
	private commitContainer(target: ContainerTarget, edit: ContainerLeaf): ScopedRestore | null {
		const sourceLeaf = nodeAtPath(target.original, edit.leafPath);
		const sourceParent = nodeAtPath(target.original, edit.parentPath);
		if (!sourceLeaf || !sourceParent || sourceLeaf.type !== 'text') return null;
		// A new bracket label can resolve against a definition outside this
		// container. Keep the whole-document semantic check for that case.
		if (/[[\]]/.test(edit.oldValue) || /[[\]]/.test(edit.newValue)) {
			if (this.bracketResolvesDefinition(edit.nextParentText)) return null;
		}
		const rawLeaf = this.source.slice(start(sourceLeaf), end(sourceLeaf));
		const patches: Patch[] = [];
		for (const change of textChanges(edit.oldValue, edit.newValue)) {
			const oldOffsets = textRange(rawLeaf, edit.oldValue, change.from, change.oldTo);
			const newOffsets = textRange(edit.nextLeafRaw, edit.newValue, change.newFrom, change.newTo);
			if (!oldOffsets || !newOffsets) return null;
			patches.push({
				start: start(sourceLeaf) + oldOffsets.from,
				end: start(sourceLeaf) + oldOffsets.to,
				value: this.lineEndings(edit.nextLeafRaw.slice(newOffsets.from, newOffsets.to))
			});
		}
		if (!patches.length) return null;
		if (
			patches.some(
				(patch) =>
					patch.start < start(sourceLeaf) || patch.end > end(sourceLeaf) || patch.start > patch.end
			)
		)
			return null;
		const sourceParentRaw = this.source.slice(start(sourceParent), end(sourceParent));
		const candidateParent = apply(
			sourceParentRaw,
			patches.map((patch) => ({
				...patch,
				start: patch.start - start(sourceParent),
				end: patch.end - start(sourceParent)
			}))
		);
		// A table cell source and serializer form can differ in the padding
		// around the delimiter pipes. Compare the inline meaning, not the padding.
		const compare = (value: string) =>
			sourceParent.type === 'tableCell' ? cellContent(value) : value;
		try {
			if (
				!equal(
					this.parse(this.normalize(compare(candidateParent))),
					this.parse(this.normalize(compare(edit.nextParentText)))
				)
			)
				return null;
		} catch {
			return null;
		}
		const sourceDelta = patches.reduce(
			(total, patch) => total + patch.value.length - (patch.end - patch.start),
			0
		);
		const candidateBlock = apply(
			this.source.slice(target.sourceFrom, target.sourceTo),
			patches.map((patch) => ({
				...patch,
				start: patch.start - target.sourceFrom,
				end: patch.end - target.sourceFrom
			}))
		);
		const sourceBlock = this.cloneChangedBlock(
			target.original,
			sourceLeaf,
			edit.newValue,
			start(sourceLeaf) + rawLeaf.length + sourceDelta,
			sourceDelta,
			target.sourceFrom
		);
		const sourceIndex = this.originalIndex(target.original);
		if (sourceIndex < 0) return null;
		const result =
			this.source.slice(0, target.sourceFrom) + candidateBlock + this.source.slice(target.sourceTo);
		recordEditorCounter('sourceFidelityScopedHint');
		recordEditorCounter('sourceFidelityScopedContainer');
		return {
			result,
			blockIndex: target.from,
			blockCount: 1,
			sourceIndex,
			sourceCount: 1,
			markdownStart: target.blockStart,
			sourceStart: target.sourceFrom,
			markdownDelta: target.delta,
			sourceDelta: result.length - this.source.length,
			markdownNodes: [edit.markdownBlock],
			sourceNodes: [sourceBlock],
			previousFrom: target.sourceFrom,
			previousTo: target.sourceTo,
			nextFrom: target.sourceFrom,
			nextTo: target.sourceFrom + candidateBlock.length
		};
	}

	/** Decode the escapes and entities of one plain text leaf. */
	private decodeText(raw: string): string {
		let value = '';
		let decoder: HTMLTextAreaElement | undefined;
		for (const unit of raw.matchAll(
			/\\[!-/:-@[-`{-~]|&(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);|\r\n|[\s\S]/gi
		)) {
			let text = unit[0];
			if (text.startsWith('\\') && text.length === 2) text = text.slice(1);
			else if (text === '\r\n') text = '\n';
			else if (text.startsWith('&') && text.endsWith(';') && typeof document !== 'undefined') {
				decoder ??= document.createElement('textarea');
				decoder.innerHTML = text;
				text = decoder.value;
			}
			value += text;
		}
		return value;
	}

	/**
	 * Copy one changed container with its new leaf value and positions. Nodes
	 * after the changed leaf move by `totalDelta`; an ancestor keeps its start
	 * and moves its end. The result is relative to `base`.
	 */
	private cloneChangedBlock(
		block: MarkdownNode,
		leaf: MarkdownNode,
		value: string,
		newLeafEnd: number,
		totalDelta: number,
		base: number
	): MarkdownNode {
		const leafStart = start(leaf);
		const leafEnd = end(leaf);
		const clone = (node: MarkdownNode): MarkdownNode => {
			const nodeStart = node.position?.start.offset;
			const nodeEnd = node.position?.end.offset;
			const position =
				node.position && nodeStart !== undefined && nodeEnd !== undefined
					? { start: { offset: nodeStart - base }, end: { offset: nodeEnd - base } }
					: undefined;
			const copy: MarkdownNode = {
				...node,
				...(position ? { position } : {}),
				...(node.children ? { children: node.children.map(clone) } : {})
			};
			if (!position || nodeStart === undefined || nodeEnd === undefined) return copy;
			if (node === leaf) {
				copy.value = value;
				position.start.offset = leafStart - base;
				position.end.offset = newLeafEnd - base;
			} else if (nodeStart >= leafEnd) {
				position.start.offset = nodeStart - base + totalDelta;
				position.end.offset = nodeEnd - base + totalDelta;
			} else if (nodeEnd >= leafEnd) {
				position.end.offset = nodeEnd - base + totalDelta;
			}
			return copy;
		};
		return clone(block);
	}

	/**
	 * Replace several plain blocks at once, for example a paragraph split or a
	 * join. Every replaced block must keep source bytes that equal its text, so
	 * the serialized replacement loses no original syntax.
	 */
	private restoreReplacedBlocks(
		markdown: string,
		hint: SourceFidelityHint,
		before: MarkdownNode[],
		originals: MarkdownNode[]
	): ScopedRestore | null {
		if (hint.previousTo <= hint.previousFrom) return null;
		if (hint.nextFrom !== hint.previousFrom) return null;
		const from = this.findBlockStart(before, hint.previousFrom);
		if (from >= before.length || start(before[from]!) !== hint.previousFrom) return null;
		let oldEnd = from;
		while (oldEnd < before.length && end(before[oldEnd]!) <= hint.previousTo) oldEnd += 1;
		if (oldEnd === from || end(before[oldEnd - 1]!) !== hint.previousTo) return null;
		const delta = markdown.length - this.markdown.length;
		if (hint.nextFrom + (hint.previousTo - hint.previousFrom) + delta !== hint.nextTo) return null;
		const nextText = markdown.slice(hint.nextFrom, hint.nextTo);
		const after = (this.parse(nextText).children ?? []).filter(
			(node) => node.type !== 'definition'
		);
		if (after.length === 0) return null;
		const trimmed = nextText.replace(/\s+$/, '');
		if (start(after[0]!) !== 0 || end(after[after.length - 1]!) !== trimmed.length) return null;
		let plain = true;
		for (let index = from; index < oldEnd; index += 1) {
			const block = before[index]!;
			const original = originals[index]!;
			const value = this.plainText(block);
			const sourceValue = original ? this.plainText(original) : null;
			if (value === null || sourceValue === null || sourceValue !== value) {
				plain = false;
				break;
			}
			if (this.source.slice(start(original!), end(original!)) !== sourceValue) {
				plain = false;
				break;
			}
		}
		const sourceIndex = this.originalIndex(originals[from]!);
		if (sourceIndex < 0) return null;
		for (let offset = 0; offset < oldEnd - from; offset += 1)
			if ((this.original.children ?? [])[sourceIndex + offset]?.type === 'definition') return null;
		const sourceFrom = start(originals[from]!);
		const sourceTo = end(originals[oldEnd - 1]!);
		// A trailing separator belongs to the gap after the replaced blocks. The
		// editor moves link definitions, so their exact source position is
		// ambiguous. Keep the whole-document route for that case.
		if (/\n\s*$/.test(nextText)) {
			const gapEnd = oldEnd < originals.length ? start(originals[oldEnd]!) : this.source.length;
			if (this.definitionBetween(sourceTo, gapEnd)) return null;
		}
		if (!plain) {
			// A paragraph with inline marks can split into two blocks. Keep the
			// original syntax of both halves and insert only the paragraph break.
			const mixed = this.restoreMixedSplit(
				markdown,
				nextText,
				trimmed,
				after,
				from,
				oldEnd,
				before,
				originals,
				hint,
				sourceIndex,
				sourceFrom,
				sourceTo
			);
			return mixed;
		}
		const inserted = this.lineEndings(nextText);
		const result = this.source.slice(0, sourceFrom) + inserted + this.source.slice(sourceTo);
		const sourceNodes = (this.parse(nextText).children ?? []).filter(
			(node) => node.type !== 'definition'
		);
		if (sourceNodes.length === 0) return null;
		recordEditorCounter('sourceFidelityScopedHint');
		return {
			result,
			blockIndex: from,
			blockCount: oldEnd - from,
			sourceIndex,
			sourceCount: oldEnd - from,
			markdownStart: hint.nextFrom,
			sourceStart: sourceFrom,
			markdownDelta: delta,
			sourceDelta: result.length - this.source.length,
			markdownNodes: after,
			sourceNodes,
			previousFrom: sourceFrom,
			previousTo: sourceTo,
			nextFrom: sourceFrom,
			nextTo: sourceFrom + inserted.length
		};
	}

	/** Decoded inline text length of one source or baseline node. */
	private textLength(node: MarkdownNode): number {
		if (node.type === 'text' || node.type === 'inlineCode')
			return (node.value ?? '').replaceAll('\r\n', '\n').length;
		let length = 0;
		for (const child of node.children ?? []) length += this.textLength(child);
		return length;
	}

	/**
	 * Decoded length of a Markdown prefix. The prefix can hold escapes, entities
	 * and line endings, so its byte count is not its text count.
	 */
	private decodedLength(raw: string, code: boolean): number {
		const pattern = code
			? /\r\n|[\s\S]/g
			: /\\[!-/:-@[-`{-~]|&(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);|\r\n|[\s\S]/gi;
		let length = 0;
		let decoder: HTMLTextAreaElement | undefined;
		for (const unit of raw.matchAll(pattern)) {
			let text = unit[0];
			if (!code && text.startsWith('\\') && text.length === 2) text = text.slice(1);
			else if (text === '\r\n') text = '\n';
			else if (
				!code &&
				text.startsWith('&') &&
				text.endsWith(';') &&
				typeof document !== 'undefined'
			) {
				decoder ??= document.createElement('textarea');
				decoder.innerHTML = text;
				text = decoder.value;
			}
			length += text.length;
		}
		return length;
	}

	/** Decoded text offset for a Markdown offset inside one block. */
	private decodedOffsetForMarkdown(node: MarkdownNode, offset: number): number | null {
		const base = start(node);
		let cumulative = 0;
		for (const child of node.children ?? []) {
			const childStart = start(child) - base;
			const childEnd = end(child) - base;
			if (offset <= childStart) return cumulative;
			if (offset >= childEnd) {
				cumulative += this.textLength(child);
				continue;
			}
			if (child.type === 'text' || child.type === 'inlineCode') {
				const raw = this.markdown.slice(start(child), start(child) + (offset - childStart));
				return cumulative + this.decodedLength(raw, child.type === 'inlineCode');
			}
			const nested = this.decodedOffsetForMarkdown(child, offset - childStart);
			return nested === null ? null : cumulative + nested;
		}
		return offset === end(node) - base ? cumulative : null;
	}

	/**
	 * Raw source offset for one decoded text offset inside a source node. The
	 * mapping walks the inline children in order. Escapes, entities and code
	 * markers stay inside the mapped child, so the offset never assumes that
	 * raw bytes equal decoded bytes.
	 */
	private sourceOffsetForText(node: MarkdownNode, offset: number): number | null {
		let remaining = offset;
		for (const child of node.children ?? []) {
			if (remaining === 0) return start(child);
			const length = this.textLength(child);
			if (remaining <= length) {
				if (child.type === 'text' || child.type === 'inlineCode') {
					const value = (child.value ?? '').replaceAll('\r\n', '\n');
					const raw = this.source.slice(start(child), end(child));
					const mapped = textRange(raw, value, remaining, remaining, child.type === 'inlineCode');
					return mapped ? start(child) + mapped.from : null;
				}
				return this.sourceOffsetForText(child, remaining);
			}
			remaining -= length;
		}
		return remaining === 0 ? end(node) : null;
	}

	/**
	 * Split one block with inline marks into several blocks. The serializer
	 * inserts a paragraph break and leaves the inline text unchanged, so the
	 * accepted bytes are the original block with that break at the matching
	 * source offset. The bounded semantic check stays in place, and any other
	 * change keeps the whole-document route.
	 */
	private restoreMixedSplit(
		markdown: string,
		nextText: string,
		trimmed: string,
		after: MarkdownNode[],
		from: number,
		oldEnd: number,
		before: MarkdownNode[],
		originals: MarkdownNode[],
		hint: SourceFidelityHint,
		sourceIndex: number,
		sourceFrom: number,
		sourceTo: number
	): ScopedRestore | null {
		if (oldEnd - from !== 1 || after.length < 2) return null;
		const block = before[from]!;
		const original = originals[from]!;
		if (!block.position || !original.position) return null;
		if (block.type !== 'paragraph' && block.type !== 'heading') return null;
		if (original.type !== block.type || !equal(block, original)) return null;
		const oldText = this.markdown.slice(start(block), end(block));
		const range = changeRange(oldText, nextText);
		// Only one insertion at one point is a local split. A replaced selection
		// or changed spelling keeps the whole-document semantic route.
		if (range.oldTo !== range.from || range.newTo === range.from) return null;
		const inserted = nextText.slice(range.from, range.newTo);
		const oldRaw = this.source.slice(sourceFrom, sourceTo);
		// Stay inside one bounded block. A large insert or a large container
		// keeps the whole-document route as the documented fallback.
		if (oldRaw.length > BOUNDED_BLOCK_CHARS || inserted.length > BOUNDED_BLOCK_CHARS) return null;
		// Reference brackets can resolve against definitions outside this block.
		if (/[[\]]/.test(oldRaw)) {
			const tree = this.parse(oldRaw);
			const node = tree.children?.[0];
			if (tree.children?.length !== 1 || !node || !equal(node, original)) return null;
		}
		if (/[[\]]/.test(trimmed) && this.bracketResolvesDefinition(trimmed)) return null;
		// The break offset is in baseline Markdown coordinates. Map it to a
		// decoded offset in the same block, then to the original source bytes.
		const decodedOffset = this.decodedOffsetForMarkdown(block, range.from);
		if (decodedOffset === null) return null;
		const rawOffset = this.sourceOffsetForText(original, decodedOffset);
		if (rawOffset === null || rawOffset < sourceFrom || rawOffset > sourceTo) return null;
		const candidate =
			this.source.slice(sourceFrom, rawOffset) +
			this.lineEndings(inserted) +
			this.source.slice(rawOffset, sourceTo);
		let target: MarkdownNode;
		let actual: MarkdownNode;
		try {
			target = this.parse(this.normalize(trimmed));
			actual = this.parse(this.normalize(candidate));
		} catch {
			return null;
		}
		if (!equal(actual, target)) return null;
		const sourceNodes = (this.parse(candidate).children ?? []).filter(
			(node) => node.type !== 'definition'
		);
		if (sourceNodes.length !== after.length) return null;
		for (let index = 0; index < after.length; index += 1)
			if (sourceNodes[index]!.type !== after[index]!.type) return null;
		if (
			start(sourceNodes[0]!) !== 0 ||
			end(sourceNodes[sourceNodes.length - 1]!) !== candidate.length
		)
			return null;
		const result = this.source.slice(0, sourceFrom) + candidate + this.source.slice(sourceTo);
		recordEditorCounter('sourceFidelityScopedHint');
		return {
			result,
			blockIndex: from,
			blockCount: 1,
			sourceIndex,
			sourceCount: 1,
			markdownStart: hint.nextFrom,
			sourceStart: sourceFrom,
			markdownDelta: markdown.length - this.markdown.length,
			sourceDelta: result.length - this.source.length,
			markdownNodes: after,
			sourceNodes,
			previousFrom: sourceFrom,
			previousTo: sourceTo,
			nextFrom: sourceFrom,
			nextTo: sourceFrom + candidate.length
		};
	}

	/**
	 * Insert complete plain blocks at one block boundary. The new bytes are the
	 * serialized form, so they need no source restoration. Existing source bytes
	 * and separators stay untouched.
	 */
	private restoreInsertedBlocks(
		markdown: string,
		hint: SourceFidelityHint,
		before: MarkdownNode[],
		originals: MarkdownNode[]
	): ScopedRestore | null {
		if (hint.previousTo !== hint.previousFrom) return null;
		if (hint.nextFrom !== hint.previousFrom) return null;
		const point = hint.previousFrom;
		const after = this.findBlockStart(before, point);
		const nextText = markdown.slice(hint.nextFrom, hint.nextTo);
		const tree = this.parse(nextText);
		const nodes = (tree.children ?? []).filter((node) => node.type !== 'definition');
		// An empty paragraph can reach the serializer as trailing whitespace
		// before its first character arrives. Keep the whitespace scoped too.
		const whitespaceOnly = nodes.length === 0 && nextText.length > 0 && /^[\r\n]+$/.test(nextText);
		if (nodes.length === 0 && !whitespaceOnly) return null;
		if (!whitespaceOnly) {
			const trimmed = nextText.replace(/\s+$/, '');
			if (end(nodes[nodes.length - 1]!) !== trimmed.length) return null;
		}
		let sourcePoint: number;
		if (after > 0 && end(before[after - 1]!) === point) {
			// The insertion starts exactly at the previous block end.
			if (this.originalIndex(originals[after - 1]!) < 0) return null;
			sourcePoint = end(originals[after - 1]!);
			// A definition can sit between the visual blocks. The editor moves it,
			// so the exact source position is ambiguous. Keep the whole-document
			// route for that case.
			const gapEnd = after < originals.length ? start(originals[after]!) : this.source.length;
			if (this.definitionBetween(sourcePoint, gapEnd)) return null;
		} else if (after > 0) {
			// The block owns no bytes in the accepted baseline, so it lives in the
			// whitespace gap between two blocks, or in the trailing whitespace.
			// Keep that gap and insert the new bytes at the same newline count.
			const baselineGapStart = end(before[after - 1]!);
			const baselineGapEnd = after < before.length ? start(before[after]!) : this.markdown.length;
			if (point < baselineGapStart || point > baselineGapEnd) return null;
			const baselineGap = this.markdown.slice(baselineGapStart, baselineGapEnd);
			if (!/^[\r\n]+$/.test(baselineGap)) return null;
			if (!whitespaceOnly && start(nodes[0]!) !== 0) return null;
			const newlines = (this.markdown.slice(baselineGapStart, point).match(/\n/g) ?? []).length;
			const sourceGapStart = end(originals[after - 1]!);
			const sourceGapEnd = after < originals.length ? start(originals[after]!) : this.source.length;
			const sourceGap = this.source.slice(sourceGapStart, sourceGapEnd);
			if (!/^[\r\n]+$/.test(sourceGap)) return null;
			sourcePoint = sourceGapStart;
			let seen = 0;
			for (let index = 0; index < sourceGap.length && seen < newlines; index += 1) {
				if (sourceGap[index] === '\n') {
					seen += 1;
					sourcePoint = sourceGapStart + index + 1;
				}
			}
			if (seen !== newlines) return null;
		} else if (after === 0 && point === 0) {
			sourcePoint = 0;
		} else {
			return null;
		}
		if (after < before.length && start(before[after]!) < point) return null;
		const inserted = this.lineEndings(nextText);
		const result = this.source.slice(0, sourcePoint) + inserted + this.source.slice(sourcePoint);
		const sourceNodes = whitespaceOnly
			? []
			: (this.parse(nextText).children ?? []).filter((node) => node.type !== 'definition');
		if (!whitespaceOnly && sourceNodes.length === 0) return null;
		const sourceIndex =
			after < originals.length
				? this.originalIndex(originals[after]!)
				: (this.original.children ?? []).length;
		if (sourceIndex < 0) return null;
		recordEditorCounter('sourceFidelityScopedHint');
		return {
			result,
			blockIndex: after,
			blockCount: 0,
			sourceIndex,
			sourceCount: 0,
			markdownStart: hint.nextFrom,
			sourceStart: sourcePoint,
			markdownDelta: markdown.length - this.markdown.length,
			sourceDelta: result.length - this.source.length,
			markdownNodes: nodes,
			sourceNodes,
			previousFrom: sourcePoint,
			previousTo: sourcePoint,
			nextFrom: sourcePoint,
			nextTo: sourcePoint + inserted.length
		};
	}

	private restoreSingleBlock(
		markdown: string,
		hint: SourceFidelityHint | undefined,
		before: MarkdownNode[],
		originals: MarkdownNode[]
	): ScopedRestore | null {
		let from: number;
		let hintBlock: { from: number; to: number } | null = null;
		let range: { from: number; oldTo: number; newTo: number } | null = null;
		if (hint) {
			const delta = markdown.length - this.markdown.length;
			let low = 0;
			let high = before.length;
			while (low < high) {
				const middle = (low + high) >>> 1;
				if (start(before[middle]!) < hint.previousFrom) low = middle + 1;
				else high = middle;
			}
			const candidate = before[low];
			if (
				candidate &&
				start(candidate) === hint.previousFrom &&
				end(candidate) === hint.previousTo &&
				hint.nextFrom === hint.previousFrom &&
				hint.nextTo <= markdown.length &&
				hint.nextTo - hint.nextFrom === hint.previousTo - hint.previousFrom + delta
			) {
				from = low;
				hintBlock = { from: hint.nextFrom, to: hint.nextTo };
				recordEditorCounter('sourceFidelityScopedHint');
			} else {
				from = this.findChangedBlock(markdown);
			}
		} else {
			from = this.findChangedBlock(markdown);
		}
		const block = before[from];
		if (!hintBlock) range = changeRange(this.markdown, markdown);
		if (
			!block?.position ||
			(block.type !== 'paragraph' && block.type !== 'heading') ||
			(range !== null && (range.from < start(block) || range.oldTo > end(block)))
		)
			return null;
		const original = originals[from]!;
		if (!original.position || original.type !== block.type || original.children?.length === 0)
			return null;
		const raw = this.source.slice(start(original), end(original));
		const next = hintBlock
			? markdown.slice(hintBlock.from, hintBlock.to)
			: markdown.slice(start(block), end(block) + markdown.length - this.markdown.length);
		// A bounded block keeps the semantic check. References can resolve
		// against definitions outside this paragraph, so a block with brackets
		// must parse to the same tree on its own. Newly inserted brackets could
		// create such a reference, so they keep the whole-document route.
		if (raw.length > BOUNDED_BLOCK_CHARS || next.length > BOUNDED_BLOCK_CHARS) return null;
		if (/[[\]]/.test(raw)) {
			const rawTree = this.parse(raw);
			const rawNode = rawTree.children?.[0];
			if (rawTree.children?.length !== 1 || !rawNode || !equal(rawNode, original)) return null;
		}
		const tree = this.parse(next);
		const after = tree.children?.[0];
		if (
			tree.children?.length !== 1 ||
			after?.type !== block.type ||
			start(after) !== 0 ||
			end(after) !== next.length
		)
			return null;
		// A bracket label that matches a definition in this document resolves
		// outside the block. An edit can turn literal brackets into such a
		// reference, so that text keeps the whole-document semantic check.
		if (/[[\]]/.test(next) && this.bracketResolvesDefinition(next)) return null;
		const patches: Patch[] = [];
		this.patchNode(original, block, after, next, patches);
		const candidate = apply(
			raw,
			patches.map((patch) => ({
				...patch,
				start: patch.start - start(original),
				end: patch.end - start(original)
			}))
		);
		try {
			if (!equal(this.parse(this.normalize(candidate)), this.parse(this.normalize(next))))
				return null;
		} catch {
			return null;
		}
		const sourceTree = this.parse(candidate);
		const sourceNode = sourceTree.children?.[0];
		if (
			sourceTree.children?.length !== 1 ||
			sourceNode?.type !== block.type ||
			start(sourceNode) !== 0 ||
			end(sourceNode) !== candidate.length
		)
			return null;
		const result = apply(this.source, patches);
		const sourceIndex = (this.original.children ?? []).indexOf(original);
		if (sourceIndex < 0) return null;
		return {
			result,
			blockIndex: from,
			blockCount: 1,
			sourceIndex,
			sourceCount: 1,
			markdownStart: start(block),
			sourceStart: start(original),
			markdownDelta: markdown.length - this.markdown.length,
			sourceDelta: result.length - this.source.length,
			markdownNodes: [after],
			sourceNodes: [sourceNode],
			previousFrom: start(original),
			previousTo: end(original),
			nextFrom: start(original),
			nextTo: start(original) + candidate.length
		};
	}

	/** Advance both baselines by the one bounded block span this edit replaced. */
	private acceptScoped(markdown: string, scoped: ScopedRestore): void {
		if (scoped.sourceIndex < 0) return;
		const baseline = [...(this.baseline.children ?? [])];
		const markdownNodes = scoped.markdownNodes.map((node) => shift(node, scoped.markdownStart));
		baseline.splice(scoped.blockIndex, scoped.blockCount, ...markdownNodes);
		for (let index = scoped.blockIndex + markdownNodes.length; index < baseline.length; index += 1)
			shift(baseline[index]!, scoped.markdownDelta);
		const originals = [...(this.original.children ?? [])];
		const sourceNodes = scoped.sourceNodes.map((node) => shift(node, scoped.sourceStart));
		originals.splice(scoped.sourceIndex, scoped.sourceCount, ...sourceNodes);
		for (let index = scoped.sourceIndex + sourceNodes.length; index < originals.length; index += 1)
			shift(originals[index]!, scoped.sourceDelta);
		this.baseline = { ...this.baseline, children: baseline };
		this.original = { ...this.original, children: originals };
		this.markdown = markdown;
		this.source = scoped.result;
		this.mappedOriginals = null;
	}

	/** Replace the accepted baselines after a whole-document reconciliation. */
	private acceptFull(markdown: string, result: string, next: MarkdownNode): void {
		this.baseline = next;
		this.original = result === markdown ? next : this.parse(result);
		this.markdown = markdown;
		this.source = result;
		this.mappedOriginals = null;
	}

	private restoreFull(markdown: string, commit: boolean): string {
		const next = this.parse(markdown);
		const before = this.baseline.children ?? [];
		let originals = this.mappedOriginals;
		if (!originals) {
			originals = (this.original.children ?? []).filter((node) => node.type !== 'definition');
			if (originals.length !== before.length) originals = this.alignBlocks(originals, before);
			this.mappedOriginals = originals;
		}
		const after = next.children ?? [];
		let result = markdown;
		let path: SourceFidelityPath = 'fullSerializer';
		if (originals.length === before.length) {
			const patches: Patch[] = [];
			let prefix = 0;
			while (
				prefix < before.length &&
				prefix < after.length &&
				equal(before[prefix]!, after[prefix]!)
			)
				prefix++;
			let suffix = 0;
			while (
				suffix < before.length - prefix &&
				suffix < after.length - prefix &&
				equal(before[before.length - 1 - suffix]!, after[after.length - 1 - suffix]!)
			)
				suffix++;
			const oldCount = before.length - prefix - suffix;
			const newCount = after.length - prefix - suffix;
			if (oldCount === newCount) {
				for (let index = prefix; index < before.length - suffix; index++) {
					this.patchNode(originals[index]!, before[index]!, after[index]!, markdown, patches);
				}
			} else {
				const from = oldCount
					? start(originals[prefix]!)
					: prefix < originals.length
						? start(originals[prefix]!)
						: this.source.length;
				const to = oldCount ? end(originals[prefix + oldCount - 1]!) : from;
				let value = newCount
					? markdown.slice(start(after[prefix]!), end(after[prefix + newCount - 1]!))
					: '';
				// Definitions have no visual node. Keep those inside a changed range.
				const definitions = (this.original.children ?? []).filter(
					(node) => node.type === 'definition' && start(node) >= from && end(node) <= to
				);
				for (const node of definitions) value += `\n\n${this.source.slice(start(node), end(node))}`;
				if (!oldCount && newCount && originals.length > 0)
					value = prefix < originals.length ? `${value}\n\n` : `\n\n${value}`;
				patches.push({ start: from, end: to, value: this.lineEndings(value) });
			}
			this.patchGaps(markdown, next, originals, patches);
			const candidate = apply(this.source, patches);
			// Reject a source patch if Markdown syntax changes its meaning.
			const target = this.parse(this.normalize(markdown));
			const matches = (value: string) => {
				try {
					return equal(this.parse(this.normalize(value)), target);
				} catch {
					return false;
				}
			};
			if (matches(candidate)) {
				result = candidate;
				path = 'fastPath';
			} else if (oldCount === newCount) {
				const blocks: Patch[] = [];
				for (let index = prefix; index < before.length - suffix; index++) {
					if (equal(before[index]!, after[index]!)) continue;
					blocks.push({
						start: start(originals[index]!),
						end: end(originals[index]!),
						value: this.lineEndings(markdown.slice(start(after[index]!), end(after[index]!)))
					});
				}
				this.patchGaps(markdown, next, originals, blocks);
				const fallback = apply(this.source, blocks);
				if (matches(fallback)) {
					result = fallback;
					path = 'blockFallback';
				}
			}
		}
		if (commit) {
			this.cachedMarkdown = markdown;
			this.cachedSource = result;
			this.acceptFull(markdown, result, next);
		}
		recordSourceFidelityPath(path);
		return result;
	}

	private patchGaps(
		markdown: string,
		next: MarkdownNode,
		originals: MarkdownNode[],
		owned: Patch[]
	): void {
		const patches: Patch[] = [];
		const visit = (
			original: MarkdownNode,
			before: MarkdownNode,
			after: MarkdownNode,
			children = (original.children ?? []).filter((node) => node.type !== 'definition')
		): void => {
			if (
				original.type !== before.type ||
				before.type !== after.type ||
				!['root', 'blockquote', 'listItem', 'list'].includes(before.type)
			)
				return;
			const oldChildren = before.children ?? [];
			const newChildren = after.children ?? [];
			if (children.length !== oldChildren.length) return;
			const mapped = new Map<number, number>();
			if (oldChildren.length === newChildren.length) {
				oldChildren.forEach((_, index) => mapped.set(index, index));
			} else {
				let prefix = 0;
				while (
					prefix < oldChildren.length &&
					prefix < newChildren.length &&
					equal(oldChildren[prefix]!, newChildren[prefix]!)
				) {
					mapped.set(prefix, prefix);
					prefix++;
				}
				let oldIndex = oldChildren.length - 1;
				let newIndex = newChildren.length - 1;
				while (
					oldIndex >= prefix &&
					newIndex >= prefix &&
					equal(oldChildren[oldIndex]!, newChildren[newIndex]!)
				)
					mapped.set(oldIndex--, newIndex--);
			}
			for (const [oldIndex, newIndex] of mapped)
				visit(children[oldIndex]!, oldChildren[oldIndex]!, newChildren[newIndex]!);
			// Lists route to their items. Only block containers own paragraph gaps.
			if (before.type === 'list') return;
			const root = before.type === 'root';
			for (let index = root ? 0 : 1; index <= children.length - (root ? 0 : 1); index++) {
				const left = index === 0 ? -1 : mapped.get(index - 1);
				const right = index === children.length ? newChildren.length : mapped.get(index);
				if (left === undefined || right === undefined || right !== left + 1) continue;
				const from = index === 0 ? 0 : end(children[index - 1]!);
				const to = index === children.length ? this.source.length : start(children[index]!);
				if (
					owned.some((patch) =>
						patch.start === patch.end
							? (patch.start > from && patch.start < to) ||
								(patch.start >= from && patch.start <= to && patch.value.includes('\n'))
							: patch.start < to && patch.end > from
					)
				)
					continue;
				const oldGap = this.markdown.slice(
					index === 0 ? 0 : end(oldChildren[index - 1]!),
					index === oldChildren.length ? this.markdown.length : start(oldChildren[index]!)
				);
				const newGap = markdown.slice(
					left === -1 ? 0 : end(newChildren[left]!),
					right === newChildren.length ? markdown.length : start(newChildren[right]!)
				);
				const delta = (newGap.match(/\n/g)?.length ?? 0) - (oldGap.match(/\n/g)?.length ?? 0);
				if (!delta) continue;
				const raw = this.source.slice(from, to);
				if (delta > 0) {
					const tail = raw.slice(raw.lastIndexOf('\n') + 1);
					if (!/^[\t >]*$/.test(tail)) continue;
					const at = to - tail.length;
					// The serializer adds an EOF newline that the source can omit.
					const added =
						delta +
						(root && index === children.length && !raw.includes('\n') && oldGap === '\n' ? 1 : 0);
					const value = this.lineEndings(`${tail.trimEnd()}\n`.repeat(added));
					const insertion = owned.find((patch) => patch.start === at && patch.end === at);
					if (insertion) {
						insertion.value =
							index === children.length ? insertion.value + value : value + insertion.value;
					} else patches.push({ start: at, end: at, value });
				} else {
					let remaining = -delta;
					const runs = [...raw.matchAll(/(?:^|(?<=\n))(?:[\t >]*(?:\r\n|\n))+/g)];
					for (const run of runs.reverse()) {
						if (
							(original.children ?? []).some(
								(node) =>
									node.type === 'definition' &&
									start(node) < from + run.index + run[0].length &&
									end(node) > from + run.index
							)
						)
							continue;
						const tokens = [...run[0].matchAll(/[\t >]*(?:\r\n|\n)/g)];
						const edge =
							(root && from === 0 && run.index === 0) ||
							(root && to === this.source.length && run.index + run[0].length === raw.length);
						const minimum = edge ? 0 : run.index === 0 ? 2 : 1;
						const count = Math.min(remaining, Math.max(0, tokens.length - minimum));
						if (!count) continue;
						const first = tokens[tokens.length - count]!;
						patches.push({
							start: from + run.index + first.index,
							end: from + run.index + run[0].length,
							value: ''
						});
						remaining -= count;
						if (!remaining) break;
					}
				}
			}
		};
		visit(this.original, this.baseline, next, originals);
		owned.push(...patches);
	}

	private alignBlocks(originals: MarkdownNode[], before: MarkdownNode[]): MarkdownNode[] {
		const definitions = (this.original.children ?? [])
			.filter((node) => node.type === 'definition')
			.map((node) => this.source.slice(start(node), end(node)))
			.join('\n\n');
		const mapped: MarkdownNode[] = [];
		let cursor = 0;
		for (const node of before) {
			const target = this.parse(this.normalize(this.markdown.slice(start(node), end(node))));
			let found = false;
			while (cursor < originals.length) {
				const original = originals[cursor++]!;
				const raw = this.source.slice(start(original), end(original));
				if (!equal(this.parse(this.normalize(`${raw}\n\n${definitions}`)), target)) continue;
				mapped.push(original);
				found = true;
				break;
			}
			if (!found) return [];
		}
		return mapped;
	}

	private lineEndings(value: string): string {
		return this.source.includes('\r\n') ? value.replace(/\r?\n/g, '\r\n') : value;
	}

	private patchNode(
		original: MarkdownNode,
		before: MarkdownNode,
		after: MarkdownNode,
		markdown: string,
		patches: Patch[]
	): void {
		if (equal(before, after)) return;
		const originalChildren = (original.children ?? []).filter((node) => node.type !== 'definition');
		const beforeChildren = before.children ?? [];
		const afterChildren = after.children ?? [];
		if (
			properties(before) === properties(after) &&
			originalChildren.length === beforeChildren.length &&
			beforeChildren.length > 0 &&
			originalChildren.every((node) => node.position)
		) {
			let prefix = 0;
			while (
				prefix < beforeChildren.length &&
				prefix < afterChildren.length &&
				equal(beforeChildren[prefix]!, afterChildren[prefix]!)
			)
				prefix++;
			let suffix = 0;
			while (
				suffix < beforeChildren.length - prefix &&
				suffix < afterChildren.length - prefix &&
				equal(
					beforeChildren[beforeChildren.length - 1 - suffix]!,
					afterChildren[afterChildren.length - 1 - suffix]!
				)
			)
				suffix++;
			const oldCount = beforeChildren.length - prefix - suffix;
			const newCount = afterChildren.length - prefix - suffix;
			if (oldCount === newCount) {
				for (let index = prefix; index < beforeChildren.length - suffix; index++) {
					this.patchNode(
						originalChildren[index]!,
						beforeChildren[index]!,
						afterChildren[index]!,
						markdown,
						patches
					);
				}
				return;
			}
			if (oldCount > 0 && newCount > 0) {
				patches.push({
					start: start(originalChildren[prefix]!),
					end: end(originalChildren[prefix + oldCount - 1]!),
					value: this.lineEndings(
						markdown.slice(
							start(afterChildren[prefix]!),
							end(afterChildren[prefix + newCount - 1]!)
						)
					)
				});
				return;
			}
		}
		if (
			original.type === before.type &&
			before.type === after.type &&
			['inlineCode', 'code'].includes(before.type) &&
			original.value?.replaceAll('\r\n', '\n') === before.value?.replaceAll('\r\n', '\n')
		) {
			const raw = this.source.slice(start(original), end(original));
			const oldValue = (before.value ?? '').replaceAll('\r\n', '\n');
			const newValue = (after.value ?? '').replaceAll('\r\n', '\n');
			const range = changeRange(oldValue, newValue);
			let offset = 0;
			let limit = raw.length;
			const fence =
				original.type === 'code' ? /^ {0,3}(`{3,}|~{3,})[^\r\n]*(?:\r?\n|$)/.exec(raw) : null;
			const closing = fence ? /(?:\r?\n)[> \t]*(`{3,}|~{3,})[ \t]*$/.exec(raw) : null;
			if (fence) {
				offset = fence[0].length;
				if (closing && closing[1]![0] === fence[1]![0] && closing[1]!.length >= fence[1]!.length)
					limit = Math.max(offset, closing.index);
			} else if (original.type === 'inlineCode') {
				offset = /^`+/.exec(raw)?.[0].length ?? 0;
				limit -= offset;
			}
			const content = raw.slice(offset, limit);
			const mapped = textRange(content, oldValue, range.from, range.oldTo, true);
			if (mapped) {
				let value = newValue.slice(range.from, range.newTo);
				if (fence && !content && value) {
					if (!fence[0].endsWith('\n')) value = `\n${value}`;
					if (closing) value += '\n';
				}
				patches.push({
					start: start(original) + offset + mapped.from,
					end: start(original) + offset + mapped.to,
					value: this.lineEndings(value)
				});
				return;
			}
		}
		if (
			original.type === 'text' &&
			before.type === 'text' &&
			after.type === 'text' &&
			original.value?.replaceAll('\r\n', '\n') === before.value?.replaceAll('\r\n', '\n')
		) {
			const oldValue = (before.value ?? '').replaceAll('\r\n', '\n');
			const newValue = (after.value ?? '').replaceAll('\r\n', '\n');
			const raw = this.source.slice(start(original), end(original));
			const nextRaw = markdown.slice(start(after), end(after));
			const changes: Patch[] = [];
			let mapped = true;
			for (const range of textChanges(oldValue, newValue)) {
				const oldOffsets = textRange(raw, oldValue, range.from, range.oldTo);
				const newOffsets = textRange(nextRaw, newValue, range.newFrom, range.newTo);
				if (!oldOffsets || !newOffsets) {
					mapped = false;
					break;
				}
				changes.push({
					start: start(original) + oldOffsets.from,
					end: start(original) + oldOffsets.to,
					value: this.lineEndings(nextRaw.slice(newOffsets.from, newOffsets.to))
				});
			}
			if (mapped) {
				patches.push(...changes);
				return;
			}
		}
		patches.push({
			start: start(original),
			end: end(original),
			value: this.lineEndings(markdown.slice(start(after), end(after)))
		});
	}
}

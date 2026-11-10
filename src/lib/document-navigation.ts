import { stripFrontmatter } from './frontmatter';

export interface DocumentHeading {
	text: string;
	level: number;
	line: number;
	element?: HTMLElement;
}

export interface SourceHeading extends DocumentHeading {
	/** Stable level/text/duplicate-occurrence identity for one source revision. */
	id: string;
	/** Zero-based UTF-16 offset in the raw Markdown, including BOM and CRLF. */
	offset: number;
}

export interface SourceHeadingIndex {
	readonly revision: number;
	readonly headings: readonly SourceHeading[];
}

/** Reads visible headings. The legacy 300-heading bound stays for existing callers. */
export function renderedDocumentHeadings(root: HTMLElement | null): DocumentHeading[] {
	return completeRenderedHeadings(root).slice(0, 300);
}

const renderedHeadingIndexes = new WeakMap<HTMLElement, DocumentHeading[]>();
const renderedHeadingRevisions = new WeakMap<HTMLElement, number>();
const renderedRevisions = new WeakMap<HTMLElement, number>();

/** Returns the shared content revision for one rendered root. */
export function renderedNavigationRevision(root: HTMLElement): number {
	return renderedRevisions.get(root) ?? 0;
}

function bumpRenderedRevision(root: HTMLElement): number {
	const next = (renderedRevisions.get(root) ?? 0) + 1;
	renderedRevisions.set(root, next);
	return next;
}

/** Drops the cached rendered heading projection after a DOM mutation. */
export function invalidateRenderedHeadings(root?: HTMLElement | null): void {
	if (root) {
		renderedHeadingIndexes.delete(root);
		renderedHeadingRevisions.delete(root);
	}
}

export interface RenderedNavigationChange {
	/** A heading element was added, removed or replaced. */
	headingsChanged: boolean;
	/** Text or child content changed. */
	textChanged: boolean;
	/** Headings whose own text changed. */
	changedHeadings: ReadonlySet<HTMLElement>;
}

const HEADING_SELECTOR = 'h1,h2,h3,h4,h5,h6';
type RenderedListener = (change: RenderedNavigationChange) => void;
const renderedObservers = new WeakMap<
	HTMLElement,
	{ observer: MutationObserver; listeners: Set<RenderedListener> }
>();

function isHeadingNode(node: Node): boolean {
	return (
		node.nodeType === Node.ELEMENT_NODE &&
		((node as Element).matches(HEADING_SELECTOR) ||
			(node as Element).querySelector(HEADING_SELECTOR) !== null)
	);
}

function classifyMutations(
	records: readonly MutationRecord[],
	root: HTMLElement
): RenderedNavigationChange {
	let headingsChanged = false;
	let textChanged = false;
	const changedHeadings = new Set<HTMLElement>();
	for (const record of records) {
		if (record.type === 'attributes') continue;
		const parent = record.target instanceof Element ? record.target : record.target.parentElement;
		const heading = parent?.closest<HTMLElement>(HEADING_SELECTOR);
		if (heading) {
			changedHeadings.add(heading);
			headingsChanged = true;
			textChanged = true;
			continue;
		}
		if (record.type === 'characterData') {
			textChanged = true;
			continue;
		}
		textChanged = true;
		const target = record.target instanceof Element ? record.target : null;
		if (
			[...record.addedNodes, ...record.removedNodes].some(isHeadingNode) ||
			(target &&
				(target.matches(HEADING_SELECTOR) ||
					target.closest(HEADING_SELECTOR) !== null ||
					target === root ||
					target.matches('.ProseMirror, .mdsh-preview')))
		)
			headingsChanged = true;
	}
	return { headingsChanged, textChanged, changedHeadings };
}

/**
 * Observes one rendered root for every navigation consumer. TOC, Find and
 * Outline share one MutationObserver, one classification pass and one text
 * index invalidation per mutation batch.
 */
export function watchRenderedNavigation(root: HTMLElement, listener: RenderedListener): () => void {
	let entry = renderedObservers.get(root);
	if (!entry) {
		const listeners = new Set<RenderedListener>();
		const observer = new MutationObserver((records) => {
			const change = classifyMutations(records, root);
			if (!change.textChanged && !change.headingsChanged) return;
			bumpRenderedRevision(root);
			if (change.textChanged) invalidateDocumentTextIndex(root);
			for (const current of [...listeners]) current(change);
		});
		observer.observe(root, { childList: true, subtree: true, characterData: true });
		entry = { observer, listeners };
		renderedObservers.set(root, entry);
	}
	entry.listeners.add(listener);
	return () => {
		const current = renderedObservers.get(root);
		if (!current) return;
		current.listeners.delete(listener);
		if (!current.listeners.size) {
			current.observer.disconnect();
			renderedObservers.delete(root);
		}
	};
}

/** Reads every visible heading, without the legacy outline bound. */
export function completeRenderedHeadings(root: HTMLElement | null): DocumentHeading[] {
	if (!root) return [];
	const revision = renderedNavigationRevision(root);
	const cached = renderedHeadingIndexes.get(root);
	if (cached && renderedHeadingRevisions.get(root) === revision) return cached;
	const headings = Array.from(root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')).map(
		(element) => ({
			text: element.textContent ?? '',
			level: Number(element.tagName.slice(1)),
			line: 0,
			element
		})
	);
	renderedHeadingIndexes.set(root, headings);
	renderedHeadingRevisions.set(root, revision);
	return headings;
}

/** Moves the viewport and, in Edit mode, the caret to a heading. */
export function focusDocumentHeading(heading: DocumentHeading, editable: boolean): void {
	const element = heading.element;
	if (!element) return;
	const scrollToHeading = () => element.scrollIntoView({ block: 'start', inline: 'nearest' });
	if (editable) {
		// Focus first. The editor can restore its previous selection and scroll when
		// it receives focus, so the heading scroll below must run after that restore.
		element.closest<HTMLElement>('.ProseMirror')?.focus({ preventScroll: true });
		const selection = window.getSelection();
		const range = document.createRange();
		range.selectNodeContents(element);
		range.collapse(true);
		selection?.removeAllRanges();
		selection?.addRange(range);
	}
	scrollToHeading();
	// A rendered document can replace a heading node during the same click. Repeat
	// the scroll on the next frame so a single click always reaches the heading.
	requestAnimationFrame(scrollToHeading);
}

interface ParsedHeading {
	text: string;
	level: number;
	line: number;
	offset: number;
}

interface ParseState {
	fence: string;
	yaml: boolean;
	previousLine: string;
}

interface ParseCheckpoint extends ParseState {
	/** Zero-based UTF-16 offset of the line start in the body without BOM. */
	offset: number;
	/** Zero-based line number. */
	line: number;
}

interface ScanResult {
	headings: ParsedHeading[];
	endLine: number;
	endState: ParseState;
	linesScanned: number;
	bytesScanned: number;
}

/** Checkpoint spacing bounds the work of one incremental heading repair. */
const CHECKPOINT_LINES = 64;
/** Larger edits fall back to one full parse. */
const MAX_INCREMENTAL_CHANGE = 64 * 1024;
const HEADING_INDEX_CACHE = 4;
/** Bound the retained raw sources for recent A and B document switches. */
const HEADING_INDEX_BYTES = 24 * 1024 * 1024;

interface HeadingScanStats {
	fullParses: number;
	incrementalParses: number;
	linesScanned: number;
	bytesScanned: number;
	diffBytesCompared: number;
	cacheEntries: number;
	cachedCharacters: number;
}

const scanStats = {
	fullParses: 0,
	incrementalParses: 0,
	linesScanned: 0,
	bytesScanned: 0,
	diffBytesCompared: 0
};

/** Returns the internal parse work counters. Used by the retained scan test. */
export function navigationScanStats(): HeadingScanStats {
	return {
		...scanStats,
		cacheEntries: headingIndexes.size,
		cachedCharacters: cachedCharacters
	};
}

/** Resets the work counters without changing cached indexes. */
export function resetNavigationScanStats(): void {
	scanStats.fullParses = 0;
	scanStats.incrementalParses = 0;
	scanStats.linesScanned = 0;
	scanStats.bytesScanned = 0;
	scanStats.diffBytesCompared = 0;
}

/**
 * Scans whole lines from a checkpoint. A non-zero start offset resumes the
 * fence, YAML and setext state captured at that line. The first resumed line
 * never opens a setext heading because its previous line stays outside the
 * repaired range.
 */
function scanHeadings(
	body: string,
	hasBom: boolean,
	start: ParseCheckpoint,
	endOffset: number,
	limit: number,
	checkpoints: ParseCheckpoint[] | null
): ScanResult {
	let lineStart = start.offset;
	let index = start.line;
	let fence = start.fence;
	let yaml = start.yaml;
	let previousLine = start.previousLine;
	let firstLine = true;
	const headings: ParsedHeading[] = [];
	let linesScanned = 0;
	let bytesScanned = 0;
	const stop = Math.max(0, Math.min(body.length, endOffset));
	if (checkpoints) checkpoints.push({ ...start });
	while (lineStart <= body.length && lineStart < stop) {
		const newline = body.indexOf('\n', lineStart);
		const hasNewline = newline >= 0;
		const lineEnd = hasNewline ? newline : body.length;
		const line = body.slice(lineStart, lineEnd);
		linesScanned++;
		bytesScanned += lineEnd - lineStart + (hasNewline ? 1 : 0);
		if (yaml) {
			if (index > 0 && /^(---|\.\.\.)\s*$/.test(line)) yaml = false;
			previousLine = line;
			firstLine = false;
			lineStart = lineEnd + 1;
			index++;
			if (checkpoints && index % CHECKPOINT_LINES === 0)
				checkpoints.push({ offset: lineStart, line: index, fence, yaml, previousLine });
			continue;
		}
		const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
		if (fence) {
			if (
				marker &&
				marker[0] === fence[0] &&
				marker.length >= fence.length &&
				line.trim() === marker
			)
				fence = '';
			previousLine = line;
			firstLine = false;
			lineStart = lineEnd + 1;
			index++;
			if (checkpoints && index % CHECKPOINT_LINES === 0)
				checkpoints.push({ offset: lineStart, line: index, fence, yaml, previousLine });
			continue;
		}
		if (marker) {
			fence = marker;
			previousLine = line;
			firstLine = false;
			lineStart = lineEnd + 1;
			index++;
			if (checkpoints && index % CHECKPOINT_LINES === 0)
				checkpoints.push({ offset: lineStart, line: index, fence, yaml, previousLine });
			continue;
		}
		const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*?)|[ \t]*)\r?$/.exec(line);
		if (atx)
			headings.push({
				text: (atx[2] ?? '').replace(/[ \t]+#+[ \t]*$/, ''),
				level: atx[1]!.length,
				line: index + 1,
				offset: lineStart + (hasBom ? 1 : 0)
			});
		else if (
			index > 0 &&
			!firstLine &&
			/^ {0,3}(=+|-+)\s*$/.test(line) &&
			previousLine.trim() &&
			!/^(?: {4}|\t|\s*[#>\-*])/.test(previousLine)
		) {
			headings.push({
				text: previousLine.trim(),
				level: line.trim().startsWith('=') ? 1 : 2,
				line: index,
				offset: lineStart - (previousLine.length + 1) + (hasBom ? 1 : 0)
			});
		}
		if (headings.length >= limit) break;
		previousLine = line;
		if (!hasNewline) break;
		lineStart = lineEnd + 1;
		index++;
		firstLine = false;
		if (checkpoints && index % CHECKPOINT_LINES === 0)
			checkpoints.push({ offset: lineStart, line: index, fence, yaml, previousLine });
	}
	return {
		headings,
		endLine: index,
		endState: { fence, yaml, previousLine },
		linesScanned,
		bytesScanned
	};
}

function parseHeadings(markdown: string, limit: number): ParsedHeading[] {
	const hasBom = markdown.charCodeAt(0) === 0xfeff;
	const body = hasBom ? markdown.slice(1) : markdown;
	const start: ParseCheckpoint = {
		offset: 0,
		line: 0,
		fence: '',
		yaml: stripFrontmatter(body).raw.length > 0,
		previousLine: ''
	};
	return scanHeadings(body, hasBom, start, body.length, limit, null).headings;
}

export { HeadingIdAllocator } from './wiki-links';

/** Reads source headings without treating YAML or code examples as headings. */
export function documentHeadings(markdown: string): DocumentHeading[] {
	return parseHeadings(markdown, 300).map(({ text, level, line }) => ({ text, level, line }));
}

let revision = 0;
interface CachedHeadingIndex extends SourceHeadingIndex {
	readonly text: string;
	readonly body: string;
	readonly hasBom: boolean;
	readonly checkpoints: readonly ParseCheckpoint[];
}
const headingIndexes = new Map<string, CachedHeadingIndex>();
let lastIndex: CachedHeadingIndex | null = null;
let cachedCharacters = 0;

function allocateHeadingIds(headings: readonly ParsedHeading[]): SourceHeading[] {
	const occurrences = new Map<string, number>();
	return headings.map((heading) => {
		const key = `${heading.level}\u0000${heading.text}`;
		const occurrence = (occurrences.get(key) ?? 0) + 1;
		occurrences.set(key, occurrence);
		return {
			...heading,
			id: `${heading.level}:${heading.text}:${occurrence}`
		};
	});
}

function cacheHeadingIndex(index: CachedHeadingIndex): void {
	const previous = headingIndexes.get(index.text);
	if (previous) {
		headingIndexes.delete(index.text);
		cachedCharacters -= previous.text.length;
	}
	headingIndexes.set(index.text, index);
	cachedCharacters += index.text.length;
	lastIndex = index;
	while (
		headingIndexes.size > HEADING_INDEX_CACHE ||
		(headingIndexes.size > 2 && cachedCharacters > HEADING_INDEX_BYTES)
	) {
		const oldestKey = headingIndexes.keys().next().value!;
		const oldest = headingIndexes.get(oldestKey)!;
		headingIndexes.delete(oldestKey);
		cachedCharacters -= oldest.text.length;
		if (lastIndex === oldest) lastIndex = null;
	}
}

function fullHeadingIndex(markdown: string): CachedHeadingIndex {
	const hasBom = markdown.charCodeAt(0) === 0xfeff;
	const body = hasBom ? markdown.slice(1) : markdown;
	const checkpoints: ParseCheckpoint[] = [];
	const start: ParseCheckpoint = {
		offset: 0,
		line: 0,
		fence: '',
		yaml: stripFrontmatter(body).raw.length > 0,
		previousLine: ''
	};
	const result = scanHeadings(
		body,
		hasBom,
		start,
		body.length,
		Number.POSITIVE_INFINITY,
		checkpoints
	);
	scanStats.fullParses++;
	scanStats.linesScanned += result.linesScanned;
	scanStats.bytesScanned += result.bytesScanned;
	return {
		revision: ++revision,
		headings: allocateHeadingIds(result.headings),
		text: markdown,
		body,
		hasBom,
		checkpoints
	};
}

/** Returns the last checkpoint at or before an offset. */
function checkpointAt(
	checkpoints: readonly ParseCheckpoint[],
	offset: number
): ParseCheckpoint | null {
	let low = 0;
	let high = checkpoints.length - 1;
	let result: ParseCheckpoint | null = null;
	while (low <= high) {
		const middle = (low + high) >> 1;
		const checkpoint = checkpoints[middle]!;
		if (checkpoint.offset <= offset) {
			result = checkpoint;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	return result;
}

/** Returns the first checkpoint at or after an offset. */
function checkpointFrom(
	checkpoints: readonly ParseCheckpoint[],
	offset: number
): ParseCheckpoint | null {
	let low = 0;
	let high = checkpoints.length - 1;
	let result: ParseCheckpoint | null = null;
	while (low <= high) {
		const middle = (low + high) >> 1;
		const checkpoint = checkpoints[middle]!;
		if (checkpoint.offset >= offset) {
			result = checkpoint;
			high = middle - 1;
		} else {
			low = middle + 1;
		}
	}
	return result;
}

/**
 * Repairs a heading index from the common prefix and suffix of an ordinary
 * edit. Only the affected checkpoint window is parsed. A fence or YAML state
 * change, a large edit, or a missing checkpoint falls back to a full parse.
 */
function repairHeadingIndex(previous: CachedHeadingIndex, next: string): CachedHeadingIndex | null {
	if (previous.text === next) return previous;
	const hasBom = next.charCodeAt(0) === 0xfeff;
	if (hasBom !== previous.hasBom) return null;
	const oldText = previous.text;
	const minimum = Math.min(oldText.length, next.length);
	let prefix = 0;
	while (prefix < minimum && oldText.charCodeAt(prefix) === next.charCodeAt(prefix)) prefix++;
	const maximumSuffix = minimum - prefix;
	let suffix = 0;
	while (
		suffix < maximumSuffix &&
		oldText.charCodeAt(oldText.length - 1 - suffix) === next.charCodeAt(next.length - 1 - suffix)
	)
		suffix++;
	scanStats.diffBytesCompared += prefix + suffix;
	if (oldText.length + next.length - 2 * (prefix + suffix) > MAX_INCREMENTAL_CHANGE) return null;
	const bomOffset = previous.hasBom ? 1 : 0;
	if (prefix < bomOffset) return null;
	const oldChangeStart = prefix - bomOffset;
	const oldBody = previous.body;
	const newBody = hasBom ? next.slice(1) : next;
	const oldChangeEnd = oldBody.length - suffix;
	if (oldChangeEnd < oldChangeStart) return null;
	const changeLineStart =
		oldChangeStart === 0 ? 0 : oldBody.lastIndexOf('\n', oldChangeStart - 1) + 1;
	const previousLineStart =
		changeLineStart === 0 ? 0 : oldBody.lastIndexOf('\n', changeLineStart - 2) + 1;
	const start = checkpointAt(previous.checkpoints, previousLineStart);
	if (!start) return null;
	const resumed =
		start.line === 0
			? {
					...start,
					fence: '',
					yaml: stripFrontmatter(newBody).raw.length > 0,
					previousLine: ''
				}
			: start;
	const endCheckpoint = checkpointFrom(previous.checkpoints, oldChangeEnd);
	const delta = newBody.length - oldBody.length;
	const oldEndOffset = endCheckpoint ? endCheckpoint.offset : oldBody.length;
	const newEndOffset = endCheckpoint
		? Math.min(newBody.length, oldEndOffset + delta)
		: newBody.length;
	const checkpoints: ParseCheckpoint[] = [];
	const repaired = scanHeadings(
		newBody,
		hasBom,
		resumed,
		newEndOffset,
		Number.POSITIVE_INFINITY,
		checkpoints
	);
	// A fence or frontmatter boundary can extend beyond the repaired window.
	// The stored state at the end checkpoint must still match.
	if (
		endCheckpoint &&
		(repaired.endState.fence !== endCheckpoint.fence ||
			repaired.endState.yaml !== endCheckpoint.yaml)
	)
		return null;
	const lineDelta = endCheckpoint ? repaired.endLine - endCheckpoint.line : 0;
	const headings: ParsedHeading[] = previous.headings
		.filter((heading) => heading.offset < start.offset)
		.map(({ text, level, line, offset }) => ({ text, level, line, offset }));
	for (const heading of repaired.headings) headings.push(heading);
	if (endCheckpoint) {
		for (const heading of previous.headings) {
			if (heading.offset < oldEndOffset) continue;
			headings.push({
				text: heading.text,
				level: heading.level,
				line: heading.line + lineDelta,
				offset: heading.offset + delta
			});
		}
	}
	const mergedCheckpoints: ParseCheckpoint[] = previous.checkpoints
		.filter((checkpoint) => checkpoint.offset < start.offset)
		.map((checkpoint) => ({ ...checkpoint }));
	for (const checkpoint of checkpoints) mergedCheckpoints.push(checkpoint);
	if (endCheckpoint) {
		for (const checkpoint of previous.checkpoints) {
			if (checkpoint.offset < oldEndOffset) continue;
			mergedCheckpoints.push({
				...checkpoint,
				offset: checkpoint.offset + delta,
				line: checkpoint.line + lineDelta
			});
		}
	}
	scanStats.incrementalParses++;
	scanStats.linesScanned += repaired.linesScanned;
	scanStats.bytesScanned += repaired.bytesScanned;
	return {
		revision: ++revision,
		headings: allocateHeadingIds(headings),
		text: next,
		body: newBody,
		hasBom,
		checkpoints: mergedCheckpoints
	};
}

/** Clears retained heading indexes. Tests use this to build a full oracle. */
export function resetSourceHeadingIndexCache(): void {
	headingIndexes.clear();
	lastIndex = null;
	cachedCharacters = 0;
}

/**
 * Returns the complete immutable heading index for an exact source string.
 * A small LRU keeps recent A/B document switches warm. When the last source is
 * an ordinary edit, only the changed checkpoint window is parsed again.
 */
export function sourceHeadingIndex(markdown: string): SourceHeadingIndex {
	const cached = headingIndexes.get(markdown);
	if (cached) {
		headingIndexes.delete(markdown);
		headingIndexes.set(markdown, cached);
		lastIndex = cached;
		return cached;
	}
	const repaired = lastIndex ? repairHeadingIndex(lastIndex, markdown) : null;
	const index = repaired ?? fullHeadingIndex(markdown);
	cacheHeadingIndex(index);
	return index;
}

/** Returns the index of the last heading at or before a one-based source line. */
export function headingIndexForLine(headings: readonly DocumentHeading[], line: number): number {
	let low = 0;
	let high = headings.length - 1;
	let result = -1;
	while (low <= high) {
		const middle = (low + high) >> 1;
		if (headings[middle]!.line <= line) {
			result = middle;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	return result;
}

interface TextPart {
	node: Text;
	start: number;
	end: number;
}

interface TextIndex {
	text: string;
	parts: TextPart[];
}

const textIndexes = new WeakMap<HTMLElement, TextIndex>();

/**
 * Drops the cached text-node map for one rendered root, or for every root when
 * no root is given. The navigation observer calls this after a DOM mutation.
 */
export function invalidateDocumentTextIndex(root?: HTMLElement | null): void {
	if (root) textIndexes.delete(root);
}

function buildTextIndex(root: HTMLElement): TextIndex {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const parts: TextPart[] = [];
	let text = '';
	let block: Element | null = null;
	let node: Node | null;
	while ((node = walker.nextNode())) {
		const parent = node.parentElement;
		if (!parent || parent.closest('[aria-hidden="true"], .katex-mathml, .mdsh-anchor')) continue;
		const nextBlock = parent.closest('p,pre,li,h1,h2,h3,h4,h5,h6,td,th,blockquote');
		if (parts.length && nextBlock !== block) text += '\n';
		block = nextBlock;
		const start = text.length;
		text += node.textContent ?? '';
		parts.push({ node: node as Text, start, end: text.length });
	}
	const index = { text, parts };
	textIndexes.set(root, index);
	return index;
}

/** Binary search for the text node that contains a match boundary. */
function partAt(parts: readonly TextPart[], offset: number, end: boolean): TextPart | undefined {
	let low = 0;
	let high = parts.length - 1;
	while (low <= high) {
		const middle = (low + high) >> 1;
		const part = parts[middle]!;
		const inside = end
			? part.start < offset && part.end >= offset
			: part.start <= offset && part.end > offset;
		if (inside) return part;
		if (part.end <= offset) low = middle + 1;
		else high = middle - 1;
	}
	return undefined;
}

/** Builds ranges without changing the editor DOM or its Markdown. */
export function documentMatches(root: HTMLElement, query: string): Range[] {
	if (!query.trim()) return [];
	const { text, parts } = textIndexes.get(root) ?? buildTextIndex(root);
	const ranges: Range[] = [];
	const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	for (const match of text.matchAll(new RegExp(escaped, 'giu'))) {
		const from = partAt(parts, match.index, false);
		const end = match.index + match[0].length;
		const to = partAt(parts, end, true);
		if (!from || !to) continue;
		const range = document.createRange();
		range.setStart(from.node, match.index - from.start);
		range.setEnd(to.node, end - to.start);
		ranges.push(range);
		if (ranges.length === 200) break;
	}
	return ranges;
}

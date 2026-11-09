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

/** Drops the cached rendered heading projection after a DOM mutation. */
export function invalidateRenderedHeadings(root?: HTMLElement | null): void {
	if (root) renderedHeadingIndexes.delete(root);
}

/** Reads every visible heading, without the legacy outline bound. */
export function completeRenderedHeadings(root: HTMLElement | null): DocumentHeading[] {
	if (!root) return [];
	const cached = renderedHeadingIndexes.get(root);
	if (cached) return cached;
	const headings = Array.from(root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')).map(
		(element) => ({
			text: element.textContent ?? '',
			level: Number(element.tagName.slice(1)),
			line: 0,
			element
		})
	);
	renderedHeadingIndexes.set(root, headings);
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

function parseHeadings(markdown: string, limit: number): ParsedHeading[] {
	const hasBom = markdown.charCodeAt(0) === 0xfeff;
	const body = hasBom ? markdown.slice(1) : markdown;
	const headings: ParsedHeading[] = [];
	let fence = '';
	let yaml = stripFrontmatter(body).raw.length > 0;
	let lineStart = 0;
	let index = 0;
	let previousLine = '';
	while (lineStart <= body.length) {
		const newline = body.indexOf('\n', lineStart);
		const hasNewline = newline >= 0;
		const lineEnd = hasNewline ? newline : body.length;
		const line = body.slice(lineStart, lineEnd);
		if (yaml) {
			if (index > 0 && /^(---|\.\.\.)\s*$/.test(line)) yaml = false;
			previousLine = line;
			lineStart = lineEnd + 1;
			index++;
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
			lineStart = lineEnd + 1;
			index++;
			continue;
		}
		if (marker) {
			fence = marker;
			previousLine = line;
			lineStart = lineEnd + 1;
			index++;
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
	}
	return headings;
}

export { HeadingIdAllocator } from './wiki-links';

/** Reads source headings without treating YAML or code examples as headings. */
export function documentHeadings(markdown: string): DocumentHeading[] {
	return parseHeadings(markdown, 300).map(({ text, level, line }) => ({ text, level, line }));
}

let revision = 0;
const headingIndexes = new Map<string, SourceHeadingIndex>();
const HEADING_INDEX_CACHE = 4;

/**
 * Returns the complete immutable heading index for an exact source string.
 * A small LRU keeps recent A/B document switches warm while bounding memory.
 */
export function sourceHeadingIndex(markdown: string): SourceHeadingIndex {
	const cached = headingIndexes.get(markdown);
	if (cached) {
		headingIndexes.delete(markdown);
		headingIndexes.set(markdown, cached);
		return cached;
	}
	const occurrences = new Map<string, number>();
	const headings = parseHeadings(markdown, Number.POSITIVE_INFINITY).map((heading) => {
		const key = `${heading.level}\u0000${heading.text}`;
		const occurrence = (occurrences.get(key) ?? 0) + 1;
		occurrences.set(key, occurrence);
		return {
			...heading,
			id: `${heading.level}:${heading.text}:${occurrence}`
		};
	});
	const index = { revision: ++revision, headings };
	headingIndexes.set(markdown, index);
	while (headingIndexes.size > HEADING_INDEX_CACHE)
		headingIndexes.delete(headingIndexes.keys().next().value!);
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

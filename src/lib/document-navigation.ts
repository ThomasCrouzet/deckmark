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

/** Reads every visible heading, without the legacy outline bound. */
export function completeRenderedHeadings(root: HTMLElement | null): DocumentHeading[] {
	return Array.from(root?.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6') ?? []).map(
		(element) => ({
			text: element.textContent ?? '',
			level: Number(element.tagName.slice(1)),
			line: 0,
			element
		})
	);
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
	const lines = body.split('\n');
	const headings: ParsedHeading[] = [];
	let fence = '';
	let yaml = stripFrontmatter(body).raw.length > 0;
	let lineStart = hasBom ? 1 : 0;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		const nextLineStart = lineStart + line.length + 1;
		if (yaml) {
			if (index > 0 && /^(---|\.\.\.)\s*$/.test(line)) yaml = false;
			lineStart = nextLineStart;
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
			lineStart = nextLineStart;
			continue;
		}
		if (marker) {
			fence = marker;
			lineStart = nextLineStart;
			continue;
		}
		const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*?)|[ \t]*)\r?$/.exec(line);
		if (atx)
			headings.push({
				text: (atx[2] ?? '').replace(/[ \t]+#+[ \t]*$/, ''),
				level: atx[1]!.length,
				line: index + 1,
				offset: lineStart
			});
		else if (
			index > 0 &&
			/^ {0,3}(=+|-+)\s*$/.test(line) &&
			lines[index - 1]!.trim() &&
			!/^(?: {4}|\t|\s*[#>\-*])/.test(lines[index - 1]!)
		) {
			headings.push({
				text: lines[index - 1]!.trim(),
				level: line.trim().startsWith('=') ? 1 : 2,
				line: index,
				offset: lineStart - (lines[index - 1]!.length + 1)
			});
		}
		if (headings.length >= limit) break;
		lineStart = nextLineStart;
	}
	return headings;
}

/** Reads source headings without treating YAML or code examples as headings. */
export function documentHeadings(markdown: string): DocumentHeading[] {
	return parseHeadings(markdown, 300).map(({ text, level, line }) => ({ text, level, line }));
}

let revision = 0;
let cachedMarkdown: string | null = null;
let cachedIndex: SourceHeadingIndex | null = null;

/**
 * Returns the complete immutable heading index for an exact source string.
 * Only the most recent string is retained so the cache stays bounded.
 */
export function sourceHeadingIndex(markdown: string): SourceHeadingIndex {
	if (cachedMarkdown === markdown && cachedIndex) return cachedIndex;
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
	cachedIndex = { revision: ++revision, headings };
	cachedMarkdown = markdown;
	return cachedIndex;
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

/** Builds ranges without changing the editor DOM or its Markdown. */
export function documentMatches(root: HTMLElement, query: string): Range[] {
	if (!query.trim()) return [];
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const parts: { node: Text; start: number; end: number }[] = [];
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
	const ranges: Range[] = [];
	const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	for (const match of text.matchAll(new RegExp(escaped, 'giu'))) {
		const from = parts.find((part) => part.start <= match.index && part.end > match.index);
		const end = match.index + match[0].length;
		const to = parts.find((part) => part.start < end && part.end >= end);
		if (!from || !to) continue;
		const range = document.createRange();
		range.setStart(from.node, match.index - from.start);
		range.setEnd(to.node, end - to.start);
		ranges.push(range);
		if (ranges.length === 200) break;
	}
	return ranges;
}

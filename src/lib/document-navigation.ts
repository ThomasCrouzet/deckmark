import { stripFrontmatter } from './frontmatter';

export interface DocumentHeading {
	text: string;
	level: number;
	line: number;
	element?: HTMLElement;
}

/** Reads visible headings without adding identifiers to editable content. */
export function renderedDocumentHeadings(root: HTMLElement | null): DocumentHeading[] {
	return Array.from(root?.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6') ?? [])
		.slice(0, 300)
		.map((element) => ({
			text: element.textContent ?? '',
			level: Number(element.tagName.slice(1)),
			line: 0,
			element
		}));
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

/** Reads source headings without treating YAML or code examples as headings. */
export function documentHeadings(markdown: string): DocumentHeading[] {
	const lines = markdown.split('\n');
	const headings: DocumentHeading[] = [];
	let fence = '';
	let yaml = stripFrontmatter(markdown).raw.length > 0;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		if (yaml) {
			if (index > 0 && /^(---|\.\.\.)\s*$/.test(line)) yaml = false;
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
			continue;
		}
		if (marker) {
			fence = marker;
			continue;
		}
		const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*?)|[ \t]*)\r?$/.exec(line);
		if (atx)
			headings.push({
				text: (atx[2] ?? '').replace(/[ \t]+#+[ \t]*$/, ''),
				level: atx[1]!.length,
				line: index + 1
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
				line: index
			});
		}
		if (headings.length >= 300) break;
	}
	return headings;
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

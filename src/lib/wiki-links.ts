// Obsidian and Logseq style wiki links: `[[File name]]`, `[[id-uuid]]`, and
// `[[Name|displayed alias]]`. ReadView handles navigation without adding a store
// dependency to the renderer. It calls `filesStore.setActive` or creates the missing file.
//
// The module stays pure (zero store dependency, zero DOM) to remain lazy-load
// friendly and easily testable.

import { escapeHTML } from './file-utils';

/**
 * Creates an ASCII slug: lowercases text, removes diacritics, and replaces
 * nonalphanumeric characters with `-`. The slug identifies `<a>` anchors as `#mdsh-wiki-{slug}`.
 * The slug need not be reversible. `data-mdsh-wiki` keeps the raw name for resolution.
 */
export function slugify(s: string): string {
	return s
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/(^-|-$)/g, '');
}

/**
 * Escapes a string for insertion into a regex (for backlink search, for
 * example - where the name contains special characters).
 */
export function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Converts `[[Target]]` and `[[Target|alias]]` to an HTML link before marked
 * parses the text. This avoids conflicts between extensions and GFM tokens.
 *
 * The produced HTML:
 *   <a href="#mdsh-wiki-{slug}" data-mdsh-wiki="{encoded-target}" class="wiki-link">{label}</a>
 *
 * - `href`: internal anchor. The clickable component prevents navigation and
 *   delegates to the store.
 * - `data-mdsh-wiki`: raw name encoded with `encodeURIComponent` for exact
 *   resolution by file name or file ID. Encoding prevents DOMPurify and XSS
 *   filters from removing attributes with HTML-like values, such as `[[<weird>]]`.
 *   ReadView decodes the value with `decodeWikiTarget`.
 * - `class="wiki-link"`: CSS hook + selector for the click handler.
 *
 * The label is HTML-escaped to avoid any injection if the name contains HTML
 * characters (e.g. `[[<script>]]`).
 */
export function preprocessWikiLinks(md: string): string {
	return mapWikiLinks(md, (target, alias, match) => {
		const cleanTarget = target.trim();
		const label = (alias ?? cleanTarget).trim();
		if (!cleanTarget) return match;
		const slug = slugify(cleanTarget);
		// `encodeURIComponent` makes the target "DOMPurify-safe" (no < > &) while
		// staying round-trippable. On the click handler side: decode via
		// `decodeWikiTarget` to recover the raw value.
		const encoded = encodeURIComponent(cleanTarget);
		return `<a href="#mdsh-wiki-${slug}" data-mdsh-wiki="${encoded}" class="wiki-link">${escapeHTML(label)}</a>`;
	});
}

/**
 * Decodes a wiki-link target read from `data-mdsh-wiki`. Inverse of the
 * encoding done in `preprocessWikiLinks`. Tolerant: returns the raw value if
 * decoding fails (malformed target).
 */
export function decodeWikiTarget(encoded: string): string {
	try {
		return decodeURIComponent(encoded);
	} catch {
		return encoded;
	}
}

/**
 * Lists the wiki-link targets referenced in a markdown document. Used to
 * compute backlinks (filesStore.backlinks).
 *
 * Returns each target ONLY ONCE (deduplication via Set), trimmed, case
 * preserved. The caller then compares by name/id.
 */
export function extractWikiLinkTargets(md: string): string[] {
	const seen = new Set<string>();
	mapWikiLinks(md, (target, _alias, match) => {
		if (target.trim()) seen.add(target.trim());
		return match;
	});
	return [...seen];
}

/** Rewrites targets while preserving aliases, whitespace, YAML, and code examples. */
export function rewriteWikiLinkTargets(md: string, resolve: (target: string) => string): string {
	return mapWikiLinks(md, (raw, alias, match) => {
		const target = raw.trim();
		const next = resolve(target);
		return !target || next === target
			? match
			: `[[${raw.replace(target, () => next)}${alias === undefined ? '' : `|${alias}`}]]`;
	});
}

/** Locate indented code relative to the current list item. */
function indentedCodeOffsets(md: string): Set<number> {
	const codeLines = new Set<number>();
	if (!/(?:^|\n)(?: {4}|\t)/.test(md)) return codeLines;
	const lists: { marker: number; content: number }[] = [];
	let offset = 0;
	let blank = true;
	let code = false;
	let fence = '';
	for (const line of md.split('\n')) {
		const start = offset;
		offset += line.length + 1;
		if (!line.trim()) {
			blank = true;
			continue;
		}
		const whitespace = /^[ \t]*/.exec(line)![0];
		const indent = [...whitespace].reduce((n, ch) => (ch === '\t' ? n + 4 - (n % 4) : n + 1), 0);
		const text = line.slice(whitespace.length);
		const marker = /^(`{3,}|~{3,})/.exec(text)?.[1];
		if (fence) {
			codeLines.add(start);
			if (
				marker &&
				marker[0] === fence[0] &&
				marker.length >= fence.length &&
				text.trim() === marker
			)
				fence = '';
			blank = false;
			continue;
		}
		const list = /^(?:[-+*]|\d+[.)])([ \t]+)/.exec(text);
		while (lists.length && (list ? indent <= lists.at(-1)!.marker : indent < lists.at(-1)!.content))
			lists.pop();
		const base = lists.at(-1)?.content ?? 0;
		if (indent >= base + 4 && (blank || code)) {
			codeLines.add(start);
			code = true;
		} else {
			code = false;
			if (marker && (marker[0] !== '`' || !text.slice(marker.length).includes('`'))) {
				fence = marker;
				codeLines.add(start);
			} else if (list) lists.push({ marker: indent, content: indent + list[0].length });
		}
		blank = false;
	}
	return codeLines;
}

/** Rendering, indexing, and rename use the same code-region boundaries. */
function mapWikiLinks(
	md: string,
	transform: (target: string, alias: string | undefined, match: string) => string
): string {
	const prefix = /^\uFEFF+/.exec(md)?.[0] ?? '';
	if (prefix) return prefix + mapWikiLinks(md.slice(prefix.length), transform);
	const indentedCode = indentedCodeOffsets(md);
	const scanner =
		/^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)|^(?: {4}|\t)[^\n]*(?:\n|$)|`+|\[\[([^[\]|\n]+)(\|[^[\]\n]*)?\]\]/gm;
	const frontmatter = /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(md);
	if (frontmatter) scanner.lastIndex = frontmatter[0].length;
	let copied = 0;
	let output = '';
	let match: RegExpExecArray | null;
	while ((match = scanner.exec(md))) {
		let inlineRun: string | undefined;
		if (match[1]) {
			const fence = match[1];
			const afterFence = match[0].trimStart().slice(fence.length);
			if (fence[0] === '`' && afterFence.includes('`')) {
				inlineRun = fence;
				scanner.lastIndex = match.index + match[0].indexOf(fence) + fence.length;
			} else {
				const close = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*\\r?$`, 'gm');
				close.lastIndex = scanner.lastIndex;
				const end = close.exec(md);
				if (!end) break;
				scanner.lastIndex = close.lastIndex;
				continue;
			}
		}
		if (inlineRun || match[0].startsWith('`')) {
			const run = inlineRun ?? match[0];
			let end = md.indexOf(run, scanner.lastIndex);
			while (end !== -1 && (md[end - 1] === '`' || md[end + run.length] === '`')) {
				end = md.indexOf(run, end + run.length);
			}
			if (end !== -1) scanner.lastIndex = end + run.length;
			continue;
		}
		const raw = match[2];
		if (!raw) {
			if (!indentedCode.has(match.index))
				scanner.lastIndex = match.index + /^[ \t]*/.exec(match[0])![0].length;
			continue;
		}
		let escapes = 0;
		for (let index = match.index - 1; index >= 0 && md[index] === '\\'; index--) escapes++;
		if (escapes % 2) continue;
		const next = transform(raw, match[3]?.slice(1), match[0]);
		if (next === match[0]) continue;
		output += md.slice(copied, match.index) + next;
		copied = scanner.lastIndex;
	}
	return output + md.slice(copied);
}

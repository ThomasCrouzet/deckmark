import hljs from 'highlight.js/lib/common';
import { Marked } from 'marked';
import { escapeHTML } from '../src/lib/html-escape';
import { getTags, getTitle, parseFrontmatter } from '../src/lib/frontmatter';
import { preprocessWikiLinks, slugify } from '../src/lib/wiki-links';

export interface RenderOptions {
	showFrontmatter?: boolean;
	wikiLinks?: boolean;
}

export interface RenderedMarkdown {
	html: string;
	frontmatter: Record<string, unknown>;
	title: string;
}

const MAX_HIGHLIGHT_CHARS = 100_000;

function compactUrl(value: string): string {
	let compact = '';
	for (const character of value) {
		if ((character.codePointAt(0) ?? 0) > 0x20) compact += character;
	}
	return compact;
}

function safeUrl(value: string, imagesOnly: boolean): string | null {
	const compact = compactUrl(value);
	if (/^(?:javascript|vbscript|file):/i.test(compact)) return null;
	if (/^data:/i.test(compact)) {
		return imagesOnly && /^data:image\//i.test(compact) ? value : null;
	}
	return value;
}

function safeLink(href: string): string | null {
	return safeUrl(href, false);
}

function safeImage(source: string): string | null {
	return safeUrl(source, true);
}

function highlightCode(code: string, language: string | undefined): string {
	const known = language && hljs.getLanguage(language) ? language : null;
	if (code.length > MAX_HIGHLIGHT_CHARS) return escapeHTML(code);
	if (known) {
		try {
			return hljs.highlight(code, { language: known, ignoreIllegals: true }).value;
		} catch {
			return escapeHTML(code);
		}
	}
	return escapeHTML(code);
}

function buildMarked(): Marked {
	const marked = new Marked({ gfm: true, breaks: false, pedantic: false });
	const usedSlugs = new Set<string>();
	marked.use({
		renderer: {
			html({ text }) {
				return escapeHTML(text);
			},
			heading({ tokens, depth, text }) {
				const inner = this.parser.parseInline(tokens);
				const base = slugify(text).slice(0, 80) || `section-${depth}`;
				let slug = base;
				let suffix = 2;
				while (usedSlugs.has(slug)) slug = `${base}-${suffix++}`;
				usedSlugs.add(slug);
				return `<h${depth} id="${escapeHTML(slug)}">${inner}</h${depth}>\n`;
			},
			link({ href, title, tokens }) {
				const inner = this.parser.parseInline(tokens);
				const safe = safeLink(href);
				if (!safe) return inner;
				const titleAttr = title ? ` title="${escapeHTML(title)}"` : '';
				return `<a href="${escapeHTML(safe)}"${titleAttr}>${inner}</a>`;
			},
			image({ href, title, text }) {
				const safe = safeImage(href);
				const alt = escapeHTML(text);
				if (!safe) return alt;
				const titleAttr = title ? ` title="${escapeHTML(title)}"` : '';
				return `<img src="${escapeHTML(safe)}" alt="${alt}"${titleAttr}>`;
			},
			code({ text, lang }) {
				const language = lang && hljs.getLanguage(lang) ? lang : null;
				const body = highlightCode(text, language ?? undefined);
				const cls = language ? `hljs language-${escapeHTML(language)}` : 'hljs';
				return `<pre><code class="${cls}">${body}</code></pre>\n`;
			},
			list(token) {
				let body = '';
				for (const item of token.items) body += this.listitem(item);
				const type = token.ordered ? 'ol' : 'ul';
				const startAttr = token.ordered && token.start !== 1 ? ` start="${token.start}"` : '';
				const classAttr = token.items.some((item) => item.task)
					? ' class="contains-task-list"'
					: '';
				return `<${type}${startAttr}${classAttr}>\n${body}</${type}>\n`;
			},
			listitem(item) {
				const classAttr = item.task ? ' class="task-list-item"' : '';
				return `<li${classAttr}>${this.parser.parse(item.tokens)}</li>\n`;
			}
		}
	});
	return marked;
}

function frontmatterBlock(data: Record<string, unknown>): string {
	if (Object.keys(data).length === 0) return '';
	const items: string[] = [];
	const seen = new Set(['title', 'tags']);
	const order = ['author', 'date', 'created', 'updated', 'description'];
	for (const key of order) {
		if (key in data) pushField(key, data[key]);
	}
	for (const key of Object.keys(data)) {
		if (!seen.has(key)) pushField(key, data[key]);
	}
	const tags = getTags(data);
	const tagsHtml =
		tags.length > 0
			? `<div class="mdsh-frontmatter-row"><dt>tags</dt><dd>${tags
					.map((tag) => `<span class="mdsh-frontmatter-tag">${escapeHTML(tag)}</span>`)
					.join(' ')}</dd></div>`
			: '';
	if (items.length === 0 && !tagsHtml) return '';
	return `<aside class="mdsh-frontmatter" aria-label="Document metadata"><dl>${items.join('')}${tagsHtml}</dl></aside>\n`;

	function pushField(key: string, raw: unknown): void {
		if (raw == null || raw === '') return;
		let display: string;
		if (raw instanceof Date) display = raw.toISOString().slice(0, 10);
		else if (Array.isArray(raw)) {
			display = raw
				.slice(0, 50)
				.map((value) =>
					value != null && typeof value === 'object' ? '[...]' : String(value).slice(0, 200)
				)
				.join(', ');
		} else if (typeof raw === 'object') return;
		else display = String(raw);
		items.push(
			`<div class="mdsh-frontmatter-row"><dt>${escapeHTML(key)}</dt><dd>${escapeHTML(display)}</dd></div>`
		);
		seen.add(key);
	}
}

/** Renders Markdown with escaped raw HTML. No browser API is used. */
export async function renderMarkdownToHtml(
	markdown: string,
	options: RenderOptions = {}
): Promise<RenderedMarkdown> {
	const parsed = await parseFrontmatter(markdown);
	const source = options.wikiLinks === false ? parsed.content : preprocessWikiLinks(parsed.content);
	const raw = buildMarked().parse(source, { async: false });
	let html = typeof raw === 'string' ? raw : '';
	if (options.showFrontmatter !== false) html = frontmatterBlock(parsed.data) + html;
	return {
		html,
		frontmatter: parsed.data,
		title: getTitle(parsed.data, parsed.content, '')
	};
}

function resolveLanguage(lang: string | undefined): string {
	const value = (lang ?? '').trim();
	return /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value) ? value : 'en';
}

const STANDALONE_STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
	margin: 0;
	background: #f8f7f4;
	color: #1c1917;
	font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
	line-height: 1.65;
}
main { max-width: 52rem; margin: 0 auto; padding: 3rem 1.25rem 5rem; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 2rem 0 0.75rem; }
h1 { font-size: 2.1rem; }
h2 { font-size: 1.6rem; border-bottom: 1px solid #d6d3d1; padding-bottom: 0.3rem; }
a { color: #9a5b12; }
img { max-width: 100%; height: auto; }
pre { overflow: auto; padding: 1rem; background: #1c1917; color: #f5f5f4; border-radius: 0.4rem; }
code { font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; font-size: 0.9em; }
:not(pre) > code { background: #e7e5e4; padding: 0.1rem 0.3rem; border-radius: 0.25rem; }
blockquote { margin: 1rem 0; padding-left: 1rem; border-left: 3px solid #d6d3d1; color: #57534e; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #d6d3d1; padding: 0.45rem 0.6rem; text-align: left; }
hr { border: 0; border-top: 1px solid #d6d3d1; margin: 2rem 0; }
.mdsh-frontmatter { margin: 0 0 2rem; padding: 0.75rem 1rem; border: 1px solid #d6d3d1; border-radius: 0.4rem; }
.mdsh-frontmatter dl { margin: 0; display: grid; gap: 0.25rem; }
.mdsh-frontmatter-row { display: flex; gap: 0.75rem; }
.mdsh-frontmatter dt { min-width: 7rem; color: #57534e; font-weight: 600; }
.mdsh-frontmatter dd { margin: 0; }
.mdsh-frontmatter-tag { display: inline-block; margin-right: 0.35rem; padding: 0.05rem 0.4rem; border: 1px solid #d6d3d1; border-radius: 999px; font-size: 0.85em; }
.wiki-link { text-decoration-style: dotted; }
.contains-task-list { list-style: none; padding-left: 1rem; }
@media print {
	body { background: #fff; color: #000; }
	main { max-width: none; padding: 0; }
	a { color: inherit; }
}
`.trim();

export interface StandaloneOptions {
	title: string;
	lang?: string;
}

/** Builds one HTML file with no external style or script dependency. */
export function buildStandaloneHtml(bodyHtml: string, options: StandaloneOptions): string {
	const title = escapeHTML(options.title || 'DeckMark document');
	const lang = resolveLanguage(options.lang);
	return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: https: http:; base-uri 'none'; form-action 'none'">
<meta name="generator" content="DeckMark CLI">
<title>${title}</title>
<style>
${STANDALONE_STYLE}
</style>
</head>
<body>
<main class="deckmark-body">
${bodyHtml}
</main>
</body>
</html>
`;
}

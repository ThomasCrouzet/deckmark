// Markdown to HTML rendering with GFM + math (KaTeX) + syntax highlighting (highlight.js) + Mermaid diagrams.
// Module lazy-loaded only at export time or for a reading view: zero impact on the initial bundle.
//
// KaTeX CSS is imported here so it joins the lazy chunk. Its fonts (via url())
// are bundled by Vite and precached by the service worker - same stack for
// the reading view in the app and for the PDF export iframe.

import 'katex/dist/katex.min.css';

import { browser } from '$app/env';
import { Marked, type Tokens } from 'marked';
import hljs from 'highlight.js/lib/common';
import katex from 'katex';
import { escapeHTML } from '../file-utils';
import { getTags, getTitle, parseFrontmatter } from '../frontmatter';
import { preprocessWikiLinks, slugify } from '../wiki-links';
import { t } from '#lib/i18n/index.js';
import {
	applyRemoteImagePolicy,
	MARKDOWN_PURIFY,
	sanitizeHtml,
	renderMermaidSvg
} from './sanitize-html';
import { prepareHtmlMedia } from './image-media';
import { applyImageMetadataToHtml } from './image-markdown';

type MathToken = Tokens.Generic & {
	type: 'blockMath' | 'inlineMath';
	text: string;
	/** For inlineMath: `true` if rendered as display math (`$$…$$` mid-line). */
	display?: boolean;
};

const MAX_HIGHLIGHT_CHARS = 100_000;

export type MermaidTheme = 'default' | 'dark' | 'neutral' | 'forest';

export interface RenderOptions {
	fileId?: string;
	projectContext?: import('../project-media').ProjectContext;
	/** Mermaid theme: `default` (light) for PDF, `dark` for the app preview. */
	mermaidTheme?: MermaidTheme;
	/**
	 * Adds visible-on-hover permalink controls to H1-H3 headings.
	 * This is a reading-view interaction, not part of exported document content.
	 */
	headingPermalinks?: boolean;
	/**
	 * Renders the front-matter metadata block at the top of the HTML output.
	 * Default: true. Set to false for raw exports (zip, copy/paste).
	 */
	showFrontmatter?: boolean;
	/** Allows network-backed images after an explicit action in the reading view. */
	allowRemoteImages?: boolean;
}

export interface RenderResult {
	html: string;
	/** Parsed front-matter data (empty if absent / invalid). */
	frontmatter: Record<string, unknown>;
	/** Priority title (front-matter > first H1 > undefined). */
	title?: string | undefined;
}

function renderMath(tex: string, displayMode: boolean): string {
	try {
		return katex.renderToString(tex, {
			displayMode,
			throwOnError: false,
			strict: 'ignore',
			output: 'htmlAndMathml',
			trust: false
		});
	} catch {
		const cls = displayMode ? 'math-error math-error-display' : 'math-error';
		return displayMode
			? `<div class="${cls}">${escapeHTML(tex)}</div>`
			: `<span class="${cls}">${escapeHTML(tex)}</span>`;
	}
}

function highlightCode(code: string, lang: string | undefined): string {
	if (code.length > MAX_HIGHLIGHT_CHARS) return escapeHTML(code);
	const language = lang && hljs.getLanguage(lang) ? lang : null;
	if (language) {
		return hljs.highlight(code, { language, ignoreIllegals: true }).value;
	}
	try {
		return hljs.highlightAuto(code).value;
	} catch {
		return escapeHTML(code);
	}
}

/**
 * Builds an isolated Marked instance. The `code` renderer captures
 * ```mermaid blocks in the sink passed via closure - guarantees isolation
 * between concurrent calls to `renderMarkdown` (no shared module state).
 *
 * The local `usedSlugs` Set guarantees heading id uniqueness within the doc
 * (two `# Hello` → `#hello` then `#hello-2`). Without dedup, the permalink
 * anchor and the TOC always point to the FIRST duplicated heading - copy/paste bug.
 */
function buildMarked(mermaidSink: string[], headingPermalinks: boolean): Marked {
	const marked = new Marked({ gfm: true, breaks: false, pedantic: false });
	const usedSlugs = new Set<string>();

	marked.use({
		renderer: {
			// §B4.5 - Discrete `#` anchor on hover over h1-h3, like GitHub /
			// Obsidian / MDN. Lets you copy a permalink to a section. The
			// slug reuses the shared `slugify` (cf. wiki-links.ts) to match
			// the id pattern produced by the TOC.
			heading({ tokens, depth, text }) {
				// `parseInline` renders bold/italic/code/etc. in the title.
				// `this` is rebound to the Marked instance at runtime.
				const inner = this.parser.parseInline(tokens);
				// `text` exposed by marked = concatenated raw text (no HTML).
				// Consistent with the slug the TOC produces on the DOM side
				// (Toc.svelte does `slugify(h.textContent)`).
				const base = slugify(text).slice(0, 80) || `section-${depth}`;
				let slug = base;
				let suffix = 2;
				while (usedSlugs.has(slug)) {
					slug = `${base}-${suffix++}`;
				}
				usedSlugs.add(slug);
				if (depth > 3 || !headingPermalinks) {
					return `<h${depth} id="${slug}">${inner}</h${depth}>\n`;
				}
				return `<h${depth} id="${slug}">${inner}<a class="mdsh-anchor" href="#${slug}" tabindex="-1" aria-hidden="true"></a></h${depth}>\n`;
			},
			list(token) {
				let body = '';
				for (const item of token.items) {
					body += this.listitem(item);
				}
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
			},
			code({ text, lang }) {
				// Mermaid: indexed placeholder (unique per call); rendered async post-parse.
				if (lang === 'mermaid') {
					const idx = mermaidSink.length;
					mermaidSink.push(text);
					return `<div class="mdsh-mermaid-placeholder" data-mermaid-idx="${idx}"></div>\n`;
				}
				const language = lang && hljs.getLanguage(lang) ? lang : null;
				const highlighted = highlightCode(text, language ?? undefined);
				const cls = language ? `hljs language-${language}` : 'hljs';
				const omitted = text.length > MAX_HIGHLIGHT_CHARS ? ' data-mdsh-highlight="omitted"' : '';
				// §B1.9 - `aria-label` on `<pre>` announces the block's
				// language to the screen reader (e.g. "Code JavaScript").
				// Without a label the SR just says "code" with no context.
				// The `<pre>` stays readable character by character via cursor navigation.
				const ariaLabel = language
					? t('read.codeBlockLang', { lang: language })
					: t('read.codeBlock');
				return `<pre aria-label="${escapeHTML(ariaLabel)}"><code class="${cls}"${omitted}>${highlighted}</code></pre>\n`;
			}
		},
		extensions: [
			{
				name: 'blockMath',
				level: 'block',
				start(src: string) {
					// Only interrupt a paragraph for a `$$` AT THE START OF A LINE (block
					// math is `$$` alone on its line). Otherwise a mid-line `$$…$$` would
					// break the paragraph and prevent inline rendering.
					let i = src.indexOf('$$');
					while (i !== -1) {
						if (i === 0 || src[i - 1] === '\n') return i;
						i = src.indexOf('$$', i + 1);
					}
					return undefined;
				},
				tokenizer(src: string) {
					const match = /^\$\$\s*\n?([\s\S]+?)\n?\s*\$\$(?:\s*\n|\s*$)/.exec(src);
					if (!match) return;
					// invariant: match[0] and match[1] are guaranteed after the `!match` guard
					// (mandatory capture group `[\s\S]+?`).
					return { type: 'blockMath', raw: match[0]!, text: match[1]!.trim() };
				},
				renderer(token) {
					const t = token as MathToken;
					return `<div class="math-block">${renderMath(t.text, true)}</div>\n`;
				}
			},
			{
				name: 'inlineMath',
				level: 'inline',
				start(src: string) {
					const idx = src.indexOf('$');
					return idx < 0 ? undefined : idx;
				},
				tokenizer(src: string) {
					if (src.startsWith('$$')) {
						// $$…$$ MID-line (the standalone block is already caught by
						// blockMath). Rendered as inline display math rather than left as
						// raw text. If not closed on the line, we let it through (no
						// confusion with two $…$).
						const block = /^\$\$([^\n]+?)\$\$/.exec(src);

						if (block)
							return {
								type: 'inlineMath',
								raw: block[0],
								text: block[1]!.trim(),
								display: true
							};

						return;
					}
					// Avoid prices like "$10" via the `(?!\d)` lookahead after the closing `$`.
					const match = /^\$(?!\s)((?:\\\$|[^\n$])+?)(?<!\s)\$(?!\d)/.exec(src);
					if (!match) return;
					return { type: 'inlineMath', raw: match[0], text: match[1] };
				},
				renderer(token) {
					const t = token as MathToken;
					return renderMath(t.text, t.display === true);
				}
			}
		]
	});

	return marked;
}

// ---------------------------------------------------------------------------
// Mermaid - diagrams rendered as SVG, lazy-loaded. Global theme (mermaid
// singleton): a re-init is forced if the requested theme changes.
// ---------------------------------------------------------------------------
interface MermaidCounter {
	current: number;
}

async function renderMermaidDiagram(
	code: string,
	theme: MermaidTheme,
	counter: MermaidCounter
): Promise<string> {
	if (!browser) {
		return `<pre class="mermaid-source"><code>${escapeHTML(code)}</code></pre>`;
	}
	try {
		const id = `mdsh-mermaid-${++counter.current}`;
		return await renderMermaidSvg(id, code, theme);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return `<div class="mermaid-error" role="alert">
<strong>${escapeHTML(t('read.mermaidError'))}</strong>
<pre><code>${escapeHTML(msg)}</code></pre>
<pre class="mermaid-source-fallback"><code>${escapeHTML(code)}</code></pre>
</div>`;
	}
}

/**
 * Sanitizes the final HTML via DOMPurify before returning it to the consumer.
 * Defends against XSS vectors introduced by inline HTML allowed by `marked`
 * (`onerror` attributes, `href="javascript:..."`, `<iframe>`, `<script>`, etc.).
 *
 * Enable HTML, SVG, SVG filters, and MathML for Mermaid and KaTeX output.
 * DOMPurify blocks `on*` handlers and `javascript:` URLs by default.
 *
 * Keep DOMPurify in the renderer's lazy chunk, outside the initial bundle.
 * Use `dompurify` directly, not `isomorphic-dompurify`. The app runs only in browsers.
 * It does not need the jsdom wrapper, which adds about 150 KB of raw code.
 */
async function sanitize(html: string, allowRemoteImages: boolean): Promise<string> {
	// Shared hook (sanitize-html): external links get noopener, remote style
	// url() beacons are stripped. Same hook as the WYSIWYG Mermaid preview.
	// Live blob URLs are embedded before DOMPurify sees them. This recovers
	// documents created by older builds while the original blob is still alive.
	const prepared = await prepareHtmlMedia(html, { allowNetwork: false });
	return applyRemoteImagePolicy(
		await sanitizeHtml(prepared.html, MARKDOWN_PURIFY),
		allowRemoteImages
	);
}

/**
 * Builds the HTML block for front-matter metadata (author, date, tags…).
 * Displayed at the top of the rendered output via an `<aside class="mdsh-frontmatter">`.
 * Values are HTML-escaped; a structured dl/dt/dd is more accessible than a
 * table (screen readers announce "definition group").
 *
 * Render `tags` as chips. Format `created` as YYYY-MM-DD when it is a Date. Omit `title`
 * because it is already the document title.
 */
function buildFrontmatterBlock(data: Record<string, unknown>): string {
	if (!data || Object.keys(data).length === 0) return '';
	const items: string[] = [];

	const order = ['author', 'date', 'created', 'updated', 'description'];
	const seen = new Set<string>(['title', 'tags']);

	const pushField = (key: string, raw: unknown) => {
		if (raw == null || raw === '') return;
		let display: string;
		if (raw instanceof Date) {
			display = raw.toISOString().slice(0, 10);
		} else if (Array.isArray(raw)) {
			// Anti-DoS bound: do NOT recursively stringify nested structures.
			// A YAML alias bomb (`*a` referenced in cascade) produces a shared
			// graph that `String()` traverses as a tree -> exponential cost that
			// freezes the tab. We cap the number of items and their length, and
			// replace any non-scalar value with `[...]`.
			display = raw
				.slice(0, 50)
				.map((v) => (v != null && typeof v === 'object' ? '[...]' : String(v).slice(0, 200)))
				.join(', ');
		} else if (typeof raw === 'object') {
			return; // skip non-trivial nested values
		} else {
			display = String(raw);
		}
		items.push(
			`<div class="mdsh-frontmatter-row"><dt>${escapeHTML(key)}</dt><dd>${escapeHTML(display)}</dd></div>`
		);
		seen.add(key);
	};

	// Stable order: known fields first, then the rest in insertion order
	for (const k of order) {
		if (k in data) pushField(k, data[k]);
	}
	for (const k of Object.keys(data)) {
		if (seen.has(k)) continue;
		pushField(k, data[k]);
	}

	const tags = getTags(data);
	const tagsHtml =
		tags.length > 0
			? `<div class="mdsh-frontmatter-row"><dt>tags</dt><dd>${tags
					.map((t) => `<span class="mdsh-frontmatter-tag">${escapeHTML(t)}</span>`)
					.join(' ')}</dd></div>`
			: '';

	if (items.length === 0 && !tagsHtml) return '';

	return `<aside class="mdsh-frontmatter" aria-label="${escapeHTML(t('read.frontmatterMeta'))}"><dl>${items.join('')}${tagsHtml}</dl></aside>\n`;
}

/**
 * Renders a Markdown string as complete HTML:
 * - YAML front-matter extracted (and optionally rendered at the top as an `<aside>`)
 * - Wiki links `[[Cible]]` and `[[Cible|alias]]` converted to `<a class="wiki-link">`
 * - GFM (tables, checklists, strikethrough)
 * - Inline math `$...$` and block `$$...$$` via KaTeX
 * - Code blocks with syntax highlighting (highlight.js, 35+ common languages)
 * - `mermaid` diagrams rendered as SVG (lazy-loaded, configurable theme)
 *
 * A closure collects Mermaid code during parsing. Each call has its own
 * collection, so concurrent calls are safe.
 *
 * DOMPurify sanitizes the final HTML. A hostile `.md` file cannot inject a script
 * through share_target, launchQueue, or drag-drop.
 */
async function renderMarkdownCore(
	md: string,
	opts: RenderOptions = {}
): Promise<{ html: string; fm: Awaited<ReturnType<typeof parseFrontmatter>> }> {
	// 1. Extract the front-matter (lazy gray-matter via parseFrontmatter).
	const fm = await parseFrontmatter(md);

	// 2. Pre-process wiki-links on the content (after front-matter so we don't
	//    accidentally transform a YAML block that contains `[[]]`).
	const preprocessed = preprocessWikiLinks(fm.content);

	const mermaidCodes: string[] = [];
	// Call-local counter: no shared module state. Mermaid IDs may collide
	// between two calls - no impact since the DOM is replaced between renders
	// and mermaid uses the IDs as internal references within the SVG (which is
	// then injected via innerHTML).
	const counter: MermaidCounter = { current: 0 };
	const marked = buildMarked(mermaidCodes, opts.headingPermalinks === true);

	const htmlRaw = marked.parse(preprocessed, { async: false });
	let html = applyImageMetadataToHtml(preprocessed, typeof htmlRaw === 'string' ? htmlRaw : '');

	if (mermaidCodes.length > 0) {
		const theme = opts.mermaidTheme ?? 'default';
		// Mermaid is a singleton (global state: theme, internal IDs) - sequential
		// rendering is mandatory to avoid any pollution between diagrams.
		for (let i = 0; i < mermaidCodes.length; i++) {
			// invariant: i < mermaidCodes.length guarantees mermaidCodes[i] is defined.
			const svg = await renderMermaidDiagram(mermaidCodes[i]!, theme, counter);
			const placeholder = `<div class="mdsh-mermaid-placeholder" data-mermaid-idx="${i}"></div>`;
			// Replacement function: avoids interpreting the `$&`, `$1`, `$$` etc.
			// patterns that could appear in the Mermaid SVG's text/ids.
			html = html.replace(placeholder, () => `<div class="mermaid-block">${svg}</div>`);
		}
	}

	// 3. Front-matter block at the top (preview + PDF). Sanitized with the rest
	//    of the HTML by DOMPurify - no path bypassing the sanitize pass.
	const showFM = opts.showFrontmatter !== false;
	if (showFM) {
		const block = buildFrontmatterBlock(fm.data);
		if (block) html = block + html;
	}

	if (opts.fileId || opts.projectContext) {
		const { projectContextFor, resolveProjectHtmlImages } = await import('../project-media');
		const context =
			opts.projectContext ?? (opts.fileId ? await projectContextFor(opts.fileId) : undefined);
		if (context) html = await resolveProjectHtmlImages(html, context);
	}
	return { html: await sanitize(html, opts.allowRemoteImages === true), fm };
}

export async function renderMarkdown(md: string, opts: RenderOptions = {}): Promise<string> {
	const { html } = await renderMarkdownCore(md, opts);
	return html;
}

/**
 * Returns rendered HTML, parsed front-matter, and the extracted title.
 * Use this variant when a caller also needs metadata.
 *
 * Single parse/render path (no second front-matter + marked pass).
 */
export async function renderMarkdownDetailed(
	md: string,
	opts: RenderOptions = {}
): Promise<RenderResult> {
	const { html, fm } = await renderMarkdownCore(md, opts);
	const title = getTitle(fm.data, fm.content, '');
	return {
		html,
		frontmatter: fm.data,
		title: title || undefined
	};
}

// Implicit re-export of `slugify` for module consumers who want to
// regenerate an anchor id on the client side (consistent with the slug set
// on the `<a class="wiki-link">`).
export { slugify };

/**
 * Tests whether Markdown contains math notation. The inline pattern matches the
 * tokenizer and excludes prices such as "$10" and "$x$5". This avoids loading
 * KaTeX CSS when it is not needed.
 */
export function hasMath(md: string): boolean {
	return /\$\$[\s\S]+?\$\$|\$(?!\s)(?:\\\$|[^\n$])+?(?<!\s)\$(?!\d)/.test(md);
}

/** Quickly tests whether a markdown string contains a Mermaid block. */
export function hasMermaid(md: string): boolean {
	return /^[ \t]*(```|~~~)[ \t]*mermaid\b/m.test(md);
}

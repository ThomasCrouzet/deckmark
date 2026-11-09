// Markdown to HTML rendering with GFM + math (KaTeX) + syntax highlighting (highlight.js) + Mermaid diagrams.
// Module lazy-loaded only at export time or for a reading view: zero impact on the initial bundle.
//
// KaTeX CSS is imported here so it joins the lazy chunk. Its fonts (via url())
// are bundled by Vite and precached by the service worker - same stack for
// the reading view in the app and for the PDF export iframe.

import 'katex/dist/katex.min.css';

import { browser } from '$app/env';
import { escapeHTML } from '../file-utils';
import { getTags, getTitle, parseFrontmatter } from '../frontmatter';
import { slugify } from '../wiki-links';
import { abortable, checkAborted } from '../abort';
import { parseMarkdownJob } from './markdown-worker';
import { RenderCache } from './render-cache';
import { createRenderInstanceId } from './render-identity';
import { recordRenderStage } from './render-stages';
import { t } from '#lib/i18n/index.js';
import {
	applyRemoteImagePolicy,
	MARKDOWN_PURIFY,
	sanitizeHtml,
	renderMermaidSvg
} from './sanitize-html';
import { prepareHtmlMedia } from './image-media';
import { applyImageMetadataToHtml } from './image-markdown';

export type MermaidTheme = 'default' | 'dark' | 'neutral' | 'forest';

export interface RenderOptions {
	signal?: AbortSignal;
	/** Active viewport work goes ahead of offscreen thumbnails and exports. */
	priority?: 'active' | 'background';
	/** Reuse only within one mounted document instance. */
	instanceId?: string;
	fileId?: string;
	/** Null means the captured file has no project, even before its draft save. */
	projectContext?: import('../project-media').ProjectContext | null;
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
	/** Converts wiki links to note links. Default: true. */
	wikiLinks?: boolean;
	/** Allows network-backed images after an explicit action in the reading view. */
	allowRemoteImages?: boolean;
	/**
	 * Keeps relative image paths without media preparation. Static site export
	 * bundles these paths as local files and reports or blocks remote sources.
	 */
	preserveLocalImages?: boolean;
}

export interface RenderResult {
	html: string;
	/** Parsed front-matter data (empty if absent / invalid). */
	frontmatter: Record<string, unknown>;
	/** Priority title (front-matter > first H1 > undefined). */
	title?: string | undefined;
}

// ---------------------------------------------------------------------------
// Mermaid - diagrams rendered as SVG, lazy-loaded. Global theme (mermaid
// singleton): a re-init is forced if the requested theme changes.
// ---------------------------------------------------------------------------
const diagramCache = new RenderCache(8 * 1024 * 1024, 256);

function instanceSvg(svg: string, namespace: string): string {
	const template = document.createElement('template');
	template.innerHTML = svg;
	const ids = new Map<string, string>();
	for (const node of template.content.querySelectorAll('[id]')) {
		const id = node.getAttribute('id')!;
		const replacement = `${namespace}-${ids.size}`;
		ids.set(id, replacement);
		node.setAttribute('id', replacement);
	}
	for (const node of template.content.querySelectorAll('*')) {
		for (const attribute of Array.from(node.attributes)) {
			if (attribute.name === 'id') continue;
			let value = attribute.value.replace(
				/url\(\s*(['"]?)#([^)'"\s]+)\1\s*\)/g,
				(match, quote: string, id: string) =>
					ids.has(id) ? `url(${quote}#${ids.get(id)}${quote})` : match
			);
			if (attribute.name === 'href' || attribute.name === 'xlink:href') {
				const id = value.startsWith('#') ? ids.get(value.slice(1)) : undefined;
				if (id) value = `#${id}`;
			} else if (attribute.name === 'aria-labelledby' || attribute.name === 'aria-describedby') {
				value = value
					.split(/\s+/)
					.map((id) => ids.get(id) ?? id)
					.join(' ');
			}
			if (value !== attribute.value) node.setAttribute(attribute.name, value);
		}
	}
	return template.innerHTML;
}

const inFlightDiagrams = new Map<string, Promise<string>>();

async function renderMermaidDiagram(
	code: string,
	theme: MermaidTheme,
	namespace: string,
	signal?: AbortSignal
): Promise<string> {
	if (!browser) {
		return `<pre class="mermaid-source"><code>${escapeHTML(code)}</code></pre>`;
	}
	try {
		checkAborted(signal);
		const key = JSON.stringify([code, theme]);
		let svg = diagramCache.get(key);
		if (svg === undefined) {
			let pending = inFlightDiagrams.get(key);
			if (!pending) {
				pending = renderMermaidSvg(createRenderInstanceId(), code, theme).finally(() => {
					inFlightDiagrams.delete(key);
				});
				inFlightDiagrams.set(key, pending);
			}
			svg = await abortable(pending, signal);
			checkAborted(signal);
			diagramCache.set(key, svg);
		}
		return instanceSvg(svg, namespace);
	} catch (err) {
		checkAborted(signal);
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
async function sanitize(
	html: string,
	allowRemoteImages: boolean,
	preserveLocalImages: boolean,
	signal?: AbortSignal,
	fileId?: string
): Promise<string> {
	// Shared hook (sanitize-html): external links get noopener, remote style
	// url() beacons are stripped. Same hook as the WYSIWYG Mermaid preview.
	// Live blob URLs are embedded before DOMPurify sees them. This recovers
	// documents created by older builds while the original blob is still alive.
	let started = performance.now();
	const prepared = preserveLocalImages
		? html
		: (await prepareHtmlMedia(html, { allowNetwork: false, signal })).html;
	checkAborted(signal);
	recordRenderStage(
		{ stage: 'media', durationMs: performance.now() - started, thread: 'main' },
		fileId
	);
	started = performance.now();
	const clean = await abortable(sanitizeHtml(prepared, MARKDOWN_PURIFY), signal);
	checkAborted(signal);
	const result = applyRemoteImagePolicy(clean, allowRemoteImages);
	recordRenderStage(
		{ stage: 'sanitize', durationMs: performance.now() - started, thread: 'main' },
		fileId
	);
	return result;
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
	const signal = opts.signal;
	checkAborted(signal);
	let started = performance.now();
	const fm = await abortable(parseFrontmatter(md), signal);
	checkAborted(signal);
	recordRenderStage(
		{ stage: 'frontmatter', durationMs: performance.now() - started, thread: 'main' },
		opts.fileId
	);
	const parsed = await parseMarkdownJob(
		{
			content: fm.content,
			wikiLinks: opts.wikiLinks !== false,
			headingPermalinks: opts.headingPermalinks === true,
			codeLabel: t('read.codeBlock'),
			codeLanguageLabel: t('read.codeBlockLang', { lang: '{lang}' })
		},
		signal,
		opts.priority ?? 'background'
	);
	checkAborted(signal);
	for (const stage of parsed.stages) recordRenderStage(stage, opts.fileId);
	let html = applyImageMetadataToHtml(parsed.source, parsed.html);
	const namespace =
		opts.instanceId && /^mdsh-render-\d+$/.test(opts.instanceId)
			? opts.instanceId
			: createRenderInstanceId();
	const diagrams: string[] = [];
	started = performance.now();
	const hits = diagramCache.hits;
	const misses = diagramCache.misses;
	for (let i = 0; i < parsed.mermaidCodes.length; i++) {
		checkAborted(signal);
		const svg = await renderMermaidDiagram(
			parsed.mermaidCodes[i]!,
			opts.mermaidTheme ?? 'default',
			`${namespace}-${i}`,
			signal
		);
		diagrams.push(`<div class="mermaid-block">${svg}</div>`);
		if (i % 16 === 15)
			await abortable(new Promise<void>((resolve) => setTimeout(resolve, 0)), signal);
	}
	checkAborted(signal);
	// Assemble all placeholders in one scan. Function replacement preserves literal dollars.
	html = html.replace(
		/<div class="mdsh-mermaid-placeholder" data-mermaid-idx="(\d+)"><\/div>/g,
		(_match, index: string) => diagrams[Number(index)] ?? ''
	);
	recordRenderStage(
		{
			stage: 'diagrams',
			durationMs: performance.now() - started,
			thread: 'main',
			cacheHits: diagramCache.hits - hits,
			cacheMisses: diagramCache.misses - misses,
			cache: diagramCache.usage()
		},
		opts.fileId
	);

	// 3. Front-matter block at the top (preview + PDF). Sanitized with the rest
	//    of the HTML by DOMPurify - no path bypassing the sanitize pass.
	const showFM = opts.showFrontmatter !== false;
	if (showFM) {
		const block = buildFrontmatterBlock(fm.data);
		if (block) html = block + html;
	}

	if (opts.projectContext !== null && (opts.fileId || opts.projectContext)) {
		checkAborted(signal);
		const { projectContextFor, resolveProjectHtmlImages } = await import('../project-media');
		const context =
			opts.projectContext ?? (opts.fileId ? await projectContextFor(opts.fileId) : undefined);
		checkAborted(signal);
		if (context) html = await resolveProjectHtmlImages(html, context, signal);
	}
	checkAborted(signal);
	started = performance.now();
	const clean = await sanitize(
		html,
		opts.allowRemoteImages === true,
		opts.preserveLocalImages === true,
		signal,
		opts.fileId
	);
	recordRenderStage(
		{ stage: 'media-sanitize', durationMs: performance.now() - started, thread: 'main' },
		opts.fileId
	);
	checkAborted(signal);
	return {
		html: clean,
		fm
	};
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
export { slugify, createRenderInstanceId };

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

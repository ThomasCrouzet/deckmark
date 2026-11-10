// Renders a planned documentation site. This module loads the Markdown
// renderer, so the panel imports it only when a user starts an export.

import { checkAborted } from '../abort';
import { escapeHTML } from '../file-utils';
import { getTags } from '../frontmatter';
import { docsSiteEn, type DocsSiteMessageKey } from '../i18n/messages/docs-site-en';
import { docsSiteFr } from '../i18n/messages/docs-site-fr';
import { pathKey, relativeDestination } from '../project-paths';
import { renderMarkdownDetailed } from '../render/markdown';
import {
	docsSiteIssue,
	mergeIssues,
	pageFallbackTitle,
	resolveSiteDestination,
	resolveSiteWikiDestination,
	type DocsSiteFile,
	type DocsSiteIssue,
	type DocsSitePlan,
	type PlannedPage
} from './docs-site-plan';

export interface SiteTocEntry {
	id: string;
	text: string;
	level: number;
}

export interface RenderedSitePage {
	page: PlannedPage;
	title: string;
	description: string | undefined;
	tags: string[];
	articleHtml: string;
	toc: SiteTocEntry[];
	searchText: string;
}

export interface RenderedDocsSite {
	pages: RenderedSitePage[];
	issues: DocsSiteIssue[];
}

export interface RenderDocsSiteOptions {
	signal?: AbortSignal;
}

const MESSAGES: Record<'en' | 'fr', Record<DocsSiteMessageKey, string>> = {
	en: docsSiteEn,
	fr: docsSiteFr
};

const MAX_PAGE_SEARCH_CHARS = 12_000;
const MAX_TOTAL_SEARCH_CHARS = 3_000_000;
const MAX_TOC_ENTRIES = 200;

function t(plan: DocsSitePlan, key: DocsSiteMessageKey): string {
	return (MESSAGES[plan.locale] ?? docsSiteEn)[key] ?? docsSiteEn[key] ?? key;
}

function fragmentOf(destination: string): string {
	const hash = destination.indexOf('#');
	return hash < 0 ? '' : destination.slice(hash + 1);
}

function externalHref(destination: string): boolean {
	return /^(?:https?:)?\/\//i.test(destination.trim());
}

function addAnchorIssue(
	plan: DocsSitePlan,
	page: PlannedPage,
	href: string,
	issues: DocsSiteIssue[]
): void {
	const fragment = fragmentOf(href);
	if (!fragment) return;
	const resolved = resolveSiteDestination(plan, page.sourcePath, href, 'link');
	if (resolved.kind === 'page' && resolved.outputPath) {
		const target = plan.pageByOutput.get(pathKey(resolved.outputPath));
		if (!target || target.anchorIds.has(fragment)) return;
	} else if (resolved.kind === 'fragment') {
		if (page.anchorIds.has(fragment)) return;
	} else return;
	issues.push(
		docsSiteIssue(
			'anchor-missing',
			'warning',
			page.sourcePath,
			href,
			`Missing anchor "${fragment}".`
		)
	);
}

function applyRemoteMediaPolicy(
	fragment: DocumentFragment,
	plan: DocsSitePlan,
	page: PlannedPage,
	issues: DocsSiteIssue[]
): void {
	for (const image of fragment.querySelectorAll<HTMLImageElement>('img')) {
		image.removeAttribute('srcset');
		image.removeAttribute('crossorigin');
		const blocked = image.getAttribute('data-mdsh-remote-src');
		if (blocked) {
			issues.push(
				docsSiteIssue(
					'image-external',
					'warning',
					page.sourcePath,
					blocked,
					`Remote image "${blocked}" is not downloaded. The export removes its source.`
				)
			);
			image.removeAttribute('src');
			image.removeAttribute('data-mdsh-remote-src');
			image.setAttribute('data-blocked-label', t(plan, 'site.imageBlocked'));
			image.classList.add('mdsh-remote-image-blocked');
			continue;
		}
		const src = image.getAttribute('src');
		if (!src) continue;
		if (/^data:/i.test(src)) continue;
		const resolved = resolveSiteDestination(plan, page.sourcePath, src, 'image');
		if (resolved.kind === 'asset' || resolved.kind === 'file') {
			if (resolved.href) {
				image.setAttribute('src', resolved.href);
				image.setAttribute('loading', 'lazy');
				image.setAttribute('decoding', 'async');
			}
			continue;
		}
		if (resolved.kind === 'external') {
			issues.push(
				docsSiteIssue(
					'image-external',
					'warning',
					page.sourcePath,
					src,
					`Remote image "${src}" is not downloaded. The export removes its source.`
				)
			);
			image.removeAttribute('src');
			image.setAttribute('data-blocked-label', t(plan, 'site.imageBlocked'));
			image.setAttribute('data-mdsh-remote-src', src);
			image.classList.add('mdsh-remote-image-blocked');
			continue;
		}
		issues.push(
			docsSiteIssue('image-missing', 'error', page.sourcePath, src, `Missing image "${src}".`)
		);
		image.removeAttribute('src');
		image.setAttribute('data-mdsh-missing-src', src);
	}

	for (const media of fragment.querySelectorAll<HTMLElement>('audio, video, source, track')) {
		media.removeAttribute('srcset');
		for (const attribute of ['src', 'poster']) {
			const source = media.getAttribute(attribute);
			if (!source) continue;
			if (/^data:/i.test(source)) continue;
			const resolved = resolveSiteDestination(plan, page.sourcePath, source, 'link');
			if (resolved.kind === 'asset' || resolved.kind === 'file') {
				if (resolved.href) media.setAttribute(attribute, resolved.href);
				continue;
			}
			if (resolved.kind === 'external') {
				issues.push(
					docsSiteIssue(
						'image-external',
						'warning',
						page.sourcePath,
						source,
						`Remote image "${source}" is not downloaded. The export removes its source.`
					)
				);
			}
			media.removeAttribute(attribute);
			media.setAttribute(`data-mdsh-remote-${attribute}`, source);
		}
	}

	for (const image of fragment.querySelectorAll<SVGImageElement>('svg image')) {
		for (const attribute of ['href', 'xlink:href']) {
			const source = image.getAttribute(attribute);
			if (!source || /^data:/i.test(source) || source.startsWith('#')) continue;
			const resolved = resolveSiteDestination(plan, page.sourcePath, source, 'image');
			if (resolved.kind === 'asset' || resolved.kind === 'file') {
				if (resolved.href) image.setAttribute(attribute, resolved.href);
			} else {
				image.removeAttribute(attribute);
			}
		}
	}
}

function applyLinkPolicy(
	fragment: DocumentFragment,
	plan: DocsSitePlan,
	page: PlannedPage,
	issues: DocsSiteIssue[]
): void {
	for (const anchor of fragment.querySelectorAll<HTMLAnchorElement>('a[href]')) {
		const wiki = anchor.getAttribute('data-mdsh-wiki');
		if (wiki) {
			let target = wiki;
			try {
				target = decodeURIComponent(wiki);
			} catch {
				/* Keep the raw target. */
			}
			const resolved = resolveSiteWikiDestination(plan, page.sourcePath, target);
			if (resolved.kind === 'page' && resolved.href) {
				anchor.setAttribute('href', resolved.href);
				anchor.removeAttribute('data-mdsh-wiki');
				addAnchorIssue(plan, page, resolved.href, issues);
			} else {
				issues.push(
					docsSiteIssue(
						resolved.reason === 'ambiguous' ? 'link-ambiguous' : 'link-missing',
						'error',
						page.sourcePath,
						target,
						resolved.reason === 'ambiguous'
							? `Several documents match "${target}".`
							: `Missing link target "${target}".`
					)
				);
				anchor.removeAttribute('href');
			}
			continue;
		}
		const href = anchor.getAttribute('href');
		if (!href) continue;
		const resolved = resolveSiteDestination(plan, page.sourcePath, href, 'link');
		if (resolved.kind === 'page' || resolved.kind === 'asset' || resolved.kind === 'file') {
			if (resolved.href) anchor.setAttribute('href', resolved.href);
			addAnchorIssue(plan, page, resolved.href ?? href, issues);
			continue;
		}
		if (resolved.kind === 'fragment') {
			addAnchorIssue(plan, page, href, issues);
			continue;
		}
		if (resolved.kind === 'external') {
			issues.push(
				docsSiteIssue(
					'link-external',
					'warning',
					page.sourcePath,
					href,
					`External link "${href}" is kept as a link.`
				)
			);
			if (externalHref(href)) {
				anchor.setAttribute('target', '_blank');
				anchor.setAttribute('rel', 'noopener noreferrer');
			}
			continue;
		}
		if (resolved.kind === 'outside-project') {
			issues.push(
				docsSiteIssue(
					'link-outside-project',
					'error',
					page.sourcePath,
					href,
					`"${href}" is outside the project.`
				)
			);
			anchor.removeAttribute('href');
			continue;
		}
		if (resolved.kind === 'missing') {
			issues.push(
				docsSiteIssue(
					'link-missing',
					'error',
					page.sourcePath,
					href,
					`Missing link target "${href}".`
				)
			);
			anchor.removeAttribute('href');
		}
	}
}

function collectToc(fragment: DocumentFragment): SiteTocEntry[] {
	const toc: SiteTocEntry[] = [];
	for (const heading of fragment.querySelectorAll<HTMLElement>('h2, h3')) {
		const id = heading.getAttribute('id');
		const text = (heading.textContent ?? '').trim();
		if (!id || !text) continue;
		toc.push({ id, text, level: Number(heading.tagName.slice(1)) });
		if (toc.length >= MAX_TOC_ENTRIES) break;
	}
	return toc;
}

function collectSearchText(fragment: DocumentFragment): string {
	const clone = fragment.cloneNode(true) as DocumentFragment;
	for (const node of clone.querySelectorAll('.mdsh-anchor, script, style, template')) node.remove();
	return (clone.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_PAGE_SEARCH_CHARS);
}

function buildArticle(
	plan: DocsSitePlan,
	page: PlannedPage,
	rendered: Awaited<ReturnType<typeof renderMarkdownDetailed>>
): {
	articleHtml: string;
	description: string | undefined;
	tags: string[];
	toc: SiteTocEntry[];
	searchText: string;
	issues: DocsSiteIssue[];
} {
	const issues: DocsSiteIssue[] = [];
	const template = document.createElement('template');
	template.innerHTML = rendered.html;
	applyLinkPolicy(template.content, plan, page, issues);
	applyRemoteMediaPolicy(template.content, plan, page, issues);
	const toc = collectToc(template.content);
	const searchText = collectSearchText(template.content);
	const description =
		typeof rendered.frontmatter.description === 'string' && rendered.frontmatter.description.trim()
			? rendered.frontmatter.description.trim()
			: undefined;
	return {
		articleHtml: template.innerHTML,
		description,
		tags: getTags(rendered.frontmatter),
		toc,
		searchText,
		issues
	};
}

/** Renders every page and collects the final resource issues. */
export async function renderDocsSite(
	plan: DocsSitePlan,
	options: RenderDocsSiteOptions = {}
): Promise<RenderedDocsSite> {
	if (typeof document === 'undefined') throw new Error('Site export requires a browser document');
	checkAborted(options.signal);
	const pages: RenderedSitePage[] = [];
	const issues: DocsSiteIssue[] = [...plan.issues];
	for (const page of plan.pages) {
		checkAborted(options.signal);
		const rendered = await renderMarkdownDetailed(page.content, {
			showFrontmatter: false,
			headingPermalinks: true,
			allowRemoteImages: true,
			preserveLocalImages: true,
			mermaidTheme: 'default',
			...(options.signal ? { signal: options.signal } : {})
		});
		checkAborted(options.signal);
		const article = buildArticle(plan, page, rendered);
		issues.push(...article.issues);
		pages.push({
			page,
			title: rendered.title?.trim() || pageFallbackTitle(page),
			description: article.description,
			tags: article.tags,
			articleHtml: article.articleHtml,
			toc: article.toc,
			searchText: article.searchText
		});
	}
	return { pages, issues: mergeIssues(issues, []) };
}

function rootPrefix(outputPath: string): string {
	const depth = outputPath.split('/').length - 1;
	return depth > 0 ? '../'.repeat(depth) : './';
}

function siteHome(plan: DocsSitePlan): PlannedPage | undefined {
	return plan.pageByOutput.get('index.html') ?? plan.pages[0];
}

function pageDocument(
	plan: DocsSitePlan,
	pages: readonly RenderedSitePage[],
	current: RenderedSitePage
): string {
	const page = current.page;
	const safeTitle = escapeHTML(current.title);
	const safeSite = escapeHTML(plan.name);
	const title = `${safeTitle} - ${safeSite}`;
	const description = escapeHTML(current.description ?? t(plan, 'site.description'));
	const stylesheet = relativeDestination(page.outputPath, plan.internal.stylesheet);
	const script = relativeDestination(page.outputPath, plan.internal.script);
	const searchIndex = relativeDestination(page.outputPath, plan.internal.searchIndex);
	const home = siteHome(plan);
	const homeHref = home ? relativeDestination(page.outputPath, home.outputPath) : './index.html';
	const root = rootPrefix(page.outputPath);
	const nav = pages
		.toSorted((a, b) =>
			a.page.sourcePath < b.page.sourcePath ? -1 : a.page.sourcePath > b.page.sourcePath ? 1 : 0
		)
		.map((entry) => {
			const href = relativeDestination(page.outputPath, entry.page.outputPath);
			const active = entry.page.outputPath === page.outputPath;
			return `<li><a href="${escapeHTML(href)}"${active ? ' aria-current="page"' : ''}>${escapeHTML(entry.title)}</a></li>`;
		})
		.join('\n');
	const toc =
		current.toc.length > 0
			? `<nav class="site-toc" aria-label="${escapeHTML(t(plan, 'site.toc'))}">
<h2>${escapeHTML(t(plan, 'site.toc'))}</h2>
<ul>${current.toc
					.map(
						(entry) =>
							`<li class="site-toc-level-${entry.level}"><a href="#${escapeHTML(entry.id)}">${escapeHTML(entry.text)}</a></li>`
					)
					.join('')}</ul>
</nav>`
			: '';
	const tags =
		current.tags.length > 0
			? `<ul class="site-tags" aria-label="${escapeHTML(t(plan, 'site.tags'))}">${current.tags
					.map((tag) => `<li>${escapeHTML(tag)}</li>`)
					.join('')}</ul>`
			: '';
	const descriptionBlock = current.description
		? `<p class="site-summary">${escapeHTML(current.description)}</p>`
		: '';
	const search = plan.includeSearchIndex
		? `<form class="site-search" role="search" data-site-search data-search-hint="${escapeHTML(t(plan, 'site.searchHint'))}" data-search-empty="${escapeHTML(t(plan, 'site.searchEmpty'))}" data-search-results="${escapeHTML(t(plan, 'site.searchResults'))}">
<label class="site-search-label" for="site-search-input">${escapeHTML(t(plan, 'site.search'))}</label>
<input id="site-search-input" type="search" name="q" autocomplete="off" placeholder="${escapeHTML(t(plan, 'site.searchPlaceholder'))}">
<p class="site-search-status" data-site-search-status role="status" aria-live="polite">${escapeHTML(t(plan, 'site.searchHint'))}</p>
<ol class="site-search-results" data-site-search-results></ol>
<noscript><p>${escapeHTML(t(plan, 'site.searchUnavailable'))}</p></noscript>
</form>`
		: '';
	const scripts = plan.includeSearchIndex
		? `<script src="${escapeHTML(searchIndex)}" defer></script>
<script src="${escapeHTML(script)}" defer></script>`
		: `<script src="${escapeHTML(script)}" defer></script>`;
	return `<!doctype html>
<html lang="${escapeHTML(plan.locale)}" data-site-root="${escapeHTML(root)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; font-src 'self' data:; base-uri 'none'; form-action 'none'; object-src 'none'">
<meta name="description" content="${description}">
<link rel="icon" href="data:,">
<link rel="stylesheet" href="${escapeHTML(stylesheet)}">
<title>${title}</title>
</head>
<body>
<a class="site-skip" href="#main">${escapeHTML(t(plan, 'site.skip'))}</a>
<header class="site-header">
<a class="site-brand" href="${escapeHTML(homeHref)}">${safeSite}</a>
<button class="site-theme" type="button" data-site-theme aria-label="${escapeHTML(t(plan, 'site.theme'))}" aria-pressed="false"><span aria-hidden="true">◐</span></button>
</header>
<div class="site-layout">
<nav class="site-nav" aria-label="${escapeHTML(t(plan, 'site.navigation'))}">
<h2>${escapeHTML(t(plan, 'site.navigation'))}</h2>
<ul>
${nav}
</ul>
</nav>
<main id="main" class="site-main">
<header class="site-page-header">
<h1>${safeTitle}</h1>
${descriptionBlock}
${tags}
</header>
<article class="site-content">
${current.articleHtml}
</article>
</main>
<aside class="site-aside">
${search}
${toc}
</aside>
</div>
<footer class="site-footer"><p>${escapeHTML(t(plan, 'site.footer'))}</p></footer>
${scripts}
</body>
</html>
`;
}

const EMPTY = new Uint8Array(0);

function encoder(): TextEncoder {
	return new TextEncoder();
}

/** Builds every file of the site in stable path order. */
export function buildDocsSiteFiles(plan: DocsSitePlan, rendered: RenderedDocsSite): DocsSiteFile[] {
	const encoderInstance = encoder();
	const files: DocsSiteFile[] = [];
	for (const page of rendered.pages) {
		files.push({
			path: page.page.outputPath,
			mime: 'text/html;charset=utf-8',
			data: encoderInstance.encode(pageDocument(plan, rendered.pages, page))
		});
	}
	for (const asset of plan.assets) {
		files.push({ path: asset.outputPath, mime: asset.mime, data: asset.data });
	}
	for (const file of plan.files) {
		files.push({ path: file.outputPath, mime: file.mime, data: file.data });
	}
	files.push({
		path: plan.internal.marker,
		mime: 'application/octet-stream',
		data: EMPTY
	});
	files.push({
		path: plan.internal.stylesheet,
		mime: 'text/css;charset=utf-8',
		data: encoderInstance.encode(DOCS_SITE_STYLESHEET)
	});
	files.push({
		path: plan.internal.script,
		mime: 'text/javascript;charset=utf-8',
		data: encoderInstance.encode(DOCS_SITE_SCRIPT)
	});
	if (plan.includeSearchIndex) {
		files.push({
			path: plan.internal.searchIndex,
			mime: 'text/javascript;charset=utf-8',
			data: encoderInstance.encode(buildSearchIndexScript(rendered.pages))
		});
	}
	return files.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function buildSearchIndexScript(pages: readonly RenderedSitePage[]): string {
	let remaining = MAX_TOTAL_SEARCH_CHARS;
	const entries = pages
		.toSorted((a, b) => (a.page.outputPath < b.page.outputPath ? -1 : 1))
		.map((page) => {
			const text = page.searchText.slice(0, Math.max(0, remaining));
			remaining -= text.length;
			return {
				path: page.page.outputPath,
				title: page.title,
				headings: page.toc.map((entry) => entry.text),
				text
			};
		});
	const payload = JSON.stringify({ schema: 'mdsh-docs-site-search/1', pages: entries }).replace(
		/</g,
		'\\u003c'
	);
	return `window.MDSH_SEARCH_INDEX = ${payload};\n`;
}

export const DOCS_SITE_STYLESHEET = `:root {
	color-scheme: light dark;
	--site-bg: #ffffff;
	--site-bg-soft: #f6f7f8;
	--site-bg-raised: #ffffff;
	--site-fg: #1c1f23;
	--site-muted: #5b6470;
	--site-border: #dfe3e8;
	--site-accent: #155e48;
	--site-accent-soft: #e6f3ed;
	--site-code: #f3f5f7;
	--site-code-border: #d9dee5;
	--site-danger: #9b2c2c;
	--site-shadow: 0 1px 2px rgb(15 23 42 / 8%);
	--site-font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, ui-sans-serif, system-ui, sans-serif;
	--site-mono: ui-monospace, "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace;
}

:root[data-theme="dark"] {
	--site-bg: #14181c;
	--site-bg-soft: #1b2026;
	--site-bg-raised: #20262d;
	--site-fg: #e7ebef;
	--site-muted: #a7b0ba;
	--site-border: #333b44;
	--site-accent: #6fd1a8;
	--site-accent-soft: #1f3a31;
	--site-code: #1b2127;
	--site-code-border: #343d47;
	--site-danger: #ff8c8c;
	--site-shadow: 0 1px 3px rgb(0 0 0 / 45%);
}

@media (prefers-color-scheme: dark) {
	:root:not([data-theme="light"]) {
		--site-bg: #14181c;
		--site-bg-soft: #1b2026;
		--site-bg-raised: #20262d;
		--site-fg: #e7ebef;
		--site-muted: #a7b0ba;
		--site-border: #333b44;
		--site-accent: #6fd1a8;
		--site-accent-soft: #1f3a31;
		--site-code: #1b2127;
		--site-code-border: #343d47;
		--site-danger: #ff8c8c;
		--site-shadow: 0 1px 3px rgb(0 0 0 / 45%);
	}
}

* { box-sizing: border-box; }
html { background: var(--site-bg); }
body {
	margin: 0;
	background: var(--site-bg);
	color: var(--site-fg);
	font: 16px/1.65 var(--site-font);
	text-rendering: optimizeLegibility;
}
a { color: var(--site-accent); text-decoration: underline; text-underline-offset: 2px; }
a:hover { text-decoration-thickness: 2px; }
button, input { font: inherit; }
:focus-visible { outline: 3px solid var(--site-accent); outline-offset: 2px; }

.site-skip {
	position: absolute;
	left: 0.5rem;
	top: -4rem;
	z-index: 20;
	padding: 0.5rem 0.75rem;
	background: var(--site-bg-raised);
	border: 1px solid var(--site-border);
	border-radius: 6px;
}
.site-skip:focus { top: 0.5rem; }

.site-header {
	position: sticky;
	top: 0;
	z-index: 10;
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 1rem;
	padding: 0.75rem 1.25rem;
	background: var(--site-bg);
	background: color-mix(in srgb, var(--site-bg) 88%, transparent);
	border-bottom: 1px solid var(--site-border);
	backdrop-filter: blur(8px);
}
.site-brand { font-weight: 700; font-size: 1rem; text-decoration: none; }
.site-theme {
	padding: 0.3rem 0.55rem;
	color: var(--site-fg);
	background: var(--site-bg-soft);
	border: 1px solid var(--site-border);
	border-radius: 6px;
	cursor: pointer;
}
.site-theme[aria-pressed="true"] { background: var(--site-accent-soft); }

.site-layout {
	display: grid;
	grid-template-columns: minmax(12rem, 16rem) minmax(0, 1fr) minmax(12rem, 17rem);
	gap: 2rem;
	max-width: 92rem;
	margin: 0 auto;
	padding: 1.5rem 1.25rem 3rem;
}
.site-nav, .site-aside { position: sticky; top: 4rem; align-self: start; max-height: calc(100dvh - 5rem); overflow: auto; }
.site-nav h2, .site-toc h2, .site-search-label {
	margin: 0 0 0.6rem;
	color: var(--site-muted);
	font-size: 0.72rem;
	font-weight: 700;
	letter-spacing: 0.08em;
	text-transform: uppercase;
}
.site-nav ul, .site-toc ul, .site-search-results, .site-tags { margin: 0; padding: 0; list-style: none; }
.site-nav li { margin: 0.15rem 0; }
.site-nav a { display: block; padding: 0.3rem 0.5rem; border-radius: 6px; color: var(--site-fg); text-decoration: none; }
.site-nav a:hover { background: var(--site-bg-soft); }
.site-nav a[aria-current="page"] { background: var(--site-accent-soft); color: var(--site-accent); font-weight: 600; }
.site-main { min-width: 0; }
.site-page-header { margin-bottom: 1.5rem; padding-bottom: 1rem; border-bottom: 1px solid var(--site-border); }
.site-page-header h1 { margin: 0 0 0.5rem; font-size: clamp(1.8rem, 3vw, 2.6rem); line-height: 1.15; letter-spacing: -0.02em; }
.site-summary { margin: 0.4rem 0 0.8rem; color: var(--site-muted); font-size: 1.05rem; }
.site-tags { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.site-tags li { padding: 0.1rem 0.5rem; background: var(--site-bg-soft); border: 1px solid var(--site-border); border-radius: 999px; color: var(--site-muted); font-size: 0.78rem; }
.site-content { max-width: 54rem; }
.site-content h1, .site-content h2, .site-content h3, .site-content h4, .site-content h5, .site-content h6 { margin: 1.6em 0 0.5em; line-height: 1.25; letter-spacing: -0.01em; }
.site-content h1 { font-size: 2rem; }
.site-content h2 { font-size: 1.55rem; padding-bottom: 0.2em; border-bottom: 1px solid var(--site-border); }
.site-content h3 { font-size: 1.25rem; }
.site-content p { margin: 0 0 0.9rem; }
.site-content ul, .site-content ol { padding-left: 1.5rem; }
.site-content li { margin: 0.2rem 0; }
.site-content li.task-list-item { list-style: none; }
.site-content li.task-list-item input { margin: 0 0.4rem 0 -1.25rem; }
.site-content blockquote { margin: 1rem 0; padding: 0.2rem 1rem; border-left: 3px solid var(--site-border); color: var(--site-muted); }
.site-content hr { margin: 2rem 0; border: 0; border-top: 1px solid var(--site-border); }
.site-content img { max-width: 100%; height: auto; margin: 1rem auto; display: block; border-radius: 4px; }
.site-content .mdsh-remote-image-blocked { min-height: 1.5rem; padding: 0.75rem; border: 1px dashed var(--site-border); color: var(--site-muted); }
.site-content .mdsh-remote-image-blocked::after { content: attr(data-blocked-label); }
.site-content code { font-family: var(--site-mono); font-size: 0.88em; background: var(--site-code); border: 1px solid var(--site-code-border); border-radius: 4px; padding: 0.1em 0.35em; }
.site-content pre { overflow-x: auto; padding: 1rem; background: var(--site-code); border: 1px solid var(--site-code-border); border-radius: 8px; }
.site-content pre code { padding: 0; background: transparent; border: 0; }
.site-content table { width: 100%; margin: 1rem 0; border-collapse: collapse; font-size: 0.94rem; }
.site-content th, .site-content td { padding: 0.5rem 0.7rem; border: 1px solid var(--site-border); text-align: left; vertical-align: top; }
.site-content th { background: var(--site-bg-soft); }
.site-content .katex { font-size: 1.05em; }
.site-content .math-block { overflow-x: auto; text-align: center; }
.site-content .math-error { color: var(--site-danger); font-family: var(--site-mono); }
.site-content .mermaid-block { overflow-x: auto; text-align: center; }
.site-content .mermaid-block svg { max-width: 100%; height: auto; }
.site-content .mdsh-anchor { margin-left: 0.35rem; opacity: 0; text-decoration: none; }
.site-content h1:hover .mdsh-anchor, .site-content h2:hover .mdsh-anchor, .site-content h3:hover .mdsh-anchor, .site-content .mdsh-anchor:focus { opacity: 1; }
.site-content .mdsh-anchor::after { content: "#"; }
.site-aside { display: flex; flex-direction: column; gap: 1.5rem; }
.site-search { padding: 0.8rem; background: var(--site-bg-soft); border: 1px solid var(--site-border); border-radius: 8px; }
.site-search-label { display: block; }
.site-search input { width: 100%; padding: 0.45rem 0.55rem; color: var(--site-fg); background: var(--site-bg-raised); border: 1px solid var(--site-border); border-radius: 6px; }
.site-search-status { margin: 0.5rem 0 0; color: var(--site-muted); font-size: 0.8rem; }
.site-search-results { margin-top: 0.5rem; }
.site-search-results li { margin: 0.4rem 0; }
.site-search-results a { display: block; padding: 0.3rem 0.4rem; border-radius: 5px; text-decoration: none; }
.site-search-results a:hover { background: var(--site-bg-raised); }
.site-search-results strong { display: block; font-size: 0.86rem; }
.site-search-results span { display: block; color: var(--site-muted); font-size: 0.76rem; line-height: 1.4; }
.site-toc { padding-left: 0.8rem; border-left: 2px solid var(--site-border); }
.site-toc li { margin: 0.25rem 0; font-size: 0.84rem; }
.site-toc-level-3 { padding-left: 0.75rem; }
.site-toc a { color: var(--site-muted); text-decoration: none; }
.site-toc a:hover { color: var(--site-accent); text-decoration: underline; }
.site-footer { padding: 1.25rem; border-top: 1px solid var(--site-border); color: var(--site-muted); font-size: 0.8rem; text-align: center; }

.hljs { color: #24292f; background: transparent; }
.hljs-doctag, .hljs-keyword, .hljs-meta .hljs-keyword, .hljs-template-tag, .hljs-template-variable, .hljs-type, .hljs-variable.language_ { color: #cf222e; }
.hljs-title, .hljs-title.class_, .hljs-title.function_ { color: #8250df; }
.hljs-attr, .hljs-attribute, .hljs-literal, .hljs-meta, .hljs-number, .hljs-operator, .hljs-variable, .hljs-selector-attr, .hljs-selector-class, .hljs-selector-id { color: #0550ae; }
.hljs-regexp, .hljs-string, .hljs-meta .hljs-string { color: #0a3069; }
.hljs-built_in, .hljs-symbol { color: #953800; }
.hljs-comment, .hljs-code, .hljs-formula { color: #6e7781; }
.hljs-name, .hljs-quote, .hljs-selector-pseudo, .hljs-selector-tag { color: #116329; }
.hljs-section { color: #0550ae; font-weight: 700; }
:root[data-theme="dark"] .hljs { color: #c9d1d9; }
:root[data-theme="dark"] .hljs-doctag, :root[data-theme="dark"] .hljs-keyword, :root[data-theme="dark"] .hljs-meta .hljs-keyword { color: #ff7b72; }
:root[data-theme="dark"] .hljs-title, :root[data-theme="dark"] .hljs-title.class_, :root[data-theme="dark"] .hljs-title.function_ { color: #d2a8ff; }
:root[data-theme="dark"] .hljs-attr, :root[data-theme="dark"] .hljs-attribute, :root[data-theme="dark"] .hljs-literal, :root[data-theme="dark"] .hljs-meta, :root[data-theme="dark"] .hljs-number, :root[data-theme="dark"] .hljs-operator, :root[data-theme="dark"] .hljs-variable { color: #79c0ff; }
:root[data-theme="dark"] .hljs-regexp, :root[data-theme="dark"] .hljs-string { color: #a5d6ff; }
:root[data-theme="dark"] .hljs-built_in, :root[data-theme="dark"] .hljs-symbol { color: #ffa657; }
:root[data-theme="dark"] .hljs-comment { color: #8b949e; }

@media (prefers-color-scheme: dark) {
	:root:not([data-theme="light"]) .hljs { color: #c9d1d9; }
	:root:not([data-theme="light"]) .hljs-doctag, :root:not([data-theme="light"]) .hljs-keyword, :root:not([data-theme="light"]) .hljs-meta .hljs-keyword { color: #ff7b72; }
	:root:not([data-theme="light"]) .hljs-title, :root:not([data-theme="light"]) .hljs-title.class_, :root:not([data-theme="light"]) .hljs-title.function_ { color: #d2a8ff; }
	:root:not([data-theme="light"]) .hljs-attr, :root:not([data-theme="light"]) .hljs-attribute, :root:not([data-theme="light"]) .hljs-literal, :root:not([data-theme="light"]) .hljs-meta, :root:not([data-theme="light"]) .hljs-number, :root:not([data-theme="light"]) .hljs-operator, :root:not([data-theme="light"]) .hljs-variable { color: #79c0ff; }
	:root:not([data-theme="light"]) .hljs-regexp, :root:not([data-theme="light"]) .hljs-string { color: #a5d6ff; }
	:root:not([data-theme="light"]) .hljs-built_in, :root:not([data-theme="light"]) .hljs-symbol { color: #ffa657; }
	:root:not([data-theme="light"]) .hljs-comment { color: #8b949e; }
}

@media (max-width: 64rem) {
	.site-layout { grid-template-columns: minmax(0, 1fr); gap: 1.5rem; }
	.site-nav, .site-aside { position: static; max-height: none; }
	.site-nav ul { display: flex; flex-wrap: wrap; gap: 0.25rem; }
	.site-nav a { padding: 0.35rem 0.55rem; }
	.site-aside { order: 2; }
	.site-main { order: 1; }
}

@media print {
	.site-header, .site-nav, .site-aside, .site-footer, .site-skip { display: none; }
	.site-layout { display: block; padding: 0; }
	.site-content { max-width: none; }
	body { color: #111; background: #fff; }
	a { color: #111; }
}
`;

export const DOCS_SITE_SCRIPT = `(function () {
	'use strict';
	var root = document.documentElement;
	var key = 'mdsh-docs-theme';
	var button = document.querySelector('[data-site-theme]');

	function storedTheme() {
		try {
			var value = localStorage.getItem(key);
			return value === 'dark' || value === 'light' ? value : null;
		} catch (error) {
			return null;
		}
	}
	function prefersDark() {
		return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
	}
	function isDark() {
		var value = root.getAttribute('data-theme');
		return value === 'dark' || (value !== 'light' && prefersDark());
	}
	function syncTheme() {
		if (button) button.setAttribute('aria-pressed', isDark() ? 'true' : 'false');
	}
	var saved = storedTheme();
	if (saved) root.setAttribute('data-theme', saved);
	if (button) {
		syncTheme();
		button.addEventListener('click', function () {
			var next = isDark() ? 'light' : 'dark';
			root.setAttribute('data-theme', next);
			try {
				localStorage.setItem(key, next);
			} catch (error) {
				/* The theme still applies for this page. */
			}
			syncTheme();
		});
	}
	if (window.matchMedia) {
		var media = window.matchMedia('(prefers-color-scheme: dark)');
		if (media.addEventListener) {
			media.addEventListener('change', function () {
				if (!root.getAttribute('data-theme')) syncTheme();
			});
		}
	}

	var form = document.querySelector('[data-site-search]');
	if (!form) return;
	var input = form.querySelector('input[type="search"]');
	var status = form.querySelector('[data-site-search-status]');
	var results = form.querySelector('[data-site-search-results]');
	if (!input || !status || !results) return;
	var index = window.MDSH_SEARCH_INDEX;
	var base = root.getAttribute('data-site-root') || './';
	var hint = form.getAttribute('data-search-hint') || '';
	var empty = form.getAttribute('data-search-empty') || '';
	var found = form.getAttribute('data-search-results') || '{n}';

	function normalize(value) {
		return String(value).toLocaleLowerCase();
	}
	function snippet(text, query) {
		var value = normalize(text);
		var at = value.indexOf(query);
		if (at < 0) return text.slice(0, 140);
		var start = Math.max(0, at - 50);
		return (start > 0 ? '...' : '') + text.slice(start, start + 160);
	}
	function render() {
		results.textContent = '';
		var query = normalize(input.value.trim());
		if (query.length < 2) {
			status.textContent = hint;
			return;
		}
		var pages = index && Array.isArray(index.pages) ? index.pages : [];
		var matches = [];
		for (var i = 0; i < pages.length; i++) {
			var page = pages[i];
			var title = normalize(page.title || '');
			var headings = normalize((page.headings || []).join(' '));
			var text = normalize(page.text || '');
			if (title.indexOf(query) < 0 && headings.indexOf(query) < 0 && text.indexOf(query) < 0) continue;
			matches.push({
				page: page,
				score: title.indexOf(query) === 0 ? 0 : title.indexOf(query) >= 0 ? 1 : headings.indexOf(query) >= 0 ? 2 : 3
			});
		}
		matches.sort(function (left, right) {
			var leftPath = String(left.page.path);
			var rightPath = String(right.page.path);
			return left.score - right.score || (leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0);
		});
		matches = matches.slice(0, 20);
		status.textContent = found.replace('{n}', String(matches.length));
		if (!matches.length) {
			var item = document.createElement('li');
			item.textContent = empty;
			results.appendChild(item);
			return;
		}
		for (var index = 0; index < matches.length; index++) {
			var match = matches[index];
			var entry = document.createElement('li');
			var link = document.createElement('a');
			link.href = base + match.page.path;
			var titleNode = document.createElement('strong');
			titleNode.textContent = match.page.title || match.page.path;
			var textNode = document.createElement('span');
			textNode.textContent = snippet(match.page.text || '', query);
			link.appendChild(titleNode);
			link.appendChild(textNode);
			entry.appendChild(link);
			results.appendChild(entry);
		}
	}
	input.addEventListener('input', render);
	form.addEventListener('submit', function (event) {
		event.preventDefault();
		render();
	});
	status.textContent = hint;
})();
`;

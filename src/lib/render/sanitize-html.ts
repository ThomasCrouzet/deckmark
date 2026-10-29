import { t } from '#lib/i18n/index.js';

// Shared DOMPurify helpers for markdown HTML (reading / export / print)
// and the WYSIWYG Mermaid preview. Both paths must neutralize remote
// `style="... url(https://...)"` beacons (SECURITY.md).

export interface SanitizeNode {
	tagName?: string;
	hasAttribute?: (name: string) => boolean;
	getAttribute?: (name: string) => string | null;
	setAttribute?: (name: string, value: string) => void;
	removeAttribute?: (name: string) => void;
}

function normalizeCssForInspection(style: string): string | null {
	if (/\/\*[\s\S]*$/.test(style.replace(/\/\*[\s\S]*?\*\//g, ''))) return null;
	const withoutComments = style
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/\\(?:\r\n|\r|\n|\f)/g, '');
	const decoded = withoutComments.replace(
		/\\([0-9a-f]{1,6})(?:\s)?|\\([^\r\n\f])/gi,
		(_match, hex, escaped) => {
			if (hex) {
				const codePoint = Number.parseInt(hex, 16);
				return codePoint === 0 || codePoint > 0x10ffff ? '\uFFFD' : String.fromCodePoint(codePoint);
			}
			return escaped ?? '';
		}
	);
	return [...decoded]
		.filter((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint > 0x1f && codePoint !== 0x7f;
		})
		.join('')
		.toLowerCase();
}

function hasOnlyFragmentUrls(style: string): boolean {
	const normalized = normalizeCssForInspection(style);
	if (normalized === null) return false;
	if (/(?:^|[^a-z-])(?:-webkit-)?image-set\s*\(|(?:^|[^a-z-])(?:image|src)\s*\(/.test(normalized)) {
		return false;
	}
	let cursor = 0;
	while (cursor < normalized.length) {
		const start = normalized.indexOf('url', cursor);
		if (start === -1) return true;
		let open = start + 3;
		while (/\s/.test(normalized[open] ?? '')) open++;
		if (normalized[open] !== '(') {
			cursor = open;
			continue;
		}
		const close = normalized.indexOf(')', open + 1);
		if (close === -1) return false;
		let value = normalized.slice(open + 1, close).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1).trim();
		}
		if (!/^#[a-z_][a-z0-9_.:-]*$/i.test(value)) return false;
		cursor = close + 1;
	}
	return true;
}

/** Keeps CSS `url()` values only when every value is a local fragment. */
export function stripRemoteStyleUrls(style: string): string {
	return hasOnlyFragmentUrls(style) ? style : '';
}

/** Neutralizes remote `url()` beacons on a node's leftover `style` attribute. */
export function neutralizeRemoteStyleUrls(node: SanitizeNode): void {
	if (typeof node.getAttribute !== 'function' || !node.hasAttribute?.('style')) return;
	const style = node.getAttribute('style') ?? '';
	const cleaned = stripRemoteStyleUrls(style);
	if (cleaned === '') node.removeAttribute?.('style');
}

/** SVG paint servers and use-elements may also fetch URLs outside img/src. */
export function neutralizeRemoteSvgReferences(node: SanitizeNode): void {
	if (typeof node.getAttribute !== 'function') return;
	for (const attribute of [
		'fill',
		'stroke',
		'filter',
		'clip-path',
		'mask',
		'marker-start',
		'marker-mid',
		'marker-end'
	]) {
		const value = node.getAttribute(attribute);
		if (value && /url\s*\(/i.test(value) && stripRemoteStyleUrls(value) === '')
			node.removeAttribute?.(attribute);
	}
	if (node.tagName?.toLowerCase() !== 'use') return;
	for (const attribute of ['href', 'xlink:href']) {
		const value = node.getAttribute(attribute);
		if (value && !/^#[a-z_][a-z0-9_.:-]*$/i.test(value.trim())) node.removeAttribute?.(attribute);
	}
}

function isNetworkImageSource(value: string): boolean {
	const source = value.trim();
	return source !== '' && !/^(?:data:|blob:|#)/i.test(source);
}

/** Blocks network-capable image sources unless the caller records explicit consent. */
export function applyRemoteImagePolicy(html: string, allowRemoteImages: boolean): string {
	if (typeof document === 'undefined') return html;
	const template = document.createElement('template');
	template.innerHTML = html;

	for (const image of template.content.querySelectorAll('img')) {
		image.setAttribute('referrerpolicy', 'no-referrer');
		image.setAttribute('crossorigin', 'anonymous');
		const src = image.getAttribute('src');
		if (!allowRemoteImages && src && isNetworkImageSource(src)) {
			image.setAttribute('data-mdsh-remote-src', src);
			image.removeAttribute('src');
			image.classList.add('mdsh-remote-image-blocked');
		}
		const srcset = image.getAttribute('srcset');
		if (!allowRemoteImages && srcset) {
			image.setAttribute('data-mdsh-remote-srcset', srcset);
			image.removeAttribute('srcset');
			image.classList.add('mdsh-remote-image-blocked');
		}
	}

	for (const image of template.content.querySelectorAll('svg image')) {
		for (const attribute of ['href', 'xlink:href']) {
			const source = image.getAttribute(attribute);
			if (!allowRemoteImages && source && isNetworkImageSource(source)) {
				image.setAttribute(`data-mdsh-remote-${attribute.replace(':', '-')}`, source);
				image.removeAttribute(attribute);
				image.classList.add('mdsh-remote-image-blocked');
			}
		}
	}

	return template.innerHTML;
}

/** Forces `target=_blank` + `rel=noopener noreferrer` on external http(s) links. */
export function hardenExternalLink(node: SanitizeNode): void {
	if (node.tagName?.toLowerCase() !== 'a' || !node.hasAttribute?.('href')) return;
	const href = node.getAttribute?.('href') ?? '';
	if (/^https?:/i.test(href)) {
		node.setAttribute?.('target', '_blank');
		node.setAttribute?.('rel', 'noopener noreferrer');
	}
}

let hookRegistered = false;

/** Registers the shared afterSanitizeAttributes hook once per DOMPurify instance. */
export function registerMdshDomPurifyHooks(purify: {
	addHook: (
		entryPoint: 'afterSanitizeAttributes',
		hookFunction: (node: SanitizeNode) => void
	) => void;
}): void {
	if (hookRegistered) return;
	purify.addHook('afterSanitizeAttributes', (node) => {
		hardenExternalLink(node);
		neutralizeRemoteStyleUrls(node);
		neutralizeRemoteSvgReferences(node);
	});
	hookRegistered = true;
}

export interface SanitizeHtmlConfig {
	USE_PROFILES?: { html?: boolean; svg?: boolean; svgFilters?: boolean; mathMl?: boolean };
	ADD_ATTR?: string[];
	ADD_TAGS?: string[];
	FORBID_TAGS?: string[];
	FORBID_ATTR?: string[];
}

// Copy only local paint and text properties from the generated SVG.
const MERMAID_PAINT_PROPERTIES = new Set([
	'fill',
	'fill-opacity',
	'fill-rule',
	'stroke',
	'stroke-width',
	'stroke-opacity',
	'stroke-dasharray',
	'stroke-dashoffset',
	'stroke-linecap',
	'stroke-linejoin',
	'opacity',
	'color',
	'font-family',
	'font-size',
	'font-weight',
	'font-style',
	'text-anchor',
	'dominant-baseline',
	'alignment-baseline',
	'text-decoration',
	'paint-order',
	'marker-start',
	'marker-mid',
	'marker-end',
	'visibility',
	'display'
]);

/** Converts only generated SVG CSS. Never applies it to the page. */
export function inlineMermaidStyles(html: string): string {
	const isolated = document.implementation.createHTMLDocument('');
	const template = isolated.createElement('template');
	template.innerHTML = html;
	for (const svg of template.content.querySelectorAll('svg')) {
		const original = new Map<Element, Set<string>>();
		const ranks = new Map<Element, Map<string, number>>();
		for (const node of [svg, ...svg.querySelectorAll<SVGElement>('*')]) {
			original.set(node, new Set(Array.from(node.style ?? [])));
		}
		for (const source of Array.from(svg.querySelectorAll('style'))) {
			const style = isolated.createElement('style');
			style.textContent = source.textContent;
			isolated.head.append(style);
			// The detached document has no navigation context or network loader.
			for (const rule of Array.from(style.sheet?.cssRules ?? [])) {
				if (rule.type !== 1) continue; // Ignore @import, @font-face, and nested rules.
				const css = rule as CSSStyleRule;
				for (const selector of css.selectorText.split(',')) {
					// Mermaid selectors are simple. Ignore complex pseudo-classes to prevent
					// an incorrect specificity value.
					if (!/^[\w\s.#>+~*-]+$/.test(selector)) continue;
					const specificity =
						(selector.match(/#/g)?.length ?? 0) * 10_000 +
						(selector.match(/\./g)?.length ?? 0) * 100 +
						(selector.match(/(?:^|[\s>+~])\w/g)?.length ?? 0);
					let nodes: Element[];
					try {
						nodes = [...(svg.matches(selector) ? [svg] : []), ...svg.querySelectorAll(selector)];
					} catch {
						continue;
					}
					for (const property of Array.from(css.style)) {
						if (!MERMAID_PAINT_PROPERTIES.has(property)) continue;
						const value = css.style.getPropertyValue(property);
						if (!stripRemoteStyleUrls(value)) continue;
						const priority = css.style.getPropertyPriority(property);
						const rank = specificity + (priority === 'important' ? 1_000_000 : 0);
						for (const node of nodes) {
							if (!(node instanceof SVGElement)) continue;
							// Explicit diagram styles have priority over the theme.
							if (original.get(node)?.has(property)) continue;
							const applied = ranks.get(node) ?? new Map<string, number>();
							if ((applied.get(property) ?? -1) > rank) continue;
							node.style.setProperty(property, value, priority);
							applied.set(property, rank);
							ranks.set(node, applied);
						}
					}
				}
			}
			style.remove();
			source.remove();
		}
	}
	return template.innerHTML;
}

/** Rejects media before Mermaid creates connected temporary nodes. */
export async function assertMermaidMediaSafe(code: string): Promise<void> {
	const reject = () => {
		throw new Error(t('read.mermaidUnsafeMedia'));
	};
	const source = code.replace(/^[ \t]*%%(?!\{)[^\n]*/gm, '');
	if (code.length > 50_000 || stripRemoteStyleUrls(source) === '') reject();
	for (const match of source.matchAll(/@\s*\{/g)) {
		const start = match.index + match[0].length;
		let depth = 1;
		let quote = '';
		let end = start;
		for (; end < source.length; end++) {
			const character = source[end];
			if (quote) {
				if (character === '\\' && quote === '"') {
					end++;
					continue;
				}
				if (character === quote) {
					if (quote === "'" && source[end + 1] === "'") {
						end++;
						continue;
					}
					quote = '';
				}
				continue;
			}
			if (character === '"' || character === "'") {
				let previous = end - 1;
				while (previous >= start && /[ \t]/.test(source[previous] ?? '')) previous--;
				if (previous < start || /[:{,[\n]/.test(source[previous] ?? '')) quote = character;
			} else if (character === '{') depth++;
			else if (character === '}' && --depth === 0) break;
		}
		if (depth !== 0) reject();
		const { load, JSON_SCHEMA } = await import('js-yaml');
		const metadata = source.slice(start, end);
		// Use the same schema and wrapper as Mermaid FlowDB.addVertex.
		const parsed: unknown = load(metadata.includes('\n') ? metadata + '\n' : '{' + metadata + '}', {
			schema: JSON_SCHEMA
		});
		if (parsed && typeof parsed === 'object' && 'img' in parsed) reject();
	}
}

// Both consumers share this queue and reset the singleton together. This prevents
// a light export from changing a concurrent dark preview.
let mermaidQueue: Promise<unknown> = Promise.resolve();
export function renderMermaidSvg(
	id: string,
	code: string,
	theme: 'default' | 'dark' | 'neutral' | 'forest'
): Promise<string> {
	const rendering = mermaidQueue.then(async () => {
		await assertMermaidMediaSafe(code);
		const { default: mermaid } = await import('mermaid');
		mermaid.initialize({
			startOnLoad: false,
			securityLevel: 'strict',
			theme,
			// Mermaid 12 defaults to the ELK layout and the `neo` look.
			// Pin the Mermaid 11 values to keep the current diagram output.
			layout: 'dagre',
			look: 'classic',
			htmlLabels: false,
			flowchart: { htmlLabels: false },
			secure: [
				'securityLevel',
				'startOnLoad',
				'maxTextSize',
				'maxEdges',
				'htmlLabels',
				'flowchart',
				'themeCSS',
				'themeVariables',
				'fontFamily',
				'altFontFamily'
			],
			fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
		});
		const { svg } = await mermaid.render(id, code);
		return inlineMermaidStyles(svg);
	});
	mermaidQueue = rendering.catch(() => undefined);
	return rendering;
}

/** DOMPurify config for the WYSIWYG Mermaid preview (native SVG labels). */
export const MERMAID_PREVIEW_PURIFY: SanitizeHtmlConfig = {
	USE_PROFILES: { html: true, svg: true, svgFilters: true },
	ADD_ATTR: ['target'],
	FORBID_TAGS: [
		'style',
		'foreignObject',
		'feImage',
		'animate',
		'set',
		'animateMotion',
		'animateTransform',
		'mpath'
	]
};

/** DOMPurify config for marked → HTML (reading / export). */
export const MARKDOWN_PURIFY: SanitizeHtmlConfig = {
	USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
	ADD_ATTR: [
		'target',
		'data-mdsh-wiki',
		'data-mdsh-remote-src',
		'data-mdsh-remote-srcset',
		'data-mdsh-remote-href',
		'data-mdsh-remote-xlink-href',
		'data-mdsh-image-ratio',
		'data-mdsh-media-src'
	],
	FORBID_TAGS: [
		'style',
		'form',
		'feImage',
		'animate',
		'set',
		'animateMotion',
		'animateTransform',
		'mpath'
	],
	FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur']
};

export async function sanitizeHtml(html: string, config: SanitizeHtmlConfig): Promise<string> {
	const { default: DOMPurify } = await import('dompurify');
	registerMdshDomPurifyHooks(DOMPurify);
	return DOMPurify.sanitize(html, config) as string;
}

/** Sanitizer used by the WYSIWYG Mermaid preview (same remote url() hook as read). */
export async function sanitizeMermaidPreviewHtml(html: string): Promise<string> {
	return applyRemoteImagePolicy(await sanitizeHtml(html, MERMAID_PREVIEW_PURIFY), false);
}

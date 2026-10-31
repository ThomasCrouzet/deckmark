import { browser } from '$app/env';
import { asset } from '$app/paths';
import { checkAborted } from '../abort';
import { escapeHTML } from '../file-utils';
import { t } from '../i18n';
import { DEFAULT_LOCALE } from '../i18n/locale';
import { hasMath } from '../render/markdown';
import type { PresentationDeck } from './model';
import type { RenderedPresentation } from './render';

const SCRIPT_NONCE = 'mdsh-presentation';

function resolveDocumentLang(lang?: string): string {
	const trimmed = lang?.trim();
	return trimmed ? trimmed : DEFAULT_LOCALE;
}

function assetUrl(path: string): string {
	const resolved = asset(path.slice(1) as Parameters<typeof asset>[0]);
	if (!browser) return resolved;
	return new URL(resolved, window.location.href).href;
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	const chunkSize = 0x8000;
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
	}
	return btoa(binary);
}

function fontMimeType(path: string): string {
	if (path.endsWith('.woff2')) return 'font/woff2';
	if (path.endsWith('.woff')) return 'font/woff';
	if (path.endsWith('.ttf')) return 'font/ttf';
	if (path.endsWith('.otf')) return 'font/otf';
	return 'application/octet-stream';
}

async function embeddedKatexCss(source: string, signal?: AbortSignal): Promise<string> {
	if (!hasMath(source)) return '';
	const response = await fetch(assetUrl('/katex/katex.min.css'), { signal: signal ?? null });
	if (!response.ok) throw new Error(`CSS /katex/katex.min.css: HTTP ${response.status}`);
	let css = await response.text();
	const paths = new Set(
		[...css.matchAll(/url\((['"]?)(fonts\/[^)'"\s]+)\1\)/g)]
			.map((match) => match[2])
			.filter((path): path is string => Boolean(path))
	);
	const replacements = new Map<string, string>();
	await Promise.all(
		[...paths].map(async (path) => {
			const fontResponse = await fetch(assetUrl(`/katex/${path}`), { signal: signal ?? null });
			if (!fontResponse.ok) throw new Error(`Font /katex/${path}: HTTP ${fontResponse.status}`);
			const data = bytesToBase64(new Uint8Array(await fontResponse.arrayBuffer()));
			replacements.set(path, `data:${fontMimeType(path)};base64,${data}`);
		})
	);
	css = css.replace(/url\((['"]?)(fonts\/[^)'"\s]+)\1\)/g, (_match, quote, path) => {
		const embedded = replacements.get(path);
		if (!embedded) throw new Error(`Font /katex/${path}: missing embedded data`);
		return `url(${quote}${embedded}${quote})`;
	});
	return css;
}

export function presentationCss(deck: PresentationDeck): string {
	const widthInches = deck.width / 96;
	const heightInches = deck.height / 96;
	return `
:root {
	--mdsh-slide-width: ${deck.width}px;
	--mdsh-slide-height: ${deck.height}px;
	--mdsh-slide-scale: 1;
	--mdsh-presentation-bg: #111827;
	--mdsh-presentation-control: rgba(15, 23, 42, 0.86);
	--mdsh-presentation-control-text: #f8fafc;
}
* { box-sizing: border-box; }
html, body { margin: 0; width: 100%; min-height: 100%; }
body {
	background: var(--mdsh-presentation-bg);
	color: #0f172a;
	font-family: Bahnschrift, "DIN Alternate", "Arial Narrow", "Aptos", -apple-system, BlinkMacSystemFont, "Segoe UI", ui-sans-serif, system-ui, sans-serif;
	overflow: hidden;
}
.mdsh-presentation {
	position: fixed;
	inset: 0;
	overflow: hidden;
}
.mdsh-slide {
	display: none;
	position: absolute;
	left: 50%;
	top: 50%;
	width: var(--mdsh-slide-width);
	height: var(--mdsh-slide-height);
	margin: 0;
	padding: 0;
	overflow: hidden;
	background: var(--slide-background, #fff);
	box-shadow: 0 18px 60px rgba(0, 0, 0, 0.38);
	transform: translate(-50%, -50%) scale(var(--mdsh-slide-scale));
	transform-origin: center;
	isolation: isolate;
}
.mdsh-slide.is-active { display: block; }
.mdsh-slide-element {
	position: absolute;
	box-sizing: border-box;
	transform-origin: center;
	color: var(--element-color, #0f172a);
	font-size: var(--element-font-size, 24px);
	text-align: var(--element-text-align, left);
}
.mdsh-slide-element-content { width: 100%; height: 100%; box-sizing: border-box; overflow: hidden; }
.mdsh-slide-element-rich .mdsh-slide-element-content { padding: 8px; }
.mdsh-slide-element-rich { line-height: 1.3; }
.mdsh-slide-element-rich .mdsh-slide-element-content > :first-child { margin-top: 0; }
.mdsh-slide-element-rich .mdsh-slide-element-content > :last-child { margin-bottom: 0; }
.mdsh-slide-element-rich h1,
.mdsh-slide-element-rich h2,
.mdsh-slide-element-rich h3,
.mdsh-slide-element-rich h4,
.mdsh-slide-element-rich h5,
.mdsh-slide-element-rich h6 { margin: 0 0 0.35em; font: inherit; line-height: 1.15; font-weight: 700; }
.mdsh-slide-element-rich h1 { font-size: 2em; }
.mdsh-slide-element-rich h2 { font-size: 1.55em; }
.mdsh-slide-element-rich h3 { font-size: 1.3em; }
.mdsh-slide-element-rich h4 { font-size: 1.12em; }
.mdsh-slide-element-rich h5,
.mdsh-slide-element-rich h6 { font-size: 1em; }
.mdsh-slide-element-rich p { margin: 0 0 0.55em; }
.mdsh-slide-element-rich ul,
.mdsh-slide-element-rich ol { margin: 0 0 0.55em; padding-left: 1.35em; }
.mdsh-slide-element-rich ul { list-style: disc; }
.mdsh-slide-element-rich ol { list-style: decimal; }
.mdsh-slide-element-rich li.task-list-item { list-style: none; }
.mdsh-slide-element-rich a { color: inherit; text-decoration: underline; }
.mdsh-slide-element-rich hr { margin: 0.55em 0; border: 0; border-top: 1px solid currentColor; }
.mdsh-slide-element-rich blockquote { margin: 0.5em 0; padding-left: 0.7em; border-left: 0.12em solid currentColor; }
.mdsh-slide-element-rich pre { margin: 0.45em 0; padding: 0.45em; overflow: hidden; white-space: pre-wrap; background: rgba(15, 23, 42, 0.08); }
.mdsh-slide-element-rich code { font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; font-size: 0.85em; }
.mdsh-slide-element-rich .hljs { color: #24292f; }
.mdsh-slide-element-rich .hljs-keyword,
.mdsh-slide-element-rich .hljs-selector-tag { color: #cf222e; }
.mdsh-slide-element-rich .hljs-string,
.mdsh-slide-element-rich .hljs-attr { color: #0a3069; }
.mdsh-slide-element-rich .hljs-title,
.mdsh-slide-element-rich .hljs-number { color: #8250df; }
.mdsh-slide-element-rich .hljs-comment { color: #6e7781; }
.mdsh-slide-element-rich table { width: 100%; border-collapse: collapse; }
.mdsh-slide-element-rich th,
.mdsh-slide-element-rich td { padding: 0.25em 0.4em; border: 1px solid currentColor; }
.mdsh-slide-element-rich .mermaid-block,
.mdsh-slide-element-rich .math-block { max-width: 100%; overflow: hidden; }
.mdsh-slide-element-rich svg { max-width: 100%; max-height: 100%; }
.mdsh-slide-element-image img {
	display: block;
	width: 100%;
	height: 100%;
	margin: 0;
	object-fit: contain;
}
.mdsh-slide-element-rectangle,
.mdsh-slide-element-rounded-rectangle,
.mdsh-slide-element-ellipse {
	background: var(--element-fill, transparent);
	border: var(--element-stroke-width, 0) solid var(--element-stroke, transparent);
}
.mdsh-slide-element-rounded-rectangle { border-radius: 24px; }
.mdsh-slide-element-ellipse { border-radius: 50%; }
.mdsh-slide-element-line, .mdsh-slide-element-arrow, .mdsh-slide-connector { overflow: visible; }
.mdsh-slide-connector { display: block; width: 100%; height: 100%; }
.mdsh-slide-controls {
	position: fixed;
	right: 16px;
	bottom: 16px;
	z-index: 100;
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 6px;
	border-radius: 10px;
	background: var(--mdsh-presentation-control);
	color: var(--mdsh-presentation-control-text);
	font: 600 14px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.mdsh-slide-controls button {
	width: 38px;
	height: 34px;
	border: 0;
	border-radius: 7px;
	background: transparent;
	color: inherit;
	font: inherit;
	cursor: pointer;
}
.mdsh-slide-controls button:hover, .mdsh-slide-controls button:focus-visible {
	background: rgba(255, 255, 255, 0.14);
	outline: 2px solid rgba(255, 255, 255, 0.7);
}
.mdsh-slide-counter { min-width: 62px; text-align: center; }
@page { size: ${widthInches}in ${heightInches}in; margin: 0; }
@media print {
	html, body { width: ${widthInches}in; min-height: 0; background: #fff; overflow: visible; }
	.mdsh-presentation { position: static; width: ${widthInches}in; height: auto; overflow: visible; }
	.mdsh-slide {
		display: block !important;
		position: relative;
		left: auto;
		top: auto;
		width: ${widthInches}in !important;
		height: ${heightInches}in !important;
		box-shadow: none;
		transform: none !important;
		break-inside: avoid;
		page-break-inside: avoid;
		break-after: page;
		page-break-after: always;
	}
	.mdsh-slide:last-child { break-after: auto; page-break-after: auto; }
	.mdsh-slide-controls { display: none !important; }
}
`;
}

function navigationScript(deck: PresentationDeck): string {
	return `(() => {
	const slides = Array.from(document.querySelectorAll('.mdsh-slide'));
	const counter = document.querySelector('.mdsh-slide-counter');
	let current = 0;
	const show = (next) => {
		if (!slides.length) return;
		current = Math.max(0, Math.min(slides.length - 1, next));
		slides.forEach((slide, index) => slide.classList.toggle('is-active', index === current));
		if (counter) counter.textContent = String(current + 1) + ' / ' + String(slides.length);
		document.title = document.title.replace(/ \u00b7 \\d+ \\/ \\d+$/, '') + ' \u00b7 ' + String(current + 1) + ' / ' + String(slides.length);
	};
	const fit = () => {
		const scale = Math.min(window.innerWidth / ${deck.width}, window.innerHeight / ${deck.height});
		document.documentElement.style.setProperty('--mdsh-slide-scale', String(Math.max(0.05, scale)));
	};
	document.querySelector('[data-action="previous"]')?.addEventListener('click', () => show(current - 1));
	document.querySelector('[data-action="next"]')?.addEventListener('click', () => show(current + 1));
	document.addEventListener('keydown', (event) => {
		if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(event.key)) { event.preventDefault(); show(current - 1); }
		if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(event.key)) { event.preventDefault(); show(current + 1); }
		if (event.key === 'Home') { event.preventDefault(); show(0); }
		if (event.key === 'End') { event.preventDefault(); show(slides.length - 1); }
	});
	let touchStart = null;
	document.addEventListener('pointerdown', (event) => { if (event.pointerType !== 'mouse') touchStart = event.clientX; });
	document.addEventListener('pointerup', (event) => {
		if (touchStart === null) return;
		const distance = event.clientX - touchStart;
		touchStart = null;
		if (Math.abs(distance) < 48) return;
		show(current + (distance < 0 ? 1 : -1));
	});
	window.addEventListener('resize', fit, { passive: true });
	fit();
	show(0);
})();`;
}

export async function buildPresentationHtmlDocument(
	title: string,
	deck: PresentationDeck,
	rendered: RenderedPresentation,
	lang?: string,
	signal?: AbortSignal
): Promise<string> {
	const katexCss = await embeddedKatexCss(rendered.source, signal);
	checkAborted(signal);
	const safeTitle = escapeHTML(title);
	const safeLang = escapeHTML(resolveDocumentLang(lang));
	const controls = `<nav class="mdsh-slide-controls" aria-label="${escapeHTML(t('presentation.dialogAria'))}"><button type="button" data-action="previous" aria-label="${escapeHTML(t('slides.previous'))}">&#8592;</button><span class="mdsh-slide-counter" aria-live="polite">1 / ${deck.slides.length}</span><button type="button" data-action="next" aria-label="${escapeHTML(t('slides.next'))}">&#8594;</button></nav>`;
	return `<!doctype html>
<html lang="${safeLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${SCRIPT_NONCE}'; object-src 'none'; base-uri 'none'; form-action 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:">
<title>${safeTitle}</title>
${katexCss ? `<style>${katexCss}</style>` : ''}
<style>${presentationCss(deck)}</style>
</head>
<body>
${rendered.html}
${controls}
<script nonce="${SCRIPT_NONCE}">${navigationScript(deck)}</script>
</body>
</html>`;
}

export function buildPresentationPrintDocument(
	title: string,
	deck: PresentationDeck,
	rendered: RenderedPresentation,
	lang?: string
): string {
	const safeTitle = escapeHTML(title);
	const safeLang = escapeHTML(resolveDocumentLang(lang));
	const katexLink = hasMath(rendered.source)
		? `<link rel="stylesheet" href="${assetUrl('/katex/katex.min.css')}">`
		: '';
	return `<!doctype html>
<html lang="${safeLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src data:">
<title>${safeTitle}</title>
${katexLink}
<style>${presentationCss(deck)}</style>
</head>
<body>
${rendered.html}
</body>
</html>`;
}

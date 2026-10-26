// Generation of a "print-ready" HTML document and opening of the print
// dialog via a hidden iframe - the user picks "Save as PDF".
// Loads the stylesheets from /static/ (KaTeX fonts + print stylesheet),
// respects BASE_PATH for GitHub Pages.

import { browser } from '$app/env';
import { asset } from '$app/paths';
import { escapeHTML } from '../file-utils';
import { TIMERS } from '../config';
import { hasMath } from './markdown';
import { t } from '#lib/i18n/index.js';
import { DEFAULT_LOCALE } from '#lib/i18n/locale.js';
import { isDesktop } from '../desktop';
import { checkAborted } from '../abort';

export class PrintImageError extends Error {
	constructor(public readonly sources: readonly string[]) {
		super(`Cannot print ${sources.length} undecoded image(s)`);
		this.name = 'PrintImageError';
	}
}

function abortError(): DOMException {
	return new DOMException('Printing preparation cancelled', 'AbortError');
}

export async function boundedWait<T>(
	promise: Promise<T>,
	timeoutMs: number,
	signal?: AbortSignal
): Promise<T> {
	if (signal?.aborted) throw abortError();
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(
			() => finish(() => reject(new Error('Asset loading timed out'))),
			timeoutMs
		);
		const onAbort = () => finish(() => reject(abortError()));
		const finish = (settle: () => void) => {
			clearTimeout(timer);
			signal?.removeEventListener('abort', onAbort);
			settle();
		};
		signal?.addEventListener('abort', onAbort, { once: true });
		promise.then(
			(value) => finish(() => resolve(value)),
			(error) => finish(() => reject(error))
		);
	});
}

export async function waitForPrintImages(
	doc: ParentNode,
	opts: { timeoutMs?: number; signal?: AbortSignal | undefined } = {}
): Promise<void> {
	if (opts.signal?.aborted) throw abortError();
	const failed: string[] = [];
	await Promise.all(
		Array.from(doc.querySelectorAll<HTMLImageElement>('img')).map(async (image) => {
			const source = image.getAttribute('src') ?? image.getAttribute('data-mdsh-remote-src') ?? '';
			try {
				if (!source) throw new Error('Image source is missing');
				if (image.complete && image.naturalWidth > 0 && image.naturalHeight > 0) return;
				const decoded =
					typeof image.decode === 'function'
						? image.decode()
						: new Promise<void>((resolve, reject) => {
								image.addEventListener('load', () => resolve(), { once: true });
								image.addEventListener('error', () => reject(new Error('Image loading failed')), {
									once: true
								});
							});

				await boundedWait(decoded, opts.timeoutMs ?? 10_000, opts.signal);
				if (image.naturalWidth === 0 || image.naturalHeight === 0) {
					throw new Error('Image decoded without pixels');
				}
			} catch (error) {
				if (opts.signal?.aborted) throw error;
				failed.push(source || image.alt);
			}
		})
	);
	if (failed.length > 0) throw new PrintImageError(failed);
}

export interface PrintDocumentOptions {
	title: string;
	bodyHtml: string;
	/** Raw markdown - used to decide whether to include the KaTeX CSS. */
	source?: string;
	/**
	 * BCP 47 language tag for `<html lang>`. Defaults to the app default
	 * locale (English). Callers should pass the live UI locale (`i18n.locale`).
	 */
	lang?: string;
}

/** Normalizes an optional lang tag; empty/missing → DEFAULT_LOCALE. */
function resolveDocumentLang(lang?: string): string {
	const trimmed = lang?.trim();
	return trimmed ? trimmed : DEFAULT_LOCALE;
}

function assetUrl(path: string): string {
	const resolved = asset(path.slice(1) as Parameters<typeof asset>[0]);
	if (!browser) return resolved;
	return new URL(resolved, window.location.href).href;
}

export function buildPrintDocument(opts: PrintDocumentOptions): string {
	const { title, bodyHtml, source, lang } = opts;
	const safeTitle = escapeHTML(title);
	const safeLang = escapeHTML(resolveDocumentLang(lang));

	const needsKatex = source ? hasMath(source) : /class="math-block"|class="katex/.test(bodyHtml);

	const printCssUrl = assetUrl('/print/print.css');
	const katexCssUrl = assetUrl('/katex/katex.min.css');

	const katexLink = needsKatex ? `<link rel="stylesheet" href="${katexCssUrl}">\n` : '';

	return `<!doctype html>
<html lang="${safeLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src data: blob:">
<title>${safeTitle}</title>
<link rel="stylesheet" href="${printCssUrl}">
${katexLink}</head>
<body>
<main class="print-body">
${bodyHtml}
</main>
</body>
</html>`;
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

/** Replaces every local KaTeX font reference with an embedded data URL. */
async function inlineKatexFonts(css: string, signal?: AbortSignal): Promise<string> {
	const matches = [...css.matchAll(/url\((['"]?)(fonts\/[^)'"\s]+)\1\)/g)];
	const replacements = new Map<string, string>();

	await Promise.all(
		matches.map(async (match) => {
			const path = match[2];
			if (!path) throw new Error('KaTeX font reference is missing a path');
			if (replacements.has(path)) return;
			const response = await fetch(assetUrl(`/katex/${path}`), { signal: signal ?? null });
			if (!response.ok) throw new Error(`Font /katex/${path}: HTTP ${response.status}`);
			const bytes = new Uint8Array(await response.arrayBuffer());
			replacements.set(path, `data:${fontMimeType(path)};base64,${bytesToBase64(bytes)}`);
		})
	);

	return css.replace(/url\((['"]?)(fonts\/[^)'"\s]+)\1\)/g, (_match, quote, path) => {
		const embedded = replacements.get(path);
		if (!embedded) throw new Error(`Font /katex/${path}: missing embedded data`);
		return `url(${quote}${embedded}${quote})`;
	});
}

/** Fetches the text of a stylesheet served by the app (for inlining). */
async function fetchCssText(path: string, signal?: AbortSignal): Promise<string> {
	const res = await fetch(assetUrl(path), { signal: signal ?? null });
	if (!res.ok) throw new Error(`CSS ${path} : HTTP ${res.status}`);
	return res.text();
}

/** Assembles the standalone document with the CSS INLINED into <style> tags. */
function renderStandaloneDoc(
	title: string,
	bodyHtml: string,
	styles: string[],
	lang?: string
): string {
	const safeTitle = escapeHTML(title);
	const safeLang = escapeHTML(resolveDocumentLang(lang));
	const styleTags = styles.map((css) => `<style>\n${css}\n</style>`).join('\n');
	return `<!doctype html>
<html lang="${safeLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; style-src 'unsafe-inline'; font-src data:; img-src data: blob:">
<title>${safeTitle}</title>
${styleTags}
</head>
<body>
<main class="print-body">
${bodyHtml}
</main>
</body>
</html>`;
}

/**
 * Builds standalone HTML for the downloadable .html export.
 *
 * Unlike the PDF (iframe of the SAME origin as the app), the exported .html is
 * meant to be opened from disk (`file://`) or re-served elsewhere. Its CSP
 * enforces `style-src 'self' 'unsafe-inline'`: cross-origin <link> tags would
 * be BLOCKED there (the document's origin is no longer the app's). So we INLINE
 * print.css - and, if needed, katex.min.css - into <style> tags. KaTeX fonts
 * are embedded as data URLs so the exported file has no network dependency.
 * The export fails closed if a required asset cannot be embedded.
 */
export async function buildStandaloneHtmlDocument(
	title: string,
	bodyHtml: string,
	source?: string,
	lang?: string,
	signal?: AbortSignal
): Promise<string> {
	const needsKatex = source ? hasMath(source) : /class="math-block"|class="katex/.test(bodyHtml);

	const styles: string[] = [await fetchCssText('/print/print.css', signal)];
	if (needsKatex) {
		const katexCss = await fetchCssText('/katex/katex.min.css', signal);
		styles.push(await inlineKatexFonts(katexCss, signal));
	}
	checkAborted(signal);
	return renderStandaloneDoc(title, bodyHtml, styles, lang);
}

/**
 * Opens a hidden iframe, writes the HTML into it, waits for assets to load
 * (KaTeX fonts, CSS, images), then triggers the native print dialog.
 *
 * The iframe is removed automatically after `afterprint` or after a 60 s grace
 * period (some browsers do not fire the event).
 */
export async function printInIframe(
	html: string,
	opts: { signal?: AbortSignal; onDialog?: () => void } = {}
): Promise<boolean> {
	if (!browser) throw new Error('printInIframe requires a browser environment');
	if (opts.signal?.aborted) throw abortError();
	if (isDesktop()) {
		const { printOnDesktop } = await import('./print-desktop');
		return printOnDesktop(html, opts);
	}

	const iframe = document.createElement('iframe');
	iframe.setAttribute('aria-hidden', 'true');
	iframe.setAttribute('tabindex', '-1');
	iframe.title = t('print.iframeTitle');
	// Visually hidden but rendered - required for print() to work.
	iframe.style.cssText =
		'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;z-index:-1';
	document.body.appendChild(iframe);

	const cleanup = () => {
		if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
	};

	try {
		const doc = iframe.contentDocument;
		if (!doc) throw new Error('iframe contentDocument indisponible');

		doc.open();
		doc.write(html);
		doc.close();

		// A written iframe can report complete before its stylesheets are ready.
		// Do not open a partially styled print while a local asset is still loading.
		await Promise.all(
			Array.from(doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')).map(
				async (link) => {
					if (link.sheet) return;
					let loaded!: () => void;
					let failed!: () => void;
					const ready = new Promise<void>((resolve, reject) => {
						loaded = resolve;
						failed = () => reject(new Error('Print stylesheet failed to load'));
						link.addEventListener('load', loaded, { once: true });
						link.addEventListener('error', failed, { once: true });
					});
					try {
						await boundedWait(ready, 10_000, opts.signal);
					} finally {
						link.removeEventListener('load', loaded);
						link.removeEventListener('error', failed);
					}
				}
			)
		);

		// Wait for the document to be "complete" - combines the two signals
		// (readyState + iframe load) with a timeout safety net.
		await boundedWait(
			new Promise<void>((resolve) => {
				let settled = false;
				let timer: ReturnType<typeof setTimeout> | null = null;
				const done = () => {
					if (settled) return;
					settled = true;
					if (timer) clearTimeout(timer);
					resolve();
				};
				if (iframe.contentDocument?.readyState === 'complete') {
					requestAnimationFrame(done);
					return;
				}
				iframe.addEventListener('load', done, { once: true });
				// Safety net: some browsers do not re-fire `load` after
				// `document.write()`; we unblock after 3 s no matter what.
				timer = setTimeout(done, TIMERS.printIframeLoadMs);
			}),
			TIMERS.printIframeLoadMs + 100,
			opts.signal
		);

		// Wait for the webfonts to load (KaTeX mostly).
		const idoc = iframe.contentDocument;
		if (idoc && 'fonts' in idoc) {
			try {
				await boundedWait(
					(idoc as Document & { fonts: FontFaceSet }).fonts.ready,
					10_000,
					opts.signal
				);
			} catch {
				if (opts.signal?.aborted) throw abortError();
			}
		}
		if (idoc) await waitForPrintImages(idoc, { signal: opts.signal });

		// Allow one extra frame for the layout to stabilize.
		await new Promise((r) => requestAnimationFrame(() => r(undefined)));

		const win = iframe.contentWindow;
		if (!win) throw new Error('iframe contentWindow indisponible');
		if (opts.signal?.aborted) throw abortError();

		// Cleanup after printing - afterprint or grace period.
		let removed = false;
		const removeOnce = () => {
			if (removed) return;
			removed = true;
			cleanup();
		};
		win.addEventListener('afterprint', removeOnce, { once: true });
		setTimeout(removeOnce, TIMERS.printIframeCleanupMs);

		win.focus();
		opts.onDialog?.();
		win.print();
		return true;
	} catch (err) {
		cleanup();
		throw err;
	}
}

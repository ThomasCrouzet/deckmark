// §2.5 - Copy to clipboard (raw Markdown / rich HTML).
//
// Lets you paste the document directly into an email, Notion, Slack… without
// going through a file. Rich HTML writes TWO representations to the
// clipboard (`text/html` + `text/plain`): the target app picks the most
// suitable one (rich editor → HTML; text field → raw markdown as a fallback).
//
// The renderer (`marked` + KaTeX + highlight.js + DOMPurify) stays lazy-loaded
// (dynamic import) - zero impact on the initial bundle.

import { t } from '#lib/i18n/index.js';

export function isClipboardSupported(): boolean {
	return typeof navigator !== 'undefined' && !!navigator.clipboard;
}

/** Copies the raw markdown as is. */
export async function copyMarkdown(content: string): Promise<void> {
	if (!isClipboardSupported()) throw new Error(t('palette.clipboardUnavailable'));
	await navigator.clipboard.writeText(content);
}

/**
 * Copies the document rendered as rich HTML (pasteable into a rich editor), with
 * a `text/plain` fallback = markdown source. If the `ClipboardItem` API is not
 * available, we fall back to a text copy of the HTML.
 */
export async function copyRichHtml(
	content: string,
	options: { allowNetworkImages?: boolean } = {}
): Promise<void> {
	if (!isClipboardSupported()) throw new Error(t('palette.clipboardUnavailable'));
	const html = Promise.all([import('../render/markdown'), import('../render/image-media')]).then(
		async ([{ renderMarkdown }, { prepareHtmlMediaOrThrow }]) => {
			const rendered = await renderMarkdown(content, {
				showFrontmatter: false,
				allowRemoteImages: options.allowNetworkImages === true
			});
			return prepareHtmlMediaOrThrow(rendered, {
				allowNetwork: options.allowNetworkImages === true
			});
		}
	);

	if (typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard.write === 'function') {
		const item = new ClipboardItem({
			'text/html': html.then((value) => new Blob([value], { type: 'text/html' })),
			'text/plain': new Blob([content], { type: 'text/plain' })
		});
		// Start the write during the user gesture. WebKit accepts the pending
		// representations but rejects a write started after asynchronous rendering.
		await Promise.all([navigator.clipboard.write([item]), html]);
		return;
	}
	// Fallback: no ClipboardItem (old Firefox) → we copy the HTML as text.
	await navigator.clipboard.writeText(await html);
}

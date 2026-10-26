// Mermaid live-preview for Milkdown Crepe.
//
// Use Crepe's CodeMirror `renderPreview` hook to show a WYSIWYG preview.
// See node_modules/@milkdown/components/src/code-block/config.ts. Latex uses
// the same pattern. Return `null` for other languages. Render Mermaid through
// `applyPreview` asynchronously.
//
// Load the Mermaid module only when the first Mermaid block renders. This keeps
// approximately 3 MB of minified code out of the editor bundle until needed.

import { browser } from '$app/env';
import { escapeHTML } from './file-utils';
import { mermaidThemeFromDataTheme } from './theme';
import { t } from '#lib/i18n/index.js';
import { sanitizeMermaidPreviewHtml, renderMermaidSvg } from './render/sanitize-html';

// Global counter to generate unique IDs on the Mermaid side. Mermaid stores
// internal references by ID in the produced SVG; two SVGs coexisting in the DOM
// with the same ID would corrupt the arrows (internal linkages).
let counter = 0;

/**
 * Builds a stable signature of (language, code) to discard stale renders.
 * `renderPreview` is called on every keystroke when the user edits a block -
 * without invalidation we would accumulate concurrent mermaid renders.
 */
function makeToken(language: string, content: string): string {
	return `${language}::${content}`;
}

/**
 * Renders a Mermaid block asynchronously and inserts its SVG in the preview.
 * Creates a token on each keystroke and ignores stale render promises.
 *
 * Stores one token per `applyPreview` callback in a WeakMap. This prevents an
 * edit in one block from canceling another block's render.
 *
 * Return values follow the `CodeBlockConfig.renderPreview` contract:
 * - `null`: no preview for this language (Milkdown hides the panel)
 * - `undefined` (implicit): async preview; we call `applyPreview()` later
 * - `string` / `HTMLElement`: synchronous preview (not used here)
 */
type ApplyPreview = (value: null | string | HTMLElement) => void;
const lastTokens = new WeakMap<ApplyPreview, string>();

export function renderMermaidPreview(
	language: string,
	content: string,
	applyPreview: ApplyPreview
): void | null {
	if (language.toLowerCase() !== 'mermaid') return null;
	const trimmed = content.trim();
	if (trimmed.length === 0) return null;

	if (!browser) return null;

	const token = makeToken(language, content) + document.documentElement.getAttribute('data-theme');
	lastTokens.set(applyPreview, token);

	void renderToSvg(trimmed)
		.then((html) => {
			// Stale render (typing in progress on THIS block): discard it to
			// avoid replacing a more recent render with an older one.
			if (lastTokens.get(applyPreview) !== token) return;
			applyPreview(html);
		})
		.catch((err: unknown) => {
			if (lastTokens.get(applyPreview) !== token) return;
			const msg = err instanceof Error ? err.message : String(err);
			applyPreview(buildErrorBlock(msg, trimmed));
		});

	// Returning `undefined` = async preview (Milkdown will show previewLoading
	// while the promise resolves).
	return undefined;
}

/** Re-export so tests drive the same function the preview uses. */
export { sanitizeMermaidPreviewHtml as sanitizePreviewHtml } from './render/sanitize-html';

async function renderToSvg(code: string): Promise<string> {
	try {
		const id = `mdsh-wysiwyg-mermaid-${++counter}`;
		const theme = mermaidThemeFromDataTheme(document.documentElement.getAttribute('data-theme'));
		const svg = await renderMermaidSvg(id, code, theme);
		// We wrap the SVG in a container so we can style it and ensure an
		// auto overflow on wide diagrams.
		const wrapped = `<div class="mdsh-mermaid-svg">${svg}</div>`;
		return await sanitizeMermaidPreviewHtml(wrapped);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return buildErrorBlock(msg, code);
	}
}

function buildErrorBlock(message: string, code: string): string {
	return `<div class="mdsh-mermaid-preview-error" role="alert"><strong>${escapeHTML(t('read.mermaidError'))}</strong><pre>${escapeHTML(message)}</pre><pre class="mdsh-mermaid-preview-error-source">${escapeHTML(code)}</pre></div>`;
}

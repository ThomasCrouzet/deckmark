// Export service - pure functions that turn a FileItem (or a list) into a
// download (.md / .html) or a print dialog (native PDF).
//
// Design: no dependency on the store. The functions neither mutate nor read
// the application state (no access to `filesStore`, no modification of `dirty`,
// no save scheduling). The store wraps these functions with its own
// side-effects (reset dirty, scheduleSave, spinner toast).
//
// Lazy-loading preserved: the rendering libs (`marked`, `katex`, `highlight.js`,
// `mermaid`, `dompurify`) remain dynamically imported inside the async
// functions so they do not fall into the initial bundle.
//
// Environment guard: all DOM-dependent functions check
// `typeof document !== 'undefined'` - useful in unit tests where the
// calling store cannot guarantee the context (jsdom OK, SSR no).

import type { FileItem } from '#lib/types.js';
import type { ProjectAssetRow } from '../db';
import { stripMdExtension, untitledBasename, untitledFilename } from '#lib/file-utils.js';
import { abortable, checkAborted } from '../abort';
import { IMPORT_LIMITS } from '../config';

export interface MediaExportOptions {
	allowNetworkImages?: boolean;
	signal?: AbortSignal;
	onDialog?: () => void;
}

/**
 * Sanitizes a filename for export: replaces characters forbidden on common
 * filesystems (`/ \ : * ? " < > |`) with `_`, to avoid a name like `a/b.md`
 * creating an unintended sub-tree in the ZIP or a broken `download` attribute
 * depending on the OS. Control characters are also neutralized. The file's
 * stored name is never modified - sanitization only happens at export time.
 *
 * Empty case (or containing only forbidden characters): fallback to the
 * live-locale untitled name (`files.untitledFilename`), preserving a possible
 * `.md` extension. An already valid name is returned as is (no regression).
 */
export function sanitizeFilename(name: string): string {
	// eslint-disable-next-line no-control-regex
	const cleaned = name.replace(/[/\\:*?"<>|\x00-\x1f]/g, '_');
	const trimmed = cleaned.trim();
	if (trimmed) return trimmed;
	// Empty name after sanitization: preserve the `.md` extension if present.
	return name.toLowerCase().endsWith('.md') ? untitledFilename() : untitledBasename();
}

/**
 * Triggers a file save. On the Tauri desktop shell, uses a native save dialog +
 * Rust write (WebView `<a download>` is unreliable across OS webviews). In the
 * browser, falls back to a blob + `<a download>` click.
 *
 * @returns `true` when a download/save was initiated; `false` when the user
 * cancelled the desktop save dialog (callers must NOT clear dirty or toast success).
 */
export async function triggerDownload(blob: Blob, filename: string): Promise<boolean> {
	const { isDesktop } = await import('../desktop');
	if (isDesktop()) {
		const { tauriSaveExportBlob } = await import('../disk-tauri');
		// A native cancellation or I/O error must never turn into a web download.
		return tauriSaveExportBlob(blob, filename);
	}
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(url);
	return true;
}

/**
 * Downloads the raw markdown under the file's name (`<name>.md`).
 * @returns `false` if the desktop save dialog was cancelled.
 */
export async function exportMarkdown(file: FileItem): Promise<boolean> {
	if (typeof document === 'undefined') return false;
	const blob = new Blob([file.content], { type: 'text/markdown;charset=utf-8' });
	// Sanitization at export time only: a name containing `/`, `:`, etc. would
	// break the `download` attribute or create a sub-tree.
	return triggerDownload(blob, sanitizeFilename(file.name));
}

/**
 * Downloads a standalone HTML document rendered from the markdown.
 * Async because the renderer (marked + KaTeX + highlight.js + DOMPurify) is lazy-loaded.
 *
 * The HTML / window title uses the front-matter `title` if present (otherwise
 * the filename) - consistent with the sidebar UI and the PDF export.
 */
/** @returns `false` if the desktop save dialog was cancelled. */
export async function exportHTML(
	file: FileItem,
	options: MediaExportOptions = {}
): Promise<boolean> {
	if (typeof document === 'undefined') return false;
	const [
		{ renderMarkdownDetailed },
		{ buildStandaloneHtmlDocument },
		{ prepareHtmlMediaOrThrow },
		{ i18n }
	] = await abortable(
		Promise.all([
			import('../render/markdown'),
			import('../render/print'),
			import('../render/image-media'),
			import('#lib/i18n/index.js')
		]),
		options.signal
	);
	const fallback = stripMdExtension(file.name);
	checkAborted(options.signal);
	const { html: renderedHtml, title } = await abortable(
		renderMarkdownDetailed(file.content, {
			...(file.projectId && file.relativePath
				? { projectContext: { projectId: file.projectId, relativePath: file.relativePath } }
				: {}),
			allowRemoteImages: options.allowNetworkImages === true
		}),
		options.signal
	);
	const bodyHtml = await prepareHtmlMediaOrThrow(renderedHtml, {
		allowNetwork: options.allowNetworkImages === true,
		signal: options.signal
	});
	const docTitle = title || fallback;
	const html = await buildStandaloneHtmlDocument(
		docTitle,
		bodyHtml,
		file.content,
		i18n.locale,
		options.signal
	);
	checkAborted(options.signal);
	options.onDialog?.();
	const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
	// Same sanitization as markdown/ZIP exports - path-like names break download.
	return triggerDownload(blob, sanitizeFilename(fallback + '.html'));
}

/**
 * Builds a print-ready document and opens the native print dialog
 * (the user picks "Save as PDF").
 * Async because the renderer and the print iframe are lazy-loaded.
 *
 * The filename-derived title is metadata only. The printable body contains
 * exactly the rendered Markdown content, without generated branding, title,
 * filename or front matter.
 */
export async function exportPDF(
	file: FileItem,
	options: MediaExportOptions = {}
): Promise<boolean> {
	if (typeof document === 'undefined') return false;
	const [
		{ renderMarkdownDetailed },
		{ buildPrintDocument, printInIframe },
		{ prepareHtmlMediaOrThrow },
		{ i18n }
	] = await abortable(
		Promise.all([
			import('../render/markdown'),
			import('../render/print'),
			import('../render/image-media'),
			import('#lib/i18n/index.js')
		]),
		options.signal
	);
	const fallback = stripMdExtension(file.name);
	checkAborted(options.signal);
	const { html: renderedHtml, title } = await abortable(
		renderMarkdownDetailed(file.content, {
			...(file.projectId && file.relativePath
				? { projectContext: { projectId: file.projectId, relativePath: file.relativePath } }
				: {}),
			showFrontmatter: false,
			allowRemoteImages: options.allowNetworkImages === true
		}),
		options.signal
	);
	const bodyHtml = await prepareHtmlMediaOrThrow(renderedHtml, {
		allowNetwork: options.allowNetworkImages === true,
		signal: options.signal
	});
	const docTitle = title || fallback;
	const html = buildPrintDocument({
		title: docTitle,
		bodyHtml,
		source: file.content,
		lang: i18n.locale
	});
	return printInIframe(html, options);
}

/**
 * Creates and downloads a ZIP containing all the files passed as arguments.
 *
 * A single download avoids the Chrome, Edge, and Safari prompt when N >= 2:
 * "This site wants to download multiple files".
 * It also removes the 120 ms setTimeout delay between separate downloads.
 *
 * `jszip` is lazy-loaded via `await import(...)` inside the function - it never
 * falls into the initial bundle, only when the user exports everything.
 * Cost: ~30 KB gzipped.
 *
 * Guarantees name uniqueness within the zip: two files named "Untitled.md"
 * would otherwise collide (JSZip silently overwrites the first entry). We
 * suffix `-2`, `-3`, … while preserving the extension.
 */
/** @returns `false` if the desktop save dialog was cancelled. */
export async function exportZip(files: FileItem[], filename = 'mdsh-export.zip'): Promise<boolean> {
	if (typeof window === 'undefined' || typeof document === 'undefined' || files.length === 0)
		return false;
	if (files.length > IMPORT_LIMITS.maxFiles) throw new Error('Library export document limit');
	const encoder = new TextEncoder();
	let inputBytes = 0;
	let entries = files.length;
	for (const file of files) {
		const size = encoder.encode(file.content).byteLength;
		inputBytes += size;
		if (size > IMPORT_LIMITS.maxFileBytes || inputBytes > IMPORT_LIMITS.maxBatchBytes)
			throw new Error('Library export size limit');
	}
	const projectIds = new Set(files.flatMap((file) => (file.projectId ? [file.projectId] : [])));
	const projectAssets = new Map<string, ProjectAssetRow[]>();
	if (projectIds.size) {
		const [{ db }, { PROJECT_LIMITS }] = await Promise.all([
			import('../db'),
			import('../project-archive')
		]);
		for (const projectId of projectIds) {
			const snapshot: ProjectAssetRow[] = [];
			projectAssets.set(projectId, snapshot);
			await db.projectAssets
				.where('projectId')
				.equals(projectId)
				.each((asset) => {
					inputBytes += asset.data.byteLength;
					entries++;
					if (entries > PROJECT_LIMITS.maxEntries - 3 || inputBytes > IMPORT_LIMITS.maxBatchBytes)
						throw new Error('Library export size limit');
					snapshot.push(asset);
				});
		}
	}
	const { default: JSZip } = await import('jszip');
	const zip = new JSZip();
	let archiveBytes = 0;
	const used = new Set<string>();
	function archiveName(requested: string): string {
		let name = sanitizeFilename(requested);
		if (used.has(name.toLowerCase())) {
			const ext = name.match(/\.[^.]+$/)?.[0] ?? '';
			const base = ext ? name.slice(0, -ext.length) : name;
			let i = 2;
			while (used.has(`${base}-${i}${ext}`.toLowerCase())) i++;
			name = `${base}-${i}${ext}`;
		}
		used.add(name.toLowerCase());
		return name;
	}
	for (const file of files.filter((file) => !file.projectId)) {
		archiveBytes += encoder.encode(file.content).byteLength;
		zip.file(archiveName(file.name), file.content);
	}
	if (projectIds.size) {
		const [{ db }, { buildProjectZip }] = await Promise.all([
			import('../db'),
			import('../project-archive')
		]);
		for (const projectId of projectIds) {
			const project = await db.projects.get(projectId);
			if (!project) throw new Error('Export project no longer exists');
			const assets = projectAssets.get(projectId) ?? [];
			const documents = files
				.filter((file) => file.projectId === projectId)
				.map((file) => ({ id: file.id, relativePath: file.relativePath!, content: file.content }));
			const archive = await buildProjectZip(project.name, documents, assets);
			archiveBytes += archive.size;
			if (archiveBytes > IMPORT_LIMITS.maxBatchBytes) throw new Error('Library export size limit');
			zip.file(archiveName(`${project.name}.zip`), await archive.arrayBuffer());
		}
	}
	const blob = await zip.generateAsync({ type: 'blob' });
	if (blob.size > IMPORT_LIMITS.maxBatchBytes) throw new Error('Library export size limit');
	return triggerDownload(blob, filename);
}

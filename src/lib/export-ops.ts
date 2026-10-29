// §P2.8+ - Export operations with spinner (toast) handling.
//
// Consolidates the store's exportAll / exportHTML / exportPDF / exportSelectedZip
// wrappers: each function shows the spinner, delegates to the service, then
// resets `dirty = false` and schedules a save.
//
// No Svelte runes - directly testable (mockable services).
// The store keeps only one-liner delegations.

import { browser } from '$app/env';
import {
	exportHTML as exportHTMLService,
	exportMarkdown as exportMarkdownService,
	exportPDF as exportPDFService,
	exportZip as exportZipService
} from './services/export';
import { spinnerStore } from './spinner.svelte';
import { t } from '#lib/i18n/index.js';
import { notify } from './notify.svelte';
import { reportError } from './report';
import type { FileItem } from './types';
import { promptStore } from './prompt.svelte';
import type { MediaExportOptions } from './services/export';
import { checkAborted } from './abort';

async function withMediaConsent<T>(
	operation: (options?: MediaExportOptions) => Promise<T>,
	options: MediaExportOptions = {}
): Promise<T | null> {
	try {
		return await operation(options);
	} catch (error) {
		checkAborted(options.signal);
		const { MediaPreparationError } = await import('./render/image-media');
		if (!(error instanceof MediaPreparationError) || !error.needsNetworkConsent) throw error;
		checkAborted(options.signal);
		const allowed = await promptStore.confirm({
			title: t('export.remoteImagesTitle'),
			message: t('export.remoteImagesPrompt', {
				n: error.issues.filter((issue) => issue.reason === 'blocked').length
			}),
			confirmLabel: t('export.remoteImagesConfirm')
		});
		if (!allowed) return null;
		checkAborted(options.signal);
		return operation({ ...options, allowNetworkImages: true });
	}
}

async function reportMediaFailure(error: unknown, fallback: string): Promise<void> {
	const { MediaPreparationError } = await import('./render/image-media');
	if (error instanceof MediaPreparationError) {
		const sources = error.issues
			.map((issue) => issue.source)
			.slice(0, 3)
			.join(', ');
		notify.error(t('export.mediaFailed', { n: error.issues.length, sources }));
		return;
	}
	reportError('export media', error, { notifyUser: fallback });
}

/** Callbacks injected by FilesStore. */
export interface ExportDeps {
	getFiles: () => readonly FileItem[];
	scheduleSave: (id: string) => void;
}

/**
 * Exports the file `id` as Markdown (direct download or desktop save dialog).
 * Resets `dirty = false` and schedules a save only after a real save/download
 * (`false` from the service = desktop dialog cancelled).
 */
export async function exportMarkdown(id: string, deps: ExportDeps): Promise<void> {
	const file = deps.getFiles().find((f) => f.id === id);
	if (!file || !browser) return;
	const snapshot = { ...file };
	try {
		const ok = await exportMarkdownService(snapshot);
		if (!ok) return;
		const current = deps.getFiles().find((candidate) => candidate.id === id);
		if (!current || current.content !== snapshot.content || current.name !== snapshot.name) return;
		current.dirty = false;
		deps.scheduleSave(id);
	} catch (err) {
		reportError('export Markdown', err, { notifyUser: t('export.mdFailed') });
	}
}

/**
 * Exports all files into a timestamped ZIP.
 * Spinner toast during generation (jszip lazy-loaded in the service).
 */
export async function exportAllZip(deps: ExportDeps): Promise<void> {
	if (!browser) return;
	const snapshot = deps.getFiles().map((file) => ({ ...file }));
	if (snapshot.length === 0) return;
	const dismiss = spinnerStore.show(t('export.creatingZip'));
	try {
		const stamp = new Date().toISOString().slice(0, 10);
		const ok = await exportZipService(snapshot, `mdsh-export-${stamp}.zip`);
		if (!ok) return; // desktop dialog cancelled - keep dirty, no success toast
		notify.success(t('export.zipCreated', { n: snapshot.length }));
	} catch (err) {
		reportError('export ZIP', err, { notifyUser: t('export.zipFailed') });
		return; // does not clear `dirty` if the export failed
	} finally {
		dismiss();
	}
	// Reset dirty + save for each exported file.
	const current = deps.getFiles();
	for (const file of snapshot) {
		const f = current.find((x) => x.id === file.id);
		if (!f || f.content !== file.content || f.name !== file.name) continue;
		f.dirty = false;
		deps.scheduleSave(f.id);
	}
}

/**
 * Exports a file as HTML (Mermaid + DOMPurify + KaTeX).
 * §6.6 - Spinner toast (can take 1-2 s on a large document).
 */
export async function exportHTML(id: string, deps: ExportDeps): Promise<void> {
	const file = deps.getFiles().find((f) => f.id === id);
	if (!file || !browser) return;
	const controller = new AbortController();
	const dismiss = spinnerStore.show(t('export.preparingHtml'), () => controller.abort());
	try {
		const snapshot = { ...file };
		const ok = await withMediaConsent((options) => exportHTMLService(snapshot, options), {
			signal: controller.signal,
			onDialog: () => dismiss.disableCancel?.()
		});
		if (!ok) return; // desktop dialog cancelled
		notify.success(t('export.htmlExported'));
	} catch (err) {
		if (!controller.signal.aborted) await reportMediaFailure(err, t('export.htmlFailed'));
	} finally {
		dismiss();
	}
}

/**
 * Exports a file as PDF via a print iframe.
 * §6.6 - Spinner toast (iframe + KaTeX fonts).
 */
export async function exportPDF(id: string, deps: ExportDeps): Promise<void> {
	const file = deps.getFiles().find((f) => f.id === id);
	if (!file || !browser) return;
	const controller = new AbortController();
	const dismiss = spinnerStore.show(t('export.preparingPdf'), () => controller.abort());
	try {
		const snapshot = { ...file };
		const opened = await withMediaConsent((options) => exportPDFService(snapshot, options), {
			signal: controller.signal,
			onDialog: () => dismiss.disableCancel?.()
		});
		if (opened) notify.success(t('export.printDialogOpened'));
	} catch (err) {
		if (!controller.signal.aborted) await reportMediaFailure(err, t('export.pdfFailed'));
	} finally {
		dismiss();
	}
}

/**
 * Exports the files of a selection as a ZIP.
 * No-op if the selection is empty or contains only invalid ids.
 */
export async function exportSelectionZip(
	selectedIds: ReadonlySet<string>,
	deps: ExportDeps
): Promise<void> {
	if (selectedIds.size === 0) return;
	const files = deps
		.getFiles()
		.filter((f) => selectedIds.has(f.id))
		.map((file) => ({ ...file }));
	if (files.length === 0) return;
	const dismiss = spinnerStore.show(t('export.creatingZip'));
	try {
		const stamp = new Date().toISOString().slice(0, 10);
		const ok = await exportZipService(files, `mdsh-selection-${stamp}.zip`);
		if (!ok) return; // desktop dialog cancelled
		notify.success(t('export.zipCreated', { n: files.length }));
	} catch (err) {
		reportError('ZIP export (selection)', err, { notifyUser: t('export.zipFailed') });
	} finally {
		dismiss();
	}
}

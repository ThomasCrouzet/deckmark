import { browser } from '$app/env';
import { exportMarkdown as exportMarkdownService } from './services/export';
import { t } from '#lib/i18n/index.js';
import { reportError } from './report';
import type { ExportDeps, ExportResult } from './export-ops';

/**
 * Exports the file `id` as Markdown (direct download or desktop save dialog).
 * Resets `dirty = false` and schedules a save only after a real save/download.
 * A cancelled dialog or an error returns a non-success outcome.
 */
export async function runExportMarkdown(id: string, deps: ExportDeps): Promise<ExportResult> {
	const file = deps.getFiles().find((f) => f.id === id);
	if (!file || !browser) return { outcome: 'failed', durable: false };
	const snapshot = { ...file };
	try {
		const { isDesktop } = await import('./desktop');
		const native = isDesktop();
		const ok = await exportMarkdownService(snapshot);
		if (!ok) return { outcome: 'cancelled', durable: false };
		const result: ExportResult = { outcome: native ? 'written' : 'initiated', durable: native };
		const current = deps.getFiles().find((candidate) => candidate.id === id);
		if (
			!current ||
			current.content !== snapshot.content ||
			current.name !== snapshot.name ||
			current.data !== snapshot.data ||
			current.kind !== snapshot.kind ||
			current.mime !== snapshot.mime
		)
			return result;
		current.dirty = false;
		deps.scheduleSave(id);
		return result;
	} catch (err) {
		reportError('export Markdown', err, { notifyUser: t('export.mdFailed') });
		return { outcome: 'failed', durable: false };
	}
}

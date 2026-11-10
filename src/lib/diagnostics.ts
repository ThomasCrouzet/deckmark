// Build an opt-in local diagnostic report on demand. The module is loaded only
// when the user opens the report UI, so it stays outside the startup graph.
import type { DiagnosticEvent } from './report';

export type { DiagnosticEvent };

const MAX_EVENTS = 80;
/** Documents read from IndexedDB per scan page. Bounds peak body retention. */
export const DIAGNOSTIC_STATS_PAGE_ROWS = 8;

export interface DiagnosticDocumentStats {
	documents: number;
	totalBytes: number;
	totalLines: number;
	kinds: Record<string, number>;
	/** Every durable row was counted at one revision. */
	complete: boolean;
	/** The user cancelled the scan before it finished. */
	cancelled: boolean;
}

/** One durable document projection. The body is released after counting. */
export interface DiagnosticStatsRow {
	id: string;
	content: string;
	kind?: string;
}

/** Bounded, ordered reads of the durable library. */
export interface DiagnosticStatsSource {
	count(): Promise<number>;
	page(after: string | undefined, limit: number): Promise<readonly DiagnosticStatsRow[]>;
}

export interface DiagnosticStatsProgress {
	scanned: number;
	documents: number;
}

export interface DiagnosticStatsOptions {
	source?: DiagnosticStatsSource;
	/** Rows per page. A page body stays outside the reactive document store. */
	pageRows?: number;
	signal?: AbortSignal;
	onProgress?: (progress: DiagnosticStatsProgress) => void;
	/** Returns false when an edit, delete, import or save invalidated the scan. */
	isStillCurrent?: (documents: number) => boolean;
}

const statsSource: DiagnosticStatsSource = {
	async count() {
		const { db } = await import('./db');
		return db.drafts.count();
	},
	async page(after, limit) {
		const { db } = await import('./db');
		const collection =
			after === undefined ? db.drafts.orderBy('id') : db.drafts.where(':id').above(after);
		return collection.limit(limit).toArray();
	}
};

/**
 * Counts UTF-8 bytes and lines in one pass. This keeps the encoded copy of a
 * large body out of the diagnosis path. Lone surrogates become the same three
 * bytes as the TextEncoder replacement character.
 */
export function countContent(content: string): { bytes: number; lines: number } {
	let bytes = 0;
	let lines = 0;
	for (let index = 0; index < content.length; index += 1) {
		const code = content.charCodeAt(index);
		if (code < 0x80) bytes += 1;
		else if (code < 0x800) bytes += 2;
		else if (code >= 0xd800 && code <= 0xdbff) {
			const next = content.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4;
				index += 1;
			} else bytes += 3;
		} else bytes += 3;
		if (code === 10) lines += 1;
	}
	return { bytes, lines: content.length === 0 ? 0 : lines + 1 };
}

export interface DiagnosticMetadata {
	version: string;
	edition: string;
	host: string | null;
	userAgent: string | null;
	platform: string | null;
	language: string | null;
	serviceWorker: string;
	displayMode: string | null;
	storage: {
		usage: number | null;
		quota: number | null;
		persistent: boolean | null;
	};
	capabilities: Record<string, boolean>;
}

export interface DiagnosticReportInput {
	generatedAt?: string;
	metadata: DiagnosticMetadata;
	events: readonly DiagnosticEvent[];
	stats: DiagnosticDocumentStats | null;
	description: string;
}

const MAX_REPORT_BYTES = 128 * 1024;

function emptyStats(): DiagnosticDocumentStats {
	return {
		documents: 0,
		totalBytes: 0,
		totalLines: 0,
		kinds: {},
		complete: true,
		cancelled: false
	};
}

function addRow(
	stats: DiagnosticDocumentStats,
	row: Pick<DiagnosticStatsRow, 'content' | 'kind'>
): void {
	const { bytes, lines } = countContent(row.content);
	stats.documents += 1;
	stats.totalBytes += bytes;
	stats.totalLines += lines;
	const kind = row.kind ?? 'unknown';
	stats.kinds[kind] = (stats.kinds[kind] ?? 0) + 1;
}

/** Structural statistics only. Document text and titles never enter the report. */
export function documentStats(
	files: readonly { content: string; kind?: string }[]
): DiagnosticDocumentStats {
	const stats = emptyStats();
	for (const file of files) addRow(stats, file);
	return stats;
}

/** Yields one task so a paged scan cannot block a long main-thread turn. */
function nextTask(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Counts the durable library in bounded pages. Bodies are read from IndexedDB
 * outside the reactive store and released after their bytes and lines are
 * added. A cancelled scan or a changed library returns explicit partial totals.
 */
export async function collectDocumentStats(
	options: DiagnosticStatsOptions = {}
): Promise<DiagnosticDocumentStats> {
	const source = options.source ?? statsSource;
	const pageRows = Math.max(1, options.pageRows ?? DIAGNOSTIC_STATS_PAGE_ROWS);
	const stats = emptyStats();
	const documents = await source.count();
	options.onProgress?.({ scanned: 0, documents });
	if (options.signal?.aborted) {
		stats.complete = false;
		stats.cancelled = true;
		return stats;
	}
	let after: string | undefined;
	while (true) {
		const rows = await source.page(after, pageRows);
		if (rows.length === 0) break;
		for (const row of rows) addRow(stats, row);
		after = rows[rows.length - 1]!.id;
		options.onProgress?.({ scanned: stats.documents, documents });
		if (options.signal?.aborted) {
			stats.complete = false;
			stats.cancelled = true;
			return stats;
		}
		if (rows.length < pageRows) break;
		await nextTask();
		if (options.signal?.aborted) {
			stats.complete = false;
			stats.cancelled = true;
			return stats;
		}
	}
	if (options.isStillCurrent && !options.isStillCurrent(stats.documents)) {
		stats.complete = false;
	}
	return stats;
}

/**
 * Build the exact report text. The user description stays visibly separate.
 * Unknown values stay null instead of a guessed value.
 */
export function buildDiagnosticReport(input: DiagnosticReportInput): string {
	const report = {
		format: 'deckmark-diagnostics',
		schemaVersion: 1,
		generatedAt: input.generatedAt ?? new Date().toISOString(),
		application: {
			version: input.metadata.version,
			edition: input.metadata.edition,
			host: input.metadata.host,
			sourceSha: null,
			sourceShaNote: 'The static client does not embed a trusted source SHA.'
		},
		environment: {
			userAgent: input.metadata.userAgent,
			platform: input.metadata.platform,
			language: input.metadata.language,
			serviceWorker: input.metadata.serviceWorker,
			displayMode: input.metadata.displayMode,
			storage: input.metadata.storage
		},
		capabilities: input.metadata.capabilities,
		documentStats: input.stats,
		events: input.events.slice(-MAX_EVENTS),
		description: input.description,
		omitted: [
			'document text',
			'file names and paths',
			'selected text',
			'snippets and templates',
			'API keys and authorization headers',
			'prompts, context and model replies',
			'local storage values',
			'raw console messages and stack traces'
		],
		limits: [
			'The user description is free text and can contain sensitive data.',
			'This report was built locally. Exporting it does not upload it.',
			'Unknown values are null, not inferred.'
		]
	};
	let text = `${JSON.stringify(report, null, 2)}\n`;
	if (new TextEncoder().encode(text).byteLength > MAX_REPORT_BYTES) {
		report.events = report.events.slice(-10);
		text = `${JSON.stringify(report, null, 2)}\n`;
	}
	return text;
}

/** Download the report locally. The caller keeps the exact text for the preview. */
export function downloadDiagnosticReport(
	text: string,
	filename = 'deckmark-diagnostics.json'
): void {
	if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return;
	const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
	const link = document.createElement('a');
	link.href = url;
	link.download = filename;
	document.body.append(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), 0);
}

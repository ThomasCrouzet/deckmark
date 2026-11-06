// Build an opt-in local diagnostic report on demand. The module is loaded only
// when the user opens the report UI, so it stays outside the startup graph.
import type { DiagnosticEvent } from './report';

export type { DiagnosticEvent };

const MAX_EVENTS = 80;

export interface DiagnosticDocumentStats {
	documents: number;
	totalBytes: number;
	totalLines: number;
	kinds: Record<string, number>;
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
/** Structural statistics only. Document text and titles never enter the report. */
export function documentStats(
	files: readonly { content: string; kind?: string }[]
): DiagnosticDocumentStats {
	const kinds: Record<string, number> = {};
	let totalBytes = 0;
	let totalLines = 0;
	for (const file of files) {
		const bytes = new TextEncoder().encode(file.content).byteLength;
		totalBytes += bytes;
		totalLines += file.content.length === 0 ? 0 : file.content.split('\n').length;
		const kind = file.kind ?? 'unknown';
		kinds[kind] = (kinds[kind] ?? 0) + 1;
	}
	return { documents: files.length, totalBytes, totalLines, kinds };
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

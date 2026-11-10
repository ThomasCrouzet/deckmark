import { describe, expect, it, beforeEach } from 'vitest';
import {
	buildDiagnosticReport,
	collectDocumentStats,
	countContent,
	documentStats,
	type DiagnosticStatsRow,
	type DiagnosticStatsSource
} from './diagnostics';
import { clearDiagnostics, diagnosticEvents, reportError, reportWarning } from './report';

const metadata = {
	version: '2.4.0',
	edition: 'web',
	host: 'example.test',
	userAgent: 'TestBrowser/1.0',
	platform: 'Linux',
	language: 'en',
	serviceWorker: 'ready',
	displayMode: 'browser',
	storage: { usage: 10, quota: 100, persistent: true },
	capabilities: { serviceWorker: true }
};

const secret = 'SENTINEL_SECRET_VALUE_9f3c';

interface PageRow extends DiagnosticStatsRow {
	id: string;
}

function pageSource(rows: PageRow[], pageSize: number) {
	const pages: number[] = [];
	const source: DiagnosticStatsSource = {
		count: async () => rows.length,
		page: async (after, limit) => {
			const start = after === undefined ? 0 : rows.findIndex((row) => row.id === after) + 1;
			const slice = rows.slice(start, start + limit);
			pages.push(slice.length);
			expect(limit).toBeLessThanOrEqual(pageSize);
			return slice;
		}
	};
	return { source, pages };
}

describe('diagnostic report redaction', () => {
	beforeEach(() => clearDiagnostics());

	it('keeps error names and drops error messages', () => {
		reportError('save draft', new Error(secret));
		const events = diagnosticEvents();
		expect(events).toHaveLength(1);
		expect(events[0]!.code).toBe('Error');
		const text = buildDiagnosticReport({
			metadata,
			events,
			stats: null,
			description: ''
		});
		expect(text).not.toContain(secret);
	});

	it('drops an unsafe error code instead of copying rejected values', () => {
		reportWarning('stream', { code: `code ${secret}` });
		expect(diagnosticEvents()[0]!.code).toBe('unknown_error');
	});

	it('records document statistics without text, names or paths', () => {
		const stats = documentStats([
			{ content: `${secret}\nsecond line`, kind: 'note' },
			{ content: 'print(1)\n', kind: 'code' }
		]);
		expect(stats).toEqual({
			documents: 2,
			totalBytes: expect.any(Number),
			totalLines: 4,
			kinds: { note: 1, code: 1 },
			complete: true,
			cancelled: false
		});
		const text = buildDiagnosticReport({ metadata, events: [], stats, description: '' });
		expect(text).not.toContain(secret);
		expect(text).not.toContain('second line');
	});

	it('keeps user text separate and reports unknown values as null', () => {
		const text = buildDiagnosticReport({
			metadata: { ...metadata, host: null },
			events: [],
			stats: null,
			description: `The button failed ${secret}`
		});
		const report = JSON.parse(text) as {
			description: string;
			application: { sourceSha: null; host: null };
			omitted: string[];
		};
		expect(report.description).toContain(secret);
		expect(report.application.sourceSha).toBeNull();
		expect(report.application.host).toBeNull();
		expect(report.omitted.join(' ')).toContain('API keys');
	});

	it('bounds the event buffer', () => {
		for (let index = 0; index < 200; index += 1) reportError(`scope ${index}`, {});
		expect(diagnosticEvents().length).toBeLessThanOrEqual(80);
	});
});

describe('diagnostic document counting', () => {
	it('matches the encoded-byte and line oracle on malformed syntax', () => {
		const encoder = new TextEncoder();
		const samples = [
			'',
			'a\nb',
			'line\r\nnext\n',
			'\uFEFFbom\n',
			'emoji \u{1F600}\n',
			'lone high \uD800\n',
			'lone low \uDC00',
			'\u0000nul\n\u007F'
		];
		for (const content of samples) {
			expect(countContent(content)).toEqual({
				bytes: encoder.encode(content).byteLength,
				lines: content.length === 0 ? 0 : content.split('\n').length
			});
		}
	});

	it('scans a large library in bounded pages and matches the full-body oracle', async () => {
		const rows: PageRow[] = Array.from({ length: 40 }, (_, index) => ({
			id: `row-${String(index).padStart(3, '0')}`,
			content: `# Row ${index}\n\n${'text '.repeat(2_000)}`,
			kind: index % 5 === 0 ? 'code' : 'note'
		}));
		const { source, pages } = pageSource(rows, 3);
		const stats = await collectDocumentStats({ source, pageRows: 3 });
		expect(Math.max(...pages)).toBeLessThanOrEqual(3);
		expect(stats).toEqual({ ...documentStats(rows), complete: true, cancelled: false });
		expect(stats.documents).toBe(40);
	});

	it('reports an explicit partial result when the scan is cancelled', async () => {
		const rows: PageRow[] = Array.from({ length: 10 }, (_, index) => ({
			id: `row-${index}`,
			content: `# Row ${index}\n`,
			kind: 'note'
		}));
		const controller = new AbortController();
		const { source } = pageSource(rows, 2);
		const stats = await collectDocumentStats({
			source,
			pageRows: 2,
			signal: controller.signal,
			onProgress: ({ scanned }) => {
				if (scanned > 0) controller.abort();
			}
		});
		expect(stats.cancelled).toBe(true);
		expect(stats.complete).toBe(false);
		expect(stats.documents).toBe(2);
		expect(stats.documents).toBeLessThan(rows.length);
	});

	it('marks the totals incomplete when the library changes mid-scan', async () => {
		const rows: PageRow[] = Array.from({ length: 6 }, (_, index) => ({
			id: `row-${index}`,
			content: `# Row ${index}\n`,
			kind: 'note'
		}));
		const { source } = pageSource(rows, 2);
		const stats = await collectDocumentStats({
			source,
			pageRows: 2,
			isStillCurrent: () => false
		});
		expect(stats.complete).toBe(false);
		expect(stats.cancelled).toBe(false);
		expect(stats.documents).toBe(rows.length);
	});

	it('propagates a storage read failure instead of claiming a report', async () => {
		const failure = new Error('read-failed');
		await expect(
			collectDocumentStats({
				source: {
					count: async () => 4,
					page: async () => {
						throw failure;
					}
				}
			})
		).rejects.toBe(failure);
	});
});

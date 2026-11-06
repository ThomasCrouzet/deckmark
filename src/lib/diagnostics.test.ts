import { describe, expect, it, beforeEach } from 'vitest';
import { buildDiagnosticReport, documentStats } from './diagnostics';
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
			kinds: { note: 1, code: 1 }
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

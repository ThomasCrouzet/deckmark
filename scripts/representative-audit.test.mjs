import assert from 'node:assert/strict';
import test from 'node:test';
import { percentile } from './benchmark-shared.mjs';
import { auditReport } from './representative-audit.mjs';

const MINIMUM = 20;

function stable(values) {
	const measured = values.filter((value) => Number.isFinite(value));
	return {
		denominator: measured.length,
		p50: percentile(measured, 0.5),
		p95: percentile(measured, 0.95),
		max: Math.max(...measured)
	};
}

function makeReport({ measuredRuns = MINIMUM, exactBytes = true } = {}) {
	const rawRuns = [];
	for (let run = 0; run < measuredRuns + 1; run += 1) {
		rawRuns.push({
			id: 'plain-start',
			run,
			warmup: run === 0,
			inputs: { raw: [{ inputToFrameMs: run === 0 ? 999 : 10 + run }] }
		});
	}
	const values = rawRuns
		.filter((run) => !run.warmup)
		.flatMap((run) => run.inputs.raw.map((sample) => sample.inputToFrameMs));
	const stats = stable(values);
	return {
		schema: 'deckmark-representative-editor/2',
		identity: {
			source: '0'.repeat(40),
			workingDiffSha256: '0'.repeat(64)
		},
		build: { mode: 'source-fidelity-instrumented' },
		exactBytes,
		sampling: { warmupRuns: 1, measuredRuns },
		rawRuns,
		cases: [
			{
				id: 'plain-start',
				runs: { measured: measuredRuns },
				durableExact: true,
				undoRestored: true,
				metrics: { inputToFrameMs: { ...stats, status: 'measured' } }
			}
		],
		budget: { platformKey: 'web-chromium' },
		browser: { name: 'chromium' }
	};
}

function makeBudgets(overrides = {}) {
	return {
		version: 1,
		defaults: { minimumSamples: MINIMUM, toleranceRatio: 0.5, warmupRuns: 1 },
		platforms: {
			'web-chromium': {
				metrics: {
					'plain-start.inputToFrameMs': { p95: 1000, unit: 'ms', ...overrides }
				}
			}
		}
	};
}

test('accepts a reviewed 20-run tail report', () => {
	const result = auditReport(makeReport(), makeBudgets());
	assert.equal(result.status, 'ok');
	assert.deepEqual(result.failures, []);
	assert.equal(result.cases[0].denominator, MINIMUM);
});

test('rejects a forged p95 that does not match the raw passes', () => {
	const report = makeReport();
	report.cases[0].metrics.inputToFrameMs.p95 = 1;
	const result = auditReport(report, makeBudgets());
	assert.equal(result.status, 'failed');
	assert.ok(result.failures.includes('plain-start:forged-p95'));
});

test('rejects a report that drops a measured pass', () => {
	const report = makeReport();
	report.rawRuns = report.rawRuns.filter((run) => run.run !== 7);
	const result = auditReport(report, makeBudgets());
	assert.equal(result.status, 'failed');
	assert.ok(result.failures.includes('plain-start:measured-run-count'));
	assert.ok(result.failures.includes('plain-start:denominator-mismatch'));
});

test('rejects a five-sample p95 as a tail estimate', () => {
	const report = makeReport({ measuredRuns: 5 });
	const result = auditReport(report, makeBudgets());
	assert.equal(result.status, 'failed');
	assert.ok(result.failures.includes('insufficient-measured-runs'));
});

test('rejects a regressed p95 against the reviewed budget', () => {
	const result = auditReport(makeReport(), makeBudgets({ p95: 1 }));
	assert.equal(result.status, 'failed');
	assert.ok(result.failures.includes('plain-start.inputToFrameMs:over-budget'));
});

test('rejects a report without exact durable bytes', () => {
	const result = auditReport(makeReport({ exactBytes: false }), makeBudgets());
	assert.equal(result.status, 'failed');
	assert.ok(result.failures.includes('exported-bytes-not-exact'));
});

test('rejects a budget for a metric that the engine does not support', () => {
	const report = makeReport();
	report.cases[0].metrics.inputToFrameMs.status = 'unsupported';
	const result = auditReport(report, makeBudgets());
	assert.equal(result.status, 'failed');
	assert.ok(result.failures.includes('plain-start.inputToFrameMs:unsupported'));
});

test('rejects a report without a source and build identity', () => {
	const report = makeReport();
	report.identity = {};
	report.build = {};
	const result = auditReport(report, makeBudgets());
	assert.equal(result.status, 'failed');
	assert.ok(result.failures.includes('missing-source-identity'));
	assert.ok(result.failures.includes('missing-build-identity'));
});

test('rejects a report without a reviewed platform baseline', () => {
	const result = auditReport(makeReport(), { ...makeBudgets(), platforms: {} });
	assert.equal(result.status, 'failed');
	assert.ok(result.failures.includes('missing-platform-baseline'));
});

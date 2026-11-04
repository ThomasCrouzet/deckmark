// Deterministic tests for the benchmark budget gate. They prove that missing
// evidence fails closed before any browser or native measurement runs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { budgetGateFailed, budgetReport } from './benchmark-shared.mjs';

const budgets = {
	version: 1,
	defaults: { toleranceRatio: 0.25, minimumRuns: 3 },
	platforms: {
		'web-test': {
			label: 'Test platform',
			metrics: {
				switchMs: { p95: 100, unit: 'ms' },
				heapMb: { p95: 500, unit: 'MB', optional: true }
			}
		},
		'web-allowed': {
			label: 'Allowed extra metric',
			allowUngated: ['extraMs'],
			metrics: {
				switchMs: { p95: 100, unit: 'ms' }
			}
		}
	}
};

const measured = (p95, runs = 5, unit = 'ms') => ({ measured: true, p95, runs, unit });

describe('benchmark budget gate', () => {
	it('passes when required metrics meet the tolerance', () => {
		const report = budgetReport({
			platformKey: 'web-test',
			summary: { switchMs: measured(120), heapMb: measured(400, 5, 'MB') },
			budgets
		});
		assert.equal(report.status, 'ok');
		assert.deepEqual(report.failures, []);
		assert.equal(report.metrics.switchMs.limitWithTolerance, 125);
		assert.equal(report.metrics.switchMs.runs, 5);
	});

	it('treats an unmeasured optional metric as supported but not required', () => {
		const report = budgetReport({
			platformKey: 'web-test',
			summary: { switchMs: measured(100), heapMb: { measured: false, runs: 0, unit: 'MB' } },
			budgets
		});
		assert.equal(report.status, 'ok');
		assert.equal(report.metrics.heapMb.status, 'unsupported');
	});

	it('fails when a p95 value exceeds the reviewed limit', () => {
		const report = budgetReport({
			platformKey: 'web-test',
			summary: { switchMs: measured(126) },
			budgets
		});
		assert.equal(report.status, 'over-budget');
		assert.deepEqual(report.failures, ['switchMs:over-budget']);
	});

	it('fails when a required metric is missing', () => {
		const report = budgetReport({
			platformKey: 'web-test',
			summary: { heapMb: measured(1, 5, 'MB') },
			budgets
		});
		assert.equal(report.status, 'invalid');
		assert.deepEqual(report.failures, ['switchMs:missing-measurement']);
	});

	it('fails when the platform has no baseline', () => {
		const report = budgetReport({
			platformKey: 'web-unknown',
			summary: { switchMs: measured(100) },
			budgets
		});
		assert.equal(report.status, 'no-baseline');
		assert.deepEqual(report.failures, ['missing-platform-baseline']);
	});

	it('fails when a required metric has too few runs', () => {
		const report = budgetReport({
			platformKey: 'web-test',
			summary: { switchMs: measured(100, 2) },
			budgets
		});
		assert.equal(report.status, 'invalid');
		assert.deepEqual(report.failures, ['switchMs:too-few-runs']);
	});

	it('fails on a non-finite or negative measurement', () => {
		const infinite = budgetReport({
			platformKey: 'web-test',
			summary: { switchMs: measured(Number.POSITIVE_INFINITY) },
			budgets
		});
		assert.equal(infinite.status, 'invalid');
		assert.deepEqual(infinite.failures, ['switchMs:non-finite-or-negative-p95']);

		const negative = budgetReport({
			platformKey: 'web-test',
			summary: { switchMs: measured(-1) },
			budgets
		});
		assert.equal(negative.status, 'invalid');
		assert.deepEqual(negative.failures, ['switchMs:non-finite-or-negative-p95']);
	});

	it('fails when a measured unit does not match the budget unit', () => {
		const report = budgetReport({
			platformKey: 'web-test',
			summary: { switchMs: measured(100, 5, 'MB') },
			budgets
		});
		assert.equal(report.status, 'invalid');
		assert.deepEqual(report.failures, ['switchMs:unit-mismatch']);
	});

	it('fails when the summary contains an ungated metric', () => {
		const report = budgetReport({
			platformKey: 'web-test',
			summary: { switchMs: measured(100), unexpectedMs: measured(10) },
			budgets
		});
		assert.equal(report.status, 'invalid');
		assert.deepEqual(report.failures, ['unexpectedMs:ungated-metric']);
	});

	it('accepts an ungated metric only through an explicit platform allowance', () => {
		const report = budgetReport({
			platformKey: 'web-allowed',
			summary: { switchMs: measured(100), extraMs: measured(10) },
			budgets
		});
		assert.equal(report.status, 'ok');
	});

	it('fails on an invalid tolerance or budget value', () => {
		const badTolerance = budgetReport({
			platformKey: 'web-test',
			summary: { switchMs: measured(100) },
			budgets,
			toleranceRatio: -1
		});
		assert.equal(badTolerance.status, 'invalid');
		assert.deepEqual(badTolerance.failures, ['invalid-tolerance-ratio']);

		const badBudget = budgetReport({
			platformKey: 'web-test',
			summary: { switchMs: measured(100) },
			budgets: {
				...budgets,
				platforms: {
					'web-test': {
						label: 'Bad budget',
						metrics: { switchMs: { p95: Number.NaN, unit: 'ms' } }
					}
				}
			}
		});
		assert.equal(badBudget.status, 'invalid');
		assert.deepEqual(badBudget.failures, ['switchMs:invalid-budget-p95']);
	});

	it('blocks only an enforcing run', () => {
		const report = budgetReport({
			platformKey: 'web-test',
			summary: { switchMs: measured(126) },
			budgets
		});
		assert.equal(budgetGateFailed(report, false), false);
		assert.equal(budgetGateFailed(report, true), true);
	});
});

describe('retained benchmark gate', () => {
	const directory = mkdtempSync(join(tmpdir(), 'deckmark-benchmark-gate-'));
	const budgetsPath = join(directory, 'budgets.json');
	const reportPath = join(directory, 'report.json');
	writeFileSync(
		budgetsPath,
		`${JSON.stringify({
			version: 1,
			defaults: { toleranceRatio: 0.25, minimumRuns: 3 },
			platforms: {
				'web-test': { label: 'Test platform', metrics: { switchMs: { p95: 100, unit: 'ms' } } }
			}
		})}\n`
	);
	const report = (overrides = {}) => ({
		schemaVersion: 2,
		target: 'web',
		source: 'a'.repeat(40),
		buildMode: 'production-static',
		summary: { switchMs: { measured: true, p95: 100, runs: 5, unit: 'ms' } },
		budget: { platformKey: 'web-test' },
		...overrides
	});
	const runGate = (value, extra = []) => {
		writeFileSync(reportPath, `${JSON.stringify(value)}\n`);
		return spawnSync(
			process.execPath,
			['scripts/benchmark-gate.mjs', '--report', reportPath, '--budgets', budgetsPath, ...extra],
			{ encoding: 'utf8' }
		);
	};

	it('accepts a complete report within the budget', () => {
		const result = runGate(report());
		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.match(result.stdout, /"status": "ok"/);
	});

	it('rejects an over-budget report with a nonzero result', () => {
		const result = runGate(
			report({
				summary: { switchMs: { measured: true, p95: 126, runs: 5, unit: 'ms' } }
			})
		);
		assert.equal(result.status, 1);
		assert.match(result.stdout, /switchMs:over-budget/);
	});

	it('rejects a report without source identity', () => {
		const result = runGate(report({ source: null }));
		assert.equal(result.status, 1);
		assert.match(result.stdout, /invalid-report:missing-source-identity/);
	});

	it('rejects failed or incomplete evidence', () => {
		const failed = runGate(report({ status: 'failed' }));
		assert.equal(failed.status, 1);
		assert.match(failed.stdout, /invalid-report:benchmark-run-failed/);

		const missing = runGate(report({ summary: {} }));
		assert.equal(missing.status, 1);
		assert.match(missing.stdout, /switchMs:missing-measurement/);
	});

	it('supports a reporting-only audit without a nonzero result', () => {
		const result = runGate(
			report({
				summary: { switchMs: { measured: true, p95: 126, runs: 5, unit: 'ms' } }
			}),
			['--report-only']
		);
		assert.equal(result.status, 0);
		assert.match(result.stdout, /"status": "failed"/);
	});

	it.after(() => rmSync(directory, { recursive: true, force: true }));
});

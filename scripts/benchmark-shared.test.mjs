// Deterministic tests for the benchmark budget gate. They prove that missing
// evidence fails closed before any browser or native measurement runs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
	assertMixedDescriptor,
	budgetGateFailed,
	budgetReport,
	loadBudgets,
	loadFixtures,
	maxLineChars,
	mixedDescriptor,
	summarize,
	summarizePasses
} from './benchmark-shared.mjs';
import {
	MIXED_FIXTURE_SPECS,
	MIXED_MARKERS,
	mixedNote,
	removeTables
} from './benchmark-fixtures/mixed.mjs';

const reviewedBudgets = await loadBudgets();

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

const measured = (p95, runs = 5, unit = 'ms') => ({
	measured: true,
	complete: true,
	p95,
	runs,
	unit
});
const measuredBoth = (p50, p95, runs = 3) => ({
	measured: true,
	complete: true,
	p50,
	p95,
	runs,
	unit: 'ms'
});

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

	it('uses an explicit per-metric minimum for one-shot lifecycle samples', () => {
		const report = budgetReport({
			platformKey: 'web-test',
			summary: { switchMs: measured(100, 1) },
			budgets: {
				...budgets,
				platforms: {
					'web-test': {
						label: 'One shot',
						metrics: { switchMs: { p95: 100, unit: 'ms', minimumRuns: 1 } }
					}
				}
			}
		});
		assert.equal(report.status, 'ok');
		assert.equal(report.metrics.switchMs.runs, 1);
		assert.equal(report.metrics.switchMs.minimumRuns, 1);
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
		summary: { switchMs: { measured: true, complete: true, p95: 100, runs: 5, unit: 'ms' } },
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
				summary: { switchMs: { measured: true, complete: true, p95: 126, runs: 5, unit: 'ms' } }
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
				summary: { switchMs: { measured: true, complete: true, p95: 126, runs: 5, unit: 'ms' } }
			}),
			['--report-only']
		);
		assert.equal(result.status, 0);
		assert.match(result.stdout, /"status": "failed"/);
	});

	it.after(() => rmSync(directory, { recursive: true, force: true }));
	it('gates a lifecycle metric on its median and reports the p95', () => {
		const report = budgetReport({
			platformKey: 'web-test',
			summary: { switchMs: measuredBoth(90, 400) },
			budgets: {
				...budgets,
				platforms: {
					'web-test': {
						label: 'Lifecycle',
						metrics: { switchMs: { p95: 100, unit: 'ms', statistic: 'p50', minimumRuns: 3 } }
					}
				}
			}
		});
		assert.equal(report.status, 'ok');
		assert.equal(report.metrics.switchMs.statistic, 'p50');
		assert.equal(report.metrics.switchMs.measuredValue, 90);
		assert.equal(report.metrics.switchMs.measuredP95, 400);
	});

	it('rejects a median gate with fewer than three runs', () => {
		const report = budgetReport({
			platformKey: 'web-test',
			summary: { switchMs: measuredBoth(90, 90, 1) },
			budgets: {
				...budgets,
				platforms: {
					'web-test': {
						label: 'Lifecycle',
						metrics: { switchMs: { p95: 100, unit: 'ms', statistic: 'p50', minimumRuns: 1 } }
					}
				}
			}
		});
		assert.equal(report.status, 'invalid');
		assert.deepEqual(report.failures, ['switchMs:p50-needs-three-runs']);
	});

	it('rejects an unknown statistic', () => {
		const report = budgetReport({
			platformKey: 'web-test',
			summary: { switchMs: measured(90) },
			budgets: {
				...budgets,
				platforms: {
					'web-test': {
						label: 'Bad statistic',
						metrics: { switchMs: { p95: 100, unit: 'ms', statistic: 'mean' } }
					}
				}
			}
		});
		assert.equal(report.status, 'invalid');
		assert.deepEqual(report.failures, ['switchMs:invalid-statistic']);
	});
	it('fails when a required metric dropped a sample', () => {
		const report = budgetReport({
			platformKey: 'web-test',
			summary: {
				switchMs: { measured: true, p50: 120, p95: 140, runs: 3, unit: 'ms', complete: false }
			},
			budgets
		});
		assert.equal(report.status, 'invalid');
		assert.deepEqual(report.failures, ['switchMs:incomplete-samples']);
	});
});

describe('retained artifact evidence contract', () => {
	const directory = mkdtempSync(join(tmpdir(), 'deckmark-benchmark-evidence-'));
	const reportPath = join(directory, 'report.json');
	const gatePath = join(import.meta.dirname, 'benchmark-gate.mjs');
	const budgetsPath = join(import.meta.dirname, 'benchmark-budgets.json');

	const reviewedSummary = (platformKey, overrides = {}) => {
		const definitions = reviewedBudgets.platforms[platformKey].metrics;
		const summary = {};
		for (const [name, definition] of Object.entries(definitions)) {
			if (definition.optional) {
				summary[name] = { runs: 0, unit: definition.unit, measured: false };
				continue;
			}
			const runs = definition.minimumRuns ?? reviewedBudgets.defaults.minimumRuns;
			const value = Number((definition.p95 * 0.5).toFixed(3));
			summary[name] = {
				runs,
				unit: definition.unit,
				measured: true,
				complete: true,
				p50: value,
				p95: value,
				min: value,
				max: value
			};
		}
		return { ...summary, ...overrides };
	};
	const webReport = (browser, summary) => ({
		schemaVersion: 2,
		target: 'web',
		browser: { name: browser },
		buildMode: 'production-static',
		source: 'a'.repeat(40),
		summary
	});
	const nativeReport = (summary) => ({
		schemaVersion: 2,
		target: 'native',
		environment: { os: { platform: 'linux' } },
		buildMode: 'debug',
		source: 'a'.repeat(40),
		summary
	});
	const runGate = (report, extra = []) => {
		writeFileSync(reportPath, `${JSON.stringify(report)}\n`);
		return spawnSync(
			process.execPath,
			[gatePath, '--report', reportPath, '--budgets', budgetsPath, ...extra],
			{
				encoding: 'utf8'
			}
		);
	};

	it('keeps one 346 ms stall out of the twenty-sample p95 but fails two', () => {
		const budgetsWithTyping = {
			version: 1,
			defaults: { toleranceRatio: 0.25, minimumRuns: 20 },
			platforms: {
				'web-webkit': {
					label: 'WebKit',
					metrics: { typingSource: { p95: 200, unit: 'ms', minimumRuns: 20 } }
				}
			}
		};
		const oneStall = [...Array(19).fill(18), 346];
		const one = summarize(oneStall);
		assert.equal(one.runs, 20);
		assert.equal(one.p95, 18);
		assert.equal(one.max, 346);
		const accepted = budgetReport({
			platformKey: 'web-webkit',
			summary: { typingSource: one },
			budgets: budgetsWithTyping
		});
		assert.equal(accepted.status, 'ok');
		assert.deepEqual(accepted.failures, []);
		const twoStalls = summarize([...Array(18).fill(18), 346, 346]);
		assert.equal(twoStalls.p95, 346);
		const rejected = budgetReport({
			platformKey: 'web-webkit',
			summary: { typingSource: twoStalls },
			budgets: budgetsWithTyping
		});
		assert.equal(rejected.status, 'over-budget');
		assert.deepEqual(rejected.failures, ['typingSource:over-budget']);
		assert.equal(
			reviewedBudgets.platforms['web-webkit'].metrics.typingSource.minimumRuns,
			20,
			'the reviewed WebKit budget must require the twenty measured samples'
		);
	});

	it('requires the twenty startup samples generated for every web platform', () => {
		const startupMetrics = [
			'coldStart',
			'cachedRestart',
			'firstContentfulPaint',
			'domInteractive',
			'domContentLoaded'
		];
		for (const platformKey of ['web-chromium', 'web-firefox', 'web-webkit']) {
			for (const metric of startupMetrics) {
				assert.equal(
					reviewedBudgets.platforms[platformKey].metrics[metric].minimumRuns,
					20,
					`${platformKey}.${metric}`
				);
			}
		}
	});

	it('accepts finite complete evidence from the reviewed budgets', () => {
		const result = runGate(webReport('chromium', reviewedSummary('web-chromium')));
		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.match(result.stdout, /"status": "ok"/);
	});

	it('rejects a required metric without a complete field', () => {
		const summary = reviewedSummary('web-chromium');
		delete summary.cachedRestart.complete;
		const result = runGate(webReport('chromium', summary));
		assert.equal(result.status, 1, result.stdout + result.stderr);
		assert.match(result.stdout, /cachedRestart:incomplete-samples/);
	});

	it('rejects a non-boolean complete field', () => {
		const summary = reviewedSummary('web-chromium');
		summary.cachedRestart.complete = 'false';
		const result = runGate(webReport('chromium', summary));
		assert.equal(result.status, 1, result.stdout + result.stderr);
		assert.match(result.stdout, /cachedRestart:incomplete-samples/);
	});

	it('rejects a truncated startup summary that claims completeness', () => {
		const summary = reviewedSummary('web-chromium');
		summary.firstContentfulPaint = {
			...summary.firstContentfulPaint,
			runs: 5,
			complete: true
		};
		const result = runGate(webReport('chromium', summary));
		assert.equal(result.status, 1, result.stdout + result.stderr);
		assert.match(result.stdout, /firstContentfulPaint:too-few-runs/);
	});

	it('rejects a non-finite retained value', () => {
		const summary = reviewedSummary('web-chromium');
		summary.firstContentfulPaint = {
			...summary.firstContentfulPaint,
			p95: null,
			complete: true
		};
		const result = runGate(webReport('chromium', summary));
		assert.equal(result.status, 1, result.stdout + result.stderr);
		assert.match(result.stdout, /firstContentfulPaint:non-finite-or-negative-p95/);
	});

	it('keeps an unmeasured optional metric accepted', () => {
		const result = runGate(webReport('firefox', reviewedSummary('web-firefox')));
		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.match(result.stdout, /"heapUsedMb": \{[\s\S]*?"status": "unsupported"/);
	});

	it('keeps the native startup minima and p50 statistic', () => {
		const platform = reviewedBudgets.platforms['native-linux-webkitgtk'].metrics;
		assert.equal(platform.startupCold.minimumRuns, 1);
		assert.equal(platform.startupWarm.minimumRuns, 3);
		assert.equal(platform.startupWarm.statistic, 'p50');
		const result = runGate(nativeReport(reviewedSummary('native-linux-webkitgtk')), [
			'--platform',
			'native-linux-webkitgtk'
		]);
		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.match(result.stdout, /"status": "ok"/);
	});

	it('rejects a native summary without a complete field', () => {
		const summary = reviewedSummary('native-linux-webkitgtk');
		delete summary.startupWarm.complete;
		const result = runGate(nativeReport(summary), ['--platform', 'native-linux-webkitgtk']);
		assert.equal(result.status, 1, result.stdout + result.stderr);
		assert.match(result.stdout, /startupWarm:incomplete-samples/);
	});

	it.after(() => rmSync(directory, { recursive: true, force: true }));
});

describe('mixed benchmark fixtures', () => {
	const root = join(import.meta.dirname, 'benchmark-fixtures');
	const expected = {
		'note-200k-mixed': { images: 2, bytes: 200_000 },
		'note-600k-mixed': { images: 6, bytes: 600_000 },
		'note-1mb-mixed': { images: 6, bytes: 1_000_000 }
	};

	it('loads every mixed fixture and verifies its manifest descriptor', async () => {
		const { descriptors } = await loadFixtures(root);
		for (const [id, want] of Object.entries(expected)) {
			const descriptor = descriptors.find((entry) => entry.id === id);
			assert.ok(descriptor, `${id} must be in the manifest`);
			assert.equal(descriptor.kind, 'mixed-note');
			assert.equal(descriptor.inlineImageCount, want.images);
			assert.ok(descriptor.maxLineChars >= 20_000, `${id} longest line`);
			assert.ok(descriptor.tableRowCount >= 60, `${id} table rows`);
			assert.ok(descriptor.listItemCount >= 90, `${id} list items`);
			const delta = Math.abs(descriptor.bytes - want.bytes);
			assert.ok(delta <= want.bytes * 0.05, `${id} bytes must stay within 5 percent`);
		}
	});

	it('reproduces the committed bytes from the generator', async () => {
		for (const spec of MIXED_FIXTURE_SPECS) {
			const generated = mixedNote({
				label: spec.label,
				targetBytes: spec.targetBytes,
				imageLineChars: spec.imageLineChars
			});
			const committed = readFileSync(join(root, `${spec.id}.md`), 'utf8');
			assert.equal(generated, committed, `${spec.id} must match its generator output`);
		}
	});

	it('fails closed when a mixed descriptor hides a missing image or a short line', () => {
		const content = readFileSync(join(root, 'note-200k-mixed.md'), 'utf8');
		const descriptor = mixedDescriptor(content);
		const noImage = { ...descriptor, inlineImageCount: 1 };
		assert.throws(
			() => assertMixedDescriptor('synthetic', noImage, descriptor),
			/inlineImageCount/
		);
		const shortLine = { ...descriptor, maxLineChars: descriptor.maxLineChars - 1 };
		assert.throws(() => assertMixedDescriptor('synthetic', shortLine, descriptor), /maxLineChars/);
		assert.throws(
			() => assertMixedDescriptor('synthetic', { ...descriptor, tableRowCount: 10 }, descriptor),
			/table/
		);
		assert.equal(maxLineChars('a\nbb\nccc'), 3);
	});

	it('keeps every caret marker unique and the tables-removed variant consistent', () => {
		const content = readFileSync(join(root, 'note-600k-mixed.md'), 'utf8');
		for (const marker of Object.values(MIXED_MARKERS)) {
			assert.equal(content.split(marker).length - 1, 1, `${marker} must appear once`);
		}
		const removed = removeTables(content);
		assert.equal(removed.split('\n').filter((line) => line.startsWith('|')).length, 0);
		assert.equal(removed.includes(MIXED_MARKERS.table), false);
		assert.ok(removed.includes(MIXED_MARKERS.prose));
		assert.ok(removed.includes(MIXED_MARKERS.list));
		assert.ok(removed.includes(MIXED_MARKERS.image));
	});
});

describe('pass-based summaries', () => {
	it('uses the median pass p95 as the gate value', () => {
		const summary = summarizePasses([
			[10, 11, 12],
			[20, 21, 22],
			[30, 31, 32]
		]);
		assert.equal(summary.passes, 3);
		assert.deepEqual(summary.passP95, [12, 22, 32]);
		assert.equal(summary.p95, 22);
		assert.equal(summary.runs, 9);
		assert.equal(summary.complete, true);
	});

	it('keeps a single pass honest and marks a null sample incomplete', () => {
		const single = summarizePasses([[5, 6, 7]]);
		assert.equal(single.p95, 7);
		const incomplete = summarizePasses([
			[5, null, 7],
			[5, 6, 7]
		]);
		assert.equal(incomplete.complete, false);
		assert.equal(incomplete.runs, 5);
		assert.equal(summarizePasses([[], []]).measured, false);
	});

	it('rejects a missing measurement through the budget gate', () => {
		const report = budgetReport({
			platformKey: 'web-test',
			summary: { switchMs: summarizePasses([[]]) },
			budgets
		});
		assert.equal(report.status, 'invalid');
		assert.match(report.failures.join(','), /switchMs:missing-measurement/);
	});
});

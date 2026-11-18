// Audit one representative editor tail report against the reviewed budgets.
// This command measures nothing. It recomputes every aggregate from the raw
// passes, proves that the declared warmup is excluded, and fails closed when a
// p95 rests on fewer than the reviewed sample count.
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { percentile } from './benchmark-shared.mjs';

const SCHEMA = 'deckmark-representative-editor/2';

/** @param {number[]} values */
function summarize(values) {
	const numbers = values.filter((value) => Number.isFinite(value));
	if (numbers.length === 0) return { denominator: 0, p50: 0, p95: 0, max: 0 };
	return {
		denominator: numbers.length,
		p50: percentile(numbers, 0.5),
		p95: percentile(numbers, 0.95),
		max: Math.max(...numbers)
	};
}

/** @param {number} left @param {number} right */
function close(left, right) {
	return Math.abs(left - right) <= 1e-6;
}

/**
 * @param {any} report
 * @param {any} budgets
 * @param {{ reportOnly?: boolean }} [options]
 */
export function auditReport(report, budgets, options = {}) {
	const failures = [];
	const cases = [];
	if (!report || typeof report !== 'object') {
		return { status: 'failed', failures: ['invalid-report'], cases };
	}
	if (report.schema !== SCHEMA) failures.push('invalid-schema');
	if (report.exactBytes !== true) failures.push('exported-bytes-not-exact');
	if (!report.sampling || typeof report.sampling !== 'object') {
		failures.push('missing-sampling');
	}
	const minimum = budgets?.defaults?.minimumSamples ?? 20;
	const tolerance = budgets?.defaults?.toleranceRatio ?? 0;
	const sampling = report.sampling ?? {};
	if (!Number.isInteger(sampling.warmupRuns) || sampling.warmupRuns < 1) {
		failures.push('warmup-not-declared');
	}
	if (!Number.isInteger(sampling.measuredRuns) || sampling.measuredRuns < minimum) {
		failures.push('insufficient-measured-runs');
	}
	if (!Array.isArray(report.rawRuns) || report.rawRuns.length === 0) {
		failures.push('missing-raw-runs');
	}
	if (!Array.isArray(report.cases) || report.cases.length === 0) {
		failures.push('missing-cases');
	}
	if (failures.length > 0) return { status: 'failed', failures, cases };

	const raw = report.rawRuns;
	const rawByCase = new Map();
	for (const run of raw) {
		if (!rawByCase.has(run.id)) rawByCase.set(run.id, []);
		rawByCase.get(run.id).push(run);
	}
	const aggregateById = new Map(report.cases.map((row) => [row.id, row]));
	for (const [id, runs] of rawByCase) {
		const row = aggregateById.get(id);
		if (!row) {
			failures.push(`${id}:missing-aggregate`);
			continue;
		}
		const warmup = runs.filter((run) => run.warmup === true);
		const measured = runs.filter((run) => run.warmup !== true);
		if (id !== 'control-no-change' && id !== 'stall-control' && warmup.length !== 1) {
			failures.push(`${id}:warmup-count`);
		}
		if (row.runs?.measured !== measured.length) {
			failures.push(`${id}:measured-run-count`);
		}
		const inputToFrame = measured.flatMap((run) =>
			(run.inputs?.raw ?? []).map((sample) => sample.inputToFrameMs)
		);
		const expected = summarize(inputToFrame);
		const recorded = row.metrics?.inputToFrameMs;
		if (!recorded) {
			failures.push(`${id}:missing-input-metric`);
			continue;
		}
		if (recorded.denominator !== expected.denominator) {
			failures.push(`${id}:denominator-mismatch`);
		}
		if (!close(recorded.p50, expected.p50)) failures.push(`${id}:forged-p50`);
		if (!close(recorded.p95, expected.p95)) failures.push(`${id}:forged-p95`);
		if (!close(recorded.max, expected.max)) failures.push(`${id}:forged-max`);
		if (recorded.status !== 'measured') {
			failures.push(`${id}:tail-estimate-insufficient`);
		}
		if (!row.durableExact) failures.push(`${id}:durable-bytes-not-exact`);
		if (id === 'mixed-enter-split' && row.undoRestored !== true) {
			failures.push(`${id}:undo-not-restored`);
		}
		cases.push({ id, denominator: expected.denominator, p95: expected.p95 });
	}

	const platformKey = report.budget?.platformKey ?? `web-${report.browser?.name ?? 'unknown'}`;
	const platform = budgets?.platforms?.[platformKey];
	if (!platform) {
		failures.push('missing-platform-baseline');
	} else {
		for (const [key, limit] of Object.entries(platform.metrics ?? {})) {
			const separator = key.indexOf('.');
			const id = key.slice(0, separator);
			const metricName = key.slice(separator + 1);
			const row = aggregateById.get(id);
			const metric = row?.metrics?.[metricName];
			const minimumSamples = limit.minimumSamples ?? minimum;
			if (!metric || metric.status === 'unsupported') {
				failures.push(`${key}:unsupported`);
				continue;
			}
			if (!Number.isInteger(metric.denominator) || metric.denominator < minimumSamples) {
				failures.push(`${key}:insufficient-samples`);
				continue;
			}
			const measured =
				metricName === 'inputToFrameMs'
					? summarize(
							(rawByCase.get(id) ?? [])
								.filter((run) => run.warmup !== true)
								.flatMap((run) => (run.inputs?.raw ?? []).map((sample) => sample.inputToFrameMs))
						).p95
					: metric.p95;
			const limitWithTolerance = Number((limit.p95 * (1 + tolerance)).toFixed(3));
			if (!Number.isFinite(measured) || measured > limitWithTolerance) {
				failures.push(`${key}:over-budget`);
			}
		}
	}

	return {
		status: failures.length === 0 ? 'ok' : 'failed',
		enforced: !options.reportOnly,
		platformKey,
		failures,
		cases
	};
}

function parseArguments(args) {
	const options = {
		report: null,
		budgets: resolve(import.meta.dirname, 'representative-budgets.json'),
		reportOnly: false
	};
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === '--report') options.report = args[++index] ?? null;
		else if (arg === '--budgets') options.budgets = resolve(args[++index] ?? '');
		else if (arg === '--report-only') options.reportOnly = true;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	if (!options.report) throw new Error('--report is required.');
	if (!isAbsolute(options.report)) throw new Error('--report must be an absolute path.');
	return options;
}

async function main() {
	const options = parseArguments(process.argv.slice(2));
	const report = JSON.parse(await readFile(resolve(options.report), 'utf8'));
	const budgets = JSON.parse(await readFile(options.budgets, 'utf8'));
	const result = auditReport(report, budgets, { reportOnly: options.reportOnly });
	console.log(JSON.stringify({ report: resolve(options.report), ...result }, null, 2));
	if (!options.reportOnly && result.status !== 'ok') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main();
}

// Shared benchmark helpers. The code reads local files and process data only.
// It sends no telemetry and makes no network request except the local static server.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { arch, cpus, platform, release, totalmem, version } from 'node:os';
import { join, resolve } from 'node:path';
import { generators } from './benchmark-fixtures/corpus.mjs';

/** @param {number[]} values @param {number} ratio */
export function percentile(values, ratio) {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
}

/**
 * Summarize numeric samples. A sample reader can return null when a browser or
 * WebView cannot measure the metric. Null samples are reported as unmeasured.
 * @param {Array<number | null | undefined>} values
 * @param {'ms' | 'MB'} [unit]
 */
export function summarize(values, unit = 'ms') {
	const measured = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
	if (measured.length === 0) {
		return { runs: 0, unit, measured: false };
	}
	const complete = measured.length === values.length;
	return {
		runs: measured.length,
		unit,
		measured: true,
		complete,
		p50: Number(percentile(measured, 0.5).toFixed(3)),
		p95: Number(percentile(measured, 0.95).toFixed(3)),
		min: Number(Math.min(...measured).toFixed(3)),
		max: Number(Math.max(...measured).toFixed(3))
	};
}

/**
 * Summarize repeated passes. Each pass is one array of samples. The gate value
 * is the median of the per-pass p95 values, so one noisy pass can neither fail
 * nor hide a systematic slowdown. `runs` is the total measured sample count and
 * every raw sample stays in the report.
 * @param {number[][]} passes
 * @param {'ms' | 'MB'} [unit]
 */
export function summarizePasses(passes, unit = 'ms') {
	const usable = passes
		.map((values) => values.filter((value) => typeof value === 'number' && Number.isFinite(value)))
		.filter((values) => values.length > 0);
	if (usable.length === 0) {
		return { runs: 0, unit, measured: false };
	}
	const flat = passes.flat();
	const complete =
		usable.length === passes.length &&
		flat.every((value) => typeof value === 'number' && Number.isFinite(value));
	const passP95 = usable.map((values) => Number(percentile(values, 0.95).toFixed(3)));
	const sortedPassP95 = [...passP95].sort((left, right) => left - right);
	const measured = flat.filter((value) => typeof value === 'number' && Number.isFinite(value));
	return {
		runs: measured.length,
		unit,
		measured: true,
		complete,
		passes: passP95.length,
		passP95,
		p50: Number(percentile(measured, 0.5).toFixed(3)),
		p95: sortedPassP95[Math.floor(sortedPassP95.length / 2)],
		min: Number(Math.min(...measured).toFixed(3)),
		max: Number(Math.max(...measured).toFixed(3))
	};
}

/** @param {number} bytes */
export function megabytes(bytes) {
	return Number((bytes / (1024 * 1024)).toFixed(1));
}

/** @param {string} [directory] */
export function gitRevision(directory = process.cwd()) {
	try {
		return execFileSync('git', ['rev-parse', 'HEAD'], {
			cwd: directory,
			encoding: 'utf8'
		}).trim();
	} catch {
		return null;
	}
}

/**
 * Record the runtime identity that affects timings. Keywords stay generic so a
 * report can be compared across platforms without claiming equal hardware.
 * @param {Record<string, unknown>} [extra]
 */
export function environmentIdentity(extra = {}) {
	const cpuList = cpus();
	return {
		capturedAt: new Date().toISOString(),
		node: process.version,
		os: {
			platform: platform(),
			release: release(),
			version: version(),
			arch: arch()
		},
		cpu: {
			model: cpuList[0]?.model?.trim() ?? 'unknown',
			logicalProcessors: cpuList.length
		},
		totalMemoryBytes: totalmem(),
		ci: {
			active: Boolean(process.env.CI),
			runnerOs: process.env.RUNNER_OS ?? null,
			runnerArch: process.env.RUNNER_ARCH ?? null,
			runnerName: process.env.RUNNER_NAME ?? null
		},
		...extra
	};
}

const manifestPath = (/** @type {string} */ root) => join(root, 'manifest.json');

/** @param {string} text */
export function maxLineChars(text) {
	let longest = 0;
	let start = 0;
	for (let index = 0; index <= text.length; index += 1) {
		const code = text.charCodeAt(index);
		if (index < text.length && code !== 10 && code !== 13) continue;
		longest = Math.max(longest, index - start);
		if (code === 13 && text.charCodeAt(index + 1) === 10) index += 1;
		start = index + 1;
	}
	return longest;
}

/**
 * Structure of one committed mixed note. The manifest keeps the reviewed
 * values; the loader recomputes them from the bytes so a drift cannot pass.
 * @param {string} text
 */
export function mixedDescriptor(text) {
	let tableRowCount = 0;
	let listItemCount = 0;
	for (const block of text.split(/\n{2,}/)) {
		const rows = block.split('\n').filter((line) => line.startsWith('|'));
		if (rows.length > 2) tableRowCount = Math.max(tableRowCount, rows.length - 2);
		const items = block.split('\n').filter((line) => /^\d+\. /.test(line));
		if (items.length) listItemCount = Math.max(listItemCount, items.length);
	}
	return {
		bytes: Buffer.byteLength(text),
		sha256: createHash('sha256').update(text).digest('hex'),
		maxLineChars: maxLineChars(text),
		inlineImageCount: text.match(/!\[[^\]]*\]\(data:image\/[a-z+]+;base64,[^)]*\)/g)?.length ?? 0,
		tableRowCount,
		listItemCount
	};
}

/**
 * Fail closed when a mixed fixture does not carry the reviewed structure.
 * @param {string} id
 * @param {Record<string, number | string>} expected
 * @param {Record<string, number | string>} actual
 */
export function assertMixedDescriptor(id, expected, actual) {
	if (!expected) throw new Error(`Mixed fixture ${id} has no descriptor.`);
	for (const key of [
		'bytes',
		'sha256',
		'maxLineChars',
		'inlineImageCount',
		'tableRowCount',
		'listItemCount'
	]) {
		if (!(key in expected)) throw new Error(`Mixed fixture ${id} descriptor has no ${key}.`);
		if (expected[key] !== actual[key]) {
			throw new Error(
				`Mixed fixture ${id} ${key} is ${actual[key]}, the manifest records ${expected[key]}.`
			);
		}
	}
	if (actual.inlineImageCount === 0) {
		throw new Error(`Mixed fixture ${id} has no inline base64 image.`);
	}
	if (Number(actual.maxLineChars) < 20_000) {
		throw new Error(`Mixed fixture ${id} longest line is under 20000 characters.`);
	}
	if (Number(actual.tableRowCount) < 60) {
		throw new Error(`Mixed fixture ${id} table has fewer than 60 rows.`);
	}
	if (Number(actual.listItemCount) < 90) {
		throw new Error(`Mixed fixture ${id} list has fewer than 90 items.`);
	}
}

/**
 * Read the fixture manifest and hash every fixture. Generated fixtures are
 * hashed from their deterministic output; their bytes stay out of the report.
 * A mixed note also reports and verifies its document structure.
 * @param {string} root
 */
export async function loadFixtures(root = join(import.meta.dirname, 'benchmark-fixtures')) {
	const absoluteRoot = resolve(root);
	const manifest = JSON.parse(await readFile(manifestPath(absoluteRoot), 'utf8'));
	const descriptors = [];
	for (const fixture of manifest.fixtures) {
		if (fixture.path) {
			const bytes = await readFile(join(absoluteRoot, fixture.path));
			const text = bytes.toString('utf8');
			const descriptor = {
				id: fixture.id,
				kind: fixture.kind,
				description: fixture.description,
				path: join(root, fixture.path),
				bytes: bytes.byteLength,
				sha256: createHash('sha256').update(bytes).digest('hex'),
				targets: fixture.targets
			};
			if (fixture.kind === 'mixed-note') {
				const structure = mixedDescriptor(text);
				assertMixedDescriptor(fixture.id, fixture.descriptor ?? {}, structure);
				Object.assign(descriptor, {
					maxLineChars: structure.maxLineChars,
					inlineImageCount: structure.inlineImageCount,
					tableRowCount: structure.tableRowCount,
					listItemCount: structure.listItemCount
				});
			}
			descriptors.push(descriptor);
			continue;
		}
		const generate = generators[fixture.generator];
		if (!generate) throw new Error(`Unknown fixture generator: ${fixture.generator}`);
		const value = generate(fixture.generatorArgs ?? {});
		const serialized = JSON.stringify(value);
		descriptors.push({
			id: fixture.id,
			kind: fixture.kind,
			description: fixture.description,
			generator: fixture.generator,
			generatorArgs: fixture.generatorArgs,
			bytes: Buffer.byteLength(serialized),
			sha256: createHash('sha256').update(serialized).digest('hex'),
			targets: fixture.targets
		});
	}
	return { manifest, descriptors };
}

/** @param {string} root @param {string} id */
export async function fixtureText(root, id) {
	const { descriptors } = await loadFixtures(root);
	const descriptor = descriptors.find((entry) => entry.id === id);
	if (!descriptor?.path) throw new Error(`Fixture has no text file: ${id}`);
	return { descriptor, text: await readFile(descriptor.path, 'utf8') };
}

/** @param {string} [path] */
export async function loadBudgets(path = join(import.meta.dirname, 'benchmark-budgets.json')) {
	const budgets = JSON.parse(await readFile(resolve(path), 'utf8'));
	if (budgets.version !== 1 || typeof budgets.platforms !== 'object') {
		throw new Error('Unsupported benchmark budget file.');
	}
	return budgets;
}

/**
 * Compare measured p95 values with the configured baseline for one platform.
 * The evaluation fails closed: a missing baseline, an absent required metric,
 * too few samples, a measured metric without `complete: true`, a unit mismatch,
 * a non-finite value, an ungated summary metric, or a p95 over the reviewed
 * limit produces a non-ok status. Only metrics marked `optional` may stay
 * unmeasured, because the engine does not expose them.
 * @param {{
 *   platformKey: string,
 *   summary: Record<string, { p50?: number, p95?: number, runs: number, unit: string, measured?: boolean, complete?: boolean }>,
 *   budgets: Awaited<ReturnType<typeof loadBudgets>>,
 *   toleranceRatio?: number,
 *   minimumRuns?: number
 * }} input
 */
export function budgetReport({ platformKey, summary, budgets, toleranceRatio, minimumRuns }) {
	const defaults = budgets.defaults ?? {};
	const tolerance = toleranceRatio ?? defaults.toleranceRatio ?? 0.5;
	const requiredRuns = minimumRuns ?? defaults.minimumRuns ?? 3;
	const platformBudget = budgets.platforms?.[platformKey];
	if (!platformBudget) {
		return {
			platformKey,
			status: 'no-baseline',
			toleranceRatio: tolerance,
			minimumRuns: requiredRuns,
			failures: ['missing-platform-baseline'],
			metrics: {}
		};
	}
	if (!Number.isFinite(tolerance) || tolerance < 0) {
		return {
			platformKey,
			label: platformBudget.label,
			status: 'invalid',
			toleranceRatio: tolerance,
			minimumRuns: requiredRuns,
			failures: ['invalid-tolerance-ratio'],
			metrics: {}
		};
	}
	/** @type {Record<string, Record<string, unknown>>} */
	const metrics = {};
	/** @type {string[]} */
	const failures = [];
	const budgetDefinitions = platformBudget.metrics ?? {};
	for (const [metric, definition] of Object.entries(budgetDefinitions)) {
		const budget =
			/** @type {{ p95: number, unit: string, note?: string, toleranceRatio?: number, optional?: boolean, minimumRuns?: number, statistic?: 'p50' | 'p95' }} */ (
				definition
			);
		const measured = summary[metric];
		const metricMinimumRuns = budget.minimumRuns ?? requiredRuns;
		const fail = (status, reason) => {
			if (!budget.optional) failures.push(`${metric}:${reason}`);
			metrics[metric] = {
				budgetP95: budget.p95,
				unit: budget.unit,
				status,
				reason,
				runs: measured?.runs ?? 0,
				minimumRuns: metricMinimumRuns,
				note: budget.note
			};
			return;
		};
		if (!Number.isFinite(budget.p95) || budget.p95 < 0) {
			fail('invalid-budget', 'invalid-budget-p95');
			continue;
		}
		const statistic = budget.statistic ?? 'p95';
		if (statistic !== 'p95' && statistic !== 'p50') {
			fail('invalid-budget', 'invalid-statistic');
			continue;
		}
		if (statistic === 'p50' && metricMinimumRuns < 3) {
			fail('invalid-budget', 'p50-needs-three-runs');
			continue;
		}
		if (!measured?.measured || measured.runs === 0) {
			fail(budget.optional ? 'unsupported' : 'missing', 'missing-measurement');
			continue;
		}
		if (!Number.isInteger(measured.runs) || measured.runs < metricMinimumRuns) {
			fail('insufficient-samples', 'too-few-runs');
			continue;
		}
		if (measured.complete !== true) {
			fail('incomplete-samples', 'incomplete-samples');
			continue;
		}
		if (measured.unit !== budget.unit) {
			fail('unit-mismatch', 'unit-mismatch');
			continue;
		}
		const measuredValue = measured[statistic];
		if (measuredValue === undefined || !Number.isFinite(measuredValue) || measuredValue < 0) {
			fail('invalid-value', `non-finite-or-negative-${statistic}`);
			continue;
		}
		const limit = Number((budget.p95 * (1 + (budget.toleranceRatio ?? tolerance))).toFixed(3));
		const over = measuredValue > limit;
		metrics[metric] = {
			budgetP95: budget.p95,
			limitWithTolerance: limit,
			statistic,
			measuredP95: measured.p95,
			measuredP50: measured.p50,
			measuredValue,
			unit: budget.unit,
			status: over ? 'over-budget' : 'ok',
			runs: measured.runs,
			minimumRuns: metricMinimumRuns,
			note: budget.note
		};
		if (over) failures.push(`${metric}:over-budget`);
	}
	for (const metric of Object.keys(summary)) {
		if (Object.hasOwn(budgetDefinitions, metric)) continue;
		if (platformBudget.allowUngated?.includes(metric)) continue;
		failures.push(`${metric}:ungated-metric`);
	}
	const overBudget = failures.some((failure) => failure.endsWith(':over-budget'));
	const status = failures.length === 0 ? 'ok' : overBudget ? 'over-budget' : 'invalid';
	return {
		platformKey,
		label: platformBudget.label,
		status,
		toleranceRatio: tolerance,
		minimumRuns: requiredRuns,
		failures,
		metrics
	};
}

/**
 * True when an enforcing run must exit nonzero. Reporting-only runs can still
 * write the same report, but they do not change the process status.
 * @param {ReturnType<typeof budgetReport>} report
 * @param {boolean} enforce
 */
export function budgetGateFailed(report, enforce) {
	return enforce && report.status !== 'ok';
}

/** @param {string} name */
export function platformKeyForWeb(name) {
	return `web-${name}`;
}

/** @param {NodeJS.Platform} name */
export function platformKeyForNative(name = process.platform) {
	if (name === 'win32') return 'native-windows-webview2';
	if (name === 'darwin') return 'native-macos-wkwebview';
	return 'native-linux-webkitgtk';
}

/** @param {number} milliseconds */
export function round(milliseconds) {
	return Number(milliseconds.toFixed(3));
}

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

/**
 * Read the fixture manifest and hash every fixture. Generated fixtures are
 * hashed from their deterministic output; their bytes stay out of the report.
 * @param {string} root
 */
export async function loadFixtures(root = join(import.meta.dirname, 'benchmark-fixtures')) {
	const absoluteRoot = resolve(root);
	const manifest = JSON.parse(await readFile(manifestPath(absoluteRoot), 'utf8'));
	const descriptors = [];
	for (const fixture of manifest.fixtures) {
		if (fixture.path) {
			const bytes = await readFile(join(absoluteRoot, fixture.path));
			descriptors.push({
				id: fixture.id,
				kind: fixture.kind,
				description: fixture.description,
				path: join(root, fixture.path),
				bytes: bytes.byteLength,
				sha256: createHash('sha256').update(bytes).digest('hex'),
				targets: fixture.targets
			});
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
 * Compare measured p95 values with the configurable baseline for one platform.
 * A budget is a recorded baseline, not a claim that two platforms are equal.
 * @param {{
 *   platformKey: string,
 *   summary: Record<string, { p95?: number, runs: number, unit: string }>,
 *   budgets: Awaited<ReturnType<typeof loadBudgets>>,
 *   toleranceRatio?: number
 * }} input
 */
export function budgetReport({ platformKey, summary, budgets, toleranceRatio }) {
	const platformBudget = budgets.platforms[platformKey];
	const tolerance = toleranceRatio ?? budgets.defaults?.toleranceRatio ?? 0.5;
	if (!platformBudget) {
		return {
			platformKey,
			status: 'no-baseline',
			toleranceRatio: tolerance,
			metrics: {}
		};
	}
	/** @type {Record<string, unknown>} */
	const metrics = {};
	let status = 'ok';
	for (const [metric, definition] of Object.entries(platformBudget.metrics ?? {})) {
		const measured = summary[metric];
		const budget =
			/** @type {{ p95: number, unit: string, note?: string, toleranceRatio?: number }} */ (
				definition
			);
		const limit = Number((budget.p95 * (1 + (budget.toleranceRatio ?? tolerance))).toFixed(3));
		if (!measured?.measured || measured.runs === 0) {
			metrics[metric] = {
				budgetP95: budget.p95,
				unit: budget.unit,
				status: 'unmeasured',
				note: budget.note
			};
			continue;
		}
		const over = measured.p95 !== undefined && measured.p95 > limit;
		if (over) status = 'over-budget';
		metrics[metric] = {
			budgetP95: budget.p95,
			limitWithTolerance: limit,
			measuredP95: measured.p95,
			unit: budget.unit,
			status: over ? 'over-budget' : 'ok',
			note: budget.note
		};
	}
	return { platformKey, label: platformBudget.label, status, toleranceRatio: tolerance, metrics };
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

#!/usr/bin/env node
// Refresh the E2E shard weights from measured CI durations.
//
// The planner in scripts/e2e-shards.mjs balances browser and file groups by
// these weights. A weight is a scheduling hint, not a budget or a test report.
// This script reads the Playwright list reporter lines of green e2e-shard jobs:
//
//   ✓  12 [chromium] › e2e/editor.spec.ts:40:3 › keeps the caret (4.2s)
//
// For each run it sums the durations of every attempt of every test per
// browser project and file. The weight of a group is the median of these sums
// across runs. The test count is the median number of distinct tests.
//
// Usage:
//   node scripts/e2e-shard-weights.mjs refresh --runs <n> [--repo <owner/name>] [--out <file>]
//   node scripts/e2e-shard-weights.mjs refresh --logs <dir> [--out <file>]
//
// `--runs` reads the newest green runs of deploy.yml with the GitHub CLI.
// `--logs` reads saved job logs offline: one subdirectory per run, one file per
// shard job log. The output keeps `version: 1` and the fallback weight.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const USAGE = `Usage:
  node scripts/e2e-shard-weights.mjs refresh --runs <n> [--repo <owner/name>] [--out <file>]
  node scripts/e2e-shard-weights.mjs refresh --logs <dir> [--out <file>]`;

export const FALLBACK_SECONDS = 5;
const DEFAULT_REPO = 'ThomasCrouzet/deckmark';
const DEFAULT_OUT = 'scripts/e2e-shard-weights.json';
const SHARD_JOB = /^e2e-shard \(\d+\)$/;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;
const TIMESTAMP = /^\S+Z /;
const LINE =
	/^\s*(?:✓|✘|ok|x)\s+\d+\s+\[([\w-]+)\] › e2e\/(\S+?):(\d+):\d+ › (.*?)(?: \(retry #\d+\))? \((\d+(?:\.\d+)?)(ms|s|m)\)\s*$/;

/** @param {string} value @param {string} unit */
function seconds(value, unit) {
	const number = Number(value);
	if (unit === 'ms') return number / 1000;
	if (unit === 'm') return number * 60;
	return number;
}

/**
 * Parse one job log into test lines.
 * @param {string} text
 * @returns {{ project: string, file: string, test: string, seconds: number }[]}
 */
export function parseShardLog(text) {
	const tests = [];
	for (const raw of text.split('\n')) {
		const line = raw.replace(/\r$/, '').replace(ANSI, '').replace(TIMESTAMP, '');
		const match = LINE.exec(line);
		if (!match) continue;
		const [, project, file, testLine, title, value, unit] = match;
		tests.push({ project, file, test: `${testLine} ${title}`, seconds: seconds(value, unit) });
	}
	return tests;
}

/** @param {number[]} values */
function median(values) {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Build the weights file from the test lines of several runs.
 * @param {{ id: string, tests: ReturnType<typeof parseShardLog> }[]} runs
 * @param {string} source
 */
export function buildWeights(runs, source) {
	if (runs.length === 0) throw new Error('No run has e2e-shard test lines.');
	/** @type {Map<string, { project: string, file: string, sums: number[], counts: number[] }>} */
	const groups = new Map();
	for (const run of runs) {
		/** @type {Map<string, { seconds: number, tests: Set<string> }>} */
		const perRun = new Map();
		for (const entry of run.tests) {
			const key = `${entry.project}::${entry.file}`;
			const value = perRun.get(key) ?? { seconds: 0, tests: new Set() };
			value.seconds += entry.seconds;
			value.tests.add(entry.test);
			perRun.set(key, value);
		}
		for (const [key, value] of perRun) {
			const [project, file] = key.split('::');
			const group = groups.get(key) ?? { project, file, sums: [], counts: [] };
			group.sums.push(value.seconds);
			group.counts.push(value.tests.size);
			groups.set(key, group);
		}
	}
	const entries = [...groups.values()]
		.map((group) => ({
			project: group.project,
			file: group.file,
			seconds: Math.round(median(group.sums) * 10) / 10,
			tests: Math.max(1, Math.round(median(group.counts)))
		}))
		.sort(
			(left, right) =>
				left.project.localeCompare(right.project) || left.file.localeCompare(right.file)
		);
	return { version: 1, source, fallbackSeconds: FALLBACK_SECONDS, groups: entries };
}

/** @param {string} directory */
function readSavedRuns(directory) {
	const runs = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const tests = [];
		for (const file of readdirSync(join(directory, entry.name)).sort()) {
			tests.push(...parseShardLog(readFileSync(join(directory, entry.name, file), 'utf8')));
		}
		if (tests.length > 0) runs.push({ id: entry.name, tests });
	}
	return runs.sort((left, right) => left.id.localeCompare(right.id));
}

/** @param {string[]} args */
function gh(args) {
	return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

/**
 * Download the shard logs of the newest green runs into one directory.
 * @param {string} repo @param {number} count @param {string} directory
 */
function downloadRuns(repo, count, directory) {
	const runs = JSON.parse(
		gh([
			'api',
			`repos/${repo}/actions/workflows/deploy.yml/runs?status=success&per_page=50`,
			'--jq',
			'[.workflow_runs[] | {id, created_at}]'
		])
	);
	const selected = [];
	for (const run of runs) {
		if (selected.length >= count) break;
		const jobs = JSON.parse(
			gh([
				'api',
				`repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`,
				'--jq',
				'[.jobs[] | {id, name, conclusion}]'
			])
		);
		const shards = jobs.filter((job) => SHARD_JOB.test(job.name));
		if (shards.length === 0 || shards.some((job) => job.conclusion !== 'success')) continue;
		mkdirSync(join(directory, String(run.id)), { recursive: true });
		for (const job of shards) {
			writeFileSync(
				join(directory, String(run.id), `${job.id}.log`),
				gh(['api', `repos/${repo}/actions/jobs/${job.id}/logs`])
			);
		}
		selected.push(run);
	}
	return selected;
}

/** @param {string[]} argv */
function parseOptions(argv) {
	/** @type {Record<string, string>} */
	const options = {};
	for (let index = 0; index < argv.length; index += 2) {
		const key = argv[index];
		const value = argv[index + 1];
		if (!key?.startsWith('--') || value === undefined || value.startsWith('--')) {
			throw new Error(USAGE);
		}
		options[key.slice(2)] = value;
	}
	for (const key of Object.keys(options)) {
		if (!['runs', 'logs', 'repo', 'out'].includes(key)) throw new Error(USAGE);
	}
	if ((options.runs === undefined) === (options.logs === undefined)) throw new Error(USAGE);
	return options;
}

function main(argv) {
	const [mode, ...rest] = argv;
	if (mode !== 'refresh') throw new Error(USAGE);
	const options = parseOptions(rest);
	const out = resolve(options.out ?? DEFAULT_OUT);
	let runs;
	let source;
	if (options.logs !== undefined) {
		runs = readSavedRuns(options.logs);
		source = `Median Playwright test durations from the list reporter, all attempts, of ${runs.length} saved runs (${runs.map((run) => run.id).join(', ')}).`;
	} else {
		const count = Number(options.runs);
		if (!Number.isInteger(count) || count < 1) throw new Error(USAGE);
		const repo = options.repo ?? DEFAULT_REPO;
		const directory = mkdtempSync(join(tmpdir(), 'e2e-shard-weights-'));
		try {
			const selected = downloadRuns(repo, count, directory);
			runs = readSavedRuns(directory);
			source = `Median Playwright test durations from the list reporter, all attempts, of the ${selected.length} newest fully successful Deploy to GitHub Pages runs (${selected.map((run) => run.id).join(', ')}; newest ${selected[0]?.created_at ?? 'none'}).`;
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}
	const weights = buildWeights(
		runs,
		`${source} A group value is the median per run of the summed test durations of one browser project and file. Paths are relative to the Playwright rootDir.`
	);
	writeFileSync(out, `${JSON.stringify(weights, null, '\t')}\n`);
	const total = weights.groups.reduce((sum, group) => sum + group.seconds, 0);
	console.log(
		`Wrote ${weights.groups.length} groups from ${runs.length} runs to ${out} (${Math.round(total)} s in total). Run Prettier on the file before commit.`
	);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
	try {
		main(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}

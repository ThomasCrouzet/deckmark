#!/usr/bin/env node
// Build a deterministic duration-balanced partition of the Playwright E2E
// suite. Groups are browser and file pairs. Every listed test stays in exactly
// one shard. The planner emits Playwright --test-list selections, one meta file
// per shard for report identity, and a plan with the partition hash. A weight
// entry is a scheduling hint only: a stale entry for a removed file warns and
// never blocks the plan.
// Usage:
//   node scripts/e2e-shards.mjs plan --list <full-list.json> --weights <weights.json> --shards <count> --out <dir>
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const USAGE =
	'Usage: node scripts/e2e-shards.mjs plan --list <full-list.json> --weights <weights.json> --shards <count> --out <dir>';

function fail(message) {
	console.error(message);
	process.exit(1);
}

function parseArgs(argv) {
	const options = {};
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (!token.startsWith('--')) fail(USAGE);
		const key = token.slice(2);
		const value = argv[index + 1];
		if (!value || value.startsWith('--')) fail(USAGE);
		options[key] = value;
		index += 1;
	}
	return options;
}

function readJson(path, label) {
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch (error) {
		if (error?.code === 'ENOENT') fail(`Cannot read ${label} file ${path}.`);
		fail(`Cannot parse ${label} file ${path}: ${error.message}`);
	}
}

function sha256(value) {
	return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function collect(report) {
	const groups = new Map();
	const keys = [];
	function walk(suites) {
		for (const suite of suites ?? []) {
			for (const spec of suite.specs ?? []) {
				for (const test of spec.tests ?? []) {
					if ((test.results ?? []).length > 0) {
						fail('The planner requires a --list report, not an execution report.');
					}
					const file = spec.file ?? suite.file;
					if (!file) fail('A listed test has no file.');
					const project = test.projectName ?? '';
					const key = `${spec.id ?? [suite.file ?? spec.file ?? '', spec.line ?? 0, spec.title ?? ''].join('::')}::${project}`;
					const groupKey = `${project}::${file}`;
					const group = groups.get(groupKey) ?? { project, file, tests: [] };
					group.tests.push(key);
					groups.set(groupKey, group);
					keys.push(key);
				}
			}
			walk(suite.suites);
		}
	}
	walk(report.suites);
	return { groups, keys };
}

function loadWeights(path) {
	const value = readJson(path, 'weights');
	if (value?.version !== 1 || !Array.isArray(value.groups)) {
		fail(`Invalid weights file ${path}: expected version 1 and a groups array.`);
	}
	if (typeof value.fallbackSeconds !== 'number' || value.fallbackSeconds <= 0) {
		fail(`Invalid weights file ${path}: fallbackSeconds must be a positive number.`);
	}
	const entries = new Map();
	for (const entry of value.groups) {
		if (
			typeof entry?.project !== 'string' ||
			typeof entry?.file !== 'string' ||
			typeof entry?.seconds !== 'number' ||
			entry.seconds < 0 ||
			!Number.isInteger(entry?.tests) ||
			entry.tests < 1
		) {
			fail(`Invalid weight entry in ${path}: ${JSON.stringify(entry)}.`);
		}
		const key = `${entry.project}::${entry.file}`;
		if (entries.has(key)) fail(`Duplicate weight entry in ${path}: ${key}.`);
		entries.set(key, entry);
	}
	return { entries, fallbackSeconds: value.fallbackSeconds, raw: value };
}

function balance(groups, shardCount) {
	const shards = Array.from({ length: shardCount }, (_, index) => ({
		shard: index + 1,
		seconds: 0,
		groups: [],
		tests: []
	}));
	const ordered = [...groups].sort(
		([leftKey, left], [rightKey, right]) =>
			right.weight - left.weight || leftKey.localeCompare(rightKey)
	);
	for (const [key, group] of ordered) {
		let target = shards[0];
		for (const shard of shards) {
			if (shard.seconds < target.seconds) target = shard;
		}
		target.seconds += group.weight;
		target.groups.push(key);
		target.tests.push(...group.tests);
	}
	for (const shard of shards) {
		shard.seconds = Math.round(shard.seconds * 10) / 10;
		shard.groups.sort();
		shard.tests.sort();
	}
	return shards;
}

const [mode, ...rest] = process.argv.slice(2);
if (mode !== 'plan') fail(USAGE);
const options = parseArgs(rest);
if (!options.list || !options.weights || !options.shards || !options.out) fail(USAGE);
const shardCount = Number(options.shards);
if (!Number.isInteger(shardCount) || shardCount < 1) fail(USAGE);

const listReport = readJson(options.list, 'test list');
if (listReport.config?.shard) fail('The full list must not declare a shard.');
const collected = collect(listReport);
if (collected.keys.length === 0) fail('The test list is empty.');
if (new Set(collected.keys).size !== collected.keys.length) {
	fail('The test list contains a duplicate test.');
}

const weights = loadWeights(options.weights);
const staleGroups = [];
for (const key of weights.entries.keys()) {
	if (!collected.groups.has(key)) {
		staleGroups.push(key);
	}
}

const unknownGroups = [];
const measured = new Map();
for (const [key, group] of collected.groups) {
	const entry = weights.entries.get(key);
	let weight;
	if (!entry) {
		unknownGroups.push(key);
		weight = weights.fallbackSeconds * group.tests.length;
	} else {
		const scale = group.tests.length / entry.tests;
		weight = entry.seconds * Math.max(1, scale);
	}
	measured.set(key, { ...group, weight });
}

if (shardCount > measured.size) {
	fail(`Cannot use ${shardCount} shards for ${measured.size} browser and file groups.`);
}

const shards = balance(measured, shardCount);
const fullListSha256 = sha256([...collected.keys].sort());
const weightsSha256 = sha256(weights.raw);
const partition = {
	version: 1,
	shardCount,
	fullListSha256,
	weightsSha256,
	unknownGroups: unknownGroups.sort(),
	staleWeightGroups: staleGroups.sort(),
	shards
};
partition.partitionSha256 = sha256({
	version: partition.version,
	shardCount: partition.shardCount,
	fullListSha256: partition.fullListSha256,
	weightsSha256: partition.weightsSha256,
	shards: partition.shards.map((shard) => ({ shard: shard.shard, groups: shard.groups }))
});

mkdirSync(options.out, { recursive: true });
writeFileSync(join(options.out, 'plan.json'), `${JSON.stringify(partition, null, 1)}\n`);
for (const shard of shards) {
	const lines = shard.groups.map((key) => {
		const [project, file] = key.split('::');
		return `[${project}] \u203a ${file}`;
	});
	writeFileSync(join(options.out, `shard-${shard.shard}.list`), `${lines.join('\n')}\n`);
	writeFileSync(
		join(options.out, `shard-${shard.shard}.meta.json`),
		`${JSON.stringify({
			shard: shard.shard,
			count: shardCount,
			partitionSha256: partition.partitionSha256,
			fullListSha256,
			testsSha256: sha256([...shard.tests].sort())
		})}\n`
	);
}

for (const key of unknownGroups) console.error(`Unmeasured group ${key} uses the fallback weight.`);
for (const key of staleGroups.sort()) {
	console.error(
		`Stale weight entry ${key} matches no listed test file. Remove it from ${options.weights} or refresh it from a measured run; the plan ignores it.`
	);
}
console.log(
	`Planned ${collected.keys.length} tests in ${measured.size} groups across ${shardCount} shards (partition ${partition.partitionSha256.slice(0, 12)}).`
);
for (const shard of shards) {
	console.log(
		`  shard ${shard.shard}: ${shard.seconds}s, ${shard.tests.length} tests, ${shard.groups.length} groups`
	);
}

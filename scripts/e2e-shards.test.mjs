// Fail-closed fixtures for the measured E2E shard planner. The planner must
// keep every listed test, include unknown files with a conservative weight and
// refuse a missing or duplicated weight entry. A stale weight entry is a
// scheduling hint for a removed file: warn and ignore it, never block CI.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';

const script = resolve(import.meta.dirname, 'e2e-shards.mjs');
const roots = [];

function root() {
	const dir = mkdtempSync(join(tmpdir(), 'deckmark-shards-'));
	roots.push(dir);
	return dir;
}

function spec(file, line, tests) {
	return {
		id: `${file}:${line}`,
		title: `${file} ${line}`,
		file,
		line,
		column: 1,
		tests: tests.map(([projectName]) => ({ projectName, results: [] }))
	};
}

function listReport(groups) {
	return {
		config: {
			version: '1.64.1',
			rootDir: '/repo/e2e',
			grep: null,
			grepInvert: 'Snapshots visuels',
			shard: null,
			workers: 1,
			projects: [{ name: 'chromium' }, { name: 'firefox' }],
			metadata: { source: 'abc123', sourceTree: 'def456' }
		},
		suites: [
			{
				file: 'suite.spec.ts',
				line: 1,
				specs: groups.flatMap(([file, line, projects]) => [spec(file, line, projects)])
			}
		]
	};
}

function weights(groups, fallbackSeconds = 60) {
	return {
		version: 1,
		source: 'fixture',
		fallbackSeconds,
		groups: groups.map(([project, file, seconds, tests]) => ({ project, file, seconds, tests }))
	};
}

function writeJson(path, value) {
	writeFileSync(path, JSON.stringify(value));
}

function sha256(value) {
	return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function plan({ list, weightFile, shards = 2, dir = root() }) {
	const listPath = join(dir, 'all-tests.json');
	const weightsPath = join(dir, 'weights.json');
	writeJson(listPath, list);
	writeJson(weightsPath, weightFile);
	const out = join(dir, 'out');
	const args = [
		script,
		'plan',
		'--list',
		listPath,
		'--weights',
		weightsPath,
		'--shards',
		String(shards),
		'--out',
		out
	];
	const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
	return {
		status: result.status ?? 1,
		output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		out,
		dir
	};
}

function readPlan(out) {
	return JSON.parse(readFileSync(join(out, 'plan.json'), 'utf8'));
}

function readList(out, shard) {
	return readFileSync(join(out, `shard-${shard}.list`), 'utf8')
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean);
}

afterEach(() => {
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('assigns every group once and keeps a deterministic balance', () => {
	const list = listReport([
		['a.spec.ts', 1, [['chromium']]],
		['b.spec.ts', 1, [['chromium']]],
		['c.spec.ts', 1, [['chromium']]],
		['d.spec.ts', 1, [['firefox']]],
		['e.spec.ts', 1, [['firefox']]]
	]);
	const weightFile = weights([
		['chromium', 'a.spec.ts', 50, 1],
		['chromium', 'b.spec.ts', 40, 1],
		['chromium', 'c.spec.ts', 30, 1],
		['firefox', 'd.spec.ts', 20, 1],
		['firefox', 'e.spec.ts', 10, 1]
	]);
	const first = plan({ list, weightFile, shards: 2 });
	assert.equal(first.status, 0, first.output);
	const second = plan({ list, weightFile, shards: 2 });
	assert.equal(second.status, 0, second.output);
	assert.equal(
		readFileSync(join(first.out, 'plan.json'), 'utf8'),
		readFileSync(join(second.out, 'plan.json'), 'utf8')
	);
	const value = readPlan(first.out);
	assert.equal(value.shardCount, 2);
	const assigned = value.shards.flatMap((shard) => shard.groups);
	assert.equal(assigned.length, 5);
	assert.equal(new Set(assigned).size, 5);
	assert.deepEqual(
		readList(first.out, 1).sort(),
		['[chromium] › a.spec.ts', '[firefox] › d.spec.ts', '[firefox] › e.spec.ts'].sort()
	);
});

test('includes a new test in a known file without dropping it', () => {
	const list = listReport([
		['a.spec.ts', 1, [['chromium']]],
		['a.spec.ts', 2, [['chromium']]],
		['b.spec.ts', 1, [['chromium']]]
	]);
	const weightFile = weights([
		['chromium', 'a.spec.ts', 10, 1],
		['chromium', 'b.spec.ts', 10, 1]
	]);
	const result = plan({ list, weightFile, shards: 2 });
	assert.equal(result.status, 0, result.output);
	const value = readPlan(result.out);
	const all = value.shards.flatMap((shard) => shard.tests);
	assert.equal(all.length, 3);
	assert.equal(new Set(all).size, 3);
	assert.ok(value.shards.some((shard) => shard.groups.includes('chromium::a.spec.ts')));
});

test('includes an unknown file with the conservative fallback weight', () => {
	const list = listReport([
		['a.spec.ts', 1, [['chromium']]],
		['new.spec.ts', 1, [['chromium']]]
	]);
	const weightFile = weights([['chromium', 'a.spec.ts', 10, 1]]);
	const result = plan({ list, weightFile, shards: 2 });
	assert.equal(result.status, 0, result.output);
	const value = readPlan(result.out);
	assert.deepEqual(value.unknownGroups, ['chromium::new.spec.ts']);
	assert.ok(value.shards.some((shard) => shard.groups.includes('chromium::new.spec.ts')));
});

test('rejects a missing weights file', () => {
	const list = listReport([['a.spec.ts', 1, [['chromium']]]]);
	const dir = root();
	writeJson(join(dir, 'all-tests.json'), list);
	try {
		execFileSync(process.execPath, [
			script,
			'plan',
			'--list',
			join(dir, 'all-tests.json'),
			'--weights',
			join(dir, 'missing-weights.json'),
			'--shards',
			'1',
			'--out',
			join(dir, 'out')
		]);
		assert.fail('the command must fail');
	} catch (error) {
		const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
		assert.notEqual(error.status, 0);
		assert.match(output, /weights/i);
	}
});

test('rejects corrupted weights', () => {
	const list = listReport([['a.spec.ts', 1, [['chromium']]]]);
	const dir = root();
	writeJson(join(dir, 'all-tests.json'), list);
	writeFileSync(join(dir, 'weights.json'), '{not json');
	try {
		execFileSync(process.execPath, [
			script,
			'plan',
			'--list',
			join(dir, 'all-tests.json'),
			'--weights',
			join(dir, 'weights.json'),
			'--shards',
			'1',
			'--out',
			join(dir, 'out')
		]);
		assert.fail('the command must fail');
	} catch (error) {
		const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
		assert.notEqual(error.status, 0);
		assert.match(output, /weights/i);
	}
});

test('rejects a duplicate weight entry', () => {
	const list = listReport([['a.spec.ts', 1, [['chromium']]]]);
	const weightFile = weights([
		['chromium', 'a.spec.ts', 10, 1],
		['chromium', 'a.spec.ts', 20, 1]
	]);
	const result = plan({ list, weightFile, shards: 1 });
	assert.notEqual(result.status, 0);
	assert.match(result.output, /duplicate/i);
});

test('warns and ignores a stale weight entry instead of blocking the plan', () => {
	const list = listReport([
		['a.spec.ts', 1, [['chromium']]],
		['a.spec.ts', 2, [['chromium']]],
		['b.spec.ts', 1, [['chromium']]]
	]);
	const weightFile = weights([
		['chromium', 'a.spec.ts', 10, 1],
		['chromium', 'removed.spec.ts', 10, 1]
	]);
	const result = plan({ list, weightFile, shards: 2 });
	assert.equal(result.status, 0, result.output);
	assert.match(result.stderr, /removed\.spec\.ts/);
	assert.match(result.stderr, /remove|refresh/i);
	const value = readPlan(result.out);
	assert.deepEqual(value.staleWeightGroups, ['chromium::removed.spec.ts']);
	assert.deepEqual(
		value.shards.flatMap((shard) => shard.tests).sort(),
		['a.spec.ts:1::chromium', 'a.spec.ts:2::chromium', 'b.spec.ts:1::chromium'].sort()
	);
});

test('records the planned shard test digest in each shard metadata', () => {
	const list = listReport([
		['a.spec.ts', 1, [['chromium']]],
		['b.spec.ts', 1, [['chromium']]],
		['c.spec.ts', 1, [['firefox']]]
	]);
	const weightFile = weights([
		['chromium', 'a.spec.ts', 10, 1],
		['chromium', 'b.spec.ts', 20, 1],
		['firefox', 'c.spec.ts', 30, 1]
	]);
	const result = plan({ list, weightFile, shards: 2 });
	assert.equal(result.status, 0, result.output);
	const value = readPlan(result.out);
	for (const shard of value.shards) {
		const meta = JSON.parse(
			readFileSync(join(result.out, `shard-${shard.shard}.meta.json`), 'utf8')
		);
		assert.equal(meta.shard, shard.shard);
		assert.equal(meta.count, 2);
		assert.equal(meta.partitionSha256, value.partitionSha256);
		assert.equal(meta.fullListSha256, value.fullListSha256);
		assert.equal(meta.testsSha256, sha256([...shard.tests].sort()));
	}
});

test('rejects more shards than groups', () => {
	const list = listReport([['a.spec.ts', 1, [['chromium']]]]);
	const result = plan({ list, weightFile: weights([['chromium', 'a.spec.ts', 10, 1]]), shards: 2 });
	assert.notEqual(result.status, 0);
	assert.match(result.output, /shard/i);
});

test('changes the partition hash when the weights change', () => {
	const list = listReport([
		['a.spec.ts', 1, [['chromium']]],
		['b.spec.ts', 1, [['chromium']]]
	]);
	const first = plan({
		list,
		weightFile: weights([
			['chromium', 'a.spec.ts', 10, 1],
			['chromium', 'b.spec.ts', 20, 1]
		]),
		shards: 2
	});
	const second = plan({
		list,
		weightFile: weights([
			['chromium', 'a.spec.ts', 30, 1],
			['chromium', 'b.spec.ts', 20, 1]
		]),
		shards: 2
	});
	assert.equal(first.status, 0, first.output);
	assert.equal(second.status, 0, second.output);
	assert.notEqual(readPlan(first.out).partitionSha256, readPlan(second.out).partitionSha256);
});

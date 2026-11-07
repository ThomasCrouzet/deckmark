// Fail-closed fixtures for the E2E manifest gate. A list report is not
// execution proof, a missing or duplicated test must fail, and an intentional
// skip must carry an explicit reason.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';

const script = resolve(import.meta.dirname, 'check-e2e-manifest.mjs');
const roots = [];

const passed = (retry = 0) => ({ status: 'passed', retry });
const skipped = () => ({ status: 'skipped', retry: 0 });
const interrupted = () => ({ status: 'interrupted', retry: 0 });

function entry(projectName, overrides = {}) {
	return {
		projectName,
		expectedStatus: 'passed',
		annotations: [],
		results: [passed()],
		status: 'expected',
		...overrides
	};
}

function spec(title, line, tests, id = `${title}:${line}`) {
	return { id, title, line, tests };
}

function config(shard = null) {
	return {
		version: '1.64.1',
		rootDir: '/repo',
		grep: null,
		grepInvert: 'Snapshots visuels',
		shard,
		workers: 1,
		projects: [{ name: 'chromium' }, { name: 'firefox' }, { name: 'webkit' }],
		metadata: {
			source: 'abc123',
			sourceTree: 'def456',
			workingDiffSha256: '0'.repeat(64),
			untracked: [],
			environment: { platform: 'linux', arch: 'x64' },
			nodeVersion: 'v22',
			prebuilt: true,
			repeatCommand: 'npx playwright test'
		}
	};
}

function report(...specs) {
	return { config: config(), suites: [{ file: 'example.spec.ts', line: 1, specs }] };
}

function listReport(...specs) {
	return report(
		...specs.map((item) => ({
			...item,
			tests: item.tests.map((testEntry) => ({ ...testEntry, results: [] }))
		}))
	);
}

function withShard(reportValue, current, total) {
	return { ...reportValue, config: { ...reportValue.config, shard: { current, total } } };
}

function withSource(reportValue, source) {
	return {
		...reportValue,
		config: {
			...reportValue.config,
			metadata: { ...reportValue.config.metadata, source }
		}
	};
}

function withPartition(reportValue, partition) {
	return {
		...reportValue,
		config: {
			...reportValue.config,
			metadata: { ...reportValue.config.metadata, partition }
		}
	};
}

function keysOf(reportValue) {
	const keys = [];
	function walk(suites) {
		for (const suite of suites ?? []) {
			for (const spec of suite.specs ?? []) {
				for (const test of spec.tests ?? []) {
					keys.push(`${spec.id}::${test.projectName}`);
				}
			}
			walk(suite.suites);
		}
	}
	walk(reportValue.suites);
	return keys.sort();
}

function sha256(value) {
	return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function planFor(expected, shardGroups, shardCount = shardGroups.length) {
	const fullListSha256 = sha256(keysOf(expected));
	const shards = shardGroups.map((specs, index) => ({
		shard: index + 1,
		seconds: 10,
		groups: specs.flatMap((item) => item.tests.map((test) => `${test.projectName}::${item.file}`)),
		tests: specs.flatMap((item) => item.tests.map((test) => `${item.id}::${test.projectName}`))
	}));
	const plan = {
		version: 1,
		shardCount,
		fullListSha256,
		weightsSha256: 'e'.repeat(64),
		unknownGroups: [],
		shards
	};
	plan.partitionSha256 = sha256({
		version: plan.version,
		shardCount: plan.shardCount,
		fullListSha256: plan.fullListSha256,
		weightsSha256: plan.weightsSha256,
		shards: plan.shards.map((shard) => ({ shard: shard.shard, groups: shard.groups }))
	});
	return plan;
}

function runPlan(expected, plan, shards, declaredShards = shards.length) {
	const root = mkdtempSync(join(tmpdir(), 'deckmark-plan-'));
	roots.push(root);
	const expectedPath = join(root, 'expected.json');
	const planPath = join(root, 'plan.json');
	writeFileSync(expectedPath, JSON.stringify(expected));
	writeFileSync(planPath, JSON.stringify(plan));
	const actualPaths = shards.map((shard, index) => {
		const path = join(root, `shard-${index + 1}.json`);
		writeFileSync(
			path,
			JSON.stringify(
				withPartition(withShard(shard, index + 1, declaredShards), {
					shard: index + 1,
					count: declaredShards,
					partitionSha256: plan.partitionSha256
				})
			)
		);
		return path;
	});
	try {
		return {
			status: 0,
			output: execFileSync(
				process.execPath,
				[script, 'plan', String(declaredShards), expectedPath, planPath, ...actualPaths],
				{ encoding: 'utf8' }
			)
		};
	} catch (error) {
		return { status: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
	}
}

function writeReports(expected, actuals, prefix = 'actual') {
	const root = mkdtempSync(join(tmpdir(), 'deckmark-manifest-'));
	roots.push(root);
	const expectedPath = join(root, 'expected.json');
	writeFileSync(expectedPath, JSON.stringify(expected));
	const actualPaths = actuals.map((actual, index) => {
		const path = join(root, `${prefix}-${index}.json`);
		writeFileSync(path, JSON.stringify(actual));
		return path;
	});
	return { root, expectedPath, actualPaths };
}

function run(mode, expected, actuals, declaredShards) {
	const { expectedPath, actualPaths } = writeReports(expected, actuals);
	const args =
		mode === 'partition'
			? [script, mode, String(declaredShards), expectedPath, ...actualPaths]
			: [script, mode, expectedPath, ...actualPaths];
	try {
		return {
			status: 0,
			output: execFileSync(process.execPath, args, { encoding: 'utf8' })
		};
	} catch (error) {
		return { status: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
	}
}

function runExecution(expected, actual) {
	return run('execution', expected, [actual]);
}

function runPartition(expected, shards, declaredShards = shards.length) {
	return run(
		'partition',
		expected,
		shards.map((shard, index) => withShard(shard, index + 1, declaredShards)),
		declaredShards
	);
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('accepts a complete execution report', () => {
	const expected = listReport(
		spec('first', 3, [entry('chromium')]),
		spec('second', 9, [entry('firefox')])
	);
	const actual = report(
		spec('first', 3, [entry('chromium')]),
		spec('second', 9, [entry('firefox')])
	);
	const result = runExecution(expected, actual);
	assert.equal(result.status, 0, result.output);
	assert.match(result.output, /Executed: 2/);
});

test('rejects a missing test', () => {
	const expected = listReport(
		spec('first', 3, [entry('chromium')]),
		spec('second', 9, [entry('firefox')])
	);
	const actual = report(spec('first', 3, [entry('chromium')]));
	const result = runExecution(expected, actual);
	assert.notEqual(result.status, 0);
	assert.match(result.output, /Missing tests/);
});

test('rejects a duplicated test', () => {
	const expected = listReport(spec('first', 3, [entry('chromium')]));
	const actual = report(
		spec('first', 3, [entry('chromium')]),
		spec('first', 3, [entry('chromium')])
	);
	const result = runExecution(expected, actual);
	assert.notEqual(result.status, 0);
	assert.match(result.output, /Duplicate tests/);
});

test('rejects an unexpected extra test', () => {
	const expected = listReport(spec('first', 3, [entry('chromium')]));
	const actual = report(
		spec('first', 3, [entry('chromium')]),
		spec('extra', 20, [entry('chromium')])
	);
	const result = runExecution(expected, actual);
	assert.notEqual(result.status, 0);
	assert.match(result.output, /Unexpected tests/);
});

test('rejects an assigned test with no result', () => {
	const expected = listReport(spec('first', 3, [entry('chromium')]));
	const actual = report(spec('first', 3, [entry('chromium', { results: [] })]));
	const result = runExecution(expected, actual);
	assert.notEqual(result.status, 0);
	assert.match(result.output, /Not executed/);
});

test('rejects an unexpected skip', () => {
	const expected = listReport(spec('first', 3, [entry('chromium')]));
	const actual = report(
		spec('first', 3, [
			entry('chromium', {
				results: [skipped()]
			})
		])
	);
	const result = runExecution(expected, actual);
	assert.notEqual(result.status, 0);
	assert.match(result.output, /Unexpected skip/);
});

test('accepts a justified skip with a reason', () => {
	const expected = listReport(
		spec('first', 3, [entry('chromium')]),
		spec('second', 9, [entry('firefox')])
	);
	const actual = report(
		spec('first', 3, [entry('chromium')]),
		spec('second', 9, [
			entry('firefox', {
				expectedStatus: 'skipped',
				annotations: [{ type: 'skip', description: 'Firefox only' }],
				results: [skipped()]
			})
		])
	);
	const result = runExecution(expected, actual);
	assert.equal(result.status, 0, result.output);
	assert.match(result.output, /Executed: 1/);
	assert.match(result.output, /Justified skips: 1/);
});

test('rejects an interrupted test', () => {
	const expected = listReport(spec('first', 3, [entry('chromium')]));
	const actual = report(spec('first', 3, [entry('chromium', { results: [interrupted()] })]));
	const result = runExecution(expected, actual);
	assert.notEqual(result.status, 0);
	assert.match(result.output, /Interrupted/);
});

test('rejects a shard where every test is not executed', () => {
	const expected = listReport(
		spec('first', 3, [entry('chromium')]),
		spec('second', 9, [entry('firefox')])
	);
	const actual = report(
		spec('first', 3, [entry('chromium', { results: [] })]),
		spec('second', 9, [entry('firefox', { results: [] })])
	);
	const result = runExecution(expected, actual);
	assert.notEqual(result.status, 0);
	assert.match(result.output, /No test executed/);
});

test('rejects a list report as execution proof', () => {
	const expected = listReport(spec('first', 3, [entry('chromium')]));
	const actual = listReport(spec('first', 3, [entry('chromium')]));
	const result = runExecution(expected, actual);
	assert.notEqual(result.status, 0);
	assert.match(result.output, /Not executed/);
});

test('rejects a missing report with one diagnostic line', () => {
	const expected = listReport(spec('first', 3, [entry('chromium')]));
	const { root, expectedPath } = writeReports(expected, []);
	const missing = join(root, 'does-not-exist.json');
	try {
		execFileSync(process.execPath, [script, 'execution', expectedPath, missing], {
			encoding: 'utf8'
		});
		assert.fail('the command must fail');
	} catch (error) {
		const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
		assert.notEqual(error.status, 0);
		assert.match(output, /Missing report/);
		assert.equal(output.trim().split('\n').length, 1);
	}
});

test('accepts a complete partition across multiple shard lists', () => {
	const expected = listReport(
		spec('first', 3, [entry('chromium')]),
		spec('second', 9, [entry('firefox')])
	);
	const result = runPartition(expected, [
		listReport(spec('first', 3, [entry('chromium')])),
		listReport(spec('second', 9, [entry('firefox')]))
	]);
	assert.equal(result.status, 0, result.output);
	assert.match(result.output, /2 tests/);
});

test('rejects a test present in two shard lists', () => {
	const expected = listReport(
		spec('first', 3, [entry('chromium')]),
		spec('second', 9, [entry('firefox')])
	);
	const result = runPartition(expected, [
		listReport(spec('first', 3, [entry('chromium')])),
		listReport(spec('first', 3, [entry('chromium')]), spec('second', 9, [entry('firefox')]))
	]);
	assert.notEqual(result.status, 0);
	assert.match(result.output, /Duplicate tests/);
});

test('rejects a partition with an execution report', () => {
	const expected = listReport(spec('first', 3, [entry('chromium')]));
	const result = runPartition(expected, [report(spec('first', 3, [entry('chromium')]))]);
	assert.notEqual(result.status, 0);
	assert.match(result.output, /list report/);
});

test('rejects a shard count mismatch', () => {
	const expected = listReport(
		spec('first', 3, [entry('chromium')]),
		spec('second', 9, [entry('firefox')])
	);
	const result = runPartition(expected, [listReport(spec('first', 3, [entry('chromium')]))], 2);
	assert.notEqual(result.status, 0);
	assert.match(result.output, /Shard count/);
});

test('rejects expected and actual reports with different sources', () => {
	const expected = listReport(spec('first', 3, [entry('chromium')]));
	const actual = withSource(report(spec('first', 3, [entry('chromium')])), 'other');
	const result = runExecution(expected, actual);
	assert.notEqual(result.status, 0);
	assert.match(result.output, /different effective inputs/);
});

test('rejects a shard list with a different source', () => {
	const expected = listReport(
		spec('first', 3, [entry('chromium')]),
		spec('second', 9, [entry('firefox')])
	);
	const result = runPartition(expected, [
		listReport(spec('first', 3, [entry('chromium')])),
		withSource(listReport(spec('second', 9, [entry('firefox')])), 'other')
	]);
	assert.notEqual(result.status, 0);
	assert.match(result.output, /different effective inputs/);
});

test('accepts two specs with the same title and line and different ids', () => {
	const expected = listReport(
		spec('first', 3, [entry('chromium')], 'id-a'),
		spec('first', 3, [entry('chromium')], 'id-b')
	);
	const actual = report(
		spec('first', 3, [entry('chromium')], 'id-a'),
		spec('first', 3, [entry('chromium')], 'id-b')
	);
	const result = runExecution(expected, actual);
	assert.equal(result.status, 0, result.output);
	assert.match(result.output, /Executed: 2/);
});

test('accepts a plan partition with matching shard lists and identity', () => {
	const first = spec('first', 3, [entry('chromium')]);
	const second = spec('second', 9, [entry('firefox')]);
	const expected = listReport(first, second);
	const plan = planFor(expected, [[first], [second]]);
	const result = runPlan(expected, plan, [listReport(first), listReport(second)]);
	assert.equal(result.status, 0, result.output);
	assert.match(result.output, /Plan partition covers every expected test exactly once \(2 tests\)/);
});

test('rejects a plan shard list with a different test', () => {
	const first = spec('first', 3, [entry('chromium')]);
	const second = spec('second', 9, [entry('firefox')]);
	const expected = listReport(first, second);
	const plan = planFor(expected, [[first], [second]]);
	const result = runPlan(expected, plan, [listReport(second), listReport(second)]);
	assert.notEqual(result.status, 0);
	assert.match(result.output, /Missing|Unexpected/);
});

test('rejects a plan with a different full list hash', () => {
	const first = spec('first', 3, [entry('chromium')]);
	const second = spec('second', 9, [entry('firefox')]);
	const expected = listReport(first, second);
	const plan = planFor(expected, [[first], [second]]);
	plan.fullListSha256 = 'a'.repeat(64);
	const result = runPlan(expected, plan, [listReport(first), listReport(second)]);
	assert.notEqual(result.status, 0);
	assert.match(result.output, /full test list/i);
});

test('rejects a plan with a tampered partition hash', () => {
	const first = spec('first', 3, [entry('chromium')]);
	const second = spec('second', 9, [entry('firefox')]);
	const expected = listReport(first, second);
	const plan = planFor(expected, [[first], [second]]);
	plan.partitionSha256 = 'a'.repeat(64);
	const result = runPlan(expected, plan, [listReport(first), listReport(second)]);
	assert.notEqual(result.status, 0);
	assert.match(result.output, /partition hash/i);
});

test('rejects a shard list with a different partition identity', () => {
	const first = spec('first', 3, [entry('chromium')]);
	const second = spec('second', 9, [entry('firefox')]);
	const expected = listReport(first, second);
	const plan = planFor(expected, [[first], [second]]);
	const root = mkdtempSync(join(tmpdir(), 'deckmark-plan-'));
	roots.push(root);
	const expectedPath = join(root, 'expected.json');
	const planPath = join(root, 'plan.json');
	writeFileSync(expectedPath, JSON.stringify(expected));
	writeFileSync(planPath, JSON.stringify(plan));
	const paths = [first, second].map((item, index) => {
		const path = join(root, `shard-${index + 1}.json`);
		writeFileSync(
			path,
			JSON.stringify(
				withPartition(withShard(listReport(item), index + 1, 2), {
					shard: index + 1,
					count: 2,
					partitionSha256: 'b'.repeat(64)
				})
			)
		);
		return path;
	});
	try {
		execFileSync(process.execPath, [script, 'plan', '2', expectedPath, planPath, ...paths]);
		assert.fail('the command must fail');
	} catch (error) {
		const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
		assert.notEqual(error.status, 0);
		assert.match(output, /partition/i);
	}
});

test('rejects a plan with a missing test', () => {
	const first = spec('first', 3, [entry('chromium')]);
	const second = spec('second', 9, [entry('firefox')]);
	const expected = listReport(first, second);
	const plan = planFor(expected, [[first], [second]]);
	plan.shards[1].tests = [];
	const result = runPlan(expected, plan, [listReport(first), listReport(second)]);
	assert.notEqual(result.status, 0);
	assert.match(result.output, /Missing/);
});

test('rejects an execution report in plan mode', () => {
	const first = spec('first', 3, [entry('chromium')]);
	const second = spec('second', 9, [entry('firefox')]);
	const expected = listReport(first, second);
	const plan = planFor(expected, [[first], [second]]);
	const result = runPlan(expected, plan, [report(first), report(second)]);
	assert.notEqual(result.status, 0);
	assert.match(result.output, /list report/);
});

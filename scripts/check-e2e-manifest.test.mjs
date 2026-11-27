// Fail-closed fixtures for the E2E manifest gate. A list report is not
// execution proof, a missing or duplicated test must fail, and an intentional
// skip must carry an explicit reason.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { e2eTestKey } from './e2e-test-key.mjs';

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
	function walk(suites, path) {
		for (const suite of suites ?? []) {
			const suitePath = [...path, suite.title ?? ''];
			for (const spec of suite.specs ?? []) {
				for (const test of spec.tests ?? []) {
					keys.push(e2eTestKey(spec, test, suitePath));
				}
			}
			walk(suite.suites, suitePath);
		}
	}
	walk(reportValue.suites, []);
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
		tests: specs.flatMap((item) => item.tests.map((test) => e2eTestKey(item, test, [''])))
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

function boundPartition(plan, index, declaredShards, overrides = {}) {
	return {
		shard: index + 1,
		count: declaredShards,
		partitionSha256: plan.partitionSha256,
		fullListSha256: plan.fullListSha256,
		testsSha256: sha256([...(plan.shards[index].tests ?? [])].sort()),
		...overrides
	};
}

function runPlan(
	expected,
	plan,
	shards,
	declaredShards = shards.length,
	partitionFor = boundPartition
) {
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
				withPartition(
					withShard(shard, index + 1, declaredShards),
					partitionFor(plan, index, declaredShards)
				)
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

test('accepts the same title and line under different describes', () => {
	const list = (specValue) => ({
		...specValue,
		tests: specValue.tests.map((testValue) => ({ ...testValue, results: [] }))
	});
	const first = spec('first', 3, [entry('chromium')]);
	const second = spec('first', 3, [entry('chromium')]);
	const expected = {
		...report(),
		suites: [
			{ title: 'alpha', file: 'example.spec.ts', line: 1, specs: [list(first)] },
			{ title: 'beta', file: 'example.spec.ts', line: 1, specs: [list(second)] }
		]
	};
	const actual = {
		...report(),
		suites: [
			{ title: 'alpha', file: 'example.spec.ts', line: 1, specs: [first] },
			{ title: 'beta', file: 'example.spec.ts', line: 1, specs: [second] }
		]
	};
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
	const result = runPlan(
		expected,
		plan,
		[listReport(first), listReport(second)],
		2,
		(planValue, index, declaredShards) =>
			boundPartition(planValue, index, declaredShards, { partitionSha256: 'b'.repeat(64) })
	);
	assert.notEqual(result.status, 0);
	assert.match(result.output, /partition/i);
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

test('accepts a bound shard execution that matches the planned test digest', () => {
	const first = spec('first', 3, [entry('chromium')]);
	const second = spec('second', 9, [entry('firefox')]);
	const expected = listReport(first, second);
	const plan = planFor(expected, [[first], [second]]);
	const bound = boundPartition(plan, 0, 2);
	const result = runExecution(
		withPartition(listReport(first), bound),
		withPartition(report(first), bound)
	);
	assert.equal(result.status, 0, result.output);
	assert.match(result.output, /Executed: 1/);
});

test('rejects a substituted shard list with unchanged bound metadata', () => {
	const first = spec('first', 3, [entry('chromium')]);
	const second = spec('second', 9, [entry('firefox')]);
	const full = listReport(first, second);
	const plan = planFor(full, [[first], [second]]);
	// The bound metadata describes shard 1. A wrong --test-list selects shard 2
	// for both the expected list and the execution, so only the digest can fail.
	const bound = boundPartition(plan, 0, 2);
	const result = runExecution(
		withPartition(listReport(second), bound),
		withPartition(report(second), bound)
	);
	assert.notEqual(result.status, 0);
	assert.match(result.output, /shard test digest/i);
});

test('rejects bound metadata without the shard test digest', () => {
	const first = spec('first', 3, [entry('chromium')]);
	const second = spec('second', 9, [entry('firefox')]);
	const expected = listReport(first, second);
	const plan = planFor(expected, [[first], [second]]);
	const { testsSha256: _testsSha256, ...unbound } = boundPartition(plan, 0, 2);
	const result = runExecution(
		withPartition(listReport(first), unbound),
		withPartition(report(first), unbound)
	);
	assert.notEqual(result.status, 0);
	assert.match(result.output, /malformed/i);
	assert.match(result.output, /testsSha256/);
});

test('rejects bound metadata with a non-digest full list hash', () => {
	const first = spec('first', 3, [entry('chromium')]);
	const second = spec('second', 9, [entry('firefox')]);
	const expected = listReport(first, second);
	const plan = planFor(expected, [[first], [second]]);
	const bound = boundPartition(plan, 0, 2, { fullListSha256: 'not-a-digest' });
	const result = runExecution(
		withPartition(listReport(first), bound),
		withPartition(report(first), bound)
	);
	assert.notEqual(result.status, 0);
	assert.match(result.output, /malformed/i);
});

test('rejects a plan shard list whose bound test digest differs from the plan', () => {
	const first = spec('first', 3, [entry('chromium')]);
	const second = spec('second', 9, [entry('firefox')]);
	const expected = listReport(first, second);
	const plan = planFor(expected, [[first], [second]]);
	const result = runPlan(
		expected,
		plan,
		[listReport(first), listReport(second)],
		2,
		(planValue, index, declaredShards) =>
			boundPartition(planValue, index, declaredShards, { testsSha256: 'a'.repeat(64) })
	);
	assert.notEqual(result.status, 0);
	assert.match(result.output, /shard test digest/i);
});

// Flaky gate. A test that passed only on its retry has status `flaky` in the
// Playwright JSON report. It fails the shard unless the quarantine lists it.
const failedAttempt = () => ({ status: 'failed', retry: 0 });
const flakyEntry = (projectName) =>
	entry(projectName, { status: 'flaky', results: [failedAttempt(), passed(1)] });

function runFlaky(quarantine, actualSpecs, { today = '2026-11-27', summary = true } = {}) {
	const expected = listReport(...actualSpecs);
	const actual = report(...actualSpecs);
	const { root, expectedPath, actualPaths } = writeReports(expected, [actual]);
	const quarantinePath = join(root, 'quarantine.json');
	writeFileSync(
		quarantinePath,
		typeof quarantine === 'string' ? quarantine : JSON.stringify(quarantine)
	);
	const summaryPath = join(root, 'summary.md');
	const env = {
		...process.env,
		E2E_FLAKY_QUARANTINE: quarantinePath,
		E2E_QUARANTINE_TODAY: today
	};
	if (summary) env.GITHUB_STEP_SUMMARY = summaryPath;
	else delete env.GITHUB_STEP_SUMMARY;
	try {
		const output = execFileSync(
			process.execPath,
			[script, 'execution', expectedPath, ...actualPaths],
			{
				encoding: 'utf8',
				env
			}
		);
		return { status: 0, output, summaryPath };
	} catch (error) {
		return {
			status: error.status ?? 1,
			output: `${error.stdout ?? ''}${error.stderr ?? ''}`,
			summaryPath
		};
	}
}

const quarantined = {
	project: 'chromium',
	file: 'example.spec.ts',
	line: 3,
	title: 'first',
	issue: 801,
	added: '2026-11-20',
	expires: '2026-12-04'
};

test('the committed flaky quarantine starts empty and valid', () => {
	const value = JSON.parse(
		readFileSync(new URL('../e2e/flaky-quarantine.json', import.meta.url), 'utf8')
	);
	assert.deepEqual(value, []);
});

test('a flaky test that is not quarantined fails the shard and is named', () => {
	const result = runFlaky([], [spec('first', 3, [flakyEntry('chromium')])]);
	assert.notEqual(result.status, 0);
	assert.match(result.output, /FLAKY chromium example\.spec\.ts:3 first/);
	assert.match(result.output, /is not in e2e\/flaky-quarantine\.json/);
	assert.match(
		readFileSync(result.summaryPath, 'utf8'),
		/\| chromium \| example\.spec\.ts:3 \| first \| not quarantined \|/
	);
});

test('a quarantined flaky test passes, is printed and is listed in the summary', () => {
	const result = runFlaky([quarantined], [spec('first', 3, [flakyEntry('chromium')])]);
	assert.equal(result.status, 0, result.output);
	assert.match(result.output, /FLAKY chromium example\.spec\.ts:3 first/);
	assert.match(result.output, /Quarantined flaky tests: 1/);
	assert.match(readFileSync(result.summaryPath, 'utf8'), /\| #801 \|/);
});

test('a quarantine entry matches only the same project, file, line and title', () => {
	for (const change of [
		{ project: 'webkit' },
		{ line: 4 },
		{ title: 'other' },
		{ file: 'a.spec.ts' }
	]) {
		const result = runFlaky(
			[{ ...quarantined, ...change }],
			[spec('first', 3, [flakyEntry('chromium')])]
		);
		assert.notEqual(result.status, 0, JSON.stringify(change));
	}
});

test('an expired quarantine entry fails even without a flaky result', () => {
	const result = runFlaky([quarantined], [spec('first', 3, [entry('chromium')])], {
		today: '2026-12-05'
	});
	assert.notEqual(result.status, 0);
	assert.match(result.output, /expired on 2026-12-04 \(issue #801\)/);
	assert.equal(
		runFlaky([quarantined], [spec('first', 3, [entry('chromium')])], { today: '2026-12-04' })
			.status,
		0
	);
});

test('a malformed quarantine fails closed', () => {
	const tooMany = Array.from({ length: 11 }, (_, index) => ({ ...quarantined, line: index + 1 }));
	for (const [value, pattern] of [
		['not json', /Cannot read the flaky quarantine/],
		['{}', /must be a JSON array/],
		[tooMany, /limit is 10/],
		[[{ ...quarantined, issue: undefined }], /open issue/],
		[[{ ...quarantined, expires: '2026-12-31' }], /at most 14 days/],
		[[{ ...quarantined, expires: '2026-02-30' }], /YYYY-MM-DD/],
		[[{ ...quarantined, reason: 'x' }], /unknown fields: reason/],
		[[{ ...quarantined, line: 0 }], /positive integer line/]
	]) {
		const result = runFlaky(value, [spec('first', 3, [entry('chromium')])], { summary: false });
		assert.notEqual(result.status, 0, String(pattern));
		assert.match(result.output, pattern);
	}
});

test('a shard stopped at maxFailures names the stop before the tests that did not run', () => {
	const expected = listReport(
		spec('first', 3, [entry('chromium')]),
		spec('second', 9, [entry('chromium')])
	);
	const actual = {
		...report(
			spec('first', 3, [
				entry('chromium', {
					status: 'unexpected',
					results: [failedAttempt(), { status: 'failed', retry: 1 }]
				})
			]),
			spec('second', 9, [entry('chromium', { status: 'skipped', results: [] })])
		),
		errors: [
			{ message: '\u001b[31mTesting stopped early after 1 maximum allowed failures.\u001b[39m' }
		]
	};
	const result = runExecution(expected, actual);
	assert.notEqual(result.status, 0);
	assert.match(
		result.output,
		/stopped after the first failure \(maxFailures\); 1 tests did not run/
	);
	assert.match(result.output, /Not executed \(1\)/);
});

#!/usr/bin/env node
// Compare tests defined by the current configuration with tests that ran, or
// prove that the shard lists partition the full list. A missing, duplicated or
// extra test fails both modes. A list report is never accepted as execution
// proof.
// Usage:
//   node scripts/check-e2e-manifest.mjs partition <shard-count> <full-list.json> <shard-list.json>...
//   node scripts/check-e2e-manifest.mjs plan <shard-count> <full-list.json> <plan.json> <shard-list.json>...
//   node scripts/check-e2e-manifest.mjs execution <expected-list.json> <actual-report.json>
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const USAGE = `Usage:
  node scripts/check-e2e-manifest.mjs partition <shard-count> <full-list.json> <shard-list.json>...
  node scripts/check-e2e-manifest.mjs plan <shard-count> <full-list.json> <plan.json> <shard-list.json>...
  node scripts/check-e2e-manifest.mjs execution <expected-list.json> <actual-report.json>`;

function readReport(path) {
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch (error) {
		if (error?.code === 'ENOENT') {
			console.error(`Missing report ${path}`);
		} else {
			console.error(`Unreadable report ${path}: ${error.message}`);
		}
		process.exit(1);
	}
}

function collect(report) {
	const entries = [];
	let retried = 0;
	function walk(suites) {
		for (const suite of suites ?? []) {
			if (suite.specs) {
				for (const spec of suite.specs) {
					for (const test of spec.tests ?? []) {
						const specId =
							spec.id ??
							[suite.file ?? spec.file ?? '', spec.line ?? 0, spec.title ?? ''].join('::');
						entries.push({ key: `${specId}::${test.projectName ?? ''}`, test });
						for (const result of test.results ?? []) {
							if ((result.retry ?? 0) > 0) retried += 1;
						}
					}
				}
			}
			walk(suite.suites);
		}
	}
	walk(report.suites);
	return { entries, retried };
}

function countsFrom(entries) {
	const counts = new Map();
	for (const { key } of entries) counts.set(key, (counts.get(key) ?? 0) + 1);
	return counts;
}

function isListReport(entries) {
	return entries.every(({ test }) => (test.results ?? []).length === 0);
}

function effectiveInputs(report, { includeShard = true, includePartition = true } = {}) {
	const config = report.config ?? {};
	const metadata = config.metadata ?? {};
	return {
		version: config.version ?? null,
		rootDir: config.rootDir ?? null,
		grep: config.grep ?? null,
		grepInvert: config.grepInvert ?? null,
		...(includeShard ? { shard: config.shard ?? null } : {}),
		...(includePartition ? { partition: metadata.partition ?? null } : {}),
		workers: config.workers ?? null,
		projects: (config.projects ?? []).map((project) => ({
			name: project.name ?? null,
			testDir: project.testDir ?? null,
			testMatch: project.testMatch ?? null,
			testIgnore: project.testIgnore ?? null,
			use: project.use ?? null
		})),
		source: metadata.source ?? null,
		sourceTree: metadata.sourceTree ?? null,
		workingDiffSha256: metadata.workingDiffSha256 ?? null,
		untracked: metadata.untracked ?? [],
		environment: metadata.environment ?? null,
		nodeVersion: metadata.nodeVersion ?? null,
		prebuilt: metadata.prebuilt ?? null,
		repeatCommand: metadata.repeatCommand ?? null
	};
}

function requireSameInputs(expectedReport, actualReport, label) {
	const expected = effectiveInputs(expectedReport);
	const actual = effectiveInputs(actualReport);
	if (JSON.stringify(expected) === JSON.stringify(actual)) return;
	console.error(`Expected and actual reports used different effective inputs: ${label}.`);
	process.exit(1);
}

function reportDifferences(expected, actual) {
	const missing = [...expected.keys()].filter((key) => !actual.has(key));
	const extra = [...actual.keys()].filter((key) => !expected.has(key));
	const duplicated = [...actual.entries()].filter(([, count]) => count > 1);
	if (!missing.length && !extra.length && !duplicated.length) return;
	if (missing.length) console.error(`Missing tests (${missing.length}):\n${missing.join('\n')}`);
	if (extra.length) console.error(`Unexpected tests (${extra.length}):\n${extra.join('\n')}`);
	if (duplicated.length) {
		console.error(
			`Duplicate tests (${duplicated.length}):\n${duplicated.map(([key, count]) => `${count} x ${key}`).join('\n')}`
		);
	}
	process.exit(1);
}

const [mode, ...args] = process.argv.slice(2);

if (mode === 'partition') {
	const [declaredShards, expectedPath, ...actualPaths] = args;
	const shardCount = Number(declaredShards);
	if (
		!expectedPath ||
		actualPaths.length === 0 ||
		!Number.isInteger(shardCount) ||
		shardCount < 1
	) {
		console.error(USAGE);
		process.exit(2);
	}
	const fullReport = readReport(expectedPath);
	const expectedReport = collect(fullReport);
	if (!isListReport(expectedReport.entries)) {
		console.error('Partition requires a --list expected report, not an execution report.');
		process.exit(1);
	}
	if (fullReport.config?.shard) {
		console.error('The full expected list must not declare a shard.');
		process.exit(1);
	}
	const actualEntries = [];
	for (const actualPath of actualPaths) {
		const shardReport = readReport(actualPath);
		const report = collect(shardReport);
		if (!isListReport(report.entries)) {
			console.error(
				`Partition requires a list report for each shard, not an execution report: ${actualPath}`
			);
			process.exit(1);
		}
		const shard = shardReport.config?.shard;
		if (
			!shard ||
			shard.total !== shardCount ||
			!Number.isInteger(shard.current) ||
			shard.current < 1 ||
			shard.current > shardCount
		) {
			console.error(`Shard list ${actualPath} does not declare a shard in 1..${shardCount}.`);
			process.exit(1);
		}
		if (
			JSON.stringify(effectiveInputs(fullReport, { includeShard: false })) !==
			JSON.stringify(effectiveInputs(shardReport, { includeShard: false }))
		) {
			console.error(`Expected and actual reports used different effective inputs: ${actualPath}.`);
			process.exit(1);
		}
		actualEntries.push(...report.entries);
	}
	if (actualPaths.length !== shardCount) {
		console.error(
			`Shard count: expected ${shardCount} shard lists, received ${actualPaths.length}.`
		);
		process.exit(1);
	}
	if (expectedReport.entries.length === 0) {
		console.error('Expected test list is empty.');
		process.exit(1);
	}
	const expected = countsFrom(expectedReport.entries);
	const actual = countsFrom(actualEntries);
	reportDifferences(expected, actual);
	console.log(
		`Partition covers every expected test exactly once (${expected.size} tests) across ${shardCount} shard lists. No execution is claimed.`
	);
	process.exit(0);
}

if (mode === 'plan') {
	const [declaredShards, expectedPath, planPath, ...actualPaths] = args;
	const shardCount = Number(declaredShards);
	if (
		!expectedPath ||
		!planPath ||
		actualPaths.length === 0 ||
		!Number.isInteger(shardCount) ||
		shardCount < 1
	) {
		console.error(USAGE);
		process.exit(2);
	}
	const fullReport = readReport(expectedPath);
	const expectedReport = collect(fullReport);
	if (!isListReport(expectedReport.entries)) {
		console.error('Plan mode requires a --list full report.');
		process.exit(1);
	}
	if (fullReport.config?.shard) {
		console.error('The full expected list must not declare a shard.');
		process.exit(1);
	}
	const expectedKeys = [...countsFrom(expectedReport.entries).keys()].sort();
	const fullListSha256 = createHash('sha256').update(JSON.stringify(expectedKeys)).digest('hex');
	const plan = readReport(planPath);
	if (plan?.version !== 1 || plan.shardCount !== shardCount || !Array.isArray(plan.shards)) {
		console.error(`The plan does not declare ${shardCount} shards.`);
		process.exit(1);
	}
	if (plan.fullListSha256 !== fullListSha256) {
		console.error('The plan does not match the full test list hash.');
		process.exit(1);
	}
	if (plan.shards.length !== shardCount) {
		console.error(`The plan has ${plan.shards.length} shard entries, expected ${shardCount}.`);
		process.exit(1);
	}
	if (plan.shards.some((shard, index) => shard.shard !== index + 1)) {
		console.error('The plan shard entries are not ordered from 1 to the shard count.');
		process.exit(1);
	}
	const planHash = createHash('sha256')
		.update(
			JSON.stringify({
				version: plan.version,
				shardCount: plan.shardCount,
				fullListSha256: plan.fullListSha256,
				weightsSha256: plan.weightsSha256,
				shards: plan.shards.map((shard) => ({ shard: shard.shard, groups: shard.groups }))
			})
		)
		.digest('hex');
	if (plan.partitionSha256 !== planHash) {
		console.error('The plan partition hash does not match its shard groups.');
		process.exit(1);
	}
	const planKeys = plan.shards.flatMap((shard) => shard.tests ?? []);
	const planCounts = new Map();
	for (const key of planKeys) planCounts.set(key, (planCounts.get(key) ?? 0) + 1);
	reportDifferences(new Map(expectedKeys.map((key) => [key, 1])), planCounts);
	if (planKeys.length !== expectedKeys.length) {
		console.error('The plan does not cover the full test list exactly once.');
		process.exit(1);
	}
	if (actualPaths.length !== shardCount) {
		console.error(
			`Shard count: expected ${shardCount} shard lists, received ${actualPaths.length}.`
		);
		process.exit(1);
	}
	for (let index = 0; index < actualPaths.length; index += 1) {
		const actualPath = actualPaths[index];
		const shardReport = readReport(actualPath);
		const report = collect(shardReport);
		if (!isListReport(report.entries)) {
			console.error(`Plan mode requires a list report for each shard: ${actualPath}`);
			process.exit(1);
		}
		if (
			JSON.stringify(
				effectiveInputs(fullReport, { includeShard: false, includePartition: false })
			) !==
			JSON.stringify(effectiveInputs(shardReport, { includeShard: false, includePartition: false }))
		) {
			console.error(`Expected and actual reports used different effective inputs: ${actualPath}.`);
			process.exit(1);
		}
		const partition = shardReport.config?.metadata?.partition;
		const expectedShard = plan.shards[index];
		if (
			partition?.shard !== expectedShard.shard ||
			partition?.count !== shardCount ||
			partition?.partitionSha256 !== plan.partitionSha256
		) {
			console.error(`Shard list ${actualPath} does not match the plan partition identity.`);
			process.exit(1);
		}
		const actualCounts = countsFrom(report.entries);
		const planned = new Map((expectedShard.tests ?? []).map((key) => [key, 1]));
		reportDifferences(planned, actualCounts);
	}
	console.log(
		`Plan partition covers every expected test exactly once (${expectedKeys.length} tests) across ${shardCount} shard lists. No execution is claimed.`
	);
	process.exit(0);
}

if (mode === 'execution') {
	const [expectedPath, actualPath] = args;
	if (!expectedPath || !actualPath || args.length !== 2) {
		console.error(USAGE);
		process.exit(2);
	}
	const expectedRaw = readReport(expectedPath);
	const expectedReport = collect(expectedRaw);
	if (!isListReport(expectedReport.entries)) {
		console.error('Execution requires a --list expected report.');
		process.exit(1);
	}
	const actualRaw = readReport(actualPath);
	const actualReport = collect(actualRaw);
	if (expectedReport.entries.length === 0) {
		console.error('Expected test list is empty.');
		process.exit(1);
	}
	requireSameInputs(expectedRaw, actualRaw, actualPath);
	const expected = countsFrom(expectedReport.entries);
	const actual = countsFrom(actualReport.entries);
	reportDifferences(expected, actual);

	const notExecuted = [];
	const unexpectedSkips = [];
	const interrupted = [];
	let executed = 0;
	let justifiedSkips = 0;
	for (const { key, test } of actualReport.entries) {
		const results = test.results ?? [];
		if (results.length === 0) {
			notExecuted.push(key);
			continue;
		}
		if (results.some((result) => result.status === 'interrupted')) {
			interrupted.push(key);
			continue;
		}
		if (results.every((result) => result.status === 'skipped')) {
			const hasReason = (test.annotations ?? []).some(
				(annotation) =>
					annotation.type === 'skip' &&
					typeof annotation.description === 'string' &&
					annotation.description.trim().length > 0
			);
			if (test.expectedStatus === 'skipped' && hasReason) justifiedSkips += 1;
			else unexpectedSkips.push(key);
			continue;
		}
		executed += 1;
	}

	if (notExecuted.length) {
		console.error(`Not executed (${notExecuted.length}):\n${notExecuted.join('\n')}`);
	}
	if (unexpectedSkips.length) {
		console.error(`Unexpected skip (${unexpectedSkips.length}):\n${unexpectedSkips.join('\n')}`);
	}
	if (interrupted.length) {
		console.error(`Interrupted (${interrupted.length}):\n${interrupted.join('\n')}`);
	}
	if (executed === 0) {
		console.error('No test executed in this report; a --list report is not execution proof.');
	}
	if (notExecuted.length || unexpectedSkips.length || interrupted.length || executed === 0) {
		process.exit(1);
	}
	console.log(
		`Execution report covers every expected test exactly once (${expected.size} tests). Executed: ${executed}. Justified skips: ${justifiedSkips}. Retried results: ${actualReport.retried}.`
	);
	process.exit(0);
}

console.error(USAGE);
process.exit(2);

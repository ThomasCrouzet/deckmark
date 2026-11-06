#!/usr/bin/env node
// Compare executed tests with the tests that the current configuration defines.
// A missing, duplicated or extra test fails the check. Pass one actual report
// or several local shard reports; their counts are combined without a network
// upload.
// Usage: node scripts/check-e2e-manifest.mjs expected.json actual.json [actual.json ...]
import { readFileSync } from 'node:fs';

function collect(report) {
	const counts = new Map();
	let retried = 0;
	function walk(suites) {
		for (const suite of suites ?? []) {
			if (suite.specs) {
				for (const spec of suite.specs) {
					for (const test of spec.tests ?? []) {
						for (const result of test.results ?? []) {
							if ((result.retry ?? 0) > 0) retried += 1;
						}
						// The spec id separates parameterized tests that share a title
						// and line. Fall back to the title path for older reports.
						const specId =
							spec.id ??
							[suite.file ?? spec.file ?? '', spec.line ?? 0, spec.title ?? ''].join('::');
						const key = `${specId}::${test.projectName ?? ''}`;
						counts.set(key, (counts.get(key) ?? 0) + 1);
					}
				}
			}
			walk(suite.suites);
		}
	}
	walk(report.suites);
	return { counts, retried };
}

const [expectedPath, ...actualPaths] = process.argv.slice(2);
if (!expectedPath || actualPaths.length === 0) {
	console.error(
		'Usage: node scripts/check-e2e-manifest.mjs expected.json actual.json [actual.json ...]'
	);
	process.exit(2);
}

const expected = collect(JSON.parse(readFileSync(expectedPath, 'utf8'))).counts;
const actual = new Map();
let retried = 0;
for (const actualPath of actualPaths) {
	const report = collect(JSON.parse(readFileSync(actualPath, 'utf8')));
	for (const [key, count] of report.counts) {
		actual.set(key, (actual.get(key) ?? 0) + count);
	}
	retried += report.retried;
}
const missing = [...expected.keys()].filter((key) => !actual.has(key));
const extra = [...actual.keys()].filter((key) => !expected.has(key));
const duplicates = [...actual.entries()].filter(([, count]) => count > 1);
const incomplete = [...actual.entries()].filter(([, count]) => count !== 1);

if (missing.length || extra.length || duplicates.length || incomplete.length) {
	if (missing.length) console.error(`Missing tests (${missing.length}):\n${missing.join('\n')}`);
	if (extra.length) console.error(`Unexpected tests (${extra.length}):\n${extra.join('\n')}`);
	if (duplicates.length) {
		console.error(
			`Duplicate tests (${duplicates.length}):\n${duplicates.map(([key, count]) => `${count} x ${key}`).join('\n')}`
		);
	}
	if (incomplete.length) {
		console.error(
			`Incomplete test entries (${incomplete.length}):\n${incomplete.map(([key, count]) => `${count} x ${key}`).join('\n')}`
		);
	}
	process.exit(1);
}
console.log(
	`Report covers every expected test exactly once (${expected.size} tests). Retried results: ${retried}.`
);

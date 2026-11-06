#!/usr/bin/env node
// Compare the tests that the shards executed with the tests that the current
// configuration defines. A missing, duplicated or extra test fails the merge.
// Usage: node scripts/check-e2e-manifest.mjs expected.json merged.json
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
						const key = [
							suite.file ?? spec.file ?? '',
							spec.line ?? 0,
							test.projectName ?? '',
							spec.title ?? ''
						].join('::');
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

const [expectedPath, mergedPath] = process.argv.slice(2);
if (!expectedPath || !mergedPath) {
	console.error('Usage: node scripts/check-e2e-manifest.mjs expected.json merged.json');
	process.exit(2);
}

const expected = collect(JSON.parse(readFileSync(expectedPath, 'utf8'))).counts;
const merged = collect(JSON.parse(readFileSync(mergedPath, 'utf8')));
const actual = merged.counts;
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
	`Merged report covers every expected test exactly once (${expected.size} tests). Retried results: ${merged.retried}.`
);

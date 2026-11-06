// Fail-closed fixtures for the merged E2E report gate. A missing or duplicated
// test must block the aggregate job, not pass as green coverage.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';

const script = resolve(import.meta.dirname, 'check-e2e-manifest.mjs');
const roots = [];

function report(...specs) {
	return {
		suites: [
			{
				file: 'example.spec.ts',
				line: 1,
				specs: specs.map(([title, line, projects]) => ({
					id: `${title}:${line}`,
					title,
					line,
					tests: projects.map((projectName) => ({ projectName }))
				}))
			}
		]
	};
}

function run(expected, merged) {
	const root = mkdtempSync(join(tmpdir(), 'deckmark-manifest-'));
	roots.push(root);
	writeFileSync(join(root, 'expected.json'), JSON.stringify(expected));
	writeFileSync(join(root, 'merged.json'), JSON.stringify(merged));
	try {
		return {
			status: 0,
			output: execFileSync(
				process.execPath,
				[script, join(root, 'expected.json'), join(root, 'merged.json')],
				{ encoding: 'utf8' }
			)
		};
	} catch (error) {
		return { status: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
	}
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('accepts a complete merged report', () => {
	const expected = report(['first', 3, ['chromium']], ['second', 9, ['firefox']]);
	const result = run(expected, expected);
	assert.equal(result.status, 0, result.output);
	assert.match(result.output, /2 tests/);
});

test('rejects a missing test', () => {
	const expected = report(['first', 3, ['chromium']], ['second', 9, ['firefox']]);
	const merged = report(['first', 3, ['chromium']]);
	const result = run(expected, merged);
	assert.notEqual(result.status, 0);
	assert.match(result.output, /Missing tests/);
});

test('rejects a duplicated test', () => {
	const expected = report(['first', 3, ['chromium']]);
	const merged = report(['first', 3, ['chromium']], ['first', 3, ['chromium']]);
	const result = run(expected, merged);
	assert.notEqual(result.status, 0);
	assert.match(result.output, /Duplicate tests/);
});

test('rejects an unexpected extra test', () => {
	const expected = report(['first', 3, ['chromium']]);
	const merged = report(['first', 3, ['chromium']], ['extra', 20, ['chromium']]);
	const result = run(expected, merged);
	assert.notEqual(result.status, 0);
	assert.match(result.output, /Unexpected tests/);
});

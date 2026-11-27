// Fixtures for the shard weight refresh. The parser must read the real list
// reporter lines of a CI log, with timestamps, colors and retries, and the
// weights must be medians per run so one slow runner cannot set a weight.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { FALLBACK_SECONDS, buildWeights, parseShardLog } from './e2e-shard-weights.mjs';

const script = resolve(import.meta.dirname, 'e2e-shard-weights.mjs');

function line(project, file, title, duration, retry = '') {
	return `2026-11-26T10:00:00.0000000Z   \u001b[32m✓\u001b[39m  1 [${project}] › e2e/${file}:10:3 › ${title}${retry} (${duration})`;
}

test('the parser reads timestamps, colors, units and retries', () => {
	const tests = parseShardLog(
		[
			'2026-11-26T10:00:00.0000000Z ##[group]Run npx playwright test',
			line('chromium', 'a.spec.ts', 'first', '1.5s'),
			line('chromium', 'a.spec.ts', 'first', '500ms', ' (retry #1)'),
			line('webkit', 'b.spec.ts', 'suite › second', '2.0m'),
			'2026-11-26T10:00:00.0000000Z   -  3 [chromium] › e2e/a.spec.ts:20:3 › skipped test',
			'2026-11-26T10:00:00.0000000Z   1 passed (3.0m)'
		].join('\n')
	);
	assert.deepEqual(tests, [
		{ project: 'chromium', file: 'a.spec.ts', test: '10 first', seconds: 1.5 },
		{ project: 'chromium', file: 'a.spec.ts', test: '10 first', seconds: 0.5 },
		{ project: 'webkit', file: 'b.spec.ts', test: '10 suite › second', seconds: 120 }
	]);
});

test('a group weight is the median of the per-run sums', () => {
	const run = (id, seconds) => ({
		id,
		tests: [
			{ project: 'chromium', file: 'a.spec.ts', test: '10 one', seconds },
			{ project: 'chromium', file: 'a.spec.ts', test: '20 two', seconds: 1 }
		]
	});
	const weights = buildWeights([run('1', 2), run('2', 4), run('3', 90)], 'fixture');
	assert.equal(weights.version, 1);
	assert.equal(weights.fallbackSeconds, FALLBACK_SECONDS);
	assert.deepEqual(weights.groups, [
		{ project: 'chromium', file: 'a.spec.ts', seconds: 5, tests: 2 }
	]);
	assert.throws(() => buildWeights([], 'fixture'), /No run/);
});

test('the offline refresh writes a weights file the planner accepts', () => {
	const root = mkdtempSync(join(tmpdir(), 'e2e-weights-'));
	try {
		for (const [run, duration] of [
			['100', '3.0s'],
			['101', '5.0s']
		]) {
			mkdirSync(join(root, 'logs', run), { recursive: true });
			writeFileSync(
				join(root, 'logs', run, 'shard-1.log'),
				`${line('chromium', 'a.spec.ts', 'one', duration)}\n${line('firefox', 'b.spec.ts', 'two', '1s')}\n`
			);
		}
		const out = join(root, 'weights.json');
		const result = spawnSync(
			process.execPath,
			[script, 'refresh', '--logs', join(root, 'logs'), '--out', out],
			{
				encoding: 'utf8'
			}
		);
		assert.equal(result.status, 0, result.stderr);
		const weights = JSON.parse(readFileSync(out, 'utf8'));
		assert.deepEqual(weights.groups, [
			{ project: 'chromium', file: 'a.spec.ts', seconds: 4, tests: 1 },
			{ project: 'firefox', file: 'b.spec.ts', seconds: 1, tests: 1 }
		]);
		assert.match(weights.source, /2 saved runs \(100, 101\)/);

		const usage = spawnSync(process.execPath, [script, 'refresh'], { encoding: 'utf8' });
		assert.notEqual(usage.status, 0);
		assert.match(usage.stderr, /Usage/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('the committed weights cover measured groups with a conservative fallback', () => {
	const weights = JSON.parse(
		readFileSync(new URL('./e2e-shard-weights.json', import.meta.url), 'utf8')
	);
	assert.equal(weights.version, 1);
	assert.ok(weights.fallbackSeconds >= 2.8, 'the fallback is not below the median test');
	assert.ok(weights.groups.length >= 300);
	assert.doesNotMatch(weights.source, /\/srv\/|\/home\//, 'no local path in the source text');
});

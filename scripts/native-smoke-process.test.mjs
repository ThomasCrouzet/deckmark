// Regression tests for the bounded native smoke process teardown.
//
// The smoke run and the benchmark share one runner and one fixed WebDriver
// port. Every fixture here is a real Node child process: the smoke teardown
// must wait for a real exit event, escalate a signal-ignoring child, keep
// unrelated processes alive, and fail loudly on a bounded timeout.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';

const { stopChild } = await import(new URL('./native-smoke-process.mjs', import.meta.url).href);

const posix = process.platform !== 'win32';

/** @param {string} source */
function spawnFixture(source) {
	return spawn(process.execPath, ['-e', `${source}\nprocess.stdout.write('ready\\n');`], {
		stdio: ['ignore', 'pipe', 'ignore']
	});
}

/** @param {import('node:child_process').ChildProcess} child */
async function ready(child) {
	await new Promise((resolve, reject) => {
		let seen = '';
		child.once('error', reject);
		child.stdout?.on('data', (chunk) => {
			seen += String(chunk);
			if (seen.includes('ready')) resolve(undefined);
		});
	});
}

/** @param {import('node:child_process').ChildProcess} child */
async function forceCleanup(child) {
	if (child.exitCode !== null || child.signalCode !== null) return;
	try {
		child.kill('SIGKILL');
	} catch {
		// The fixture may already be gone.
	}
	await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 2_000))]);
}

test('a slow graceful exit is awaited through the real close signal', async () => {
	const child = spawnFixture(
		"process.on('SIGTERM', () => setTimeout(() => process.exit(0), 300)); setInterval(() => {}, 1000);"
	);
	try {
		await ready(child);
		const startedAt = performance.now();
		const result = await stopChild(child, { label: 'slow-exit', graceMs: 5_000, killMs: 2_000 });
		const elapsed = performance.now() - startedAt;
		assert.equal(result.pid, child.pid);
		assert.equal(result.label, 'slow-exit');
		assert.equal(result.escalated, false);
		assert.equal(child.exitCode !== null || child.signalCode !== null, true);
		if (posix) {
			assert.equal(result.signal, null);
			assert.equal(result.exitCode, 0);
			assert.ok(elapsed >= 250, `teardown returned before the child exited: ${elapsed} ms`);
			assert.throws(() => process.kill(/** @type {number} */ (child.pid), 0), /ESRCH/);
		}
	} finally {
		await forceCleanup(child);
	}
});

test('a SIGTERM-ignoring child is escalated and does not survive teardown', async () => {
	const child = spawnFixture("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);");
	try {
		await ready(child);
		const result = await stopChild(child, { label: 'ignore-term', graceMs: 300, killMs: 3_000 });
		assert.equal(result.pid, child.pid);
		assert.equal(result.escalated, posix);
		assert.equal(child.exitCode !== null || child.signalCode !== null, true);
		if (posix) {
			assert.equal(result.signal, 'SIGKILL');
			assert.throws(() => process.kill(/** @type {number} */ (child.pid), 0), /ESRCH/);
		}
	} finally {
		await forceCleanup(child);
	}
});

test(
	'an unkillable child fails with bounded timeout diagnostics',
	{ skip: !posix && 'Windows kill() cannot be ignored' },
	async () => {
		const child = spawnFixture("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);");
		try {
			await ready(child);
			await assert.rejects(
				() =>
					stopChild(child, {
						label: 'stuck-app',
						graceMs: 150,
						killMs: 150,
						termSignal: 'SIGTERM',
						killSignal: 'SIGTERM'
					}),
				(error) => {
					assert.match(String(error), /stuck-app/);
					assert.match(String(error), new RegExp(`pid ${child.pid}`));
					assert.match(String(error), /did not exit after 300 ms/);
					return true;
				}
			);
			assert.equal(child.exitCode, null);
			assert.equal(child.signalCode, null);
		} finally {
			await forceCleanup(child);
		}
	}
);

test('teardown terminates only the owned child', async () => {
	const bystander = spawnFixture('setInterval(() => {}, 1000);');
	const target = spawnFixture('setInterval(() => {}, 1000);');
	try {
		await Promise.all([ready(bystander), ready(target)]);
		await stopChild(target, { label: 'owned', graceMs: 300, killMs: 2_000 });
		assert.equal(target.exitCode !== null || target.signalCode !== null, true);
		assert.equal(bystander.exitCode, null);
		assert.equal(bystander.signalCode, null);
		if (posix) assert.doesNotThrow(() => process.kill(/** @type {number} */ (bystander.pid), 0));
	} finally {
		await forceCleanup(target);
		await forceCleanup(bystander);
	}
});

test('an already exited child returns without a signal', async () => {
	const child = spawnFixture('process.exit(0);');
	await once(child, 'exit');
	const result = await stopChild(child, { label: 'already-exited', graceMs: 1_000, killMs: 1_000 });
	assert.equal(result.pid, child.pid);
	assert.equal(result.escalated, false);
	assert.equal(result.exitCode, 0);
});

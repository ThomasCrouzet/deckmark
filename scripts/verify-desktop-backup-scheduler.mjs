import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync('src/lib/desktop-backup.ts', 'utf8');
const code = ts.transpileModule(source, {
	compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;
const hour = 3_600_000;
const initialTime = 100 * hour;
const fixture = {
	enabled: true,
	root: '/native/picker/folder',
	rootId: 'native-grant-id',
	intervalHours: 24,
	retention: 10,
	lastSuccessAt: initialTime - 23 * hour
};

function boot(preferences = fixture, write = async () => ({ fileName: 'snapshot.json' })) {
	let stored = JSON.stringify(preferences);
	let now = initialTime;
	let nextTimer = 0;
	const timers = new Map();
	const calls = [];
	const modules = {
		'$app/env': { browser: true },
		'./edition': { IS_DESKTOP_EDITION: true },
		'./preferences': {
			readPreference: () => stored,
			writePreference: (_key, value) => {
				stored = value;
			}
		},
		'./services/backup': {
			collectBackup: async () => ({ marker: 'backup' }),
			serializeBackup: JSON.stringify,
			parseBackupWithReport: JSON.parse
		},
		'./files.svelte': { filesStore: { flushPendingAwait: async () => {} } },
		'@tauri-apps/api/core': {
			invoke: async (command, args) => {
				calls.push({ command, args });
				if (command === 'desktop_backup_pick_root') {
					return { rootId: 'picked-id', path: '/picked/folder' };
				}
				assert.equal(command, 'desktop_backup_write');
				return write();
			}
		}
	};
	const exports = {};
	const setTimer = (callback, delay) => {
		const id = ++nextTimer;
		timers.set(id, { callback, at: now + delay });
		return id;
	};
	vm.runInNewContext(code, {
		exports,
		require: (name) => {
			assert.ok(name in modules, `unexpected dependency ${name}`);
			return modules[name];
		},
		Date: class extends Date {
			static now() {
				return now;
			}
		},
		setTimeout: setTimer,
		clearTimeout: (id) => timers.delete(id),
		setInterval: setTimer,
		clearInterval: (id) => timers.delete(id)
	});
	return {
		api: exports,
		calls,
		preferences: () => JSON.parse(stored),
		delay: () => Math.min(...[...timers.values()].map(({ at }) => at - now)),
		advance: async (milliseconds) => {
			now += milliseconds;
			for (const [id, timer] of [...timers]) {
				if (timer.at > now) continue;
				timers.delete(id);
				timer.callback();
			}
			for (let index = 0; index < 40; index++) await Promise.resolve();
		}
	};
}

const results = [];
const check = async (name, run) => {
	await run();
	results.push({ name, passed: true });
};

await check('a schedule with no previous snapshot starts its first backup', async () => {
	const app = boot({ ...fixture, lastSuccessAt: null });
	app.api.startDesktopBackupScheduler();
	assert.equal(app.delay(), 0);
	await app.advance(0);
	assert.equal(app.calls.length, 1);
	assert.equal(app.delay(), 24 * hour);
});

await check('restart uses the remaining interval and overdue startup runs once', async () => {
	const recent = boot();
	recent.api.startDesktopBackupScheduler();
	assert.equal(recent.delay(), hour);
	const overdue = boot({ ...fixture, lastSuccessAt: initialTime - 25 * hour });
	overdue.api.startDesktopBackupScheduler();
	assert.equal(overdue.delay(), 0);
	await overdue.advance(0);
	assert.equal(overdue.calls.length, 1);
	assert.equal(overdue.calls[0].args.rootId, fixture.rootId);
	assert.equal('root' in overdue.calls[0].args, false);
	assert.equal(overdue.delay(), 24 * hour);
});

await check('folder choice stays opt-in and legacy paths do not grant access', async () => {
	const disabled = boot({ ...fixture, enabled: false });
	await disabled.api.chooseBackupFolder('Choose folder');
	assert.equal(disabled.preferences().rootId, 'picked-id');
	assert.equal(disabled.preferences().enabled, false);
	assert.equal(disabled.delay(), Infinity);
	const legacy = boot({ ...fixture, rootId: undefined });
	legacy.api.startDesktopBackupScheduler();
	assert.equal(legacy.delay(), Infinity);
	assert.equal(legacy.api.getDesktopBackupState().root, null);
});

await check(
	'manual success resets the deadline and does not restore disabled settings',
	async () => {
		let finish;
		const app = boot(
			fixture,
			() =>
				new Promise((resolve) => {
					finish = resolve;
				})
		);
		app.api.startDesktopBackupScheduler();
		const pending = app.api.writeBackupNow();
		await app.advance(0);
		app.api.disableDesktopBackup();
		finish({ fileName: 'snapshot.json' });
		await pending;
		assert.equal(app.preferences().enabled, false);
		assert.equal(app.delay(), Infinity);
		const manual = boot();
		manual.api.startDesktopBackupScheduler();
		await manual.api.writeBackupNow();
		assert.equal(manual.delay(), 24 * hour);
	}
);

await check('failed scheduled writes wait one interval and report the error', async () => {
	const app = boot({ ...fixture, lastSuccessAt: initialTime - 25 * hour }, async () => {
		throw new Error('disk full');
	});
	app.api.startDesktopBackupScheduler();
	await app.advance(0);
	assert.equal(app.calls.length, 1);
	assert.equal(app.delay(), 24 * hour);
	assert.match(app.api.getDesktopBackupState().lastError, /disk full/);
});

const report = {
	command: 'node scripts/verify-desktop-backup-scheduler.mjs',
	revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
	diff: execFileSync('git', ['diff', '--', 'src/lib/desktop-backup.ts'], { encoding: 'utf8' }),
	environment: { node: process.version, platform: process.platform, architecture: process.arch },
	fixtures: {
		now: initialTime,
		preferences: fixture,
		nativeBridge: 'controlled picker and write results'
	},
	results
};
const output = process.argv[2] ?? 'test-results/backup-scheduler.json';
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Passed ${results.length} backup scheduler checks. Report: ${output}`);

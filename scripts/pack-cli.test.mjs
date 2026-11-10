#!/usr/bin/env node
// Installed-user proof for the CLI and MCP package.
// The test builds a real package, copies it outside the repository, runs it with
// no Node on PATH, and checks the documented command, release layout, protocol,
// root, output-guard, and cleanup behavior. It writes a JSON evidence file under
// test-results/.
//
// Run: node --test scripts/pack-cli.test.mjs

import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import {
	promotePackage,
	reconcileInterruptedPromotion,
	renameWithRetry,
	resolveArchiveTool,
	windowsLauncherInvocation
} from './pack-cli.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const HOST_OS = process.platform === 'win32' ? 'windows' : process.platform;
const RELEASE_NAME = `deckmark-cli-${VERSION}-${HOST_OS}-${process.arch}`;
const PACKAGE = join(ROOT, 'test-results', RELEASE_NAME);
const ARCHIVE = `${PACKAGE}${process.platform === 'win32' ? '.zip' : '.tar.gz'}`;
const PACK_SCRIPT = join(ROOT, 'scripts', 'pack-cli.mjs');
const TAR = resolveArchiveTool();
const CANARY = 'deckmark-test-secret-4f8a1c';
const COMMANDS = [];
const OBSERVED = {};
const NEGATIVE = { outputGuard: [], verify: [], mcpUsage: [] };
let installRoot;
let projectRoot;
let packageRoot;
let fixtureRoot;
let homeRoot;
let emptyPath;
let manifest;
let archiveSha256;
let escapePathCreated = false;

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		encoding: 'utf8',
		timeout: 60_000,
		...options
	});
	COMMANDS.push({
		command: [command, ...args].join(' '),
		status: result.status,
		signal: result.signal ?? null
	});
	return result;
}

function installedEnv(extra = {}) {
	return {
		PATH: emptyPath,
		HOME: homeRoot,
		TMPDIR: join(installRoot, 'tmp'),
		DECKMARK_TEST_SECRET: CANARY,
		...(process.platform === 'win32'
			? {
					SystemRoot: process.env.SystemRoot,
					ComSpec: process.env.ComSpec,
					PATHEXT: '.CMD;.EXE;.BAT'
				}
			: {}),
		...extra
	};
}

function launcherInvocation(name, args, root = packageRoot) {
	if (process.platform !== 'win32') {
		return { command: join(root, 'bin', name), args, options: {} };
	}
	return windowsLauncherInvocation(join(root, 'bin', `${name}.cmd`), args);
}

function cli(args, options = {}) {
	const invocation = launcherInvocation('deckmark', args);
	return run(invocation.command, invocation.args, {
		...invocation.options,
		cwd: fixtureRoot,
		env: installedEnv(),
		...options
	});
}

function mcpDirect(args, input) {
	const node = join(packageRoot, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
	return run(node, [join(packageRoot, 'lib', 'deckmark-mcp.mjs'), ...args], {
		cwd: fixtureRoot,
		env: installedEnv(),
		input
	});
}

// The POSIX launcher is a documented install path, so the protocol test starts
// it. Windows clients use the direct runtime form; that form is kept here.
function mcp(args, input) {
	if (process.platform === 'win32') return mcpDirect(args, input);
	const invocation = launcherInvocation('deckmark-mcp', args);
	return run(invocation.command, invocation.args, {
		...invocation.options,
		cwd: fixtureRoot,
		env: installedEnv(),
		input
	});
}

function treeHash(root) {
	const hash = createHash('sha256');
	function walk(directory) {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
			a.name.localeCompare(b.name)
		)) {
			if (entry.name === 'node_modules' || entry.name === '.git') continue;
			const full = join(directory, entry.name);
			const name = relative(root, full).split(sep).join('/');
			if (entry.isSymbolicLink()) {
				hash.update(`link:${name}:${readFileSync(full, 'utf8')}\0`);
			} else if (entry.isDirectory()) {
				walk(full);
			} else if (entry.isFile()) {
				hash.update(`file:${name}\0`);
				hash.update(readFileSync(full));
				hash.update('\0');
			}
		}
	}
	walk(root);
	return hash.digest('hex');
}

function mcpMessages(...messages) {
	return `${messages.map((message) => JSON.stringify(message)).join('\n')}\n`;
}

// Windows holds the image of a running executable. The package process scan
// names a live process as a process leak. It must not report a delete race.
// On Windows each scan is a blocking PowerShell call with its own 15 s cap, so
// the deadline is checked between scans. The wait can overshoot the deadline
// by one scan. The 400 ms refusal below proves detection, not promptness.
const PACKAGE_PROCESS_POLL_MS = 100;

function normalizePackageRoot(root) {
	const absolute = resolve(root);
	try {
		return realpathSync(absolute);
	} catch {
		// Cleanup can run after the package is gone. Do not add an error then.
		return absolute;
	}
}

function parseWindowsProcessIds(stdout) {
	return stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			if (!/^[1-9][0-9]*$/.test(line)) {
				throw new Error(`Cannot parse package process ID: ${JSON.stringify(line)}`);
			}
			return Number(line);
		});
}

function packageProcessIds(root) {
	const normalizedRoot = normalizePackageRoot(root);
	const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
	if (process.platform === 'linux') {
		const ids = [];
		for (const entry of readdirSync('/proc')) {
			if (!/^[0-9]+$/.test(entry)) continue;
			let executable;
			try {
				executable = readlinkSync(`/proc/${entry}/exe`);
			} catch {
				continue;
			}
			if (executable === normalizedRoot || executable.startsWith(prefix)) {
				ids.push(Number(entry));
			}
		}
		return ids;
	}
	if (process.platform === 'win32') {
		const script = [
			"$ErrorActionPreference = 'SilentlyContinue'",
			'$root = $env:DECKMARK_PACKAGE_ROOT',
			'Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { $_.Id }'
		].join('\n');
		const result = spawnSync(
			'powershell.exe',
			['-NoProfile', '-NonInteractive', '-Command', script],
			{
				encoding: 'utf8',
				timeout: 15_000,
				env: { ...process.env, DECKMARK_PACKAGE_ROOT: prefix }
			}
		);
		if (result.status !== 0) {
			throw new Error(
				`Cannot inspect package processes: ${result.stderr || result.error?.message || result.status}`
			);
		}
		return parseWindowsProcessIds(result.stdout);
	}
	// macOS unlinks a running image. There is no lock to wait for.
	return [];
}

async function waitForPackageProcess(root, pid, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (!packageProcessIds(root).includes(pid)) {
		if (Date.now() >= deadline) {
			throw new Error(`Package process ${pid} did not appear in the process table`);
		}
		await new Promise((resolveWait) => setTimeout(resolveWait, PACKAGE_PROCESS_POLL_MS));
	}
}

async function waitForPackageProcessesToExit(root, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const ids = packageProcessIds(root);
		if (ids.length === 0) return;
		if (Date.now() >= deadline) {
			throw new Error(`Package process still running: ${ids.join(', ')}`);
		}
		await new Promise((resolveWait) => setTimeout(resolveWait, PACKAGE_PROCESS_POLL_MS));
	}
}

// Own a child and its close promise together. Attach the listener before any
// await so an early exit cannot leave cleanup waiting on an event that already
// fired. stopTracked kills the child and awaits that same promise.
function spawnTracked(command, args, options) {
	const child = spawn(command, args, options);
	const closed = new Promise((resolveClose) => {
		child.once('close', resolveClose);
		child.once('error', resolveClose);
	});
	return { child, closed };
}

async function stopTracked({ child, closed }) {
	child.kill('SIGKILL');
	await closed;
}

// A just-terminated image can stay locked for a moment while Windows releases
// it. Retry only after the process wait above proves that no process runs from
// the package. A lock that outlasts the retries still fails the call.
function removePackageTree(directory) {
	rmSync(directory, {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 100
	});
}

function verifyPackage() {
	return run(process.execPath, [PACK_SCRIPT, 'verify', '--dir', PACKAGE], {
		cwd: ROOT,
		env: process.env
	});
}

before(() => {
	mkdirSync(join(ROOT, 'test-results'), { recursive: true });
	const build = run(
		process.execPath,
		[
			PACK_SCRIPT,
			'--out',
			join(ROOT, 'test-results', '272-cli-pack'),
			'--allow-dirty',
			'--archive'
		],
		{ cwd: ROOT, env: process.env, timeout: 300_000 }
	);
	assert.equal(build.status, 0, `pack failed:\n${build.stdout}\n${build.stderr}`);
	assert.equal(basename(PACKAGE), RELEASE_NAME);
	manifest = JSON.parse(readFileSync(join(PACKAGE, 'deckmark-build.json'), 'utf8'));

	installRoot = mkdtempSync(join(tmpdir(), 'deckmark install & smoke-'));
	archiveSha256 = createHash('sha256').update(readFileSync(ARCHIVE)).digest('hex');
	const extract = run(TAR, ['-xf', ARCHIVE, '-C', installRoot], { cwd: ROOT, env: process.env });
	assert.equal(extract.status, 0, `extract failed:\n${extract.stderr}`);
	packageRoot = join(installRoot, RELEASE_NAME);
	homeRoot = join(installRoot, 'home');
	emptyPath = join(installRoot, 'empty-path');
	mkdirSync(homeRoot, { recursive: true });
	mkdirSync(emptyPath, { recursive: true });
	mkdirSync(join(installRoot, 'tmp'), { recursive: true });

	projectRoot = mkdtempSync(join(tmpdir(), 'deckmark project & smoke-'));
	fixtureRoot = join(projectRoot, 'project');
	mkdirSync(join(fixtureRoot, 'notes'), { recursive: true });
	writeFileSync(
		join(fixtureRoot, 'notes', 'good.md'),
		'---\ntitle: Installed Note\n---\n\n# Installed Note\n\nHello DeckMark.\n'
	);
	writeFileSync(join(fixtureRoot, 'broken.md'), '# Broken\n\nA [missing target](missing.md).\n');
	mkdirSync(join(projectRoot, 'outside'), { recursive: true });
	writeFileSync(join(projectRoot, 'outside', 'secret.md'), 'OUTSIDE SECRET\n');
	try {
		symlinkSync(join(projectRoot, 'outside', 'secret.md'), join(fixtureRoot, 'notes', 'escape.md'));
		escapePathCreated = true;
	} catch {
		// Windows without symlink privilege cannot create the link. The traversal
		// and absolute-path refusal below still runs and still checks the result.
	}
});

after(async () => {
	if (installRoot) {
		await waitForPackageProcessesToExit(installRoot, 5_000);
		removePackageTree(installRoot);
	}
	if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
});

test('Windows archive tool is resolved from SystemRoot, not from PATH', () => {
	const root = 'C:\\Windows';
	const expected = join(root, 'System32', 'tar.exe');
	const selected = resolveArchiveTool({
		platform: 'win32',
		env: {
			SystemRoot: root,
			PATH: 'C:\\Program Files\\Git\\mingw64\\bin;C:\\Program Files\\Git\\bin'
		},
		exists: (candidate) => candidate === expected
	});
	assert.equal(selected, expected);
	assert.notEqual(selected, 'tar.exe');

	assert.equal(
		resolveArchiveTool({ platform: 'win32', env: { SYSTEMROOT: root }, exists: () => true }),
		expected
	);
	assert.equal(resolveArchiveTool({ platform: 'linux', env: {}, exists: () => false }), 'tar');
	assert.equal(resolveArchiveTool({ platform: 'darwin', env: {}, exists: () => false }), 'tar');
	assert.throws(
		() => resolveArchiveTool({ platform: 'win32', env: {}, exists: () => true }),
		/SystemRoot is not set/
	);
	assert.throws(
		() => resolveArchiveTool({ platform: 'win32', env: { SystemRoot: root }, exists: () => false }),
		/Cannot find the Windows archive tool: .*System32.*tar\.exe/
	);
});

test('Windows package rename retries a transient directory lock', () => {
	let calls = 0;
	const delays = [];
	renameWithRetry('stage', 'release', {
		platform: 'win32',
		rename: () => {
			calls += 1;
			if (calls < 3) {
				const error = new Error('The directory is in use.');
				error.code = 'EPERM';
				throw error;
			}
		},
		pause: (ms) => delays.push(ms)
	});
	assert.equal(calls, 3);
	assert.deepEqual(delays, [100, 200]);

	assert.throws(
		() =>
			renameWithRetry('stage', 'release', {
				platform: 'win32',
				rename: () => {
					throw Object.assign(new Error('Missing directory.'), { code: 'ENOENT' });
				},
				pause: () => assert.fail('A permanent error must not pause.')
			}),
		/ENOENT|Missing directory/
	);
	let linuxCalls = 0;
	assert.throws(() =>
		renameWithRetry('stage', 'release', {
			platform: 'linux',
			rename: () => {
				linuxCalls += 1;
				throw Object.assign(new Error('Locked.'), { code: 'EPERM' });
			},
			pause: () => assert.fail('Linux must not retry.')
		})
	);
	assert.equal(linuxCalls, 1);
});

// Promotion fault risks. A real package build cannot produce these states
// deterministically: the file system fails between two renames, a power loss
// leaves one rename committed, or cleanup fails after the new package is in
// place. The browser suite cannot run this Node script at all. These isolated
// cases use real temporary directories and real payload files. They inject only
// the failing operation. The installed-package suite still builds, replaces and
// runs a real package below.
function ownedPackageFixture(directory, label) {
	mkdirSync(join(directory, 'bin'), { recursive: true });
	writeFileSync(join(directory, 'bin', `${label}.txt`), `${label}\n`);
	writeFileSync(
		join(directory, 'deckmark-build.json'),
		`${JSON.stringify({ schema: 'deckmark-cli-install/1' })}\n`
	);
	return directory;
}

function stageFixture(directory, label) {
	mkdirSync(join(directory, 'bin'), { recursive: true });
	writeFileSync(join(directory, 'bin', `${label}.txt`), `${label}\n`);
	return directory;
}

function codedError(message, code) {
	return Object.assign(new Error(message), { code });
}

function promotionLeftovers(parent, name) {
	return readdirSync(parent).filter((entry) => entry.startsWith(`.${name}.`));
}

test('promotion restores the previous package when the staged rename fails', () => {
	const root = mkdtempSync(join(tmpdir(), 'deckmark-promote-'));
	try {
		const out = ownedPackageFixture(join(root, 'cli'), 'old');
		const stage = stageFixture(join(root, 'stage'), 'new');
		const warnings = [];
		assert.throws(
			() =>
				promotePackage({
					stage,
					out,
					platform: 'linux',
					rename: (from, to) => {
						if (from === stage && to === out) {
							throw codedError('injected promotion failure', 'EACCES');
						}
						renameSync(from, to);
					},
					report: () => {},
					warn: (line) => warnings.push(line)
				}),
			/injected promotion failure[\s\S]*previous package at .* was restored/
		);
		assert.equal(readFileSync(join(out, 'bin', 'old.txt'), 'utf8'), 'old\n');
		assert.equal(existsSync(stage), true, 'the caller still owns the staged package');
		assert.deepEqual(promotionLeftovers(root, 'cli'), []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('promotion leaves no output when a new package rename fails', () => {
	const root = mkdtempSync(join(tmpdir(), 'deckmark-promote-new-'));
	try {
		const out = join(root, 'cli');
		const stage = stageFixture(join(root, 'stage'), 'new');
		assert.throws(
			() =>
				promotePackage({
					stage,
					out,
					platform: 'linux',
					rename: () => {
						throw codedError('injected new package failure', 'ENOSPC');
					},
					report: () => {},
					warn: () => {}
				}),
			/injected new package failure[\s\S]*was not replaced/
		);
		assert.equal(existsSync(out), false);
		assert.equal(existsSync(stage), true);
		assert.deepEqual(promotionLeftovers(root, 'cli'), []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('promotion retries a transient Windows rename and keeps the new package', () => {
	const root = mkdtempSync(join(tmpdir(), 'deckmark-promote-retry-'));
	try {
		const out = ownedPackageFixture(join(root, 'cli'), 'old');
		const stage = stageFixture(join(root, 'stage'), 'new');
		let attempts = 0;
		const delays = [];
		const result = promotePackage({
			stage,
			out,
			platform: 'win32',
			rename: (from, to) => {
				if (from === stage && to === out) {
					attempts += 1;
					if (attempts < 3) throw codedError('The directory is in use.', 'EPERM');
				}
				renameSync(from, to);
			},
			pause: (ms) => delays.push(ms),
			report: () => {},
			warn: () => {}
		});
		assert.equal(attempts, 3);
		assert.deepEqual(delays, [100, 200]);
		assert.equal(result.backupRetained, '');
		assert.equal(readFileSync(join(out, 'bin', 'new.txt'), 'utf8'), 'new\n');
		assert.deepEqual(promotionLeftovers(root, 'cli'), []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('promotion restores the previous package after the last Windows attempt fails', () => {
	const root = mkdtempSync(join(tmpdir(), 'deckmark-promote-last-'));
	try {
		const out = ownedPackageFixture(join(root, 'cli'), 'old');
		const stage = stageFixture(join(root, 'stage'), 'new');
		let attempts = 0;
		const delays = [];
		assert.throws(
			() =>
				promotePackage({
					stage,
					out,
					platform: 'win32',
					rename: (from, to) => {
						if (from === stage && to === out) {
							attempts += 1;
							throw codedError('The directory is in use.', 'EPERM');
						}
						renameSync(from, to);
					},
					pause: (ms) => delays.push(ms),
					report: () => {},
					warn: () => {}
				}),
			/previous package at .* was restored/
		);
		assert.equal(attempts, 20);
		assert.equal(delays.length, 19);
		assert.equal(readFileSync(join(out, 'bin', 'old.txt'), 'utf8'), 'old\n');
		assert.deepEqual(promotionLeftovers(root, 'cli'), []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('promotion keeps a named backup when cleanup after success fails', () => {
	const root = mkdtempSync(join(tmpdir(), 'deckmark-promote-cleanup-'));
	try {
		const out = ownedPackageFixture(join(root, 'cli'), 'old');
		const stage = stageFixture(join(root, 'stage'), 'new');
		const warnings = [];
		const result = promotePackage({
			stage,
			out,
			platform: 'linux',
			remove: (target, options) => {
				if (String(target).includes('.backup-')) {
					throw codedError('injected cleanup failure', 'EBUSY');
				}
				rmSync(target, options);
			},
			report: () => {},
			warn: (line) => warnings.push(line)
		});
		assert.match(result.backupRetained, /\.cli\.backup-[0-9a-f]+$/);
		assert.equal(existsSync(result.backupRetained), true);
		assert.equal(readFileSync(join(out, 'bin', 'new.txt'), 'utf8'), 'new\n');
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /remains: injected cleanup failure/);
		assert.equal(existsSync(join(root, '.cli.pack-transaction.json')), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('archive failure restores the previous package and keeps the previous archive', () => {
	const root = mkdtempSync(join(tmpdir(), 'deckmark-promote-archive-'));
	try {
		const out = ownedPackageFixture(join(root, 'cli'), 'old');
		const stage = stageFixture(join(root, 'stage'), 'new');
		const archive = join(root, 'cli.tar.gz');
		writeFileSync(archive, 'OLD ARCHIVE\n');
		assert.throws(
			() =>
				promotePackage({
					stage,
					out,
					archive,
					platform: 'linux',
					createArchive: (temporary) => {
						writeFileSync(temporary, 'PARTIAL ARCHIVE\n');
						throw codedError('injected archive failure', 'ENOSPC');
					},
					report: () => {},
					warn: () => {}
				}),
			/injected archive failure[\s\S]*previous package at .* was restored/
		);
		assert.equal(readFileSync(join(out, 'bin', 'old.txt'), 'utf8'), 'old\n');
		assert.equal(readFileSync(archive, 'utf8'), 'OLD ARCHIVE\n');
		assert.equal(
			readdirSync(root).filter((entry) => entry.includes('.archive-')).length,
			0,
			'a partial archive must not remain'
		);
		assert.deepEqual(promotionLeftovers(root, 'cli'), []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('archive promotion replaces the archive only after the complete temporary file', () => {
	const root = mkdtempSync(join(tmpdir(), 'deckmark-promote-archive-ok-'));
	try {
		const out = ownedPackageFixture(join(root, 'cli'), 'old');
		const stage = stageFixture(join(root, 'stage'), 'new');
		const archive = join(root, 'cli.tar.gz');
		writeFileSync(archive, 'OLD ARCHIVE\n');
		const seen = [];
		promotePackage({
			stage,
			out,
			archive,
			platform: 'linux',
			createArchive: (temporary) => {
				seen.push(temporary);
				writeFileSync(temporary, 'NEW ARCHIVE\n');
			},
			report: () => {},
			warn: () => {}
		});
		assert.equal(seen.length, 1);
		assert.equal(existsSync(seen[0]), false);
		assert.equal(readFileSync(archive, 'utf8'), 'NEW ARCHIVE\n');
		assert.equal(readFileSync(join(out, 'bin', 'new.txt'), 'utf8'), 'new\n');
		assert.deepEqual(promotionLeftovers(root, 'cli'), []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('an interrupted promotion marker restores the previous package before the next build', () => {
	const root = mkdtempSync(join(tmpdir(), 'deckmark-promote-recover-'));
	try {
		const out = join(root, 'cli');
		const backup = ownedPackageFixture(join(root, '.cli.backup-deadbeef'), 'old');
		const marker = join(root, '.cli.pack-transaction.json');
		writeFileSync(
			marker,
			`${JSON.stringify({
				schema: 'deckmark-cli-promotion/1',
				out,
				backup,
				archive: '',
				stage: join(root, 'stage')
			})}\n`
		);
		const lines = [];
		const result = reconcileInterruptedPromotion(out, {
			rename: renameSync,
			remove: rmSync,
			report: (line) => lines.push(line)
		});
		assert.equal(result.recovered, true);
		assert.equal(existsSync(marker), false);
		assert.equal(existsSync(backup), false);
		assert.equal(readFileSync(join(out, 'bin', 'old.txt'), 'utf8'), 'old\n');
		assert.equal(lines.length, 1);
		assert.match(lines[0], /restored the previous package/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('an interrupted promotion marker removes a stale backup when the new package is in place', () => {
	const root = mkdtempSync(join(tmpdir(), 'deckmark-promote-recover-new-'));
	try {
		const out = ownedPackageFixture(join(root, 'cli'), 'new');
		const backup = ownedPackageFixture(join(root, '.cli.backup-deadbeef'), 'old');
		const marker = join(root, '.cli.pack-transaction.json');
		writeFileSync(
			marker,
			`${JSON.stringify({
				schema: 'deckmark-cli-promotion/1',
				out,
				backup,
				archive: '',
				stage: join(root, 'stage')
			})}\n`
		);
		const result = reconcileInterruptedPromotion(out, {
			rename: renameSync,
			remove: rmSync,
			report: () => {}
		});
		assert.equal(result.recovered, true);
		assert.equal(existsSync(marker), false);
		assert.equal(existsSync(backup), false);
		assert.equal(readFileSync(join(out, 'bin', 'new.txt'), 'utf8'), 'new\n');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('an unreadable promotion marker fails closed and names the marker', () => {
	const root = mkdtempSync(join(tmpdir(), 'deckmark-promote-marker-'));
	try {
		const out = join(root, 'cli');
		const marker = join(root, '.cli.pack-transaction.json');
		writeFileSync(marker, '{not json\n');
		assert.throws(
			() =>
				reconcileInterruptedPromotion(out, {
					rename: renameSync,
					remove: rmSync,
					report: () => {}
				}),
			/Cannot read the interrupted promotion marker .*pack-transaction\.json/
		);
		assert.equal(existsSync(marker), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('a second pack replaces the previous package and leaves no staging or backup', () => {
	const parent = mkdtempSync(join(tmpdir(), 'deckmark-replace-'));
	try {
		const out = join(parent, 'pkg');
		for (const attempt of [1, 2]) {
			const pack = run(process.execPath, [PACK_SCRIPT, '--out', out, '--allow-dirty'], {
				cwd: ROOT,
				env: process.env,
				timeout: 300_000
			});
			assert.equal(pack.status, 0, `pack attempt ${attempt} failed:\n${pack.stderr}`);
			const verify = run(process.execPath, [PACK_SCRIPT, 'verify', '--dir', out], {
				cwd: ROOT,
				env: process.env
			});
			assert.equal(verify.status, 0, `verify attempt ${attempt} failed:\n${verify.stderr}`);
		}
		assert.deepEqual(promotionLeftovers(parent, 'pkg'), []);
		OBSERVED.replacement = { attempts: 2, leftovers: [] };
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}
});

test('Windows launcher builds one prequoted cmd.exe line for verbatim spawn', () => {
	const invocation = windowsLauncherInvocation(
		'C:\\Program Files\\DeckMark\\bin\\deckmark.cmd',
		['--version'],
		'cmd.exe'
	);
	assert.equal(invocation.command, 'cmd.exe');
	assert.deepEqual(invocation.args.slice(0, 3), ['/d', '/s', '/c']);
	assert.equal(invocation.args.length, 4);
	assert.equal(
		invocation.args[3],
		`""C:\\Program Files\\DeckMark\\bin\\deckmark.cmd" "--version""`
	);
	// cmd.exe /s strips the first and the last quote. The line must keep the
	// quoted launcher and the quoted arguments after that removal.
	assert.equal(
		invocation.args[3].slice(1, -1),
		'"C:\\Program Files\\DeckMark\\bin\\deckmark.cmd" "--version"'
	);
	assert.deepEqual(invocation.options, { windowsVerbatimArguments: true });
	assert.throws(() => windowsLauncherInvocation('x.cmd', ['100%']), /percent sign/);
	assert.throws(() => windowsLauncherInvocation('x.cmd', ['say "hi"']), /Windows \.cmd launcher/);
});

test('pack refuses a dangerous or unowned output before it deletes anything', () => {
	const scratch = mkdtempSync(join(tmpdir(), 'deckmark-outguard-'));
	try {
		const fakeRepo = join(scratch, 'repo');
		mkdirSync(join(fakeRepo, 'scripts'), { recursive: true });
		copyFileSync(PACK_SCRIPT, join(fakeRepo, 'scripts', 'pack-cli.mjs'));
		copyFileSync(join(ROOT, 'package.json'), join(fakeRepo, 'package.json'));
		const fakeHome = join(scratch, 'home');
		const fakeWork = join(scratch, 'work');
		mkdirSync(fakeHome);
		mkdirSync(fakeWork);
		const docs = join(scratch, 'documents');
		mkdirSync(docs);
		writeFileSync(join(docs, 'notes.md'), 'KEEP THIS FILE\n');
		const note = join(scratch, 'note.txt');
		writeFileSync(note, 'KEEP THIS FILE\n');
		const marked = join(scratch, 'marked');
		mkdirSync(marked);
		writeFileSync(join(marked, 'deckmark-build.json'), '{"schema":"other/1"}\n');
		writeFileSync(join(marked, 'keep.md'), 'KEEP THIS FILE\n');

		const env = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome };
		const packOut = (out) =>
			run(
				process.execPath,
				[join(fakeRepo, 'scripts', 'pack-cli.mjs'), '--out', out, '--allow-dirty'],
				{ cwd: fakeWork, env }
			);

		const cases = [
			{ out: fakeRepo, detail: /repository root/ },
			{ out: scratch, detail: /repository root|ancestor/ },
			{ out: fakeHome, detail: /home directory/ },
			{ out: docs, detail: /no deckmark-build\.json marker/ },
			{ out: note, detail: /exists and is not a directory/ },
			{ out: marked, detail: /no deckmark-build\.json marker/ }
		];
		for (const item of cases) {
			const result = packOut(item.out);
			NEGATIVE.outputGuard.push({
				out: item.out,
				exit: result.status,
				stderr: result.stderr.trim()
			});
			assert.notEqual(result.status, 0, `--out ${item.out} was accepted`);
			assert.match(result.stderr, /Refusing --out/);
			assert.match(result.stderr, item.detail);
		}
		assert.ok(existsSync(join(fakeWork, '..', 'repo', 'scripts', 'pack-cli.mjs')));
		assert.ok(existsSync(join(fakeRepo, 'package.json')));
		assert.equal(readFileSync(join(docs, 'notes.md'), 'utf8'), 'KEEP THIS FILE\n');
		assert.equal(readFileSync(note, 'utf8'), 'KEEP THIS FILE\n');
		assert.equal(readFileSync(join(marked, 'keep.md'), 'utf8'), 'KEEP THIS FILE\n');
		assert.deepEqual(readdirSync(fakeHome), []);
		assert.ok(existsSync(join(scratch, 'documents')));
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

test('package reproduces source identity, release layout, and hash verification', () => {
	assert.equal(manifest.schema, 'deckmark-cli-install/1');
	assert.equal(manifest.version, VERSION);
	assert.equal(basename(PACKAGE), RELEASE_NAME);
	assert.match(manifest.source.gitSha, /^[0-9a-f]{40}$/);
	assert.equal(
		manifest.source.gitSha,
		execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
	);
	assert.ok(Number(manifest.runtime.nodeVersion.split('.')[0]) >= 22);
	assert.equal(manifest.target.platform, process.platform);
	assert.equal(manifest.target.arch, process.arch);

	const runtimeName = process.platform === 'win32' ? 'runtime/node.exe' : 'runtime/node';
	const launchers =
		process.platform === 'win32'
			? ['bin/deckmark.cmd', 'bin/deckmark-mcp.cmd']
			: ['bin/deckmark', 'bin/deckmark-mcp'];
	assert.deepEqual(
		Object.keys(manifest.files).sort(),
		[
			...launchers,
			'lib/deckmark.mjs',
			'lib/deckmark-mcp.mjs',
			runtimeName,
			'runtime/LICENSE-node.txt'
		].sort()
	);

	const listing = run(TAR, ['-tf', ARCHIVE], { cwd: ROOT, env: process.env });
	assert.equal(listing.status, 0, listing.stderr);
	const entries = listing.stdout
		.split(/\r?\n/)
		.filter(Boolean)
		.map((entry) => entry.replaceAll('\\', '/').replace(/\/$/, ''));
	assert.ok(entries.length > 0);
	for (const entry of entries) {
		assert.ok(
			entry === RELEASE_NAME || entry.startsWith(`${RELEASE_NAME}/`),
			`archive entry ${entry} is outside the ${RELEASE_NAME}/ release root`
		);
	}
	OBSERVED.archiveRoot = RELEASE_NAME;
	OBSERVED.archiveEntries = entries.length;

	const verify = verifyPackage();
	assert.equal(verify.status, 0, verify.stderr);

	const manifestPath = join(PACKAGE, 'deckmark-build.json');
	const original = readFileSync(manifestPath, 'utf8');
	const tampered = JSON.parse(original);
	tampered.version = '0.0.0-tampered';
	writeFileSync(manifestPath, `${JSON.stringify(tampered, null, 2)}\n`);
	const rejected = verifyPackage();
	writeFileSync(manifestPath, original);
	assert.notEqual(rejected.status, 0);
	assert.match(rejected.stderr, /differs from package\.json/);
});

test('verify rejects an unlisted payload file, an unexpected entry, a symbolic link, and a wrong mode', () => {
	const cases = [];

	const injected = join(PACKAGE, 'lib', 'injected.mjs');
	writeFileSync(injected, 'export const injected = true;\n');
	let result = verifyPackage();
	rmSync(injected, { force: true });
	cases.push({ mutation: 'lib/injected.mjs', exit: result.status, stderr: result.stderr.trim() });
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Unlisted file in the package: lib\/injected\.mjs/);

	const extraRoot = join(PACKAGE, 'README.txt');
	writeFileSync(extraRoot, 'extra\n');
	result = verifyPackage();
	rmSync(extraRoot, { force: true });
	cases.push({ mutation: 'README.txt', exit: result.status, stderr: result.stderr.trim() });
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Unexpected entry in the package root: README\.txt/);

	const nested = join(PACKAGE, 'lib', 'nested');
	mkdirSync(nested);
	writeFileSync(join(nested, 'extra.mjs'), 'export const extra = true;\n');
	result = verifyPackage();
	rmSync(nested, { recursive: true, force: true });
	cases.push({ mutation: 'lib/nested', exit: result.status, stderr: result.stderr.trim() });
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Unexpected entry in the package: lib\/nested/);

	if (process.platform !== 'win32') {
		const alias = join(PACKAGE, 'lib', 'alias.mjs');
		symlinkSync(join(PACKAGE, 'lib', 'deckmark.mjs'), alias);
		result = verifyPackage();
		rmSync(alias, { force: true });
		cases.push({ mutation: 'lib/alias.mjs', exit: result.status, stderr: result.stderr.trim() });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /Symbolic link in the package: lib\/alias\.mjs/);

		const launcher = join(PACKAGE, 'bin', 'deckmark');
		chmodSync(launcher, 0o644);
		result = verifyPackage();
		chmodSync(launcher, 0o755);
		cases.push({
			mutation: 'bin/deckmark mode 644',
			exit: result.status,
			stderr: result.stderr.trim()
		});
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /not executable for its owner: bin\/deckmark/);
	}

	NEGATIVE.verify = cases;
	assert.equal(verifyPackage().status, 0);
});

test('installed CLI runs with no external Node, PATH, or checkout', () => {
	const version = cli(['--version']);
	assert.equal(version.status, 0, version.stderr);
	assert.equal(version.stdout.trim(), `deckmark ${manifest.version}`);
	OBSERVED.version = version.stdout.trim();

	const help = cli(['--help']);
	assert.equal(help.status, 0, help.stderr);
	assert.match(help.stdout, /DeckMark CLI/);
	OBSERVED.helpFirstLine = help.stdout.trim().split('\n')[0];
	for (const command of ['check', 'search', 'render', 'export', 'inspect']) {
		assert.match(help.stdout, new RegExp(command));
	}
	assert.equal(`${help.stdout}${help.stderr}`.includes(CANARY), false);

	const cwd = cli(['--version'], { cwd: ROOT });
	assert.equal(cwd.stdout.trim(), `deckmark ${manifest.version}`);

	const envPath = cli(['--version'], { env: { ...process.env, DECKMARK_TEST_SECRET: CANARY } });
	assert.equal(envPath.stdout.trim(), `deckmark ${manifest.version}`);
	assert.equal(`${envPath.stdout}${envPath.stderr}`.includes(CANARY), false);
});

test('installed CLI checks a real project and exports HTML and ZIP', () => {
	const check = cli(['check', '.', '--json']);
	assert.equal(check.status, 5, check.stderr);
	const report = JSON.parse(check.stdout);
	assert.equal(report.schema, 'mdsh-docs-check/1');
	assert.ok(report.issues.some((issue) => issue.code === 'link-missing'));
	OBSERVED.check = {
		exit: check.status,
		schema: report.schema,
		documents: report.documents,
		errors: report.summary.errors,
		warnings: report.summary.warnings,
		issueCodes: [...new Set(report.issues.map((issue) => issue.code))]
	};

	const html = cli(['export', 'notes/good.md', '--format', 'html', '--out', 'good.html', '--json']);
	assert.equal(html.status, 0, html.stderr);
	const htmlReport = JSON.parse(html.stdout);
	assert.equal(htmlReport.schema, 'deckmark-export/1');
	assert.ok(existsSync(join(fixtureRoot, 'good.html')));
	assert.match(readFileSync(join(fixtureRoot, 'good.html'), 'utf8'), /Installed Note/);
	OBSERVED.exportHtml = { exit: html.status, bytes: htmlReport.bytes };

	const zip = cli(['export', '.', '--format', 'zip', '--out', 'project.zip', '--json']);
	assert.equal(zip.status, 0, zip.stderr);
	const zipReport = JSON.parse(zip.stdout);
	assert.equal(zipReport.schema, 'deckmark-export/1');
	assert.ok(existsSync(join(fixtureRoot, 'project.zip')));
	OBSERVED.exportZip = {
		exit: zip.status,
		documents: zipReport.documents,
		assets: zipReport.assets,
		bytes: zipReport.bytes
	};
});

test('installed MCP launcher initializes, lists tools, reads an approved file, and rejects escapes', () => {
	const calls = [
		{
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: {
				protocolVersion: '2025-06-18',
				capabilities: {},
				clientInfo: { name: 'pack-test', version: '1' }
			}
		},
		{ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
		{
			jsonrpc: '2.0',
			id: 3,
			method: 'tools/call',
			params: { name: 'read_file', arguments: { path: 'notes/good.md' } }
		},
		{
			jsonrpc: '2.0',
			id: 4,
			method: 'tools/call',
			params: { name: 'read_file', arguments: { path: '../outside/secret.md' } }
		},
		{
			jsonrpc: '2.0',
			id: 5,
			method: 'tools/call',
			params: { name: 'read_file', arguments: { path: join(projectRoot, 'outside', 'secret.md') } }
		}
	];
	if (escapePathCreated) {
		calls.push({
			jsonrpc: '2.0',
			id: 6,
			method: 'tools/call',
			params: { name: 'read_file', arguments: { path: 'notes/escape.md' } }
		});
	}
	const approved = mcp(['--root', fixtureRoot], mcpMessages(...calls));
	assert.equal(approved.status, 0, approved.stderr);
	const lines = approved.stdout
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line));
	assert.equal(lines[0].result.serverInfo.name, 'deckmark-mcp');
	assert.ok(lines[1].result.tools.some((tool) => tool.name === 'read_file'));
	assert.match(lines[2].result.content[0].text, /Hello DeckMark/);

	// Unconditional root-escape proof. The traversal and the absolute form are
	// rejected by the path rules before resolution, so the code is unsafe-path.
	for (const index of [3, 4]) {
		assert.equal(lines[index].result.isError, true);
		assert.match(lines[index].result.content[0].text, /unsafe-path: Path traversal rejected/);
	}
	const escape = lines[3].result.content[0].text;
	let symlinkEscape = 'not created';
	if (escapePathCreated) {
		assert.equal(lines[5].result.isError, true);
		assert.match(lines[5].result.content[0].text, /outside-root/);
		symlinkEscape = lines[5].result.content[0].text;
	}
	OBSERVED.mcp = {
		exit: approved.status,
		platformLauncher: process.platform === 'win32' ? 'runtime/node' : 'bin/deckmark-mcp',
		protocolVersion: lines[0].result.protocolVersion,
		server: lines[0].result.serverInfo,
		tools: lines[1].result.tools.map((tool) => tool.name),
		approvedRead: /Hello DeckMark/.test(lines[2].result.content[0].text),
		escape,
		symlinkCreated: escapePathCreated,
		symlinkEscape
	};
	assert.equal(`${approved.stdout}${approved.stderr}`.includes('OUTSIDE SECRET'), false);
	assert.equal(`${approved.stdout}${approved.stderr}`.includes(CANARY), false);
});

test('installed MCP prints one usage line and exits 2 for a missing or bad root', () => {
	const cases = [
		{ args: [], detail: /^deckmark-mcp: At least one --root directory is required\.$/ },
		{ args: ['--root'], detail: /^deckmark-mcp: Missing --root value\.$/ },
		{
			args: ['--root', join(fixtureRoot, 'absent-root')],
			detail: /^deckmark-mcp: Root directory does not exist:/
		},
		{ args: ['--bogus'], detail: /^deckmark-mcp: Unknown argument: --bogus\./ }
	];
	for (const item of cases) {
		const result = mcp(item.args, '');
		NEGATIVE.mcpUsage.push({ args: item.args, exit: result.status, stderr: result.stderr.trim() });
		assert.equal(result.status, 2, `exit ${result.status} for ${JSON.stringify(item.args)}`);
		const output = `${result.stdout}${result.stderr}`;
		assert.equal(/\n\s+at\s|Node\.js v/.test(output), false, output);
		assert.equal(result.stderr.trim().split('\n').length, 1);
		assert.match(result.stderr.trim(), item.detail);
		assert.equal(result.stdout, '');
	}
});

// Limitation, not fixed here: on Windows the .cmd launcher is cmd.exe and the
// node.exe grandchild owns the runtime image. This test awaits close on the
// launcher only. A grandchild that outlives stdio can still pass this test and
// then fail the package process scan below. The original locker is unknown.
test('concurrent CLI and MCP access leaves project documents unchanged', async () => {
	const brokenCheck = launcherInvocation('deckmark', ['check', 'broken.md', '--json']);
	const projectCheck = launcherInvocation('deckmark', ['check', '.', '--json']);
	const node = join(packageRoot, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
	const server = join(packageRoot, 'lib', 'deckmark-mcp.mjs');
	const hashBefore = treeHash(fixtureRoot);
	// The .cmd launcher needs verbatim arguments for its prequoted cmd.exe line.
	// The direct runtime is a plain Node process, so it must keep default quoting;
	// otherwise libuv leaves a root path that contains a space unquoted.
	const jobs = [
		{
			command: node,
			args: [server, '--root', fixtureRoot],
			options: {},
			input: mcpMessages({
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: { name: 'read_file', arguments: { path: 'notes/good.md' } }
			})
		},
		brokenCheck,
		projectCheck
	];
	const results = await Promise.all(
		jobs.map(
			({ command, args, options, input }) =>
				new Promise((resolveRun) => {
					const child = spawn(command, args, {
						...options,
						cwd: fixtureRoot,
						env: installedEnv()
					});
					let stdout = '';
					let stderr = '';
					child.stdout.on('data', (chunk) => (stdout += chunk));
					child.stderr.on('data', (chunk) => (stderr += chunk));
					child.stdin.end(input ?? '');
					child.on('close', (status) => resolveRun({ status, stdout, stderr }));
				})
		)
	);
	COMMANDS.push({
		command: 'three concurrent CLI/MCP processes',
		status: results.map((item) => item.status)
	});
	assert.deepEqual(
		results.map((item) => item.status),
		[0, 5, 5]
	);
	assert.equal(treeHash(fixtureRoot), hashBefore);
});

test('uninstall removes only the package and keeps documents', async () => {
	assert.ok(existsSync(packageRoot));
	const projectHash = treeHash(fixtureRoot);

	// A real installed process holds the runtime open. The scanner must name it
	// and the harness wait must reject while it runs. This is harness behavior
	// only: no product uninstall command deletes the package. Linux and Windows
	// run this canary; macOS unlinks a running image, so it has no lock.
	if (process.platform === 'linux' || process.platform === 'win32') {
		const runtime = join(
			packageRoot,
			'runtime',
			process.platform === 'win32' ? 'node.exe' : 'node'
		);
		const holder = spawnTracked(runtime, ['-e', 'setInterval(() => {}, 1000)'], {
			cwd: fixtureRoot,
			env: installedEnv()
		});
		await new Promise((resolveSpawn, rejectSpawn) => {
			holder.child.once('spawn', resolveSpawn);
			holder.child.once('error', rejectSpawn);
		});
		try {
			await waitForPackageProcess(packageRoot, holder.child.pid, 10_000);
			await assert.rejects(
				waitForPackageProcessesToExit(packageRoot, 400),
				/Package process still running/
			);
			assert.equal(existsSync(packageRoot), true);
			// This canary records scanner detection and the harness wait. It does
			// not test a product uninstall guard, and nothing deletes the package
			// while the holder runs.
			OBSERVED.packageProcessScan = {
				liveProcess: holder.child.pid,
				detected: true,
				waitRejected: true
			};
		} finally {
			await stopTracked(holder);
		}
	}

	await waitForPackageProcessesToExit(packageRoot, 5_000);
	removePackageTree(packageRoot);
	assert.equal(existsSync(packageRoot), false);
	assert.equal(existsSync(fixtureRoot), true);
	assert.equal(treeHash(fixtureRoot), projectHash);
	assert.deepEqual(readdirSync(homeRoot), []);

	const evidence = {
		schema: 'deckmark-cli-install-evidence/1',
		command: 'node --test scripts/pack-cli.test.mjs',
		sourceSha: manifest.source.gitSha,
		sourceDirty: manifest.source.dirty,
		packageVersion: manifest.version,
		releaseName: RELEASE_NAME,
		runtime: manifest.runtime,
		target: manifest.target,
		platform: process.platform,
		arch: process.arch,
		node: process.version,
		packagePath: PACKAGE,
		packageArchive: ARCHIVE,
		packageArchiveSha256: archiveSha256,
		packageFiles: manifest.files,
		packageTreeSha256: treeHash(PACKAGE),
		negativeChecks: NEGATIVE,
		observations: OBSERVED,
		checks: COMMANDS
	};
	writeFileSync(
		join(ROOT, 'test-results', '272-cli-pack-evidence.json'),
		`${JSON.stringify(evidence, null, 2)}\n`
	);
});

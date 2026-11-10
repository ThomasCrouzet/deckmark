#!/usr/bin/env node
// Build or verify the installed-user CLI and MCP package.
// The package contains a version-matched Node runtime, the existing CLI bundle,
// the existing MCP source, and small launchers. It adds no service and no
// network listener. It does not sign, publish, or change a release workflow.
//
// Usage:
//   node scripts/pack-cli.mjs --out build/cli-pack [--name <dir>] [--archive]
//     [--runtime-node <path>] [--allow-dirty]
//   node scripts/pack-cli.mjs verify --dir build/cli-pack [--expect-version <version>]
//     [--expect-platform <platform>] [--expect-arch <arch>]

import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
	copyFileSync,
	createReadStream,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = 'deckmark-cli-install/1';
const MIN_NODE_MAJOR = 22;
const RELEASE_OS = process.platform === 'win32' ? 'windows' : process.platform;
const PAYLOAD_DIRECTORIES = ['bin', 'lib', 'runtime'];
const TOP_LEVEL_ENTRIES = new Set([...PAYLOAD_DIRECTORIES, 'deckmark-build.json', 'SHA256SUMS']);
const CMD_UNSAFE = /["%\r\n]/;

function fail(message) {
	process.stderr.write(`pack-cli: ${message}\n`);
	process.exit(1);
}

function usage(message) {
	if (message) process.stderr.write(`pack-cli: ${message}\n`);
	process.stderr.write(
		'Usage: node scripts/pack-cli.mjs --out <dir> [--name <dir>] [--runtime-node <path>]\n' +
			'         [--allow-dirty] [--archive]\n' +
			'       node scripts/pack-cli.mjs verify --dir <dir> [--expect-version <version>]\n' +
			'         [--expect-platform <platform>] [--expect-arch <arch>]\n'
	);
	process.exit(2);
}

function systemRoot(env) {
	const key = Object.keys(env).find((name) => name.toLowerCase() === 'systemroot');
	return key ? String(env[key] ?? '') : '';
}

// Windows ships bsdtar at a fixed path under SystemRoot. Do not resolve tar
// through PATH: Git for Windows puts GNU tar first, and GNU tar cannot write a
// ZIP archive. A missing tool is a clear build failure, not a fallback.
export function resolveArchiveTool({
	platform = process.platform,
	env = process.env,
	exists = existsSync
} = {}) {
	if (platform !== 'win32') return 'tar';
	const root = systemRoot(env);
	if (!root) {
		throw new Error(
			'Cannot find the Windows archive tool: SystemRoot is not set. ' +
				'Run the packer from a standard Windows environment.'
		);
	}
	const candidate = join(root, 'System32', 'tar.exe');
	if (!exists(candidate)) {
		throw new Error(
			`Cannot find the Windows archive tool: ${candidate}. ` +
				'Windows provides bsdtar at System32/tar.exe under SystemRoot.'
		);
	}
	return candidate;
}

function archiveToolPath() {
	try {
		return resolveArchiveTool();
	} catch (error) {
		fail(error.message);
	}
}

function parseArgs(argv) {
	const options = {
		command: argv[0] === 'verify' ? 'verify' : 'pack',
		out: 'build/cli-pack',
		name: '',
		dir: '',
		runtimeNode: process.execPath,
		allowDirty: false,
		archive: false,
		expectVersion: '',
		expectPlatform: process.platform,
		expectArch: process.arch
	};
	const rest = options.command === 'verify' ? argv.slice(1) : argv;
	for (let index = 0; index < rest.length; index += 1) {
		const arg = rest[index];
		if (arg === '--out') options.out = rest[++index] ?? '';
		else if (arg === '--name') options.name = rest[++index] ?? '';
		else if (arg === '--dir') options.dir = rest[++index] ?? '';
		else if (arg === '--runtime-node') options.runtimeNode = rest[++index] ?? '';
		else if (arg === '--allow-dirty') options.allowDirty = true;
		else if (arg === '--archive') options.archive = true;
		else if (arg === '--expect-version') options.expectVersion = rest[++index] ?? '';
		else if (arg === '--expect-platform') options.expectPlatform = rest[++index] ?? '';
		else if (arg === '--expect-arch') options.expectArch = rest[++index] ?? '';
		else if (arg === '--help' || arg === '-h') usage();
		else usage(`Unknown argument: ${arg}`);
	}
	if (options.command === 'pack' && !options.out) usage('Missing --out value.');
	if (options.command === 'verify' && !options.dir) usage('Missing --dir value.');
	return options;
}

function sha256File(path) {
	return new Promise((resolveHash, reject) => {
		const hash = createHash('sha256');
		const stream = createReadStream(path);
		stream.on('data', (chunk) => hash.update(chunk));
		stream.on('error', reject);
		stream.on('end', () => resolveHash(hash.digest('hex')));
	});
}

function fileSha(path) {
	return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function sleepSync(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Windows can hold a directory handle briefly after a child process stops.
 * Retry only transient Windows errors. Other platforms and other errors fail
 * at the first attempt.
 */
export function renameWithRetry(from, to, options = {}) {
	const platform = options.platform ?? process.platform;
	const rename = options.rename ?? renameSync;
	const pause = options.pause ?? sleepSync;
	const attempts = platform === 'win32' ? 20 : 1;
	for (let attempt = 0; ; attempt += 1) {
		try {
			rename(from, to);
			return;
		} catch (error) {
			const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
			const transient = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
			if (attempt + 1 >= attempts || !transient) throw error;
			pause(100 * (attempt + 1));
		}
	}
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { encoding: 'utf8', ...options });
	if (result.error) throw new Error(`${command}: ${result.error.message}`);
	if (result.status !== 0) {
		const detail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
		throw new Error(
			`${command} ${args.join(' ')} failed (${result.status})${detail ? `: ${detail}` : ''}`
		);
	}
	return result;
}

function git(...args) {
	return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function packageVersion() {
	return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
}

function releaseName(version) {
	return `deckmark-cli-${version}-${RELEASE_OS}-${process.arch}`;
}

function sourceIdentity() {
	let sha;
	try {
		sha = git('rev-parse', 'HEAD');
	} catch {
		fail('Cannot read the source commit. Run this command in a Git checkout.');
	}
	const status = git('status', '--porcelain');
	return { gitSha: sha, dirty: status.length > 0 };
}

function runtimeIdentity(nodePath) {
	const absolute = resolve(nodePath);
	if (!existsSync(absolute)) fail(`Runtime Node does not exist: ${absolute}`);
	const version = run(absolute, ['--version']).stdout.trim().replace(/^v/, '');
	const major = Number(version.split('.')[0]);
	if (!Number.isInteger(major) || major < MIN_NODE_MAJOR) {
		fail(`Runtime Node ${version} is older than the supported major ${MIN_NODE_MAJOR}.`);
	}
	const identity = run(absolute, [
		'-p',
		'JSON.stringify({platform:process.platform,arch:process.arch})'
	]).stdout.trim();
	let parsed;
	try {
		parsed = JSON.parse(identity);
	} catch {
		fail(`Cannot read the runtime platform from ${absolute}.`);
	}
	if (parsed.platform !== process.platform || parsed.arch !== process.arch) {
		fail(
			`Runtime Node is ${parsed.platform}-${parsed.arch}; this build host is ${process.platform}-${process.arch}. ` +
				'Build each package on its target operating system and architecture.'
		);
	}
	const licenseCandidates = [
		join(dirname(absolute), '..', 'LICENSE'),
		join(dirname(absolute), 'LICENSE')
	];
	const license = licenseCandidates.find((candidate) => existsSync(candidate));
	if (!license) {
		fail(`Cannot find the Node LICENSE near ${absolute}. Use an official Node archive.`);
	}
	return { absolute, version, platform: parsed.platform, arch: parsed.arch, license };
}

function isSameOrAncestor(candidate, target) {
	const candidatePath = resolve(candidate);
	const targetPath = resolve(target);
	if (candidatePath === targetPath) return true;
	const relation = relative(candidatePath, targetPath);
	if (relation === '') return true;
	if (isAbsolute(relation)) return false;
	return relation !== '..' && !relation.startsWith(`..${sep}`);
}

// Resolve the symbolic links in the existing part of a path. The output path
// must be checked as the file system resolves it, not as the user typed it.
function canonicalPath(value) {
	let current = resolve(value);
	const missing = [];
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) break;
		missing.unshift(basename(current));
		current = parent;
	}
	const real = realpathSync(current);
	return missing.length > 0 ? join(real, ...missing) : real;
}

function isOwnedPackage(directory) {
	const marker = join(directory, 'deckmark-build.json');
	if (!existsSync(marker)) return false;
	let manifest;
	try {
		manifest = JSON.parse(readFileSync(marker, 'utf8'));
	} catch {
		return false;
	}
	if (manifest?.schema !== SCHEMA) return false;
	return readdirSync(directory).every((entry) => TOP_LEVEL_ENTRIES.has(entry));
}

// A directory can vanish or change between two checks. A failed read is an
// ownership failure, never a reason to delete the path.
function isOwnedPackageSafe(directory) {
	try {
		return isOwnedPackage(directory);
	} catch {
		return false;
	}
}

// The packer deletes the output directory before it renames the new build into
// place. Refuse every output that can hold data the packer does not own. There
// is no flag that bypasses this check.
function assertSafeOutput(requested, label) {
	const out = canonicalPath(requested);
	const parsed = parse(out);
	const segments = out.slice(parsed.root.length).split(sep).filter(Boolean);
	if (out === parsed.root) fail(`Refusing ${label} ${out}: it is a file system root.`);
	if (segments.length < 2) {
		fail(`Refusing ${label} ${out}: it is too close to the file system root.`);
	}
	const protectedPaths = [
		['the repository root', ROOT],
		['the user home directory', homedir()],
		['the working directory', process.cwd()]
	];
	for (const [name, target] of protectedPaths) {
		if (isSameOrAncestor(out, canonicalPath(target))) {
			fail(`Refusing ${label} ${out}: it is ${name} or an ancestor of it.`);
		}
	}
	if (isSameOrAncestor(canonicalPath(join(ROOT, '.git')), out)) {
		fail(`Refusing ${label} ${out}: it is inside the Git directory.`);
	}
	if (!existsSync(out)) return out;
	const info = lstatSync(out);
	if (info.isSymbolicLink()) {
		fail(`Refusing ${label} ${out}: it is a symbolic link. Use the real directory path.`);
	}
	if (!info.isDirectory()) {
		fail(`Refusing ${label} ${out}: it exists and is not a directory.`);
	}
	if (readdirSync(out).length === 0) return out;
	if (!isOwnedPackage(out)) {
		fail(
			`Refusing ${label} ${out}: it is not empty and it has no deckmark-build.json marker. ` +
				'Remove that directory yourself when you are sure that it holds no data.'
		);
	}
	return out;
}

function assertArchivePath(archive) {
	if (!existsSync(archive)) return;
	const info = lstatSync(archive);
	if (info.isDirectory()) {
		fail(`Refusing to replace ${archive}: it is a directory.`);
	}
	if (!info.isFile()) fail(`Refusing to replace ${archive}: it is not a regular file.`);
}

const PROMOTION_SCHEMA = 'deckmark-cli-promotion/1';

function transactionMarker(out) {
	return join(dirname(out), `.${basename(out)}.pack-transaction.json`);
}

function randomSuffix() {
	return randomBytes(6).toString('hex');
}

function backupPath(out) {
	return join(dirname(out), `.${basename(out)}.backup-${randomSuffix()}`);
}

function archiveTemporaryPath(archive) {
	const extension = archive.endsWith('.zip')
		? '.zip'
		: archive.endsWith('.tar.gz')
			? '.tar.gz'
			: '';
	const name = extension ? basename(archive).slice(0, -extension.length) : basename(archive);
	return join(dirname(archive), `.${name}.archive-${randomSuffix()}${extension}`);
}

// The marker is the durable record of one promotion. Write it to a sibling
// temporary file first so a crash cannot leave a partial marker that names the
// wrong backup.
function writeTransactionMarker(marker, state) {
	const temporary = `${marker}.tmp-${randomSuffix()}`;
	writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
	try {
		renameWithRetry(temporary, marker);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

function promotionState(state, out, marker) {
	const backup = typeof state?.backup === 'string' ? resolve(state.backup) : '';
	const valid =
		state?.schema === PROMOTION_SCHEMA &&
		typeof state.out === 'string' &&
		resolve(state.out) === out &&
		backup !== '' &&
		dirname(backup) === dirname(out) &&
		basename(backup).startsWith(`.${basename(out)}.backup-`);
	if (!valid) {
		throw new Error(
			`Refusing the interrupted promotion marker ${marker}: it does not name this output. ` +
				'Inspect the marker and the sibling backup before you pack again.'
		);
	}
	return { backup, state };
}

/**
 * Complete or undo one interrupted promotion before a new build starts.
 * A crash between the two renames leaves the output absent and the previous
 * package in the sibling backup. A crash after the new rename leaves both. A
 * marker that records a failed rollback fails closed because the state is
 * unknown.
 */
export function reconcileInterruptedPromotion(out, options = {}) {
	const platform = options.platform ?? process.platform;
	const rename = options.rename ?? renameSync;
	const pause = options.pause ?? sleepSync;
	const remove = options.remove ?? rmSync;
	const exists = options.exists ?? existsSync;
	const report = options.report ?? (() => {});
	const target = resolve(out);
	const marker = transactionMarker(target);
	if (!exists(marker)) return { recovered: false };
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(marker, 'utf8'));
	} catch {
		throw new Error(
			`Cannot read the interrupted promotion marker ${marker}. ` +
				'Inspect the marker and the sibling backup before you pack again.'
		);
	}
	const { backup, state } = promotionState(parsed, target, marker);
	if (state.rollback === true) {
		throw new Error(
			`The interrupted promotion marker ${marker} records a failed rollback` +
				`${state.failure ? ` (${state.failure})` : ''}. ` +
				`Inspect ${target} and ${backup} before you pack again.`
		);
	}
	if (exists(target)) {
		// The new package is in place. The previous package is no longer needed.
		if (exists(backup)) {
			remove(backup, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
		remove(marker, { force: true });
		report(`completed an interrupted promotion of ${target} and removed the stale backup`);
		return { recovered: true };
	}
	if (!exists(backup)) {
		remove(marker, { force: true });
		return { recovered: false };
	}
	if (!isOwnedPackage(backup)) {
		throw new Error(
			`Refusing to restore ${backup}: it has no valid deckmark-build.json marker. ` +
				'Inspect the backup and the promotion marker before you pack again.'
		);
	}
	renameWithRetry(backup, target, { platform, rename, pause });
	remove(marker, { force: true });
	report(`restored the previous package at ${target} after an interrupted promotion`);
	return { recovered: true };
}

/**
 * Replace one package with a tested stage. The previous package moves to a
 * sibling backup and returns if any later step fails. The backup is removed
 * only after the directory and the optional archive are committed.
 */
export function promotePackage(options) {
	const stage = resolve(options.stage);
	const out = resolve(options.out);
	const archive = options.archive ? resolve(options.archive) : '';
	if (!existsSync(stage)) throw new Error(`Missing staged package: ${stage}`);
	if (archive && typeof options.createArchive !== 'function') {
		throw new Error('An archive target needs a createArchive function.');
	}
	const platform = options.platform ?? process.platform;
	const rename = options.rename ?? renameSync;
	const pause = options.pause ?? sleepSync;
	const remove = options.remove ?? rmSync;
	const exists = options.exists ?? existsSync;
	const report = options.report ?? (() => {});
	const warn = options.warn ?? (() => {});
	const move = (from, to) => renameWithRetry(from, to, { platform, rename, pause });
	const marker = transactionMarker(out);
	const backup = backupPath(out);
	const temporaryArchive = archive ? archiveTemporaryPath(archive) : '';
	const hadPrevious = exists(out);
	if (hadPrevious && !isOwnedPackageSafe(out)) {
		throw new Error(`Refusing to replace ${out}: it has no valid deckmark-build.json marker.`);
	}
	const state = {
		schema: PROMOTION_SCHEMA,
		out,
		backup,
		archive,
		stage,
		pid: process.pid,
		startedAt: new Date().toISOString()
	};
	writeTransactionMarker(marker, state);
	let promoted = false;
	let previousMoved = false;
	try {
		if (hadPrevious) {
			move(out, backup);
			previousMoved = true;
			// Recheck ownership at the destructive boundary. A path that changed
			// after assertSafeOutput() returns to its place through the rollback.
			if (!isOwnedPackageSafe(backup)) {
				throw new Error(
					`Refusing to replace ${out}: the directory changed and has no valid deckmark-build.json marker.`
				);
			}
		}
		move(stage, out);
		promoted = true;
		if (archive) {
			options.createArchive(temporaryArchive);
			if (!exists(temporaryArchive)) {
				throw new Error(`The archive tool did not write ${temporaryArchive}.`);
			}
			move(temporaryArchive, archive);
		}
	} catch (error) {
		const failure = error instanceof Error ? error.message : String(error);
		// Record the failed rollback before it starts. A later invocation must not
		// guess which package is current when recovery also fails.
		try {
			writeTransactionMarker(marker, { ...state, rollback: true, failure });
		} catch {
			// Keep the original marker. The error below still names the state.
		}
		try {
			if (promoted && exists(out)) {
				remove(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			}
			if (previousMoved && exists(backup)) move(backup, out);
			if (temporaryArchive && exists(temporaryArchive)) remove(temporaryArchive, { force: true });
		} catch (recoveryError) {
			const detail = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
			throw new Error(
				`Promotion failed: ${failure}. Recovery also failed: ${detail}. ` +
					`Inspect ${out}, ${backup}, and ${marker} before the next pack.`,
				{ cause: recoveryError }
			);
		}
		try {
			remove(marker, { force: true });
		} catch (markerError) {
			const detail = markerError instanceof Error ? markerError.message : String(markerError);
			throw new Error(
				`Promotion failed: ${failure}. The previous package state was restored, ` +
					`but the transaction marker ${marker} remains: ${detail}`,
				{ cause: markerError }
			);
		}
		throw new Error(
			`Promotion failed: ${failure}. ` +
				(hadPrevious
					? `The previous package at ${out} was restored.`
					: `The output ${out} was not replaced.`),
			{ cause: error }
		);
	}
	let backupRetained = '';
	if (previousMoved && exists(backup)) {
		try {
			remove(backup, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		} catch (error) {
			backupRetained = backup;
			const detail = error instanceof Error ? error.message : String(error);
			warn(`installed ${out}, but the previous package backup at ${backup} remains: ${detail}`);
		}
	}
	try {
		remove(marker, { force: true });
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		warn(`installed ${out}, but the transaction marker ${marker} remains: ${detail}`);
	}
	report(`installed ${out}${archive ? ` and ${archive}` : ''}`);
	return { backupRetained };
}

function posixLauncher(libName) {
	return `#!/bin/sh
set -eu

case $0 in
\t*/*) self=$0 ;;
\t*) self=$(command -v "$0" 2>/dev/null || printf '%s' "$0") ;;
esac
case $self in
\t*/*) here=\${self%/*} ;;
\t*) here=. ;;
esac
here=$(CDPATH= cd -P "$here" && pwd)
exec "$here/../runtime/node" "$here/../lib/${libName}" "$@"
`;
}

function windowsLauncher(libName) {
	return `@echo off\r
"%~dp0..\\runtime\\node.exe" "%~dp0..\\lib\\${libName}" %*\r
exit /b %ERRORLEVEL%\r
`;
}

async function writeManifest(stage, version, source, runtime, platform, arch) {
	const files = {};
	const paths = [
		...readdirSync(join(stage, 'bin')).map((name) => `bin/${name}`),
		...readdirSync(join(stage, 'lib')).map((name) => `lib/${name}`),
		`runtime/${platform === 'win32' ? 'node.exe' : 'node'}`,
		'runtime/LICENSE-node.txt'
	].sort();
	for (const path of paths) {
		const absolute = join(stage, path.split('/').join(sep));
		files[path] = {
			sha256: await sha256File(absolute),
			bytes: statSync(absolute).size
		};
	}
	const manifest = {
		schema: SCHEMA,
		version,
		source,
		runtime: {
			nodeVersion: runtime.version,
			platform: runtime.platform,
			arch: runtime.arch
		},
		target: { platform, arch },
		files
	};
	writeFileSync(join(stage, 'deckmark-build.json'), `${JSON.stringify(manifest, null, 2)}\n`);
	const sums = paths.map((path) => `${files[path].sha256}  ${path}`).join('\n');
	writeFileSync(join(stage, 'SHA256SUMS'), `${sums}\n`);
	return manifest;
}

// A batch file cannot receive a double quote, a percent sign, or a line break
// without a second expansion in cmd.exe. Refuse those arguments instead of
// building a command line that means something else.
function cmdArgument(value) {
	const text = String(value);
	if (CMD_UNSAFE.test(text)) {
		throw new Error(
			`Cannot pass ${JSON.stringify(text)} through a Windows .cmd launcher. ` +
				'Use a path without a quote, a percent sign, or a line break.'
		);
	}
	return `"${text}"`;
}

// cmd.exe /s removes the first and the last quote from the command it receives.
// Wrap the complete line once so the quoted launcher and its quoted arguments
// survive that rule. The line is already escaped for cmd.exe, so the spawn must
// pass it verbatim. Otherwise libuv escapes the quotes again for the C runtime,
// which cmd.exe does not parse.
export function windowsLauncherInvocation(
	command,
	args,
	comspec = process.env.ComSpec || 'cmd.exe'
) {
	const line = [command, ...args].map(cmdArgument).join(' ');
	return {
		command: comspec,
		args: ['/d', '/s', '/c', `"${line}"`],
		options: { windowsVerbatimArguments: true }
	};
}

function runLauncher(stage, name, args) {
	if (process.platform === 'win32') {
		const invocation = windowsLauncherInvocation(join(stage, 'bin', `${name}.cmd`), args);
		return run(invocation.command, invocation.args, invocation.options);
	}
	return run(join(stage, 'bin', name), args);
}

function smokeMcp(stage) {
	const node = join(stage, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
	const server = join(stage, 'lib', 'deckmark-mcp.mjs');
	const request = {
		jsonrpc: '2.0',
		id: 1,
		method: 'initialize',
		params: {
			protocolVersion: '2025-06-18',
			capabilities: {},
			clientInfo: { name: 'pack-cli', version: '1' }
		}
	};
	const result = run(node, [server, '--root', stage], { input: `${JSON.stringify(request)}\n` });
	let response;
	try {
		response = JSON.parse(result.stdout.trim().split('\n')[0]);
	} catch {
		fail('The packaged MCP server did not return valid JSON.');
	}
	if (response?.result?.serverInfo?.name !== 'deckmark-mcp') {
		fail('The packaged MCP server returned an unexpected initialize response.');
	}
}

async function pack(options) {
	const version = packageVersion();
	const requestedOut = resolve(options.out);
	// A dangerous --out selection is refused even when --name moves the build.
	assertSafeOutput(requestedOut, '--out');

	let name = '';
	if (options.name) {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.name)) {
			fail(
				`Invalid --name ${options.name}: use one name with letters, digits, dot, underscore, or hyphen.`
			);
		}
		name = options.name;
	} else if (options.archive) {
		// The archive root directory must match the documented release layout.
		name = releaseName(version);
	}
	const out = assertSafeOutput(name ? join(dirname(requestedOut), name) : requestedOut, '--out');
	reconcileInterruptedPromotion(out, {
		report: (line) => process.stdout.write(`pack-cli: ${line}\n`)
	});

	const source = sourceIdentity();
	if (source.dirty && !options.allowDirty) {
		fail(
			'The source tree is dirty. Commit the changes or use --allow-dirty for a local test build.'
		);
	}
	const runtime = runtimeIdentity(options.runtimeNode);
	const parent = dirname(out);
	mkdirSync(parent, { recursive: true });
	const stage = mkdtempSync(join(parent, `.${basename(out)}.stage-`));

	try {
		mkdirSync(join(stage, 'bin'), { recursive: true });
		mkdirSync(join(stage, 'lib'), { recursive: true });
		mkdirSync(join(stage, 'runtime'), { recursive: true });

		process.stdout.write('pack-cli: building the CLI bundle\n');
		const { bundle } = await import('./build-cli.mjs');
		await bundle();
		const cliBundle = join(ROOT, '.cli', 'deckmark.mjs');
		if (!existsSync(cliBundle)) fail('The CLI bundle was not created.');

		process.stdout.write('pack-cli: copying the CLI, MCP source, and runtime\n');
		copyFileSync(cliBundle, join(stage, 'lib', 'deckmark.mjs'));
		copyFileSync(join(ROOT, 'bin', 'deckmark-mcp.mjs'), join(stage, 'lib', 'deckmark-mcp.mjs'));
		const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
		copyFileSync(runtime.absolute, join(stage, 'runtime', nodeName));
		copyFileSync(runtime.license, join(stage, 'runtime', 'LICENSE-node.txt'));

		if (process.platform === 'win32') {
			writeFileSync(join(stage, 'bin', 'deckmark.cmd'), windowsLauncher('deckmark.mjs'));
			writeFileSync(join(stage, 'bin', 'deckmark-mcp.cmd'), windowsLauncher('deckmark-mcp.mjs'));
		} else {
			writeFileSync(join(stage, 'bin', 'deckmark'), posixLauncher('deckmark.mjs'), {
				mode: 0o755
			});
			writeFileSync(join(stage, 'bin', 'deckmark-mcp'), posixLauncher('deckmark-mcp.mjs'), {
				mode: 0o755
			});
		}
		const runtimeBinary = join(stage, 'runtime', nodeName);
		if (process.platform !== 'win32') run('chmod', ['755', runtimeBinary]);

		if (process.platform !== 'win32') run('chmod', ['755', stage]);

		const manifest = await writeManifest(
			stage,
			version,
			source,
			runtime,
			process.platform,
			process.arch
		);

		process.stdout.write('pack-cli: running the packaged smoke checks\n');
		const cliVersion = runLauncher(stage, 'deckmark', ['--version']).stdout.trim();
		if (cliVersion !== `deckmark ${version}`) {
			fail(`The packaged CLI reported "${cliVersion}" instead of "deckmark ${version}".`);
		}
		smokeMcp(stage);

		// The output directory is now known to be new, empty, or a package that
		// this tool built. Replace it with the finished stage through a recoverable
		// swap. The previous package returns if the archive also fails.
		const archive = options.archive
			? `${out}${process.platform === 'win32' ? '.zip' : '.tar.gz'}`
			: '';
		if (archive) assertArchivePath(archive);
		process.stdout.write('pack-cli: promoting the tested package\n');
		promotePackage({
			stage,
			out,
			archive,
			createArchive: archive
				? (temporary) => {
						const tar = archiveToolPath();
						if (process.platform === 'win32') {
							run(tar, ['-a', '-c', '-f', temporary, '-C', parent, basename(out)]);
						} else {
							run(tar, ['-czf', temporary, '-C', parent, basename(out)]);
						}
					}
				: undefined,
			report: (line) => process.stdout.write(`pack-cli: ${line}\n`),
			warn: (line) => process.stderr.write(`pack-cli: ${line}\n`)
		});

		if (archive) {
			process.stdout.write(
				`pack-cli: wrote ${relative(ROOT, archive) || archive} (root ${basename(out)}/, sha256 ${await sha256File(archive)})\n`
			);
		}
		process.stdout.write(
			`pack-cli: wrote ${relative(ROOT, out) || out} (${manifest.target.platform}-${manifest.target.arch}, Node ${manifest.runtime.nodeVersion}, source ${source.gitSha.slice(0, 12)}${source.dirty ? ', dirty' : ''})\n`
		);
	} finally {
		if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
	}
}

function launcherPaths(platform) {
	if (platform === 'win32') return ['bin/deckmark.cmd', 'bin/deckmark-mcp.cmd'];
	return ['bin/deckmark', 'bin/deckmark-mcp'];
}

function assertExecutable(dir, path) {
	const info = statSync(join(dir, path.split('/').join(sep)));
	const mode = info.mode & 0o777;
	if ((mode & 0o100) === 0) {
		fail(`Payload file is not executable for its owner: ${path} (mode ${mode.toString(8)})`);
	}
	if ((mode & 0o022) !== 0) {
		fail(`Payload file is writable by group or others: ${path} (mode ${mode.toString(8)})`);
	}
}

// The manifest proves the integrity of the files it names. The directory walk
// proves that the package holds nothing else: no extra file, no extra
// directory, and no symbolic link.
function inspectPayload(dir, manifest) {
	const files = manifest.files ?? {};
	const listed = new Set(Object.keys(files));
	const payload = new Set();
	for (const path of listed) {
		const [directory] = path.split('/');
		if (!PAYLOAD_DIRECTORIES.includes(directory)) {
			fail(`Manifest lists a path outside the payload directories: ${path}`);
		}
	}
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!TOP_LEVEL_ENTRIES.has(entry.name)) {
			fail(`Unexpected entry in the package root: ${entry.name}`);
		}
		if (entry.isSymbolicLink()) fail(`Symbolic link in the package root: ${entry.name}`);
		if (PAYLOAD_DIRECTORIES.includes(entry.name) && !entry.isDirectory()) {
			fail(`Expected a directory: ${entry.name}`);
		}
	}
	for (const directory of PAYLOAD_DIRECTORIES) {
		const absolute = join(dir, directory);
		if (!existsSync(absolute)) fail(`Missing directory: ${directory}`);
		if (!statSync(absolute).isDirectory()) fail(`Expected a directory: ${directory}`);
		for (const entry of readdirSync(absolute, { withFileTypes: true })) {
			const path = `${directory}/${entry.name}`;
			if (entry.isSymbolicLink()) fail(`Symbolic link in the package: ${path}`);
			if (!entry.isFile()) fail(`Unexpected entry in the package: ${path}`);
			if (!listed.has(path)) fail(`Unlisted file in the package: ${path}`);
			payload.add(path);
		}
	}
	for (const path of listed) {
		if (!payload.has(path)) fail(`Missing file: ${path}`);
	}
	if (manifest.target?.platform !== 'win32') {
		for (const path of [...launcherPaths(manifest.target?.platform), 'runtime/node']) {
			if (!listed.has(path)) fail(`Missing file: ${path}`);
			assertExecutable(dir, path);
		}
	}
}

const CHECKSUM_LINE = /^([0-9a-fA-F]{64}) {2}(.+)$/;

// SHA256SUMS is a strict artifact: one LF-terminated line per payload file, in
// the canonical sorted order that writeManifest() produces. The parser accepts
// uppercase hex because sha256sum -c accepts it, and normalizes it for the
// comparison. Everything else fails with the line number.
function parseChecksumFile(text) {
	if (text.length === 0) fail('SHA256SUMS is empty: the file must list every payload file.');
	if (text.includes('\r')) {
		fail('Invalid SHA256SUMS: the file must use LF line endings, not CR.');
	}
	if (!text.endsWith('\n')) fail('Invalid SHA256SUMS: the file must end with one LF.');
	const entries = new Map();
	const lines = text.slice(0, -1).split('\n');
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const match = CHECKSUM_LINE.exec(line);
		if (!match) {
			fail(
				`Invalid SHA256SUMS line ${index + 1}: expected 64 hex digits, two spaces, and a relative path.`
			);
		}
		const path = match[2];
		const segments = path.split('/');
		if (
			path.startsWith('/') ||
			path.includes('\\') ||
			path.includes('\0') ||
			segments.some((segment) => segment === '' || segment === '.' || segment === '..')
		) {
			fail(`Invalid SHA256SUMS path: ${path}`);
		}
		if (entries.has(path)) fail(`Duplicate SHA256SUMS entry: ${path}`);
		entries.set(path, match[1].toLowerCase());
	}
	return entries;
}

function verifyManifest(dir, manifest, options) {
	if (manifest.schema !== SCHEMA) fail(`Unsupported manifest schema: ${manifest.schema}`);
	const version = packageVersion();
	if (options.expectVersion) {
		if (manifest.version !== options.expectVersion) {
			fail(`Package version ${manifest.version} differs from expected ${options.expectVersion}.`);
		}
	} else if (manifest.version !== version) {
		fail(`Package version ${manifest.version} differs from package.json ${version}.`);
	}
	if (options.expectPlatform && manifest.target?.platform !== options.expectPlatform) {
		fail(
			`Package platform ${manifest.target?.platform} differs from expected ${options.expectPlatform}.`
		);
	}
	if (options.expectArch && manifest.target?.arch !== options.expectArch) {
		fail(
			`Package architecture ${manifest.target?.arch} differs from expected ${options.expectArch}.`
		);
	}
	inspectPayload(dir, manifest);
	const files = manifest.files ?? {};
	const sumsPath = join(dir, 'SHA256SUMS');
	if (!existsSync(sumsPath)) fail(`Missing SHA256SUMS: ${sumsPath}`);
	const sums = parseChecksumFile(readFileSync(sumsPath, 'utf8'));
	const listed = [...sums.keys()];
	for (const path of listed) {
		if (!Object.hasOwn(files, path)) fail(`Unknown file in SHA256SUMS: ${path}`);
	}
	const expected = Object.keys(files).sort();
	const missing = expected.filter((path) => !sums.has(path));
	if (missing.length > 0) fail(`Missing from SHA256SUMS: ${missing.join(', ')}`);
	if (JSON.stringify(listed) !== JSON.stringify(expected)) {
		fail('SHA256SUMS does not list the manifest files in canonical order.');
	}
	for (const path of expected) {
		const record = files[path];
		if (typeof record?.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(record.sha256)) {
			fail(`Invalid manifest checksum for ${path}: expected 64 lowercase hex digits.`);
		}
		if (!Number.isSafeInteger(record.bytes) || record.bytes < 0) {
			fail(`Invalid manifest size for ${path}: expected a non-negative integer.`);
		}
		const absolute = join(dir, path.split('/').join(sep));
		if (!existsSync(absolute)) fail(`Missing file: ${path}`);
		if (sums.get(path) !== record.sha256) {
			fail(`SHA256SUMS digest differs from deckmark-build.json: ${path}`);
		}
		const actual = fileSha(absolute);
		if (actual !== record.sha256) fail(`Hash mismatch: ${path}`);
		const size = statSync(absolute).size;
		if (size !== record.bytes) {
			fail(`Declared size ${record.bytes} differs from the actual size ${size}: ${path}`);
		}
	}
	if (manifest.target.platform === process.platform && manifest.target.arch === process.arch) {
		const node = join(dir, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
		const reported = run(node, ['--version']).stdout.trim().replace(/^v/, '');
		if (reported !== manifest.runtime.nodeVersion) {
			fail(`Runtime version ${reported} differs from manifest ${manifest.runtime.nodeVersion}.`);
		}
	}
	process.stdout.write(
		`pack-cli: verified ${dir} (${manifest.version}, ${manifest.target.platform}-${manifest.target.arch}, source ${manifest.source.gitSha.slice(0, 12)})\n`
	);
}

function verify(options) {
	const dir = resolve(options.dir);
	const manifestPath = join(dir, 'deckmark-build.json');
	if (!existsSync(manifestPath)) fail(`Missing manifest: ${manifestPath}`);
	let manifest;
	try {
		manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
	} catch {
		fail(`Cannot parse manifest: ${manifestPath}`);
	}
	verifyManifest(dir, manifest, options);
}

const invokedDirectly =
	process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
	const options = parseArgs(process.argv.slice(2));
	if (options.command === 'verify') verify(options);
	else await pack(options);
}

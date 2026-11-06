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

import { createHash } from 'node:crypto';
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
import { fileURLToPath } from 'node:url';

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

function runLauncher(stage, name, args) {
	if (process.platform === 'win32') {
		const line = [join(stage, 'bin', `${name}.cmd`), ...args].map(cmdArgument).join(' ');
		return run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', line]);
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
		// this tool built. Replace it with the finished stage.
		rmSync(out, { recursive: true, force: true });
		renameSync(stage, out);

		if (options.archive) {
			const archive = `${out}${process.platform === 'win32' ? '.zip' : '.tar.gz'}`;
			assertArchivePath(archive);
			if (process.platform === 'win32') {
				run('tar.exe', ['-a', '-c', '-f', archive, '-C', parent, basename(out)]);
			} else {
				run('tar', ['-czf', archive, '-C', parent, basename(out)]);
			}
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
	const listed = readFileSync(join(dir, 'SHA256SUMS'), 'utf8')
		.trim()
		.split('\n')
		.filter(Boolean)
		.map((line) => line.slice(66));
	const expected = Object.keys(files).sort();
	if (JSON.stringify(listed) !== JSON.stringify(expected)) {
		fail('SHA256SUMS does not list the manifest files.');
	}
	for (const path of expected) {
		const absolute = join(dir, path.split('/').join(sep));
		if (!existsSync(absolute)) fail(`Missing file: ${path}`);
		const actual = fileSha(absolute);
		if (actual !== files[path].sha256) fail(`Hash mismatch: ${path}`);
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

const options = parseArgs(process.argv.slice(2));
if (options.command === 'verify') verify(options);
else await pack(options);

#!/usr/bin/env node
// Build or verify the installed-user CLI and MCP package.
// The package contains a version-matched Node runtime, the existing CLI bundle,
// the existing MCP source, and small launchers. It adds no service and no
// network listener. It does not sign, publish, or change a release workflow.
//
// Usage:
//   node scripts/pack-cli.mjs --out build/cli-pack [--runtime-node <path>] [--allow-dirty]
//   node scripts/pack-cli.mjs verify --dir build/cli-pack [--expect-version <version>]
//     [--expect-platform <platform>] [--expect-arch <arch>]

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
	copyFileSync,
	createReadStream,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = 'deckmark-cli-install/1';
const MIN_NODE_MAJOR = 22;

function fail(message) {
	process.stderr.write(`pack-cli: ${message}\n`);
	process.exit(1);
}

function usage(message) {
	if (message) process.stderr.write(`pack-cli: ${message}\n`);
	process.stderr.write(
		'Usage: node scripts/pack-cli.mjs --out <dir> [--runtime-node <path>] [--allow-dirty] [--archive]\n' +
			'       node scripts/pack-cli.mjs verify --dir <dir> [--expect-version <version>]\n' +
			'         [--expect-platform <platform>] [--expect-arch <arch>]\n'
	);
	process.exit(2);
}

function parseArgs(argv) {
	const options = {
		command: argv[0] === 'verify' ? 'verify' : 'pack',
		out: 'build/cli-pack',
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

function posixLauncher(libName) {
	return `#!/bin/sh
set -eu

case $0 in
	*/*) self=$0 ;;
	*) self=$(command -v "$0" 2>/dev/null || printf '%s' "$0") ;;
esac
case $self in
	*/*) here=\${self%/*} ;;
	*) here=. ;;
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

function runLauncher(stage, name, args) {
	if (process.platform === 'win32') {
		const launcher = join(stage, 'bin', `${name}.cmd`);
		const line = `"${launcher}" ${args.map((value) => `"${value}"`).join(' ')}`;
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
	const source = sourceIdentity();
	if (source.dirty && !options.allowDirty) {
		fail(
			'The source tree is dirty. Commit the changes or use --allow-dirty for a local test build.'
		);
	}
	const runtime = runtimeIdentity(options.runtimeNode);
	const out = resolve(options.out);
	const parent = dirname(out);
	mkdirSync(parent, { recursive: true });
	const stage = `${out}.stage-${process.pid}`;
	rmSync(stage, { recursive: true, force: true });
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
		writeFileSync(join(stage, 'bin', 'deckmark'), posixLauncher('deckmark.mjs'), { mode: 0o755 });
		writeFileSync(join(stage, 'bin', 'deckmark-mcp'), posixLauncher('deckmark-mcp.mjs'), {
			mode: 0o755
		});
	}
	const runtimeBinary = join(stage, 'runtime', nodeName);
	if (process.platform !== 'win32') run('chmod', ['755', runtimeBinary]);

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

	rmSync(out, { recursive: true, force: true });
	renameSync(stage, out);
	let archive = '';
	if (options.archive) {
		archive = process.platform === 'win32' ? `${out}.zip` : `${out}.tar.gz`;
		rmSync(archive, { force: true });
		if (process.platform === 'win32') {
			run('tar.exe', ['-a', '-c', '-f', archive, '-C', parent, basename(out)]);
		} else {
			run('tar', ['-czf', archive, '-C', parent, basename(out)]);
		}
		process.stdout.write(
			`pack-cli: wrote ${relative(ROOT, archive) || archive} (sha256 ${await sha256File(archive)})\n`
		);
	}
	process.stdout.write(
		`pack-cli: wrote ${relative(ROOT, out) || out} (${manifest.target.platform}-${manifest.target.arch}, Node ${manifest.runtime.nodeVersion}, source ${source.gitSha.slice(0, 12)}${source.dirty ? ', dirty' : ''})\n`
	);
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

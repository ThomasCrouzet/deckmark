#!/usr/bin/env node
// Installed-user proof for the CLI and MCP package.
// The test builds a real package, copies it outside the repository, runs it with
// no Node on PATH, and checks the documented command, protocol, root, and
// cleanup behavior. It writes a JSON evidence file under test-results/.
//
// Run: node --test scripts/pack-cli.test.mjs

import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = join(ROOT, 'test-results', '272-cli-pack');
const CANARY = 'deckmark-test-secret-4f8a1c';
const COMMANDS = [];
const OBSERVED = {};
let installRoot;
let packageRoot;
let archivePath;
let archiveSha256;
let fixtureRoot;
let homeRoot;
let emptyPath;
let manifest;

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

function cli(args, options = {}) {
	return run(
		join(packageRoot, 'bin', process.platform === 'win32' ? 'deckmark.cmd' : 'deckmark'),
		args,
		{
			cwd: fixtureRoot,
			env: installedEnv(),
			...options
		}
	);
}

function mcp(args, input) {
	const node = join(packageRoot, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
	return run(node, [join(packageRoot, 'lib', 'deckmark-mcp.mjs'), ...args], {
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

before(() => {
	mkdirSync(join(ROOT, 'test-results'), { recursive: true });
	rmSync(PACKAGE, { recursive: true, force: true });
	const build = run(
		process.execPath,
		[join(ROOT, 'scripts', 'pack-cli.mjs'), '--out', PACKAGE, '--allow-dirty', '--archive'],
		{ cwd: ROOT, env: process.env }
	);
	assert.equal(build.status, 0, `pack failed:\n${build.stdout}\n${build.stderr}`);
	manifest = JSON.parse(readFileSync(join(PACKAGE, 'deckmark-build.json'), 'utf8'));

	installRoot = mkdtempSync(join(tmpdir(), 'deckmark-install-'));
	const archive = process.platform === 'win32' ? `${PACKAGE}.zip` : `${PACKAGE}.tar.gz`;
	archivePath = archive;
	archiveSha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
	const extract = run('tar', ['-xf', archive, '-C', installRoot], { cwd: ROOT, env: process.env });
	assert.equal(extract.status, 0, `extract failed:\n${extract.stderr}`);
	packageRoot = join(installRoot, basename(PACKAGE));
	homeRoot = join(installRoot, 'home');
	emptyPath = join(installRoot, 'empty-path');
	mkdirSync(homeRoot, { recursive: true });
	mkdirSync(emptyPath, { recursive: true });
	mkdirSync(join(installRoot, 'tmp'), { recursive: true });

	fixtureRoot = join(installRoot, 'project');
	mkdirSync(join(fixtureRoot, 'notes'), { recursive: true });
	writeFileSync(
		join(fixtureRoot, 'notes', 'good.md'),
		'---\ntitle: Installed Note\n---\n\n# Installed Note\n\nHello DeckMark.\n'
	);
	writeFileSync(join(fixtureRoot, 'broken.md'), '# Broken\n\nA [missing target](missing.md).\n');
	mkdirSync(join(installRoot, 'outside'), { recursive: true });
	writeFileSync(join(installRoot, 'outside', 'secret.md'), 'OUTSIDE SECRET\n');
	try {
		symlinkSync(join(installRoot, 'outside', 'secret.md'), join(fixtureRoot, 'notes', 'escape.md'));
	} catch {
		// Windows without symlink privilege uses a missing path for the root test.
	}
});

after(() => {
	if (installRoot) rmSync(installRoot, { recursive: true, force: true });
});

test('package reproduces source identity and passes hash verification', () => {
	assert.equal(manifest.schema, 'deckmark-cli-install/1');
	assert.equal(
		manifest.version,
		JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
	);
	assert.match(manifest.source.gitSha, /^[0-9a-f]{40}$/);
	assert.equal(
		manifest.source.gitSha,
		execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
	);
	assert.ok(Number(manifest.runtime.nodeVersion.split('.')[0]) >= 22);
	assert.equal(manifest.target.platform, process.platform);
	assert.equal(manifest.target.arch, process.arch);

	const verify = run(
		process.execPath,
		[join(ROOT, 'scripts', 'pack-cli.mjs'), 'verify', '--dir', PACKAGE],
		{
			cwd: ROOT,
			env: process.env
		}
	);
	assert.equal(verify.status, 0, verify.stderr);

	const manifestPath = join(PACKAGE, 'deckmark-build.json');
	const original = readFileSync(manifestPath, 'utf8');
	const tampered = JSON.parse(original);
	tampered.version = '0.0.0-tampered';
	writeFileSync(manifestPath, `${JSON.stringify(tampered, null, 2)}\n`);
	const rejected = run(
		process.execPath,
		[join(ROOT, 'scripts', 'pack-cli.mjs'), 'verify', '--dir', PACKAGE],
		{
			cwd: ROOT,
			env: process.env
		}
	);
	writeFileSync(manifestPath, original);
	assert.notEqual(rejected.status, 0);
	assert.match(rejected.stderr, /differs from package\.json/);
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

test('installed MCP initializes, lists tools, reads an approved file, and rejects an escape', () => {
	const approved = mcp(
		['--root', fixtureRoot],
		mcpMessages(
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
				params: { name: 'read_file', arguments: { path: 'notes/escape.md' } }
			}
		)
	);
	assert.equal(approved.status, 0, approved.stderr);
	const lines = approved.stdout
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line));
	assert.equal(lines[0].result.serverInfo.name, 'deckmark-mcp');
	assert.ok(lines[1].result.tools.some((tool) => tool.name === 'read_file'));
	assert.match(lines[2].result.content[0].text, /Hello DeckMark/);
	assert.equal(lines[3].result.isError, true);
	if (existsSync(join(fixtureRoot, 'notes', 'escape.md'))) {
		assert.match(lines[3].result.content[0].text, /outside-root/);
	}
	OBSERVED.mcp = {
		exit: approved.status,
		protocolVersion: lines[0].result.protocolVersion,
		server: lines[0].result.serverInfo,
		tools: lines[1].result.tools.map((tool) => tool.name),
		approvedRead: /Hello DeckMark/.test(lines[2].result.content[0].text),
		escape: lines[3].result.content[0].text
	};
	assert.equal(`${approved.stdout}${approved.stderr}`.includes('OUTSIDE SECRET'), false);
	assert.equal(`${approved.stdout}${approved.stderr}`.includes(CANARY), false);

	const noRoot = mcp([], '');
	assert.notEqual(noRoot.status, 0);
	assert.match(noRoot.stderr, /At least one --root directory is required/);
});

test('concurrent CLI and MCP access leaves project documents unchanged', async () => {
	const cliPath = join(
		packageRoot,
		'bin',
		process.platform === 'win32' ? 'deckmark.cmd' : 'deckmark'
	);
	const node = join(packageRoot, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
	const server = join(packageRoot, 'lib', 'deckmark-mcp.mjs');
	const hashBefore = treeHash(fixtureRoot);
	const args = [
		[
			node,
			[server, '--root', fixtureRoot],
			mcpMessages({
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: { name: 'read_file', arguments: { path: 'notes/good.md' } }
			})
		],
		[cliPath, ['check', 'broken.md', '--json']],
		[cliPath, ['check', '.', '--json']]
	];
	const results = await Promise.all(
		args.map(
			([command, commandArgs, input]) =>
				new Promise((resolveRun) => {
					const child = spawn(command, commandArgs, {
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

test('uninstall removes only the package and keeps documents', () => {
	assert.ok(existsSync(packageRoot));
	rmSync(installRoot, { recursive: true, force: true });
	assert.equal(existsSync(packageRoot), false);
	assert.equal(existsSync(fixtureRoot), false);

	const evidence = {
		schema: 'deckmark-cli-install-evidence/1',
		command: 'node --test scripts/pack-cli.test.mjs',
		sourceSha: manifest.source.gitSha,
		sourceDirty: manifest.source.dirty,
		packageVersion: manifest.version,
		runtime: manifest.runtime,
		target: manifest.target,
		platform: process.platform,
		arch: process.arch,
		node: process.version,
		packagePath: PACKAGE,
		packageArchive: archivePath,
		packageArchiveSha256: archiveSha256,
		packageFiles: manifest.files,
		packageTreeSha256: treeHash(PACKAGE),
		observations: OBSERVED,
		checks: COMMANDS
	};
	writeFileSync(
		join(ROOT, 'test-results', '272-cli-pack-evidence.json'),
		`${JSON.stringify(evidence, null, 2)}\n`
	);
});

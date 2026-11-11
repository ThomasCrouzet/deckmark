import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { classifyChangedPaths } from './ci-security-scope.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'ci-security-scope.mjs');

function runCli(args) {
	return spawnSync(process.execPath, [SCRIPT, ...args], {
		encoding: 'utf8',
		env: { ...process.env, GIT_DIR: '', GIT_WORK_TREE: '' }
	});
}

function withFiles(files) {
	const dir = mkdtempSync(join(tmpdir(), 'ci-security-scope-'));
	const path = join(dir, 'changed-files');
	writeFileSync(path, files.join('\n'));
	return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('Rust and GLib inputs require the Rust audit and scan', () => {
	for (const path of [
		'src-tauri/src/lib.rs',
		'src-tauri/Cargo.lock',
		'patches/glib/variant-str-iter.patch',
		'rust-toolchain.toml',
		'scripts/annotate-cargo-sbom.mjs',
		'scripts/vendor-glib.mjs',
		'Cargo.toml'
	]) {
		const scope = classifyChangedPaths([path]);
		assert.equal(scope.rust, true, path);
		assert.equal(scope.failClosed, false, path);
	}
});

test('Node dependency inputs require the npm audit only', () => {
	for (const path of ['package.json', 'package-lock.json', '.npmrc', '.node-version']) {
		const scope = classifyChangedPaths([path]);
		assert.equal(scope.npm, true, path);
		assert.equal(scope.rust, false, path);
	}
});

test('shared workflow scripts and actions require both audits', () => {
	for (const path of [
		'.github/scripts/configure-ubuntu-apt.sh',
		'.github/actions/setup/action.yml',
		'.github/workflows/security.yml'
	]) {
		const scope = classifyChangedPaths([path]);
		assert.equal(scope.rust, true, path);
		assert.equal(scope.npm, true, path);
	}
});

test('known application and documentation paths need neither audit', () => {
	const scope = classifyChangedPaths([
		'src/lib/storage.ts',
		'e2e/wiki-links.spec.ts',
		'cli/index.ts',
		'docs/CI.md',
		'README.md',
		'scripts/build-edition.mjs',
		'.github/workflows/deploy.yml'
	]);
	assert.equal(scope.rust, false);
	assert.equal(scope.npm, false);
	assert.equal(scope.failClosed, false);
});

test('an unknown top-level path fails closed and requires both audits', () => {
	for (const path of ['new-pipeline/step.yaml', 'new-root.config']) {
		const scope = classifyChangedPaths([path]);
		assert.equal(scope.rust, true, path);
		assert.equal(scope.npm, true, path);
		assert.equal(scope.failClosed, true, path);
	}
});

test('a malformed or escaping path is rejected', () => {
	for (const path of ['../outside', '/absolute/file', 'dir\\file', 'a/../../b', '']) {
		assert.throws(() => classifyChangedPaths([path]), path);
	}
});

test('an empty changed set requests full validation', () => {
	const scope = classifyChangedPaths([]);
	assert.equal(scope.rust, true);
	assert.equal(scope.npm, true);
	assert.equal(scope.failClosed, true);
	assert.match(scope.reason, /empty/);
});

test('the CLI writes GitHub outputs for a scheduled full scan', () => {
	const result = runCli(['--event-name', 'schedule']);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /^rust=true$/m);
	assert.match(result.stdout, /^npm=true$/m);
	assert.match(result.stdout, /^fail_closed=false$/m);
});

test('the CLI classifies a push file list and writes the output file', () => {
	const fixture = withFiles(['src-tauri/Cargo.lock']);
	const output = join(dirname(fixture.path), 'github-output');
	try {
		const result = runCli([
			'--event-name',
			'push',
			'--files',
			fixture.path,
			'--github-output',
			output
		]);
		assert.equal(result.status, 0, result.stderr);
		const written = readFileSync(output, 'utf8');
		assert.match(written, /^rust=true$/m);
		assert.match(written, /^npm=false$/m);
	} finally {
		fixture.cleanup();
	}
});

test('a push or pull request without a file list fails closed', () => {
	for (const event of ['push', 'pull_request']) {
		const result = runCli(['--event-name', event]);
		assert.equal(result.status, 2, `${event}: ${result.stderr}`);
	}
});

test('an unknown event fails closed', () => {
	const result = runCli(['--event-name', 'release']);
	assert.equal(result.status, 2);
	assert.match(result.stderr, /unknown event/i);
});

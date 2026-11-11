import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = readFileSync(join(ROOT, '.github', 'workflows', 'cli-package.yml'), 'utf8');
const NODE_VERSION = readFileSync(join(ROOT, '.node-version'), 'utf8').trim();

function extractAnchoredPaths(text) {
	const lines = text.split('\n');
	const start = lines.findIndex((line) => /^\s*paths: &cli-paths\s*$/.test(line));
	assert.notEqual(start, -1, 'missing anchored CLI path list');
	const indent = lines[start].match(/^\s*/)[0].length;
	const paths = [];
	for (let index = start + 1; index < lines.length; index += 1) {
		const line = lines[index];
		if (line.trim() === '') continue;
		const lineIndent = line.match(/^\s*/)[0].length;
		if (lineIndent <= indent) break;
		const match = line.match(/^\s*-\s*'([^']+)'\s*$/);
		assert.ok(match, `unexpected path entry: ${line}`);
		paths.push(match[1]);
	}
	return paths;
}

test('the pull request and push filters share one complete path list', () => {
	const paths = extractAnchoredPaths(CLI);
	assert.equal((CLI.match(/paths: \*cli-paths/g) ?? []).length, 1);
	assert.deepEqual(paths, [
		'cli/**',
		'bin/deckmark.mjs',
		'bin/deckmark-mcp.mjs',
		'src/lib/**',
		'scripts/build-cli.mjs',
		'scripts/pack-cli.mjs',
		'scripts/pack-cli.test.mjs',
		'scripts/ci-cli*.mjs',
		'package.json',
		'package-lock.json',
		'.node-version',
		'.npmrc',
		'tsconfig.json',
		'.github/scripts/**',
		'.github/actions/**',
		'.github/workflows/cli-package.yml'
	]);
	assert.ok(paths.includes('.github/scripts/**'));
	assert.ok(paths.includes('.github/actions/**'));
	assert.ok(paths.includes('.github/workflows/cli-package.yml'));
});

test('the standalone bundled-runtime contract and installed suite remain', () => {
	assert.match(CLI, /runtime="\$RUNNER_TEMP\/cli-runtime"/);
	assert.match(CLI, /runtime\/bin\/\$binary/);
	assert.match(CLI, /runtime\/LICENSE/);
	assert.match(CLI, /node-version-file: \.node-version/);
	assert.equal(NODE_VERSION, '22');
	assert.match(CLI, /npm ci --legacy-peer-deps/);
	assert.match(CLI, /--test scripts\/pack-cli\.test\.mjs/);
	assert.match(CLI, /scripts\/pack-cli\.mjs verify/);
	assert.match(CLI, /installed-cli/);
	for (const runner of ['ubuntu-24.04', 'windows-2022', 'macos-15']) {
		assert.match(CLI, new RegExp(runner), runner);
	}
});

test('the workflow is callable but has no release, registry, or auth side effect', () => {
	assert.match(CLI, /workflow_call:/);
	assert.doesNotMatch(CLI, /workflow_run|^  release:/m);
	assert.doesNotMatch(CLI, /npm publish|npm login|registry-url|NODE_AUTH_TOKEN|secrets\./);
	assert.doesNotMatch(CLI, /id-token:\s*write|contents:\s*write|packages:\s*write/);
	assert.match(CLI, /permissions:\n  contents: read/);
});

test('only the reusable call uploads release build deliverables', () => {
	const gates = CLI.match(
		/if: github\.event_name == 'workflow_call'[^\n]*\n\s+uses: actions\/upload-artifact@[0-9a-f]{40}/g
	);
	assert.equal((gates ?? []).length, 2);
	assert.match(CLI, /path: test-results\/deckmark-cli-\*\.tar\.gz/);
	assert.match(CLI, /path: test-results\/deckmark-cli-\*\.zip/);
	assert.match(
		CLI,
		/name: deckmark-cli-\$\{\{ github\.sha \}\}-\$\{\{ matrix\.node_platform \}\}-\$\{\{ matrix\.node_arch \}\}/
	);
	assert.match(CLI, /if-no-files-found: error/);
	assert.doesNotMatch(CLI, /upload-sarif/);
});

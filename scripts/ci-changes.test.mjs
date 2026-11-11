// Fail-closed fixtures for the Web change route. A pull request that changes
// only documented files may skip the browser matrix. Every other event, path
// or malformed input must select full validation.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';

const script = resolve(import.meta.dirname, 'ci-changes.mjs');

function invoke({ eventName = 'pull_request', paths = [], args = [] } = {}) {
	const environment = { ...process.env };
	delete environment.GITHUB_EVENT_NAME;
	if (eventName !== null) environment.GITHUB_EVENT_NAME = eventName;
	const cli = [...args];
	if (eventName !== null && !args.includes('--event-name')) {
		cli.push('--event-name', eventName);
	}
	return spawnSync(process.execPath, [script, ...cli], {
		encoding: 'utf8',
		input: paths.length === 0 ? '' : `${paths.join('\0')}\0`,
		env: environment
	});
}

function outputs(result) {
	assert.equal(result.status, 0, result.stderr);
	const lines = result.stdout.trim().split('\n');
	assert.equal(lines.length, 2, 'the script must print one value for each output');
	return Object.fromEntries(lines.map((line) => line.split('=')));
}

function expectRejection(result) {
	assert.notEqual(result.status, 0, 'the classifier must reject this input');
	assert.equal(result.stdout, '', 'a rejected input must not publish a class');
	assert.match(result.stderr, /^ci-changes: /);
}

test('a documentation-only pull request selects the documentation class', () => {
	const single = outputs(invoke({ paths: ['docs/CI.md'] }));
	assert.equal(single.class, 'docs');
	assert.equal(single.reason, 'docs-only:1');

	const several = outputs(
		invoke({ paths: ['CHANGELOG.md', 'docs/testing/split-view.md', 'docs/screenshots/a.webp'] })
	);
	assert.equal(several.class, 'docs');
	assert.equal(several.reason, 'docs-only:3');

	for (const path of [
		'AGENTS.md',
		'ARCHITECTURE.md',
		'CODE_OF_CONDUCT.md',
		'CONTRIBUTING.md',
		'GOVERNANCE.md',
		'LICENSE',
		'README',
		'README.md',
		'README.markdown',
		'README.txt',
		'SECURITY.md',
		'SUPPORT.md',
		'THIRD_PARTY_NOTICES.md',
		'docs/demo.gif',
		'docs/promotion/poster.png'
	]) {
		const result = outputs(invoke({ paths: [path] }));
		assert.equal(result.class, 'docs', path);
	}
});

test('one non-documentation path selects full validation', () => {
	const result = outputs(invoke({ paths: ['docs/CI.md', 'src/lib/editor-state.ts'] }));
	assert.equal(result.class, 'full');
	assert.equal(result.reason, 'full:non-documentation');
});

test('a root documentation name with a sensitive suffix selects full validation', () => {
	for (const path of [
		'README.js',
		'README.sh',
		'README.exe',
		'README.json',
		'README.html',
		'README.md.js',
		'LICENSE.js',
		'SECURITY.ts',
		'CHANGELOG.lock',
		'ARCHITECTURE.ts'
	]) {
		const result = outputs(invoke({ paths: [path] }));
		assert.equal(result.class, 'full', path);
		assert.equal(result.reason, 'full:non-documentation', path);
	}
});

test('runtime, test, workflow and policy paths select full validation', () => {
	for (const path of [
		'package.json',
		'package-lock.json',
		'.node-version',
		'.npmrc',
		'playwright.config.ts',
		'vite.config.ts',
		'svelte.config.js',
		'tsconfig.json',
		'e2e/editor-state.spec.ts',
		'src/lib/editor-state.test.ts',
		'static/icon.png',
		'src-tauri/Cargo.toml',
		'cli/cli.mjs',
		'patches/milkdown.patch',
		'scripts/ci-changes.mjs',
		'scripts/ci-tier.test.mjs',
		'.github/workflows/deploy.yml',
		'.github/ci/playwright-image.json',
		'.github/scripts/configure-ubuntu-apt.sh',
		'.github/ISSUE_TEMPLATE/bug.md',
		'docs/build.mjs',
		'docs/notes.txt/executable',
		'src/README.md',
		'sbom-npm.cdx.json'
	]) {
		const result = outputs(invoke({ paths: [path] }));
		assert.equal(result.class, 'full', path);
		assert.equal(result.reason, 'full:non-documentation', path);
	}
});

test('an unsatisfiable path or an empty change set selects full validation', () => {
	for (const path of [
		'/etc/passwd',
		'docs/../../src/lib/editor-state.ts',
		'docs//CI.md',
		'docs/',
		'..',
		'docs/CI.md\nclass=docs'
	]) {
		const result = outputs(invoke({ paths: [path] }));
		assert.equal(result.class, 'full', JSON.stringify(path));
		assert.equal(result.reason, 'full:non-documentation', JSON.stringify(path));
	}

	const empty = outputs(invoke({ paths: [] }));
	assert.equal(empty.class, 'full');
	assert.equal(empty.reason, 'full:no-paths');
});

test('every event other than pull_request selects full validation', () => {
	for (const eventName of ['push', 'schedule', 'workflow_dispatch', 'workflow_call', 'release']) {
		const result = outputs(invoke({ eventName, paths: ['docs/CI.md'] }));
		assert.equal(result.class, 'full', eventName);
		assert.equal(result.reason, `event:${eventName}`, eventName);
	}
});

test('an unknown event selects full validation instead of the documentation class', () => {
	const result = outputs(invoke({ eventName: 'pull_request_target', paths: ['docs/CI.md'] }));
	assert.equal(result.class, 'full');
	assert.equal(result.reason, 'event:pull_request_target:default-full');
});

test('a missing or malformed event name fails closed', () => {
	expectRejection(invoke({ eventName: null }));
	expectRejection(invoke({ eventName: 'Pull_Request' }));
	expectRejection(invoke({ eventName: '' }));
});

test('an unknown argument fails closed', () => {
	expectRejection(invoke({ paths: ['docs/CI.md'], args: ['--paths', 'docs/CI.md'] }));
	expectRejection(invoke({ paths: ['docs/CI.md'], args: ['docs/CI.md'] }));
});

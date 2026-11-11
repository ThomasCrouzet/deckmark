// Fixtures for the Desktop path filter. A shared frontend, a shared CI helper
// or an action must request native coverage. Documentation and isolated Web
// tests must not.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';
import { needsDesktopValidation } from './desktop-changes.mjs';

const script = resolve(import.meta.dirname, 'desktop-changes.mjs');

function invoke(paths) {
	return spawnSync(process.execPath, [script], {
		encoding: 'utf8',
		input: paths.length === 0 ? '' : `${paths.join('\0')}\0`
	});
}

test('shared frontend, build inputs and shared CI helpers request native coverage', () => {
	for (const path of [
		'src/lib/editor-state.ts',
		'src/routes/+page.svelte',
		'src-tauri/src/lib.rs',
		'static/icon.png',
		'patches/milkdown+7.23.0.patch',
		'scripts/ci-changes.mjs',
		'scripts/desktop-changes.mjs',
		'.github/workflows/desktop.yml',
		'.github/ci/playwright-image.json',
		'.github/actions/setup-node-cache/action.yml',
		'.github/scripts/configure-ubuntu-apt.sh',
		'.node-version',
		'.npmrc',
		'package.json',
		'package-lock.json',
		'rust-toolchain.toml',
		'svelte.config.js',
		'tsconfig.json',
		'vite.config.ts'
	]) {
		assert.equal(needsDesktopValidation([path]), true, path);
	}
});

test('documentation, Web-only tests and unrelated workflows do not request native coverage', () => {
	for (const path of [
		'docs/CI.md',
		'docs/screenshots/a.webp',
		'README.md',
		'CHANGELOG.md',
		'src/lib/editor-state.test.ts',
		'src/lib/editor-state.spec.ts',
		'src/lib/__tests__/editor-state.ts',
		'e2e/editor-state.spec.ts',
		'.github/workflows/deploy.yml',
		'.github/workflows/verify-deployment.yml'
	]) {
		assert.equal(needsDesktopValidation([path]), false, path);
	}
});

test('one requiring path is enough to request native coverage', () => {
	assert.equal(needsDesktopValidation(['docs/CI.md', 'src/lib/editor-state.ts']), true);
	assert.equal(needsDesktopValidation(['docs/CI.md', 'README.md']), false);
	assert.equal(needsDesktopValidation([]), false);
});

test('the CLI prints the routing decision from NUL-separated paths', () => {
	const required = invoke(['scripts/ci-changes.mjs']);
	assert.equal(required.status, 0, required.stderr);
	assert.equal(required.stdout, 'required=true\n');

	const notRequired = invoke(['docs/CI.md']);
	assert.equal(notRequired.status, 0, notRequired.stderr);
	assert.equal(notRequired.stdout, 'required=false\n');

	const empty = invoke([]);
	assert.equal(empty.status, 0, empty.stderr);
	assert.equal(empty.stdout, 'required=false\n');
});

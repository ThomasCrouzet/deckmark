// Fail-closed fixtures for the reusable build gate. This is CI policy, not
// browser behavior: an E2E test cannot prove that a mismatched artifact blocks
// the preview server before a single test runs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';

const script = resolve(import.meta.dirname, 'build-provenance.mjs');
const roots = [];

function git(repository, ...args) {
	return execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
}

function run(repository, ...args) {
	try {
		return {
			status: 0,
			output: execFileSync(process.execPath, [script, ...args], {
				cwd: repository,
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
				// A CI runner exports the workflow commit. The fixture repository
				// has its own commit, so the test must not inherit that value.
				env: { ...process.env, GITHUB_SHA: '' }
			})
		};
	} catch (error) {
		return {
			status: error.status ?? 1,
			output: `${error.stdout ?? ''}${error.stderr ?? ''}`
		};
	}
}

function createRepository() {
	const repository = mkdtempSync(join(tmpdir(), 'deckmark-provenance-'));
	roots.push(repository);
	const files = {
		'package.json': '{"name":"fixture","version":"0.0.0"}\n',
		'package-lock.json': '{"lockfileVersion":3}\n',
		'vite.config.ts': 'export default {};\n',
		'tsconfig.json': '{}\n',
		'scripts/build-edition.mjs': '// fixture\n',
		'scripts/generate-service-worker.mjs': '// fixture\n',
		'scripts/patch-milkdown-images.mjs': '// fixture\n',
		'.github/workflows/deploy.yml': 'name: fixture\n',
		'.github/workflows/desktop.yml': 'name: fixture\n',
		'.gitignore': 'build/\n'
	};
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(join(repository, path, '..'), { recursive: true });
		writeFileSync(join(repository, path), content);
	}
	git(repository, 'init', '--quiet');
	git(repository, 'config', 'user.email', 'fixture@example.invalid');
	git(repository, 'config', 'user.name', 'Fixture');
	git(repository, 'add', '-A');
	git(repository, 'commit', '--quiet', '-m', 'fixture');
	const source = git(repository, 'rev-parse', 'HEAD');
	mkdirSync(join(repository, 'build'), { recursive: true });
	writeFileSync(
		join(repository, 'build', 'edition.json'),
		JSON.stringify({ edition: 'web', version: '0.0.0', sourceSha: source, basePath: '' })
	);
	writeFileSync(join(repository, 'build', 'index.html'), '<!doctype html><title>fixture</title>\n');
	return { repository, source };
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('records and verifies a clean artifact', () => {
	const { repository, source } = createRepository();
	const write = run(repository, 'write', '--kind', 'e2e', '--instrumentation', 'source-fidelity');
	assert.equal(write.status, 0, write.output);
	assert.match(write.output, new RegExp(source));
	const verify = run(repository, 'verify', '--kind', 'e2e', '--instrumentation', 'source-fidelity');
	assert.equal(verify.status, 0, verify.output);
});

test('rejects a tampered build byte', () => {
	const { repository } = createRepository();
	assert.equal(
		run(repository, 'write', '--kind', 'e2e', '--instrumentation', 'source-fidelity').status,
		0
	);
	writeFileSync(join(repository, 'build', 'index.html'), '<!doctype html><title>changed</title>\n');
	const verify = run(repository, 'verify', '--kind', 'e2e', '--instrumentation', 'source-fidelity');
	assert.notEqual(verify.status, 0);
	assert.match(verify.output, /build tree does not match/i);
});

test('rejects a different artifact kind', () => {
	const { repository } = createRepository();
	assert.equal(
		run(repository, 'write', '--kind', 'e2e', '--instrumentation', 'source-fidelity').status,
		0
	);
	const verify = run(
		repository,
		'verify',
		'--kind',
		'web-benchmark',
		'--instrumentation',
		'source-fidelity'
	);
	assert.notEqual(verify.status, 0);
	assert.match(verify.output, /kind/i);
});

test('rejects a dirty working tree when writing', () => {
	const { repository } = createRepository();
	writeFileSync(join(repository, 'untracked.txt'), 'not committed\n');
	const write = run(repository, 'write', '--kind', 'e2e', '--instrumentation', 'source-fidelity');
	assert.notEqual(write.status, 0);
	assert.match(write.output, /dirty working tree/i);
});

test('rejects a changed build input after recording', () => {
	const { repository } = createRepository();
	assert.equal(
		run(repository, 'write', '--kind', 'e2e', '--instrumentation', 'source-fidelity').status,
		0
	);
	writeFileSync(join(repository, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}\n');
	const verify = run(repository, 'verify', '--kind', 'e2e', '--instrumentation', 'source-fidelity');
	assert.notEqual(verify.status, 0);
	assert.match(verify.output, /working tree is dirty|build input changed/i);
});

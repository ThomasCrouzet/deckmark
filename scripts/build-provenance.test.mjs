// Fail-closed fixtures for the reusable build gate. This is CI policy, not
// browser behavior: an E2E test cannot prove that a mismatched artifact blocks
// the preview server before a single test runs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';

const script = resolve(import.meta.dirname, 'build-provenance.mjs');
const roots = [];

// A pre-push hook inherits Git's repository variables. From a linked worktree
// Git exports GIT_DIR, and it can also export a work tree, an index, common and
// object directories, and config injections. An inherited value makes every
// fixture command operate on the caller's repository: `git init` re-initializes
// the hook worktree, writes `core.bare = true` to the shared config, and
// fixture commits land on the real branch.
const INHERITED_GIT_ROUTING = [
	'GIT_DIR',
	'GIT_WORK_TREE',
	'GIT_COMMON_DIR',
	'GIT_INDEX_FILE',
	'GIT_OBJECT_DIRECTORY',
	'GIT_ALTERNATE_OBJECT_DIRECTORIES',
	'GIT_NAMESPACE',
	'GIT_QUARANTINE_PATH',
	'GIT_PREFIX',
	'GIT_SHALLOW_FILE',
	'GIT_GRAFT_FILE',
	'GIT_REPLACE_REF_BASE'
];

// Drop only the variables that select a repository, index, object store or
// config file. Authentication variables such as GIT_ASKPASS and SSH_AUTH_SOCK
// stay in place, so a fixture never loses the caller's credentials.
function fixtureEnvironment(extra = {}) {
	const environment = { ...process.env };
	for (const name of INHERITED_GIT_ROUTING) delete environment[name];
	delete environment.GIT_CONFIG;
	delete environment.GIT_CONFIG_PARAMETERS;
	for (const name of Object.keys(environment)) {
		if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(name)) delete environment[name];
	}
	return { ...environment, ...extra };
}

function git(repository, ...args) {
	return execFileSync('git', args, {
		cwd: repository,
		encoding: 'utf8',
		env: fixtureEnvironment()
	}).trim();
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
				env: fixtureEnvironment({ GITHUB_SHA: '' })
			})
		};
	} catch (error) {
		return {
			status: error.status ?? 1,
			output: `${error.stdout ?? ''}${error.stderr ?? ''}`
		};
	}
}

// The bytes a leaked variable would rewrite. Compare before and after a fixture
// run to prove the caller's repository stayed untouched.
function externalState(repository) {
	const gitDirectory = git(repository, 'rev-parse', '--absolute-git-dir');
	return {
		config: readFileSync(join(gitDirectory, 'config'), 'utf8'),
		head: git(repository, 'rev-parse', 'HEAD'),
		index: createHash('sha256')
			.update(readFileSync(join(gitDirectory, 'index')))
			.digest('hex'),
		refs: git(repository, 'for-each-ref', '--format=%(refname) %(objectname)')
	};
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
	// Fail closed: a fixture repository must own its Git directory. Without this
	// guard an inherited GIT_DIR sends the next commands to another checkout.
	const gitDirectory = git(repository, 'rev-parse', '--absolute-git-dir');
	if (resolve(gitDirectory) !== resolve(repository, '.git')) {
		throw new Error(`Fixture Git resolved ${gitDirectory} instead of ${repository}/.git.`);
	}
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

test('ignores repository variables exported by a pre-push hook', () => {
	// This repository stands in for the caller's checkout. Git variables reach
	// the fixtures through process.env, exactly as a hook would pass them.
	const outside = createRepository();
	const before = externalState(outside.repository);
	const leaked = {
		GIT_DIR: join(outside.repository, '.git'),
		GIT_WORK_TREE: outside.repository,
		GIT_COMMON_DIR: join(outside.repository, '.git'),
		GIT_INDEX_FILE: join(outside.repository, '.git', 'index'),
		GIT_OBJECT_DIRECTORY: join(outside.repository, '.git', 'objects'),
		GIT_ALTERNATE_OBJECT_DIRECTORIES: join(outside.repository, '.git', 'objects'),
		GIT_CONFIG: join(outside.repository, '.git', 'config')
	};
	const saved = new Map(Object.keys(leaked).map((name) => [name, process.env[name]]));
	try {
		for (const [name, value] of Object.entries(leaked)) process.env[name] = value;
		const { repository } = createRepository();
		assert.notEqual(resolve(repository), resolve(outside.repository));
		assert.equal(
			git(repository, 'rev-parse', '--absolute-git-dir'),
			join(resolve(repository), '.git')
		);
		const write = run(repository, 'write', '--kind', 'e2e', '--instrumentation', 'source-fidelity');
		assert.equal(write.status, 0, write.output);
	} finally {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
	assert.deepEqual(externalState(outside.repository), before);
});

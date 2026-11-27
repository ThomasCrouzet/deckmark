// Fixtures for the same-tree proof. Each case builds a real Git history with
// a local origin (base, pull request head, squash merge) and answers the API
// calls from recorded JSON, so every refusal path is proved against Git
// objects and API facts, not against mocked call sequences.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { REQUIREMENTS, missingJobs, proveTree } from './ci-tree-proof.mjs';

const REPOSITORY = 'owner/repo';
const roots = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function gitEnvironment() {
	const environment = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (!name.startsWith('GIT_')) environment[name] = value;
	}
	return {
		...environment,
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_CONFIG_GLOBAL: '/dev/null',
		GIT_AUTHOR_NAME: 'CI fixture',
		GIT_AUTHOR_EMAIL: 'ci@example.invalid',
		GIT_COMMITTER_NAME: 'CI fixture',
		GIT_COMMITTER_EMAIL: 'ci@example.invalid'
	};
}

/**
 * main: base -> (behind) ; pull request head: base -> change ; merges:
 * squash (parent base, head tree), behind (parent behind, head tree) and
 * different (parent base, other tree).
 */
function history() {
	const root = mkdtempSync(join(tmpdir(), 'tree-proof-'));
	roots.push(root);
	const origin = join(root, 'origin.git');
	const work = join(root, 'work');
	const env = gitEnvironment();
	const git = (cwd, ...args) =>
		execFileSync('git', args, {
			cwd,
			env,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe']
		}).trim();
	execFileSync('git', ['init', '-q', '--bare', origin], { env });
	execFileSync('git', ['init', '-q', '-b', 'main', work], { env });
	git(work, 'remote', 'add', 'origin', origin);
	writeFileSync(join(work, 'a.txt'), 'base\n');
	git(work, 'add', '-A');
	git(work, 'commit', '-qm', 'base');
	const base = git(work, 'rev-parse', 'HEAD');
	git(work, 'checkout', '-qb', 'feature');
	writeFileSync(join(work, 'b.txt'), 'change\n');
	git(work, 'add', '-A');
	git(work, 'commit', '-qm', 'fix: change');
	const head = git(work, 'rev-parse', 'HEAD');
	const headTree = git(work, 'rev-parse', 'HEAD^{tree}');
	git(work, 'checkout', '-q', 'main');
	writeFileSync(join(work, 'c.txt'), 'other\n');
	git(work, 'add', '-A');
	git(work, 'commit', '-qm', 'other main change');
	const behind = git(work, 'rev-parse', 'HEAD');
	const otherTree = git(work, 'rev-parse', 'HEAD^{tree}');
	const squash = git(work, 'commit-tree', headTree, '-p', base, '-m', 'fix: change (#7)');
	const behindMerge = git(work, 'commit-tree', headTree, '-p', behind, '-m', 'fix: change (#7)');
	const different = git(work, 'commit-tree', otherTree, '-p', base, '-m', 'fix: change (#7)');
	git(work, 'push', '-q', 'origin', `${head}:refs/pull/7/head`, 'main');
	const runGit = (args) =>
		execFileSync('git', args, {
			cwd: work,
			env,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe']
		});
	return { base, head, squash, behindMerge, different, git: runGit };
}

const deployJobs = (overrides = {}) =>
	[
		'check',
		'e2e',
		'lighthouse',
		'e2e-build',
		'e2e-manifest',
		'e2e-shard (1)',
		'e2e-shard (2)',
		'build (false)',
		'build (/deckmark, true)',
		'fail-fast'
	].map((name) => ({ name, conclusion: overrides[name] ?? 'success' }));

function apiFor({ sha, head, pulls, runs, jobs }) {
	const responses = new Map([
		[
			`repos/${REPOSITORY}/commits/${sha}/pulls?per_page=100`,
			pulls ?? [
				{
					number: 7,
					merged_at: '2026-11-27T10:00:00Z',
					merge_commit_sha: sha,
					base: { ref: 'main', repo: { full_name: REPOSITORY } },
					head: { sha: head, repo: { full_name: REPOSITORY } }
				}
			]
		],
		[
			`repos/${REPOSITORY}/actions/workflows/deploy.yml/runs?event=pull_request&head_sha=${head}&per_page=50`,
			{
				workflow_runs: runs ?? [
					{
						id: 41,
						head_sha: head,
						event: 'pull_request',
						conclusion: 'success',
						created_at: '2026-11-27T09:00:00Z',
						path: '.github/workflows/deploy.yml',
						head_repository: { full_name: REPOSITORY }
					}
				]
			}
		],
		[
			`repos/${REPOSITORY}/actions/runs/41/jobs?filter=latest&per_page=100`,
			{ jobs: jobs ?? deployJobs() }
		]
	]);
	return async (path) => {
		if (!responses.has(path)) throw new Error(`GET ${path}: HTTP 404`);
		return structuredClone(responses.get(path));
	};
}

async function prove(fixture, options = {}) {
	const sha = options.sha ?? fixture.squash;
	return proveTree({
		event: options.event ?? 'push',
		ref: options.ref ?? 'refs/heads/main',
		sha,
		repository: REPOSITORY,
		workflow: 'deploy.yml',
		git: fixture.git,
		api: options.api ?? apiFor({ sha, head: fixture.head, ...options })
	});
}

test('a squash merge of an up-to-date green pull request reuses its run', async () => {
	const fixture = history();
	const result = await prove(fixture);
	assert.equal(result.reuse, true, result.reason);
	assert.equal(result.proofRun, 41);
	assert.equal(result.proofSha, fixture.head);
	assert.equal(result.pull, 7);
});

test('only a push to main can reuse a proof', async () => {
	const fixture = history();
	for (const options of [
		{ event: 'pull_request' },
		{ event: 'workflow_dispatch' },
		{ ref: 'refs/heads/other' }
	]) {
		const result = await prove(fixture, options);
		assert.equal(result.reuse, false, JSON.stringify(options));
		assert.match(result.reason, /not a push to main/);
	}
});

test('a commit without exactly one merged same-repository pull request runs full validation', async () => {
	const fixture = history();
	const pull = (overrides) => ({
		number: 7,
		merged_at: '2026-11-27T10:00:00Z',
		merge_commit_sha: fixture.squash,
		base: { ref: 'main', repo: { full_name: REPOSITORY } },
		head: { sha: fixture.head, repo: { full_name: REPOSITORY } },
		...overrides
	});
	for (const [pulls, pattern] of [
		[[], /0 merged pull requests/],
		[[pull({ merged_at: null })], /0 merged pull requests/],
		[[pull({ merge_commit_sha: fixture.different })], /0 merged pull requests/],
		[[pull(), pull({ number: 8 })], /2 merged pull requests/],
		[[pull({ head: { sha: fixture.head, repo: { full_name: 'fork/repo' } } })], /fork/]
	]) {
		const result = await prove(fixture, { pulls });
		assert.equal(result.reuse, false);
		assert.match(result.reason, pattern);
	}
});

test('the fetched pull request head must equal the API head', async () => {
	const fixture = history();
	const api = apiFor({ sha: fixture.squash, head: fixture.base });
	const result = await prove(fixture, { api });
	assert.equal(result.reuse, false);
	assert.match(result.reason, /refs\/pull\/7\/head is [0-9a-f]{40}, the API reports/);
});

test('a different tree or a BEHIND head runs full validation', async () => {
	const fixture = history();
	const different = await prove(fixture, { sha: fixture.different });
	assert.equal(different.reuse, false);
	assert.match(different.reason, /differs from the head tree/);
	const behind = await prove(fixture, { sha: fixture.behindMerge });
	assert.equal(behind.reuse, false);
	assert.match(behind.reason, /BEHIND/);
});

test('the proof run must be a green same-repository pull request run with every required job', async () => {
	const fixture = history();
	const runBase = {
		id: 41,
		head_sha: fixture.head,
		event: 'pull_request',
		conclusion: 'success',
		created_at: '2026-11-27T09:00:00Z',
		path: '.github/workflows/deploy.yml',
		head_repository: { full_name: REPOSITORY }
	};
	for (const [runs, pattern] of [
		[[], /no successful pull_request run/],
		[[{ ...runBase, conclusion: 'failure' }], /no successful/],
		[[{ ...runBase, head_repository: { full_name: 'fork/repo' } }], /no successful/],
		[[{ ...runBase, path: '.github/workflows/desktop.yml' }], /no successful/],
		[[{ ...runBase, head_sha: fixture.base }], /no successful/]
	]) {
		const result = await prove(fixture, { runs });
		assert.equal(result.reuse, false, JSON.stringify(runs));
		assert.match(result.reason, pattern);
	}
	for (const [jobs, pattern] of [
		[deployJobs({ lighthouse: 'skipped' }), /lighthouse=skipped/],
		[deployJobs({ 'e2e-shard (2)': 'failure' }), /e2e-shard \(2\)=failure/],
		[
			deployJobs().filter((job) => job.name !== 'build (false)'),
			/build \(\* ran 1 times, expected 2/
		],
		[deployJobs().filter((job) => !job.name.startsWith('e2e-shard')), /e2e-shard \(\* did not run/]
	]) {
		const result = await prove(fixture, { jobs });
		assert.equal(result.reuse, false);
		assert.match(result.reason, pattern);
	}
});

test('an API error never selects reuse', async () => {
	const fixture = history();
	const result = await prove(fixture, {
		api: async () => {
			throw new Error('HTTP 502');
		}
	});
	assert.equal(result.reuse, false);
	assert.match(result.reason, /^error: HTTP 502/);
});

test('the Desktop proof requires every native and benchmark matrix row', () => {
	const jobs = [
		'desktop-validation',
		'web-build',
		...['ubuntu-24.04', 'windows-2022', 'macos-15'].flatMap((os) => [
			`validate-desktop (${os})`,
			`native-smoke (${os})`,
			`native-benchmark (${os})`
		]),
		...['chromium', 'firefox', 'webkit'].map((browser) => `web-benchmark (${browser})`)
	].map((name) => ({ name, conclusion: 'success' }));
	assert.deepEqual(missingJobs(jobs, REQUIREMENTS['desktop.yml']), []);
	const old = jobs
		.filter((job) => !job.name.startsWith('native-'))
		.concat({
			name: 'native-validation (macos-15)',
			conclusion: 'success'
		});
	assert.match(
		missingJobs(old, REQUIREMENTS['desktop.yml']).join('; '),
		/native-smoke \(\* did not run/
	);
});

test('the command line writes reuse=false and exits 0 when it cannot prove the tree', () => {
	const root = mkdtempSync(join(tmpdir(), 'tree-proof-cli-'));
	roots.push(root);
	const output = join(root, 'output');
	const result = spawnSync(
		process.execPath,
		[
			resolve(import.meta.dirname, 'ci-tree-proof.mjs'),
			'--event',
			'pull_request',
			'--ref',
			'refs/pull/7/merge',
			'--sha',
			'a'.repeat(40),
			'--repository',
			REPOSITORY,
			'--workflow',
			'deploy.yml',
			'--output',
			output
		],
		{ encoding: 'utf8', env: { ...process.env, GITHUB_API_URL: 'http://127.0.0.1:9' } }
	);
	assert.equal(result.status, 0, result.stderr);
	const values = Object.fromEntries(
		readFileSync(output, 'utf8')
			.trim()
			.split('\n')
			.map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
	);
	assert.equal(values.reuse, 'false');
	assert.equal(values.proof_run, '');
	assert.match(values.reason, /not a push to main/);
});

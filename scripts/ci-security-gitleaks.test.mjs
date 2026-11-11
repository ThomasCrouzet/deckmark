import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = join(ROOT, 'scripts', 'ci-security-gitleaks-range.sh');
const ZERO = '0'.repeat(40);

function sanitizedEnv(home) {
	const env = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith('GIT_')) env[key] = value;
	}
	return {
		...env,
		HOME: home,
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
		GIT_AUTHOR_NAME: 'CI Test',
		GIT_AUTHOR_EMAIL: 'ci@example.invalid',
		GIT_COMMITTER_NAME: 'CI Test',
		GIT_COMMITTER_EMAIL: 'ci@example.invalid',
		GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
		GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z'
	};
}

function git(repo, args, env) {
	const result = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
	assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
	return result.stdout.trim();
}

function commit(repo, env, file, content, message) {
	writeFileSync(join(repo, file), content);
	git(repo, ['add', file], env);
	git(repo, ['commit', '-q', '-m', message], env);
	return git(repo, ['rev-parse', 'HEAD'], env);
}

function runHelper(args, repo, env) {
	return spawnSync('bash', [HELPER, ...args], { cwd: repo, env, encoding: 'utf8' });
}

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), 'ci-gitleaks-range-'));
	const repo = join(dir, 'repo');
	const env = sanitizedEnv(dir);
	spawnSync('git', ['init', '-q', '-b', 'main', repo], { env, encoding: 'utf8' });
	git(repo, ['config', 'user.name', 'CI Test'], env);
	git(repo, ['config', 'user.email', 'ci@example.invalid'], env);
	const first = commit(repo, env, 'note.md', 'first\n', 'first');
	const second = commit(repo, env, 'note.md', 'second\n', 'second');
	const head = commit(repo, env, 'note.md', 'third\n', 'third');
	git(repo, ['checkout', '-q', '--orphan', 'orphan'], env);
	const orphan = commit(repo, env, 'orphan.md', 'orphan\n', 'orphan');
	git(repo, ['checkout', '-q', 'main'], env);
	return {
		repo,
		env,
		first,
		second,
		head,
		orphan,
		cleanup: () => rmSync(dir, { recursive: true, force: true })
	};
}

test('a push scans a reachable before..after range', () => {
	const data = fixture();
	try {
		const result = runHelper(
			['--event', 'push', '--before', data.first, '--head', data.head],
			data.repo,
			data.env
		);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout.trim(), `${data.first}..${data.head}`);
	} finally {
		data.cleanup();
	}
});

test('a push with a new or unreachable before falls back to full history', () => {
	const data = fixture();
	try {
		for (const before of [ZERO, data.orphan, 'not-a-sha', '']) {
			const result = runHelper(
				['--event', 'push', '--before', before, '--head', data.head],
				data.repo,
				data.env
			);
			assert.equal(result.status, 0, `${before}: ${result.stderr}`);
			assert.equal(result.stdout.trim(), '', before);
		}
	} finally {
		data.cleanup();
	}
});

test('a pull request scans only a reachable base..head range', () => {
	const data = fixture();
	try {
		const result = runHelper(
			['--event', 'pull_request', '--base', data.first, '--head', data.head],
			data.repo,
			data.env
		);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout.trim(), `${data.first}..${data.head}`);
	} finally {
		data.cleanup();
	}
});

test('an unavailable or unrelated pull request range fails closed', () => {
	const data = fixture();
	try {
		const cases = [
			['--base', data.orphan, '--head', data.head],
			['--base', 'not-a-sha', '--head', data.head],
			['--base', data.first],
			['--head', data.head]
		];
		for (const args of cases) {
			const result = runHelper(['--event', 'pull_request', ...args], data.repo, data.env);
			assert.equal(result.status, 2, args.join(' '));
			assert.match(result.stderr, /reachable range/i);
		}
	} finally {
		data.cleanup();
	}
});

test('scheduled and manual runs scan full history', () => {
	const data = fixture();
	try {
		for (const event of ['schedule', 'workflow_dispatch']) {
			const result = runHelper(['--event', event], data.repo, data.env);
			assert.equal(result.status, 0, result.stderr);
			assert.equal(result.stdout.trim(), '');
		}
	} finally {
		data.cleanup();
	}
});

test('an unknown event fails closed', () => {
	const data = fixture();
	try {
		const result = runHelper(['--event', 'release'], data.repo, data.env);
		assert.equal(result.status, 2);
		assert.match(result.stderr, /unknown event/i);
	} finally {
		data.cleanup();
	}
});

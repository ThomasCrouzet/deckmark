import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { evaluateWorkflowCondition } from './ci-security-workflow-expression.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SECURITY = readFileSync(join(ROOT, '.github', 'workflows', 'security.yml'), 'utf8');
const GITLEAKS = readFileSync(join(ROOT, '.github', 'workflows', 'gitleaks.yml'), 'utf8');

function jobBlock(text, id) {
	const lines = text.split('\n');
	const start = lines.findIndex((line) => line === `  ${id}:`);
	if (start < 0) throw new Error(`Missing job: ${id}`);
	let end = lines.length;
	for (let index = start + 1; index < lines.length; index += 1) {
		if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[index]) || /^\S/.test(lines[index])) {
			end = index;
			break;
		}
	}
	return lines.slice(start, end).join('\n');
}

function stepRun(job, name) {
	const lines = job.split('\n');
	const nameIndex = lines.findIndex((line) => line.trim() === `- name: ${name}`);
	if (nameIndex < 0) throw new Error(`Missing step: ${name}`);
	let runIndex = -1;
	for (let index = nameIndex + 1; index < lines.length; index += 1) {
		if (/^\s*- name:/.test(lines[index])) break;
		if (/^\s*run: \|\s*$/.test(lines[index])) {
			runIndex = index;
			break;
		}
	}
	if (runIndex < 0) throw new Error(`Missing run block: ${name}`);
	const runIndent = lines[runIndex].match(/^\s*/)[0].length;
	const output = [];
	let contentIndent = null;
	for (let index = runIndex + 1; index < lines.length; index += 1) {
		const line = lines[index];
		if (line.trim() === '') {
			output.push('');
			continue;
		}
		const indent = line.match(/^\s*/)[0].length;
		if (indent <= runIndent) break;
		if (contentIndent === null) contentIndent = indent;
		output.push(line.slice(contentIndent));
	}
	return output.join('\n').replace(/\n+$/, '');
}

function stepIf(job, name) {
	const lines = job.split('\n');
	const nameIndex = lines.findIndex((line) => line.trim() === `- name: ${name}`);
	if (nameIndex < 0) throw new Error(`Missing step: ${name}`);
	for (let index = nameIndex + 1; index < lines.length; index += 1) {
		if (/^\s*- name:/.test(lines[index])) break;
		const match = lines[index].match(/^\s*if:\s*(.+?)\s*$/);
		if (match) return match[1];
	}
	throw new Error(`Missing if: for ${name}`);
}

function runShell(script, env) {
	return spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
		env: { ...process.env, ...env },
		encoding: 'utf8'
	});
}

test('the required security job names remain present', () => {
	assert.match(SECURITY, /^  dependency-review:$/m);
	assert.match(SECURITY, /^  dependency-audit:$/m);
	assert.match(SECURITY, /^    name: codeql \(javascript-typescript, none\)$/m);
	assert.match(SECURITY, /^    name: codeql \(rust, none\)$/m);
	assert.match(GITLEAKS, /^  secrets:$/m);
});

test('the Rust aggregate rejects a failed classifier and a missing scan', () => {
	const aggregate = stepRun(
		jobBlock(SECURITY, 'codeql-rust'),
		'Require Rust analysis when Rust inputs change'
	);
	const healthy = {
		CHANGES_RESULT: 'success',
		ANALYSIS_REQUIRED: 'true',
		ANALYSIS_RESULT: 'success'
	};
	assert.equal(runShell(aggregate, healthy).status, 0);
	assert.equal(
		runShell(aggregate, { ...healthy, ANALYSIS_REQUIRED: 'false', ANALYSIS_RESULT: 'skipped' })
			.status,
		0
	);
	for (const override of [
		{ CHANGES_RESULT: 'failure' },
		{ CHANGES_RESULT: 'skipped' },
		{ ANALYSIS_REQUIRED: 'true', ANALYSIS_RESULT: 'skipped' },
		{ ANALYSIS_REQUIRED: 'true', ANALYSIS_RESULT: 'failure' },
		{ ANALYSIS_REQUIRED: 'false', ANALYSIS_RESULT: 'success' },
		{ ANALYSIS_REQUIRED: '', ANALYSIS_RESULT: '' }
	]) {
		assert.notEqual(runShell(aggregate, { ...healthy, ...override }).status, 0);
	}
});

test('dependency-audit fails closed when the scope job does not succeed', () => {
	const guard = stepRun(jobBlock(SECURITY, 'dependency-audit'), 'Require a valid security scope');
	assert.equal(runShell(guard, { SCOPE_RESULT: 'success' }).status, 0);
	for (const result of ['failure', 'skipped', 'cancelled', '']) {
		assert.notEqual(runShell(guard, { SCOPE_RESULT: result }).status, 0, result);
	}
});

test('the required dependency-audit job is not skipped by a failed classifier', () => {
	const job = jobBlock(SECURITY, 'dependency-audit');
	assert.match(job, /needs: security-scope/);
	assert.match(job, /if: always\(\)/);
	assert.match(job, /node-version-file: \.node-version/);
	assert.doesNotMatch(job, /node-version: 22/);
});

test('the security scope job uses the classified change set', () => {
	const job = jobBlock(SECURITY, 'security-scope');
	assert.match(job, /fetch-depth: 0/);
	assert.match(job, /scripts\/ci-security-scope\.mjs/);
	assert.match(job, /--github-output/);
	assert.match(SECURITY, /if: needs\.security-scope\.outputs\.rust == 'true'/);
});

test('the Rust CodeQL job uses the supported no-build mode without a full build', () => {
	const job = jobBlock(SECURITY, 'codeql-rust-scan');
	assert.match(job, /languages: rust/);
	assert.match(job, /build-mode: none/);
	assert.doesNotMatch(job, /^\s*- name: Build Rust$/m);
	assert.doesNotMatch(job, /^\s*run:\s*cargo build/m);
	assert.match(job, /rust-toolchain|Setup Rust/);
});

test('CodeQL analysis stays local and is not treated as findings acceptance', () => {
	assert.equal((SECURITY.match(/upload: never/g) ?? []).length, 2);
	assert.equal((SECURITY.match(/upload-database: false/g) ?? []).length, 2);
	assert.doesNotMatch(SECURITY, /upload-sarif|upload-artifact|security-events:\s*write/);
});

test('the secret scan keeps the secrets job, weekly full scan, and no credentials', () => {
	assert.match(GITLEAKS, /fetch-depth: 0/);
	assert.match(GITLEAKS, /persist-credentials: false/);
	assert.match(GITLEAKS, /cron:/);
	assert.match(GITLEAKS, /scripts\/ci-security-gitleaks-range\.sh/);
	assert.doesNotMatch(GITLEAKS, /upload-artifact|upload-sarif|security-events:\s*write/);
	assert.doesNotMatch(GITLEAKS, /secrets\.[A-Za-z]|NODE_AUTH_TOKEN|GITHUB_TOKEN/);
});

function sanitizedGitEnv(home) {
	const env = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith('GIT_')) env[key] = value;
	}
	return {
		...env,
		HOME: home,
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_AUTHOR_NAME: 'CI Test',
		GIT_AUTHOR_EMAIL: 'ci@example.invalid',
		GIT_COMMITTER_NAME: 'CI Test',
		GIT_COMMITTER_EMAIL: 'ci@example.invalid'
	};
}

function git(repo, args, env) {
	const result = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
	assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
	return result.stdout.trim();
}

function commit(repo, env, file, content, message) {
	const path = join(repo, file);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
	git(repo, ['add', file], env);
	git(repo, ['commit', '-q', '-m', message], env);
	return git(repo, ['rev-parse', 'HEAD'], env);
}

function repositoryFixture(commits) {
	const dir = mkdtempSync(join(tmpdir(), 'ci-security-scope-workflow-'));
	const repo = join(dir, 'repo');
	const env = sanitizedGitEnv(dir);
	mkdirSync(join(repo, 'scripts'), { recursive: true });
	copyFileSync(
		join(ROOT, 'scripts', 'ci-security-scope.mjs'),
		join(repo, 'scripts', 'ci-security-scope.mjs')
	);
	spawnSync('git', ['init', '-q', '-b', 'main', repo], { env, encoding: 'utf8' });
	git(repo, ['config', 'user.name', 'CI Test'], env);
	git(repo, ['config', 'user.email', 'ci@example.invalid'], env);
	const shas = commits.map(([file, content, message]) => commit(repo, env, file, content, message));
	return {
		dir,
		repo,
		env,
		shas,
		cleanup: () => rmSync(dir, { recursive: true, force: true })
	};
}

function scopeFixture() {
	const data = repositoryFixture([
		['docs/CI.md', 'first\n', 'first'],
		['src-tauri/Cargo.lock', 'lock\n', 'second']
	]);
	return { ...data, first: data.shas[0], head: data.shas[1] };
}

function runScopeStep(script, repo, env, overrides) {
	const runnerTemp = mkdtempSync(join(tmpdir(), 'ci-security-runner-'));
	const output = join(runnerTemp, 'github-output');
	writeFileSync(output, '');
	const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
		cwd: repo,
		env: {
			...env,
			RUNNER_TEMP: runnerTemp,
			GITHUB_OUTPUT: output,
			...overrides
		},
		encoding: 'utf8'
	});
	const written = readFileSync(output, 'utf8');
	rmSync(runnerTemp, { recursive: true, force: true });
	return { result, written };
}

test('the security scope shell scopes a real push and falls back to full checks', () => {
	const script = stepRun(jobBlock(SECURITY, 'security-scope'), 'Detect security inputs');
	const data = scopeFixture();
	try {
		const scoped = runScopeStep(script, data.repo, data.env, {
			EVENT_NAME: 'push',
			BEFORE_SHA: data.first,
			BASE_SHA: '',
			HEAD_SHA: data.head
		});
		assert.equal(scoped.result.status, 0, scoped.result.stderr);
		assert.match(scoped.written, /^rust=true$/m);
		assert.match(scoped.written, /^npm=false$/m);

		for (const overrides of [
			{ EVENT_NAME: 'push', BEFORE_SHA: '0'.repeat(40), HEAD_SHA: data.head },
			{ EVENT_NAME: 'push', BEFORE_SHA: data.head, HEAD_SHA: data.head },
			{ EVENT_NAME: 'schedule', HEAD_SHA: data.head }
		]) {
			const fallback = runScopeStep(script, data.repo, data.env, overrides);
			assert.equal(fallback.result.status, 0, fallback.result.stderr);
			assert.match(fallback.written, /^rust=true$/m, overrides.EVENT_NAME);
			assert.match(fallback.written, /^npm=true$/m, overrides.EVENT_NAME);
		}

		const pullRequest = runScopeStep(script, data.repo, data.env, {
			EVENT_NAME: 'pull_request',
			BEFORE_SHA: '',
			BASE_SHA: data.first,
			HEAD_SHA: data.head
		});
		assert.equal(pullRequest.result.status, 0, pullRequest.result.stderr);
		assert.match(pullRequest.written, /^rust=true$/m);
	} finally {
		data.cleanup();
	}
});

test('a change to the audit wrapper alone requests and runs the audit', () => {
	// The wrapper is a security control. A diff that changes only the wrapper
	// must request both audits, and the audit steps must then execute. The test
	// never accepts a changed wrapper as a passing audit without a run.
	const script = stepRun(jobBlock(SECURITY, 'security-scope'), 'Detect security inputs');
	const data = repositoryFixture([
		['docs/CI.md', 'first\n', 'first'],
		['scripts/ci-security-cargo-audit.sh', '#!/usr/bin/env bash\nexit 1\n', 'weaken the wrapper']
	]);
	try {
		const scoped = runScopeStep(script, data.repo, data.env, {
			EVENT_NAME: 'push',
			BEFORE_SHA: data.shas[0],
			BASE_SHA: '',
			HEAD_SHA: data.shas[1]
		});
		assert.equal(scoped.result.status, 0, scoped.result.stderr);
		assert.match(scoped.written, /^rust=true$/m);
		assert.match(scoped.written, /^npm=true$/m);
		assert.doesNotMatch(scoped.written, /^fail_closed=true$/m);

		const job = jobBlock(SECURITY, 'dependency-audit');
		const scope = {
			'security-scope': { result: 'success', outputs: { rust: 'true', npm: 'true' } }
		};
		for (const step of ['Ensure the pinned cargo-audit', 'Audit Cargo.lock']) {
			const gate = stepIf(job, step);
			assert.equal(evaluateWorkflowCondition(gate, { needs: scope }), true, step);
		}
		assert.doesNotMatch(job, /continue-on-error|if:\s*false/);

		// A change set without a security input still skips the Rust steps, so
		// the gate keeps its cost bound.
		assert.equal(
			evaluateWorkflowCondition(stepIf(job, 'Audit Cargo.lock'), {
				needs: {
					'security-scope': { result: 'success', outputs: { rust: 'false', npm: 'false' } }
				}
			}),
			false
		);
	} finally {
		data.cleanup();
	}
});

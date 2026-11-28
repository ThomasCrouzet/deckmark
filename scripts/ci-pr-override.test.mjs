// Fixtures for the release-please override convention. The cases are the
// defects of earlier releases: a Refs footer printed as "closes", a `deps:`
// entry merged into the previous line, a missing block, and a fix that
// reached main with no changelog entry.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { checkOverride, headerKey, renderOverride } from './ci-pr-override.mjs';

const script = resolve(import.meta.dirname, 'ci-pr-override.mjs');
const roots = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const commit = (message, sha = 'a'.repeat(40)) => ({ sha, message });
const block = (...entries) => `BEGIN_COMMIT_OVERRIDE\n${entries.join('\n\n')}\nEND_COMMIT_OVERRIDE`;

test('the printed block has one entry per commit and moves issue footers into the header', () => {
	const text = renderOverride([
		commit('fix(editor): keep typed text at the caret\n\nEvidence.\n\nFixes #769'),
		commit('perf(editor): scope the Enter split publication.\n\nRefs #628, #631'),
		commit('deps: update the npm group'),
		commit('Merge branch x'),
		commit('fix(editor): keep typed text at the caret (#769)'),
		commit('feat(cli)!: rename the list command\n\nBREAKING CHANGE: the old name is gone.')
	]);
	assert.equal(
		text,
		[
			'Closes #769',
			'',
			'BEGIN_COMMIT_OVERRIDE',
			'fix(editor): keep typed text at the caret (#769)',
			'',
			'perf(editor): scope the Enter split publication (#628, #631)',
			'',
			'build(deps): update the npm group',
			'',
			'feat(cli)!: rename the list command',
			'BREAKING-CHANGE: the old name is gone.',
			'END_COMMIT_OVERRIDE',
			''
		].join('\n')
	);
	assert.deepEqual(checkOverride(text, []), []);
});

test('a valid block with free sections and closing lines outside it passes', () => {
	const body = [
		'## Summary',
		'Batch of fixes.',
		'',
		'Closes #769',
		'Related to #628.',
		'',
		block(
			'fix(editor): keep typed text at the caret (#769)\nBody line that stays out of the changelog.',
			'ci: rebalance the e2e shards'
		)
	].join('\r\n');
	assert.deepEqual(checkOverride(body, [commit('fix(editor): keep typed text at the caret')]), []);
});

test('a missing, repeated, reversed or empty block fails', () => {
	assert.match(checkOverride('## Summary', [])[0], /no BEGIN_COMMIT_OVERRIDE block/);
	assert.match(checkOverride(`${block('fix: a')}\n${block('fix: b')}`, [])[0], /exactly one/);
	assert.match(
		checkOverride('END_COMMIT_OVERRIDE\nfix: a\nBEGIN_COMMIT_OVERRIDE', [])[0],
		/comes before/
	);
	assert.match(checkOverride(block(''), [])[0], /empty/);
	assert.match(checkOverride(undefined, [])[0], /no BEGIN_COMMIT_OVERRIDE block/);
});

test('every entry must be a conventional header and never deps', () => {
	assert.match(
		checkOverride(block('Update the editor'), []).join('\n'),
		/must start with a conventional header/
	);
	assert.match(
		checkOverride(block('fix: a', 'deps: bump x'), []).join('\n'),
		/deps is not a release-please type/
	);
	assert.match(
		checkOverride(block('fix: a\nfix: b'), []).join('\n'),
		/needs a blank line before it/
	);
	assert.match(checkOverride(block('fix: a', ' fix: b'), []).join('\n'), /line start/);
	assert.match(checkOverride(block('fixes: a'), []).join('\n'), /conventional header/);
});

test('a reference inside the block fails because release-please prints it as closes', () => {
	for (const line of [
		'Refs #769',
		'Closes #769',
		'Fixes: owner/repo#12',
		'See #1',
		'Related to #628',
		'after #780 landed'
	]) {
		const problems = checkOverride(block(`fix(editor): a\n${line}`), []);
		assert.match(problems.join('\n'), /prints it as "closes"/, line);
	}
	const paragraph = checkOverride(block('fix(editor): a', 'Second paragraph that names #4.'), []);
	assert.match(paragraph.join('\n'), /prints it as "closes"/);
	assert.deepEqual(checkOverride(block('fix(editor): a (#769)'), []), []);
});

test('a breaking entry needs its BREAKING-CHANGE line', () => {
	assert.match(checkOverride(block('feat(cli)!: rename'), []).join('\n'), /BREAKING-CHANGE/);
	assert.deepEqual(
		checkOverride(block('feat(cli)!: rename\nBREAKING-CHANGE: the old name is gone.'), []),
		[]
	);
});

test('every releasable branch commit needs an entry with the same header', () => {
	const commits = [
		commit('fix(editor): keep the caret\n\nFixes review finding DATA-02', 'b'.repeat(40)),
		commit('feat(cli): add list', 'c'.repeat(40)),
		commit('ci: rebalance shards', 'd'.repeat(40)),
		commit('docs: explain', 'e'.repeat(40)),
		commit('refactor(core)!: drop the old API', 'f'.repeat(40))
	];
	const problems = checkOverride(block('fix(editor): keep the caret (#769)'), commits);
	assert.equal(problems.length, 2, problems.join('\n'));
	assert.match(problems[0], /ccccccc "feat\(cli\): add list" has no entry/);
	assert.match(problems[1], /fffffff "refactor\(core\)!: drop the old API" has no entry/);
	assert.equal(headerKey('Fix(editor)!: Keep  the caret. '), 'fix(editor): keep the caret');
	assert.equal(headerKey('fix(editor): keep the caret (#1, #2)'), 'fix(editor): keep the caret');
});

test('the command line checks PR_BODY against the real branch commits', () => {
	const root = mkdtempSync(join(tmpdir(), 'pr-override-'));
	roots.push(root);
	// Drop inherited GIT_* state. A Git hook sets GIT_DIR and GIT_INDEX_FILE,
	// and the fixture commands would then write to the real repository.
	const env = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
	for (const [name, value] of Object.entries(process.env)) {
		if (!name.startsWith('GIT_')) env[name] = value;
	}
	const git = (...args) =>
		execFileSync(
			'git',
			['-C', root, '-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', ...args],
			{
				env,
				encoding: 'utf8'
			}
		).trim();
	git('init', '-q', '-b', 'main');
	writeFileSync(join(root, 'a.txt'), 'a\n');
	git('add', '-A');
	git('commit', '-qm', 'chore: base');
	const base = git('rev-parse', 'HEAD');
	writeFileSync(join(root, 'a.txt'), 'b\n');
	git('commit', '-qam', 'fix(editor): keep the caret\n\nRefs #769');
	const run = (mode, body) =>
		spawnSync(process.execPath, [script, mode, '--base', base, '--head', 'HEAD'], {
			cwd: root,
			env: body === undefined ? env : { ...env, PR_BODY: body },
			encoding: 'utf8'
		});
	const printed = run('print');
	assert.equal(printed.status, 0, printed.stderr);
	assert.match(
		printed.stdout,
		/^BEGIN_COMMIT_OVERRIDE\nfix\(editor\): keep the caret \(#769\)\nEND_COMMIT_OVERRIDE\n$/
	);
	const valid = run('check', `## Summary\n\n${printed.stdout}`);
	assert.equal(valid.status, 0, valid.stderr);
	const invalid = run('check', block('ci: other'));
	assert.equal(invalid.status, 1);
	assert.match(
		invalid.stderr,
		/::error::Releasable commit [0-9a-f]{7} "fix\(editor\): keep the caret" has no entry/
	);
	const unset = run('check');
	assert.equal(unset.status, 2);
	assert.match(unset.stderr, /PR_BODY is not set/);
});

test('the pull request template carries one block that the check refuses until edited', () => {
	const template = readFileSync(
		new URL('../.github/PULL_REQUEST_TEMPLATE.md', import.meta.url),
		'utf8'
	);
	assert.equal(template.split('BEGIN_COMMIT_OVERRIDE').length - 1, 1);
	assert.equal(template.split('END_COMMIT_OVERRIDE').length - 1, 1);
	assert.notDeepEqual(checkOverride(template, []), [], 'the placeholder is not a valid entry');
});

test('the pr-body workflow reads the body from the environment and skips release pull requests', async () => {
	const { load } = await import('js-yaml');
	const workflow = load(
		readFileSync(new URL('../.github/workflows/pr-body.yml', import.meta.url), 'utf8')
	);
	assert.deepEqual(workflow.on.pull_request.branches, ['main']);
	for (const type of ['opened', 'edited', 'synchronize', 'reopened', 'ready_for_review']) {
		assert.ok(workflow.on.pull_request.types.includes(type), type);
	}
	assert.deepEqual(workflow.permissions, { contents: 'read' });
	const job = workflow.jobs['pr-body'];
	assert.match(job.if, /!startsWith\(github\.head_ref, 'release-please--'\)/);
	const check = job.steps.find((step) => /ci-pr-override\.mjs check/.test(step.run ?? ''));
	assert.equal(check.env.PR_BODY, '${{ github.event.pull_request.body }}');
	assert.doesNotMatch(check.run, /github\.event/, 'no event text inside the run script');
	const text = JSON.stringify(job.steps);
	assert.doesNotMatch(text, /npm (ci|install)/, 'the check installs no dependency');
});

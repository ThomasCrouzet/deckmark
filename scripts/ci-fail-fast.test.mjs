// Fixtures for the cross-workflow fail-fast sentinel. The script runs with a
// `gh` stub on PATH that serves recorded API JSON and records every cancel
// request, so each case proves which runs the sentinel cancels and which it
// leaves alone.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';

const script = resolve(import.meta.dirname, 'ci-fail-fast.sh');
const SHA = 'a'.repeat(40);
const SELF = 100;
const roots = [];

const STUB = `#!/usr/bin/env bash
dir="$GH_STUB_DIR"
printf '%s\\n' "$*" >> "$dir/calls"
if [ "$1" = api ] && [ "$2" = -X ]; then
  id=$(printf '%s' "$4" | sed -E 's#.*/runs/([0-9]+)/cancel$#\\1#')
  printf '%s\\n' "$id" >> "$dir/cancelled"
  exit 0
fi
path="$2"
case "$path" in
  */jobs\\?*) id=\${path#*/runs/}; id=\${id%%/*}; file="$dir/jobs-$id.json" ;;
  *runs\\?*) file="$dir/runs.json" ;;
  */runs/*) file="$dir/run-\${path##*/}.json" ;;
  *) file='' ;;
esac
if [ -z "$file" ] || [ ! -f "$file" ]; then echo 'HTTP 500' >&2; exit 1; fi
cat "$file"
`;

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const at = (minutes) =>
	new Date(Date.UTC(2026, 10, 27, 10, minutes)).toISOString().replace('.000', '');

function run(id, path, status = 'in_progress', created = at(0)) {
	return {
		id,
		status,
		path: `.github/workflows/${path}`,
		name: path.replace('.yml', ''),
		created_at: created
	};
}

function job(name, status = 'in_progress', conclusion = null, completed = null) {
	return {
		name,
		status,
		conclusion,
		html_url: `https://github.com/x/y/actions/runs/1/job/${name.length}`,
		completed_at: completed
	};
}

/**
 * @param {{ runs: object[], jobs: Record<number, object[]>, own?: object, omit?: string[] }} fixture
 */
function sentinel(fixture) {
	const root = mkdtempSync(join(tmpdir(), 'fail-fast-'));
	roots.push(root);
	const bin = join(root, 'bin');
	const data = join(root, 'data');
	mkdirSync(bin);
	mkdirSync(data);
	writeFileSync(join(bin, 'gh'), STUB);
	chmodSync(join(bin, 'gh'), 0o755);
	const own = fixture.own ?? { id: SELF, created_at: at(0), run_attempt: 1, run_started_at: at(0) };
	if (!fixture.omit?.includes('own'))
		writeFileSync(join(data, `run-${SELF}.json`), JSON.stringify(own));
	if (!fixture.omit?.includes('runs')) {
		writeFileSync(join(data, 'runs.json'), JSON.stringify({ workflow_runs: fixture.runs }));
	}
	for (const [id, jobs] of Object.entries(fixture.jobs)) {
		writeFileSync(join(data, `jobs-${id}.json`), JSON.stringify({ jobs }));
	}
	const result = spawnSync('bash', [script], {
		encoding: 'utf8',
		env: {
			...process.env,
			PATH: `${bin}:${process.env.PATH}`,
			GH_STUB_DIR: data,
			GH_TOKEN: 'stub',
			REPOSITORY: 'owner/repo',
			HEAD_SHA: SHA,
			EVENT_NAME: 'pull_request',
			SELF_RUN_ID: String(SELF),
			POLL_SECONDS: '0',
			DEADLINE_SECONDS: '5',
			SELF_CANCEL_WAIT_SECONDS: '0',
			API_RETRY_SECONDS: '0'
		},
		timeout: 20_000
	});
	const cancelledPath = join(data, 'cancelled');
	const cancelled = existsSync(cancelledPath)
		? readFileSync(cancelledPath, 'utf8').trim().split('\n').map(Number)
		: [];
	const callsPath = join(data, 'calls');
	const calls = existsSync(callsPath) ? readFileSync(callsPath, 'utf8') : '';
	return { ...result, output: `${result.stdout}${result.stderr}`, cancelled, calls };
}

const webRun = (status = 'in_progress') => run(SELF, 'deploy.yml', status);

test('no failure: the sentinel exits when every run is complete and cancels nothing', () => {
	const result = sentinel({
		runs: [webRun(), run(200, 'desktop.yml', 'completed'), run(300, 'security.yml', 'completed')],
		jobs: {
			[SELF]: [
				job('fail-fast'),
				job('check', 'completed', 'success'),
				job('e2e', 'completed', 'success')
			],
			200: [job('desktop-validation', 'completed', 'success')],
			300: [job('dependency-audit', 'completed', 'success')]
		}
	});
	assert.equal(result.status, 0, result.output);
	assert.match(result.output, /No job failed/);
	assert.deepEqual(result.cancelled, []);
});

test('a failure in the own run cancels the other open runs, then the own run last', () => {
	const result = sentinel({
		runs: [
			webRun(),
			run(200, 'desktop.yml'),
			run(300, 'security.yml'),
			run(400, 'gitleaks.yml', 'completed')
		],
		jobs: {
			[SELF]: [
				job('fail-fast'),
				job('e2e-shard (3)', 'completed', 'failure', at(5)),
				job('e2e-shard (4)')
			],
			200: [job('native-benchmark (macos-15)')],
			300: [job('codeql (javascript-typescript, none)')],
			400: [job('secrets', 'completed', 'success')]
		}
	});
	assert.equal(result.status, 0, result.output);
	assert.match(
		result.output,
		/::error::fail-fast: deploy \/ e2e-shard \(3\) \(https:[^)]+\) failed/
	);
	assert.deepEqual(result.cancelled.slice(0, 2).sort(), [200, 300]);
	assert.equal(result.cancelled.at(-1), SELF, 'the own run is cancelled last');
	assert.ok(!result.cancelled.includes(400), 'a completed run is not cancelled');
});

test('a failure in another workflow cancels the Web run', () => {
	const result = sentinel({
		runs: [webRun(), run(200, 'desktop.yml'), run(300, 'security.yml')],
		jobs: {
			[SELF]: [job('fail-fast'), job('e2e-shard (1)')],
			200: [
				job('web-benchmark (chromium)', 'completed', 'failure', at(6)),
				job('native-smoke (macos-15)')
			],
			300: [job('dependency-review', 'completed', 'success')]
		}
	});
	assert.match(result.output, /desktop \/ web-benchmark \(chromium\) \(https:[^)]+\) failed/);
	assert.deepEqual(result.cancelled.slice(0, 2).sort(), [200, 300]);
	assert.equal(result.cancelled.at(-1), SELF);
});

test('an aggregate failure is not a cause', () => {
	const result = sentinel({
		runs: [webRun(), run(200, 'desktop.yml', 'completed'), run(300, 'security.yml', 'completed')],
		jobs: {
			[SELF]: [
				job('fail-fast'),
				job('e2e', 'completed', 'failure', at(3)),
				job('check', 'completed', 'failure', at(3))
			],
			200: [job('desktop-validation', 'completed', 'failure', at(3))],
			300: [job('codeql (rust, none)', 'completed', 'failure', at(3))]
		}
	});
	assert.equal(result.status, 0, result.output);
	assert.deepEqual(result.cancelled, []);
	assert.match(result.output, /No job failed/);
});

test('a run that is publishing is never cancelled', () => {
	const result = sentinel({
		runs: [webRun(), run(200, 'desktop.yml'), run(300, 'security.yml')],
		jobs: {
			[SELF]: [job('fail-fast'), job('deploy', 'in_progress')],
			200: [
				job('release-please', 'completed', 'success'),
				job('build-desktop (macos-15, dmg, --bundles dmg)')
			],
			300: [
				job('dependency-audit', 'completed', 'failure', at(4)),
				job('codeql (javascript-typescript, none)')
			]
		}
	});
	assert.match(result.output, /security \/ dependency-audit \(https:[^)]+\) failed/);
	assert.match(result.output, /run 100 \(deploy\) is publishing/);
	assert.match(result.output, /run 200 \(desktop\) is publishing/);
	assert.deepEqual(result.cancelled, [300]);
});

test('an API error stops the sentinel with a warning and a zero exit', () => {
	for (const omit of ['own', 'runs']) {
		const result = sentinel({
			runs: [webRun()],
			jobs: { [SELF]: [job('fail-fast')] },
			omit: [omit]
		});
		assert.equal(result.status, 0, result.output);
		assert.match(result.output, /::warning::fail-fast: the GitHub API did not answer/);
		assert.deepEqual(result.cancelled, []);
	}
	const jobs = sentinel({
		runs: [webRun(), run(200, 'desktop.yml')],
		jobs: { [SELF]: [job('fail-fast')] }
	});
	assert.equal(jobs.status, 0);
	assert.match(jobs.output, /jobs of run 200/);
});

test('a run of an earlier event on the same commit is ignored', () => {
	const result = sentinel({
		runs: [webRun('completed'), run(200, 'desktop.yml', 'completed', '2026-11-27T08:00:00Z')],
		jobs: {
			[SELF]: [job('fail-fast'), job('check', 'completed', 'success')],
			200: [job('validate-desktop (macos-15)', 'completed', 'failure', '2026-11-27T08:10:00Z')]
		}
	});
	assert.deepEqual(result.cancelled, []);
	assert.match(result.output, /No job failed/);
});

test('a re-run attempt ignores a failure that completed before the attempt started', () => {
	const own = { id: SELF, created_at: at(0), run_attempt: 2, run_started_at: at(30) };
	const old = sentinel({
		own,
		runs: [webRun(), run(200, 'desktop.yml', 'completed')],
		jobs: {
			[SELF]: [job('fail-fast'), job('check', 'completed', 'success')],
			200: [job('web-benchmark (chromium)', 'completed', 'failure', at(10))]
		}
	});
	assert.deepEqual(old.cancelled, []);
	const fresh = sentinel({
		own,
		runs: [webRun(), run(200, 'desktop.yml')],
		jobs: {
			[SELF]: [job('fail-fast'), job('e2e-shard (2)', 'completed', 'failure', at(35))],
			200: [job('web-benchmark (chromium)')]
		}
	});
	assert.deepEqual(fresh.cancelled, [200, SELF]);
});

test('the pr-body workflow neither triggers nor receives a cancellation', () => {
	const result = sentinel({
		runs: [webRun('completed'), run(500, 'pr-body.yml', 'in_progress')],
		jobs: {
			[SELF]: [job('fail-fast'), job('check', 'completed', 'success')],
			500: [job('pr-body', 'completed', 'failure', at(1))]
		}
	});
	assert.deepEqual(result.cancelled, []);
	assert.doesNotMatch(result.calls, /runs\/500\/jobs/);
});

test('the workflow runs the sentinel alone with actions: write and no project code', async () => {
	const { load } = await import('js-yaml');
	const workflow = load(
		readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8')
	);
	const jobs = Object.entries(workflow.jobs);
	const writers = jobs
		.filter(([, value]) => value.permissions?.actions === 'write')
		.map(([name]) => name);
	assert.deepEqual(writers, ['fail-fast'], 'only the sentinel can cancel runs');
	const sentinelJob = workflow.jobs['fail-fast'];
	assert.deepEqual(sentinelJob.permissions, { actions: 'write', contents: 'read' });
	assert.deepEqual(sentinelJob.needs, ['ci-tier']);
	assert.match(sentinelJob.if, /needs\.ci-tier\.outputs\.full == 'true'/);
	assert.match(sentinelJob.if, /inputs\.fail_fast/);
	const uses = sentinelJob.steps.map((step) => step.uses ?? '').filter(Boolean);
	assert.equal(uses.length, 1, 'only the checkout action');
	assert.match(uses[0], /^actions\/checkout@[0-9a-f]{40}/);
	const checkout = sentinelJob.steps[0].with;
	assert.equal(checkout['persist-credentials'], false);
	assert.equal(checkout['sparse-checkout'], 'scripts/ci-fail-fast.sh');
	const runs = sentinelJob.steps.map((step) => step.run ?? '').join('\n');
	assert.doesNotMatch(runs, /npm|npx|node /, 'the sentinel runs no project dependency');
	assert.equal(sentinelJob.steps.at(-1).run, 'bash scripts/ci-fail-fast.sh');
	assert.equal(workflow.on.workflow_dispatch.inputs.fail_fast.default, true);
});

test('every validation matrix stops its siblings at the first failure', async () => {
	const { load } = await import('js-yaml');
	const read = (name) =>
		load(readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8'));
	const deploy = read('deploy.yml');
	const desktop = read('desktop.yml');
	const cli = read('cli-package.yml');
	for (const [label, job] of [
		['e2e-shard', deploy.jobs['e2e-shard']],
		['build', deploy.jobs.build],
		['validate-desktop', desktop.jobs['validate-desktop']],
		['web-benchmark', desktop.jobs['web-benchmark']],
		['native-smoke', desktop.jobs['native-smoke']],
		['native-benchmark', desktop.jobs['native-benchmark']],
		['build-desktop', desktop.jobs['build-desktop']],
		['installed-cli', cli.jobs['installed-cli']]
	]) {
		assert.equal(job.strategy['fail-fast'], true, label);
	}
});

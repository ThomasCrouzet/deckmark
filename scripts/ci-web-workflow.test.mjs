import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
const { load } = await import('js-yaml');

const workflow = load(
	readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8')
);
const aggregate = workflow.jobs.e2e.steps.find((step) => step.run)?.run;
const healthy = {
	TIER_RESULT: 'success',
	FULL: 'true',
	TIER: 'full',
	BUILD_RESULT: 'success',
	SHARD_RESULT: 'success',
	MANIFEST_RESULT: 'success'
};

function runAggregate(overrides = {}) {
	return spawnSync('bash', ['-e', '-o', 'pipefail', '-c', aggregate], {
		env: { ...process.env, ...healthy, ...overrides },
		encoding: 'utf8'
	});
}

test('a complete full-tier result passes the actual E2E aggregate shell', () => {
	const result = runAggregate();
	assert.equal(result.status, 0, result.stderr);
});

test('a deferred draft cannot pass even with successful-looking dependency results', () => {
	assert.notEqual(runAggregate({ FULL: 'false', TIER: 'draft' }).status, 0);
});

test('missing, cancelled, skipped and failed required results cannot pass', () => {
	for (const field of ['TIER_RESULT', 'BUILD_RESULT', 'SHARD_RESULT', 'MANIFEST_RESULT']) {
		for (const result of ['', 'failure', 'skipped', 'cancelled', 'timed_out']) {
			assert.notEqual(runAggregate({ [field]: result }).status, 0, `${field}=${result}`);
		}
	}
	assert.notEqual(runAggregate({ FULL: '', TIER: '' }).status, 0);
});

test('the aggregate consumes real tier outputs and waits for the policy decision', () => {
	assert.ok(workflow.jobs.e2e.needs.includes('ci-tier'));
	const env = workflow.jobs.e2e.steps.find((step) => step.run).env;
	assert.equal(env.TIER_RESULT, '${{ needs.ci-tier.result }}');
	assert.equal(env.FULL, '${{ needs.ci-tier.outputs.full }}');
	assert.equal(env.TIER, '${{ needs.ci-tier.outputs.tier }}');
});

test('heavy Web jobs require the successful full-tier decision', () => {
	for (const name of ['e2e-build', 'e2e-config', 'e2e-shard', 'e2e-manifest', 'lighthouse']) {
		const job = workflow.jobs[name];
		assert.ok(job.needs.includes('ci-tier'), name);
		assert.match(job.if, /needs\.ci-tier\.outputs\.full == 'true'/, name);
		assert.doesNotMatch(job.if, /always\(\)/, name);
	}
});

test('ready and draft transitions rerun the policy on the same head', () => {
	const actions = workflow.on.pull_request.types;
	for (const action of [
		'opened',
		'synchronize',
		'reopened',
		'ready_for_review',
		'converted_to_draft'
	]) {
		assert.ok(actions.includes(action), action);
	}
	const classify = workflow.jobs['ci-tier'].steps.find((step) => step.id === 'tier');
	assert.match(classify.run, /scripts\/ci-tier\.mjs/);
	assert.match(classify.run, /GITHUB_EVENT_PATH/);
});

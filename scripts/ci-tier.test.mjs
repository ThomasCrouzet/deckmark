// Fail-closed fixtures for the CI tier policy. A draft pull request defers the
// expensive matrix. A missing, malformed or contradictory event must fail the
// run instead of selecting the fast tier.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';

const script = resolve(import.meta.dirname, 'ci-tier.mjs');
const root = mkdtempSync(join(tmpdir(), 'ci-tier-'));
let sequence = 0;

after(() => rmSync(root, { recursive: true, force: true }));

const sha = (character) => character.repeat(40);

function pullRequest(action, draft, overrides = {}) {
	return {
		action,
		number: 42,
		pull_request: {
			number: 42,
			draft,
			head: { sha: sha('a') },
			base: { sha: sha('b') },
			...overrides
		}
	};
}

function invoke({ eventName, payload, useFlag = true, env = {} } = {}) {
	const call = { ...process.env, ...env };
	if (eventName === undefined) delete call.GITHUB_EVENT_NAME;
	else call.GITHUB_EVENT_NAME = eventName;
	const cli = [];
	if (eventName !== undefined && useFlag) cli.push('--event-name', eventName);
	if (payload !== undefined) {
		sequence += 1;
		const file = join(root, `event-${sequence}.json`);
		writeFileSync(file, typeof payload === 'string' ? payload : JSON.stringify(payload));
		cli.push('--event', file);
	}
	return spawnSync(process.execPath, [script, ...cli], { encoding: 'utf8', env: call });
}

function outputs(result) {
	assert.equal(result.status, 0, result.stderr);
	const lines = result.stdout.trim().split('\n');
	assert.equal(lines.length, 3, 'the script must print one value for each output');
	return Object.fromEntries(lines.map((line) => line.split('=')));
}

function expectPolicyError(result) {
	assert.notEqual(result.status, 0, 'the policy must reject this input');
	assert.equal(result.stdout, '', 'a rejected input must not publish a tier');
	assert.match(result.stderr, /^ci-tier: /);
}

test('draft pull request events select the draft tier', () => {
	for (const action of ['opened', 'synchronize', 'reopened']) {
		const result = outputs(
			invoke({ eventName: 'pull_request', payload: pullRequest(action, true) })
		);
		assert.equal(result.full, 'false', action);
		assert.equal(result.tier, 'draft', action);
		assert.equal(result.reason, `event:pull_request:${action}:draft`, action);
	}
});

test('a converted_to_draft event returns to the draft tier', () => {
	const result = outputs(
		invoke({ eventName: 'pull_request', payload: pullRequest('converted_to_draft', true) })
	);
	assert.equal(result.full, 'false');
	assert.equal(result.tier, 'draft');
});

test('a ready pull request runs the full tier', () => {
	const result = outputs(
		invoke({ eventName: 'pull_request', payload: pullRequest('ready_for_review', false) })
	);
	assert.equal(result.full, 'true');
	assert.equal(result.tier, 'full');
});

test('a synchronize event on a ready pull request stays full', () => {
	const result = outputs(
		invoke({ eventName: 'pull_request', payload: pullRequest('synchronize', false) })
	);
	assert.equal(result.full, 'true');
});

test('push, schedule, manual, reusable and release runs are full', () => {
	const cases = [
		['push', { ref: 'refs/heads/main', before: sha('0'), after: sha('c') }],
		['schedule', { schedule: '0 4 * * 1' }],
		['workflow_dispatch', { inputs: {} }],
		['workflow_call', { inputs: { release_tag: 'v1.0.0' } }],
		['release', { action: 'published', release: { tag_name: 'v1.0.0' } }]
	];
	for (const [eventName, payload] of cases) {
		const result = outputs(invoke({ eventName, payload }));
		assert.equal(result.full, 'true', eventName);
		assert.equal(result.tier, 'full', eventName);
	}
});

test('a pull request without a boolean draft field fails closed', () => {
	const missing = pullRequest('opened', true);
	delete missing.pull_request.draft;
	expectPolicyError(invoke({ eventName: 'pull_request', payload: missing }));
	expectPolicyError(invoke({ eventName: 'pull_request', payload: pullRequest('opened', 'true') }));
});

test('an action that contradicts the draft flag fails closed', () => {
	expectPolicyError(
		invoke({ eventName: 'pull_request', payload: pullRequest('ready_for_review', true) })
	);
	expectPolicyError(
		invoke({ eventName: 'pull_request', payload: pullRequest('converted_to_draft', false) })
	);
});

test('an unlisted pull request action fails closed', () => {
	const payload = pullRequest('labeled', true, { labels: [{ name: 'skip-ci' }] });
	expectPolicyError(invoke({ eventName: 'pull_request', payload }));
});

test('a missing event name and malformed JSON fail closed', () => {
	expectPolicyError(invoke({ payload: pullRequest('opened', true) }));
	expectPolicyError(invoke({ eventName: 'pull_request', payload: '{"action":' }));
});

test('an event name with the wrong payload fails closed', () => {
	expectPolicyError(invoke({ eventName: 'pull_request', payload: { ref: 'refs/heads/main' } }));
	expectPolicyError(invoke({ eventName: 'push', payload: pullRequest('opened', true) }));
});

test('explicit environment input classifies without an event file', () => {
	const ready = outputs(
		invoke({
			eventName: 'pull_request',
			useFlag: false,
			env: {
				CI_TIER_ACTION: 'ready_for_review',
				CI_TIER_DRAFT: 'false',
				CI_TIER_PR_NUMBER: '7',
				CI_TIER_HEAD_SHA: sha('a'),
				CI_TIER_BASE_SHA: sha('b')
			}
		})
	);
	assert.equal(ready.full, 'true');

	expectPolicyError(
		invoke({
			eventName: 'pull_request',
			useFlag: false,
			env: {
				CI_TIER_ACTION: 'opened',
				CI_TIER_PR_NUMBER: '7',
				CI_TIER_HEAD_SHA: sha('a'),
				CI_TIER_BASE_SHA: sha('b')
			}
		})
	);
});

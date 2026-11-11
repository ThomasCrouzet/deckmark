import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
const { load } = await import('js-yaml');

const source = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
const workflow = load(source);
const aggregate = workflow.jobs.e2e.steps.find((step) => step.run)?.run;
const healthy = {
	TIER_RESULT: 'success',
	FULL: 'true',
	TIER: 'full',
	CLASS: 'full',
	CLASS_REASON: 'full:non-documentation',
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

function steps() {
	return Object.entries(workflow.jobs).flatMap(([job, value]) =>
		(value.steps ?? []).map((step) => ({ job, step }))
	);
}

test('a complete full-tier result passes the actual E2E aggregate shell', () => {
	const result = runAggregate();
	assert.equal(result.status, 0, result.stderr);
});

test('a deferred draft cannot pass even with successful-looking dependency results', () => {
	assert.notEqual(runAggregate({ FULL: 'false', TIER: 'draft' }).status, 0);
});

test('a documentation-only class is the only accepted not-applicable result', () => {
	const result = runAggregate({
		CLASS: 'docs',
		CLASS_REASON: 'docs-only:3',
		BUILD_RESULT: 'skipped',
		SHARD_RESULT: 'skipped',
		MANIFEST_RESULT: 'skipped'
	});
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /not applicable/);
});

test('the documentation class cannot hide a browser result that ran', () => {
	for (const field of ['BUILD_RESULT', 'SHARD_RESULT', 'MANIFEST_RESULT']) {
		for (const value of ['success', 'failure', 'cancelled', '']) {
			assert.notEqual(
				runAggregate({
					CLASS: 'docs',
					CLASS_REASON: 'docs-only:3',
					BUILD_RESULT: 'skipped',
					SHARD_RESULT: 'skipped',
					MANIFEST_RESULT: 'skipped',
					[field]: value
				}).status,
				0,
				`${field}=${value}`
			);
		}
	}
});

test('a missing, unknown or malformed class cannot pass', () => {
	for (const overrides of [
		{ CLASS: '' },
		{ CLASS: 'doc' },
		{ CLASS: 'unknown' },
		{ CLASS: 'Docs' },
		{ CLASS: 'docs', CLASS_REASON: '' },
		{ CLASS: 'docs', CLASS_REASON: 'full:non-documentation' },
		{ CLASS: 'full', CLASS_REASON: '' }
	]) {
		assert.notEqual(runAggregate(overrides).status, 0, JSON.stringify(overrides));
	}
});

test('missing, cancelled, skipped and failed required results cannot pass', () => {
	for (const field of ['TIER_RESULT', 'BUILD_RESULT', 'SHARD_RESULT', 'MANIFEST_RESULT']) {
		for (const result of ['', 'failure', 'skipped', 'cancelled', 'timed_out']) {
			assert.notEqual(runAggregate({ [field]: result }).status, 0, `${field}=${result}`);
		}
	}
	assert.notEqual(runAggregate({ FULL: '', TIER: '' }).status, 0);
});

test('the aggregate consumes real tier and class outputs and waits for the policy decision', () => {
	assert.ok(workflow.jobs.e2e.needs.includes('ci-tier'));
	const env = workflow.jobs.e2e.steps.find((step) => step.run).env;
	assert.equal(env.TIER_RESULT, '${{ needs.ci-tier.result }}');
	assert.equal(env.FULL, '${{ needs.ci-tier.outputs.full }}');
	assert.equal(env.TIER, '${{ needs.ci-tier.outputs.tier }}');
	assert.equal(env.CLASS, '${{ needs.ci-tier.outputs.class }}');
	assert.equal(env.CLASS_REASON, '${{ needs.ci-tier.outputs.class_reason }}');
});

test('heavy browser jobs require the successful full tier and the full class', () => {
	for (const name of ['e2e-build', 'e2e-shard', 'e2e-manifest']) {
		const job = workflow.jobs[name];
		assert.ok(job.needs.includes('ci-tier'), name);
		assert.match(job.if, /needs\.ci-tier\.outputs\.full == 'true'/, name);
		assert.match(job.if, /needs\.ci-tier\.outputs\.class == 'full'/, name);
		assert.doesNotMatch(job.if, /always\(\)/, name);
	}
	const lighthouse = workflow.jobs.lighthouse;
	assert.ok(lighthouse.needs.includes('ci-tier'));
	assert.match(lighthouse.if, /needs\.ci-tier\.outputs\.full == 'true'/);
	assert.doesNotMatch(lighthouse.if, /always\(\)/);
});

test('the fast checks and both production builds run on every tier and class', () => {
	for (const name of ['typecheck', 'lint', 'unit', 'build']) {
		assert.equal(workflow.jobs[name].if, undefined, name);
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

test('the policy job classifies the change set from real commit paths', () => {
	const step = workflow.jobs['ci-tier'].steps.find((value) => value.id === 'changes');
	assert.match(step.run, /git diff --name-only -z/);
	assert.match(step.run, /scripts\/ci-changes\.mjs/);
	assert.match(step.run, /"\$EVENT_NAME" = 'pull_request'/);
	assert.equal(step.env.BASE_SHA, '${{ github.event.pull_request.base.sha }}');
	assert.equal(step.env.HEAD_SHA, '${{ github.event.pull_request.head.sha || github.sha }}');
	assert.equal(workflow.jobs['ci-tier'].outputs.class, '${{ steps.changes.outputs.class }}');
	assert.equal(
		workflow.jobs['ci-tier'].outputs.class_reason,
		'${{ steps.changes.outputs.reason }}'
	);
});

test('the pinned image is resolved once, fails closed and feeds every container job', () => {
	const job = workflow.jobs['ci-tier'];
	const step = job.steps.find((value) => value.id === 'image');
	assert.match(step.run, /scripts\/ci-playwright-image\.mjs/);
	assert.equal(step['continue-on-error'], undefined);
	assert.doesNotMatch(step.run, /\|\|\s*true/);
	assert.equal(job['continue-on-error'], undefined);
	assert.equal(job.outputs.image, '${{ steps.image.outputs.image }}');
	assert.equal(job.outputs.playwright, '${{ steps.image.outputs.playwright }}');

	for (const name of ['e2e-shard', 'e2e-manifest']) {
		assert.equal(workflow.jobs[name].container.image, '${{ needs.ci-tier.outputs.image }}', name);
	}
});

test('the image resolver shell writes usable Actions outputs in both workflows', () => {
	const verification = load(
		readFileSync(new URL('../.github/workflows/verify-deployment.yml', import.meta.url), 'utf8')
	);
	const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
		.devDependencies['@playwright/test'];
	for (const job of [workflow.jobs['ci-tier'], verification.jobs['resolve-image']]) {
		const directory = mkdtempSync(join(tmpdir(), 'deckmark-image-output-'));
		try {
			const output = join(directory, 'outputs');
			const script = job.steps.find((step) => step.id === 'image').run;
			const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
				cwd: new URL('..', import.meta.url),
				env: { ...process.env, GITHUB_OUTPUT: output },
				encoding: 'utf8'
			});
			assert.equal(result.status, 0, result.stderr);
			const values = Object.fromEntries(
				readFileSync(output, 'utf8')
					.trim()
					.split('\n')
					.map((line) => line.split('='))
			);
			assert.match(
				values.image ?? '',
				/^mcr\.microsoft\.com\/playwright(?::v[\d.]+-noble)?@sha256:[a-f0-9]{64}$/
			);
			assert.equal(values.playwright, version);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}
});

test('the shard count has one definition and one consumer expression', () => {
	assert.equal(workflow.jobs['e2e-config'], undefined, 'the control-only job is removed');
	const definitions = steps().filter(({ step }) => /shards=\[/.test(step.run ?? ''));
	assert.equal(definitions.length, 1, 'the shard count is defined once');
	assert.equal(definitions[0].job, 'ci-tier');

	const consumers = steps().filter(({ step }) => step.env?.SHARD_COUNT !== undefined);
	assert.ok(consumers.length >= 4, 'every shard and manifest step reads the count');
	for (const { job, step } of consumers) {
		assert.equal(step.env.SHARD_COUNT, '${{ needs.ci-tier.outputs.shard_count }}', job);
	}
	assert.equal(
		workflow.jobs['e2e-shard'].strategy.matrix.shard,
		'${{ fromJSON(needs.ci-tier.outputs.shard_matrix) }}'
	);
});

test('every job installs the Node version from .node-version', () => {
	const setups = steps().filter(({ step }) => /actions\/setup-node@/.test(step.uses ?? ''));
	assert.ok(setups.length >= 8);
	for (const { job, step } of setups) {
		assert.equal(step.with['node-version-file'], '.node-version', job);
		assert.equal(step.with['node-version'], undefined, job);
	}
	assert.doesNotMatch(source, /node22/, 'a cache key must not hardcode the Node version');
});

test('the required check names and both production build names stay unchanged', () => {
	for (const name of ['check', 'build', 'e2e', 'lighthouse']) {
		assert.ok(workflow.jobs[name], name);
		assert.equal(workflow.jobs[name].name, undefined, `${name} keeps its job-id check name`);
	}
	const matrix = workflow.jobs.build.strategy.matrix.include;
	assert.equal(matrix.length, 2);
	assert.deepEqual(Object.keys(matrix[0]), ['base_path', 'upload']);
	assert.deepEqual(Object.keys(matrix[1]), ['base_path', 'upload']);
	assert.equal(matrix[0].upload, true);
	assert.equal(matrix[1].upload, false);
	assert.equal(matrix[0].base_path, '${{ needs.pages-config.outputs.production_base_path }}');
	assert.equal(matrix[1].base_path, '${{ needs.pages-config.outputs.check_base_path }}');
});

test('the browser suite keeps its visual snapshot exclusions', () => {
	for (const name of ['e2e-shard', 'e2e-manifest']) {
		const runs = workflow.jobs[name].steps
			.filter((step) => /playwright test/.test(step.run ?? ''))
			.map((step) => step.run);
		assert.ok(runs.length > 0, name);
		for (const run of runs) {
			assert.match(run, /--ignore-snapshots/, name);
			assert.match(run, /--grep-invert "Snapshots visuels"/, name);
		}
	}
});

test('the workflow uploads no test report, coverage or SARIF artifact', () => {
	const uploads = steps().filter(({ step }) =>
		/actions\/upload-(?:artifact|pages-artifact)@/.test(step.uses ?? '')
	);
	assert.ok(uploads.length > 0);
	for (const { job, step } of uploads) {
		const path = String(step.with?.path ?? '');
		assert.doesNotMatch(
			path,
			/test-results|playwright-report|production-report|coverage|\.nyc_output|sarif/i,
			job
		);
	}
	assert.doesNotMatch(source, /upload-sarif/);
});

test('the unit job runs the project test entrypoint instead of collecting coverage', () => {
	const unit = workflow.jobs.unit.steps.find((step) => /npm (run )?test/.test(step.run ?? ''));
	assert.ok(unit, 'the unit job runs npm test');
	assert.doesNotMatch(unit.run, /test:coverage/);
});

test('both origins deploy in parallel behind the same gates and one verification', () => {
	const pages = workflow.jobs.deploy;
	const mirror = workflow.jobs['deploy-cloudflare'];
	assert.deepEqual(pages.needs, ['check', 'build', 'e2e', 'lighthouse']);
	for (const gate of ['build', 'e2e', 'lighthouse']) {
		assert.ok(mirror.needs.includes(gate), gate);
	}
	assert.ok(!mirror.needs.includes('deploy'), 'the mirror does not wait for Pages');
	assert.deepEqual(workflow.jobs['verify-public'].needs, ['deploy', 'deploy-cloudflare']);
});

import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
const { load } = await import('js-yaml');

const source = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
const workflow = load(source);
const verification = load(
	readFileSync(new URL('../.github/workflows/verify-deployment.yml', import.meta.url), 'utf8')
);
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

// Every job that runs a browser inside the pinned container. The two deploy
// jobs share a HOME for checkout and provenance. The deployment check uses the
// same shape, so one HOME contract covers all three.
const browserContainerJobs = [
	['deploy e2e-shard', workflow.jobs['e2e-shard']],
	['deploy e2e-manifest', workflow.jobs['e2e-manifest']],
	['verify-deployment browser', verification.jobs.browser]
];

// The exact trust line. Each browser container job contains it once.
const trustLine = 'git config --global --add safe.directory "$GITHUB_WORKSPACE"';

function trustLines(job) {
	return job.steps
		.flatMap((step) => (step.run ?? '').split('\n').map((line) => line.trim()))
		.filter((line) => line === trustLine);
}

// Run Git fixtures with no inherited GIT_* state. A developer shell must not
// change rename detection or redirect the fixture repository.
function gitEnvironment(overrides = {}) {
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
		GIT_COMMITTER_EMAIL: 'ci@example.invalid',
		...overrides
	};
}

// Container steps run with the job HOME, which the browser jobs set to /root.
// actions/checkout writes its safe.directory entry under a temporary HOME
// instead, so a later step cannot read the checkout. Git also rejects a
// repository that another user owns, whatever HOME it uses. The fixture uses a
// temporary directory as the job HOME and forces the other-owner case.
function homeEnvironment(home) {
	const environment = gitEnvironment();
	delete environment.GIT_CONFIG_GLOBAL;
	return { ...environment, HOME: home, GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' };
}

function runGitInHome(home, cwd, args) {
	return spawnSync('git', args, { cwd, env: homeEnvironment(home), encoding: 'utf8' });
}

function createGitRepository() {
	const repository = mkdtempSync(join(tmpdir(), 'deckmark-change-set-'));
	const runGit = (args) => {
		const result = spawnSync('git', ['-C', repository, ...args], {
			env: gitEnvironment(),
			encoding: 'utf8'
		});
		assert.equal(result.status, 0, result.stderr);
		return result.stdout.trim();
	};
	runGit(['init', '-q']);
	runGit(['config', 'user.email', 'ci@example.invalid']);
	runGit(['config', 'user.name', 'CI fixture']);
	runGit(['config', 'diff.renames', 'true']);
	return { repository, runGit };
}

// Execute the exact workflow shell step so the diff command and the
// classifier stay coupled to the real workflow text.
function runChangeStep(repository, base, head) {
	const output = join(repository, 'github-output');
	const step = workflow.jobs['ci-tier'].steps.find((value) => value.id === 'changes');
	const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', step.run], {
		cwd: repository,
		env: gitEnvironment({
			EVENT_NAME: 'pull_request',
			BASE_SHA: base,
			HEAD_SHA: head,
			GITHUB_OUTPUT: output
		}),
		encoding: 'utf8'
	});
	return { result, output };
}

function changeOutputs(result, output) {
	assert.equal(result.status, 0, result.stderr);
	return Object.fromEntries(
		readFileSync(output, 'utf8')
			.trim()
			.split('\n')
			.map((line) => line.split('='))
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

test('each browser container job runs as root with one job HOME', () => {
	for (const [name, job] of browserContainerJobs) {
		assert.equal(job.container.options, '--user root', name);
		// Firefox refuses to start when $HOME belongs to another user. The
		// container default HOME is not root-owned, so the job sets HOME=/root
		// before checkout runs and keeps it for every step.
		assert.equal(job.env?.HOME, '/root', `${name} sets the job HOME`);
		const uses = job.steps.map((step) => step.uses ?? '');
		for (const action of ['actions/checkout@', 'actions/setup-node@', 'actions/cache@']) {
			assert.ok(
				uses.some((value) => value.startsWith(action)),
				`${name} runs ${action} in the job HOME`
			);
		}
		const setup = job.steps.find((step) => /actions\/setup-node@/.test(step.uses ?? ''));
		assert.equal(setup.with.cache, 'npm', `${name} caches npm from the same HOME`);
	}
});

test('no browser container step overrides the job HOME', () => {
	for (const [name, job] of browserContainerJobs) {
		for (const step of job.steps) {
			// A step HOME would split checkout, cache, provenance and browsers.
			assert.equal(step.env?.HOME, undefined, `${name}: ${step.name} overrides HOME`);
			assert.doesNotMatch(
				step.run ?? '',
				/(^|\s)(export\s+)?HOME=/,
				`${name}: ${step.name} assigns HOME`
			);
			assert.doesNotMatch(step.run ?? '', /\/github\/home/, `${name}: ${step.name}`);
		}
	}
});

test('container browser jobs trust the workspace in the HOME that runs their steps', () => {
	for (const [name, job] of browserContainerJobs) {
		const lines = job.steps.flatMap((step) =>
			(step.run ?? '').split('\n').map((line) => line.trim())
		);
		assert.equal(trustLines(job).length, 1, name);
		assert.doesNotMatch(lines.join('\n'), /safe\.directory\s+\*/i, name);
		const trustIndex = job.steps.findIndex((step) =>
			(step.run ?? '').split('\n').some((line) => line.trim() === trustLine)
		);
		assert.ok(trustIndex >= 0, name);
		assert.ok(
			trustIndex < job.steps.findIndex((step) => /playwright test/.test(step.run ?? '')),
			`${name} trusts the workspace before Playwright reads it`
		);
	}
	const checkout = workflow.jobs['e2e-manifest'].steps.find((step) =>
		step.uses?.startsWith('actions/checkout@')
	);
	assert.equal(checkout.with['persist-credentials'], false);
});

test('each browser container job restores provenance in its own job HOME', () => {
	const { repository, runGit } = createGitRepository();
	const checkoutHome = mkdtempSync(join(tmpdir(), 'deckmark-checkout-home-'));
	const homes = [];
	// The production provenance preflight, run in the fixture checkout.
	const provenanceScript = JSON.stringify(
		fileURLToPath(new URL('./test-source.mjs', import.meta.url))
	);
	const provenance = (home) =>
		spawnSync(
			process.execPath,
			[
				'-e',
				`import(${provenanceScript}).then((module) => console.log(JSON.stringify(module.testSource())))`
			],
			{ cwd: repository, env: homeEnvironment(home), encoding: 'utf8' }
		);
	try {
		writeFileSync(join(repository, 'note.md'), '# One\n');
		runGit(['add', '-A']);
		runGit(['commit', '-qm', 'base']);
		writeFileSync(join(repository, 'note.md'), '# Two\n');
		const head = runGit(['rev-parse', 'HEAD']);

		// actions/checkout adds the safe directory to its temporary HOME only.
		const checkoutTrust = spawnSync(
			'git',
			['config', '--global', '--add', 'safe.directory', repository],
			{ cwd: repository, env: homeEnvironment(checkoutHome), encoding: 'utf8' }
		);
		assert.equal(checkoutTrust.status, 0, checkoutTrust.stderr);

		for (const [name, job] of browserContainerJobs) {
			const home = mkdtempSync(join(tmpdir(), 'deckmark-job-home-'));
			homes.push(home);

			// The fixture must reproduce the job symptom: Git cannot read the
			// commit through the temporary-HOME trust entry.
			const before = provenance(home);
			assert.notEqual(before.status, 0, `${name} starts untrusted`);
			assert.match(before.stderr, /dubious ownership|Not a git repository/, name);

			const [line] = trustLines(job);
			assert.ok(line, `${name} has a job HOME trust step`);
			const trust = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', line], {
				cwd: repository,
				env: { ...homeEnvironment(home), GITHUB_WORKSPACE: repository },
				encoding: 'utf8'
			});
			assert.equal(trust.status, 0, trust.stderr);

			const after = provenance(home);
			assert.equal(after.status, 0, after.stderr);
			const metadata = JSON.parse(after.stdout);
			assert.equal(metadata.source, head, name);
			assert.deepEqual(metadata.untracked, [], name);

			const diff = runGitInHome(home, repository, ['diff', '--binary', 'HEAD']);
			assert.equal(diff.status, 0, diff.stderr);
			assert.match(diff.stdout, /\+# Two/, name);

			const trusted = runGitInHome(home, repository, [
				'config',
				'--global',
				'--get-all',
				'safe.directory'
			]);
			assert.deepEqual(trusted.stdout.trim().split('\n'), [repository], name);
		}
	} finally {
		rmSync(repository, { recursive: true, force: true });
		rmSync(checkoutHome, { recursive: true, force: true });
		for (const home of homes) rmSync(home, { recursive: true, force: true });
	}
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
	assert.match(step.run, /git diff --no-renames --name-only -z/);
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

test('a real documentation-only commit selects the documentation class', () => {
	const { repository, runGit } = createGitRepository();
	try {
		mkdirSync(join(repository, 'docs'));
		writeFileSync(join(repository, 'docs', 'guide.md'), '# Guide\n');
		runGit(['add', '-A']);
		runGit(['commit', '-qm', 'base']);
		const base = runGit(['rev-parse', 'HEAD']);
		writeFileSync(join(repository, 'docs', 'CI.md'), '# CI\n');
		runGit(['add', '-A']);
		runGit(['commit', '-qm', 'docs']);
		const head = runGit(['rev-parse', 'HEAD']);
		mkdirSync(join(repository, 'scripts'));
		copyFileSync(
			fileURLToPath(new URL('./ci-changes.mjs', import.meta.url)),
			join(repository, 'scripts', 'ci-changes.mjs')
		);

		const { result, output } = runChangeStep(repository, base, head);
		const values = changeOutputs(result, output);
		assert.equal(values.class, 'docs');
		assert.equal(values.reason, 'docs-only:1');
	} finally {
		rmSync(repository, { recursive: true, force: true });
	}
});

test('a real git rename from a test tree into docs still selects full validation', () => {
	const { repository, runGit } = createGitRepository();
	try {
		mkdirSync(join(repository, 'e2e'));
		mkdirSync(join(repository, 'docs'));
		writeFileSync(join(repository, 'e2e', 'critical.spec.ts'), 'test("critical", () => {});\n');
		runGit(['add', '-A']);
		runGit(['commit', '-qm', 'base']);
		const base = runGit(['rev-parse', 'HEAD']);
		runGit(['mv', 'e2e/critical.spec.ts', 'docs/critical.md']);
		runGit(['commit', '-qm', 'rename']);
		const head = runGit(['rev-parse', 'HEAD']);
		mkdirSync(join(repository, 'scripts'));
		copyFileSync(
			fileURLToPath(new URL('./ci-changes.mjs', import.meta.url)),
			join(repository, 'scripts', 'ci-changes.mjs')
		);

		const { result, output } = runChangeStep(repository, base, head);
		const values = changeOutputs(result, output);
		assert.equal(values.class, 'full');
		assert.equal(values.reason, 'full:non-documentation');
	} finally {
		rmSync(repository, { recursive: true, force: true });
	}
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
	assert.deepEqual(
		mirror.needs,
		pages.needs,
		'the mirror must keep the exact fast-check, build, browser and Lighthouse gates'
	);
	assert.ok(!mirror.needs.includes('deploy'), 'the mirror does not wait for Pages');
	assert.deepEqual(workflow.jobs['verify-public'].needs, ['deploy', 'deploy-cloudflare']);
});

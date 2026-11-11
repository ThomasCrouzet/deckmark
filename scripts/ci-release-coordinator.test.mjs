// Release coordination for the Desktop workflow.
//
// The Desktop workflow no longer calls a second workflow that polls for its own
// push validation. One run owns validation, release creation, packaging and
// publication, and each downstream job reads the exact source identity from the
// previous job. These tests execute the coordinator command line. A routing or
// gate regression fails here before it reaches a release.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import test from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'scripts', 'ci-release-coordinator.mjs');
const DESKTOP_WORKFLOW = readFileSync(join(ROOT, '.github', 'workflows', 'desktop.yml'), 'utf8');
const RELEASE_WORKFLOW = readFileSync(
	join(ROOT, '.github', 'workflows', 'release-please.yml'),
	'utf8'
);
const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

function run(args, options = {}) {
	return spawnSync(process.execPath, [CLI, ...args], {
		encoding: 'utf8',
		...options
	});
}

/** @param {string} directory */
function directory() {
	return mkdtempSync(join(tmpdir(), 'release-coordinator-'));
}

/**
 * Write the key=value lines that a workflow step appends to GITHUB_OUTPUT.
 * @param {string} text
 */
function parseOutputs(text) {
	/** @type {Record<string, string>} */
	const values = {};
	for (const line of text.split('\n')) {
		if (line.trim() === '') continue;
		const index = line.indexOf('=');
		assert.notEqual(index, -1, `unexpected output line: ${line}`);
		values[line.slice(0, index)] = line.slice(index + 1);
	}
	return values;
}

/** @param {string[]} args */
function planOutputs(args) {
	const result = run(['plan', ...args]);
	assert.equal(result.status, 0, result.stderr);
	return parseOutputs(result.stdout);
}

const PLAN_BASE = [
	'--event-name',
	'push',
	'--ref',
	'refs/heads/main',
	'--release-created',
	'true',
	'--tag-name',
	'v2.6.0',
	'--input-tag',
	'',
	'--packaging-only',
	'false',
	'--release-please-result',
	'success',
	'--validation-result',
	'success',
	'--resolve-result',
	'success',
	'--changes-result',
	'success',
	'--sha',
	SHA,
	'--run-sha',
	SHA,
	'--tag-sha',
	SHA,
	'--version',
	'2.6.0'
];

/**
 * Replace one flag value and keep the remaining arguments.
 * @param {string[]} args
 * @param {string} flag
 * @param {string} value
 */
function replaceFlag(args, flag, value) {
	const copy = [...args];
	const index = copy.indexOf(flag);
	assert.notEqual(index, -1, `missing flag ${flag}`);
	copy[index + 1] = value;
	return copy;
}

test('a release push builds and publishes the exact source commit', () => {
	const outputs = planOutputs(PLAN_BASE);
	assert.deepEqual(outputs, {
		build: 'true',
		publish: 'true',
		packaging: 'false',
		tag: 'v2.6.0',
		sha: SHA,
		reason: 'push:release'
	});
});

test('a push without a release and a schedule event build nothing', () => {
	const quiet = planOutputs(
		replaceFlag(replaceFlag(PLAN_BASE, '--release-created', ''), '--tag-name', '')
	);
	assert.equal(quiet.build, 'false');
	assert.equal(quiet.publish, 'false');
	assert.equal(quiet.reason, 'push:no-release');
});

test('the plan refuses a release that does not match the source', () => {
	for (const [args, pattern] of [
		[replaceFlag(PLAN_BASE, '--tag-name', 'v2.7.0'), /does not match the package version/],
		[replaceFlag(PLAN_BASE, '--tag-name', 'release-2.6.0'), /Invalid release tag/],
		[replaceFlag(PLAN_BASE, '--tag-sha', OTHER_SHA), /tag identifies a different commit/],
		[replaceFlag(PLAN_BASE, '--run-sha', OTHER_SHA), /run started from a different commit/],
		[replaceFlag(PLAN_BASE, '--validation-result', 'cancelled'), /validation is not successful/],
		[replaceFlag(PLAN_BASE, '--validation-result', ''), /validation is not successful/],
		[
			replaceFlag(PLAN_BASE, '--release-please-result', 'failure'),
			/release-please is not successful/
		],
		[replaceFlag(PLAN_BASE, '--changes-result', 'failure'), /change detection is not successful/],
		[replaceFlag(PLAN_BASE, '--resolve-result', 'skipped'), /source resolution was skipped/],
		[replaceFlag(PLAN_BASE, '--resolve-result', ''), /source resolution is not successful/],
		[
			replaceFlag(replaceFlag(PLAN_BASE, '--tag-name', ''), '--release-created', 'true'),
			/without a tag name/
		],
		[replaceFlag(PLAN_BASE, '--release-created', 'yes'), /release_created/],
		[replaceFlag(PLAN_BASE, '--event-name', 'pull_request'), /not a release event/],
		[replaceFlag(PLAN_BASE, '--ref', 'refs/heads/topic'), /outside main/],
		[replaceFlag(PLAN_BASE, '--sha', 'abc'), /Invalid source commit/]
	]) {
		const result = run(['plan', ...args]);
		assert.notEqual(result.status, 0, `accepted ${args.join(' ')}`);
		assert.match(result.stderr, /** @type {RegExp} */ (pattern));
	}
});

test('a manual dispatch keeps the release and packaging paths separate', () => {
	const dispatch = replaceFlag(
		replaceFlag(PLAN_BASE, '--event-name', 'workflow_dispatch'),
		'--release-created',
		''
	);

	const release = planOutputs(replaceFlag(dispatch, '--input-tag', 'v2.6.0'));
	assert.equal(release.build, 'true');
	assert.equal(release.publish, 'true');
	assert.equal(release.packaging, 'false');

	const packaging = planOutputs(replaceFlag(dispatch, '--packaging-only', 'true'));
	assert.equal(packaging.build, 'true');
	assert.equal(packaging.publish, 'false');
	assert.equal(packaging.packaging, 'true');
	assert.equal(packaging.tag, 'v2.6.0');

	const validation = planOutputs(replaceFlag(dispatch, '--validation-result', 'success'));
	assert.equal(validation.build, 'false');
	assert.equal(validation.reason, 'dispatch:validate');

	const contradiction = run([
		'plan',
		...replaceFlag(replaceFlag(dispatch, '--packaging-only', 'true'), '--input-tag', 'v2.6.0')
	]);
	assert.notEqual(contradiction.status, 0);
	assert.match(contradiction.stderr, /packaging-only run cannot publish/);

	const mismatch = run(['plan', ...replaceFlag(dispatch, '--input-tag', 'v2.5.0')]);
	assert.notEqual(mismatch.status, 0);
	assert.match(mismatch.stderr, /does not match the package version/);
});

test('the plan refuses an unsupported argument or a missing value', () => {
	const unknown = run(['plan', ...PLAN_BASE, '--publish', 'true']);
	assert.notEqual(unknown.status, 0);
	assert.match(unknown.stderr, /unknown argument/);

	const empty = run(['plan', ...replaceFlag(PLAN_BASE, '--version', '')]);
	assert.notEqual(empty.status, 0);
	assert.match(empty.stderr, /Invalid package version/);

	const missing = run(['plan', ...PLAN_BASE.slice(0, -1)]);
	assert.notEqual(missing.status, 0);
	assert.match(missing.stderr, /missing value for --version/);
});

/**
 * Run the validation gate with one environment.
 * @param {Record<string, string>} overrides
 */
function gate(overrides) {
	const env = {
		PATH: process.env.PATH,
		CHANGES_RESULT: 'success',
		VALIDATION_REQUIRED: 'true',
		FULL: 'true',
		TIER: 'full',
		RESOLVE_RESULT: 'success',
		VALIDATE_RESULT: 'success',
		NATIVE_RESULT: 'success',
		WEB_BUILD_RESULT: 'success',
		WEB_BENCHMARK_RESULT: 'success',
		...overrides
	};
	return run(['gate'], { env });
}

test('the validation gate accepts one full successful matrix', () => {
	const result = gate({});
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Every required job succeeded/);
});

test('the validation gate accepts a path decision only when it is explicit', () => {
	const notRequired = gate({ VALIDATION_REQUIRED: 'false' });
	assert.equal(notRequired.status, 0, notRequired.stderr);
	assert.match(notRequired.stdout, /not required/);

	// A missing classifier output is not a path decision.
	const missing = gate({ VALIDATION_REQUIRED: '' });
	assert.notEqual(missing.status, 0);
	assert.match(missing.stderr, /VALIDATION_REQUIRED/);

	const failedClassifier = gate({ CHANGES_RESULT: 'failure' });
	assert.notEqual(failedClassifier.status, 0);
	assert.match(failedClassifier.stderr, /change detection failed/);

	const malformed = gate({ VALIDATION_REQUIRED: 'yes' });
	assert.notEqual(malformed.status, 0);
	assert.match(malformed.stderr, /VALIDATION_REQUIRED/);
});

test('the validation gate rejects a deferred, cancelled or incomplete matrix', () => {
	const draft = gate({ FULL: 'false', TIER: 'draft' });
	assert.notEqual(draft.status, 0);
	assert.match(draft.stderr, /not a pass/);

	const tier = gate({ TIER: '' });
	assert.notEqual(tier.status, 0);
	assert.match(tier.stderr, /not a pass/);

	for (const name of [
		'RESOLVE_RESULT',
		'VALIDATE_RESULT',
		'NATIVE_RESULT',
		'WEB_BUILD_RESULT',
		'WEB_BENCHMARK_RESULT'
	]) {
		for (const value of ['failure', 'cancelled', 'skipped', '']) {
			const result = gate({ [name]: value });
			assert.notEqual(result.status, 0, `${name}=${value} passed`);
			assert.match(result.stderr, new RegExp(name), `${name}=${value}`);
		}
	}
});

/** Build a ustar entry for the test archive. */
function tarHeader(name, size) {
	const header = Buffer.alloc(512, 0);
	header.write(name, 0, 100, 'utf8');
	header.write('0000644\0', 100, 8);
	header.write('0000000\0', 108, 8);
	header.write('0000000\0', 116, 8);
	header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12);
	header.write(`${Math.floor(0).toString(8).padStart(11, '0')}\0`, 136, 12);
	header.write('        ', 148, 8);
	header.write('0', 156, 1);
	header.write('ustar\0', 257, 6);
	header.write('00', 263, 2);
	let sum = 0;
	for (const byte of header) sum += byte;
	header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
	return header;
}

/**
 * Build a gzip tar archive from in-memory entries.
 * @param {{ name: string, data: string }[]} entries
 */
function tarGz(entries) {
	const blocks = [];
	for (const { name, data } of entries) {
		const payload = Buffer.from(data, 'utf8');
		blocks.push(tarHeader(name, payload.length), payload);
		const padding = (512 - (payload.length % 512)) % 512;
		if (padding) blocks.push(Buffer.alloc(padding, 0));
	}
	blocks.push(Buffer.alloc(1024, 0));
	return gzipSync(Buffer.concat(blocks));
}

/**
 * Build a stored zip archive from in-memory entries.
 * @param {{ name: string, data: string }[]} entries
 */
function storedZip(entries) {
	const local = [];
	const central = [];
	let offset = 0;
	for (const { name, data } of entries) {
		const payload = Buffer.from(data, 'utf8');
		const nameBuffer = Buffer.from(name, 'utf8');
		const header = Buffer.alloc(30);
		header.writeUInt32LE(0x04034b50, 0);
		header.writeUInt16LE(20, 4);
		header.writeUInt32LE(payload.length, 18);
		header.writeUInt32LE(payload.length, 22);
		header.writeUInt16LE(nameBuffer.length, 26);
		local.push(header, nameBuffer, payload);
		const entry = Buffer.alloc(46);
		entry.writeUInt32LE(0x02014b50, 0);
		entry.writeUInt16LE(20, 4);
		entry.writeUInt16LE(20, 6);
		entry.writeUInt32LE(payload.length, 20);
		entry.writeUInt32LE(payload.length, 24);
		entry.writeUInt16LE(nameBuffer.length, 28);
		entry.writeUInt32LE(offset, 42);
		central.push(Buffer.concat([entry, nameBuffer]));
		offset += header.length + nameBuffer.length + payload.length;
	}
	const centralBuffer = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralBuffer.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...local, centralBuffer, end]);
}

const VERSION = '2.6.0';

/** @param {string} platform @param {string} arch @param {string} [sha] */
function manifest(platform, arch, sha = SHA) {
	return JSON.stringify(
		{
			schema: 'deckmark-cli-install/1',
			version: VERSION,
			source: { gitSha: sha, dirty: false },
			runtime: { nodeVersion: '22.23.4', platform, arch },
			target: { platform, arch },
			files: {}
		},
		null,
		2
	);
}

const TARGETS = [
	{
		artifact: `deckmark-cli-${SHA}-linux-x64`,
		archive: `deckmark-cli-${VERSION}-linux-x64.tar.gz`,
		platform: 'linux',
		arch: 'x64'
	},
	{
		artifact: `deckmark-cli-${SHA}-win32-x64`,
		archive: `deckmark-cli-${VERSION}-windows-x64.zip`,
		platform: 'win32',
		arch: 'x64'
	},
	{
		artifact: `deckmark-cli-${SHA}-darwin-arm64`,
		archive: `deckmark-cli-${VERSION}-darwin-arm64.tar.gz`,
		platform: 'darwin',
		arch: 'arm64'
	}
];

const ARCHIVE_ROOT = `deckmark-cli-${VERSION}`;

/** @param {{ platform: string, arch: string }} target @param {string} os @param {{ gitSha?: string, dirty?: boolean, version?: string, target?: any }} [overrides] */
function buildTargetDirectory(root, target, os, overrides = {}) {
	const name = `${ARCHIVE_ROOT}-${os}-${target.arch}`;
	const build = JSON.parse(manifest(target.platform, target.arch, overrides.gitSha ?? SHA));
	if (overrides.dirty) build.source.dirty = true;
	if (overrides.version) build.version = overrides.version;
	if (overrides.target) build.target = overrides.target;
	const entries = [
		{ name: `${name}/deckmark-build.json`, data: `${JSON.stringify(build, null, 2)}\n` },
		{ name: `${name}/SHA256SUMS`, data: `${'f'.repeat(64)}  lib/deckmark.mjs\n` }
	];
	const targetDirectory = join(root, target.artifact);
	mkdirSync(targetDirectory, { recursive: true });
	const archiveName = target.archive;
	writeFileSync(
		join(targetDirectory, archiveName),
		target.platform === 'win32' ? storedZip(entries) : tarGz(entries)
	);
	return targetDirectory;
}

/** Build the three downloaded artifact directories. */
function cliFixture() {
	const root = directory();
	TARGETS.forEach((target, index) => {
		buildTargetDirectory(root, target, ['linux', 'windows', 'darwin'][index]);
	});
	return root;
}

let reportCounter = 0;

/** @param {string} root */
function verifyCli(root, extra = []) {
	reportCounter += 1;
	return run(
		[
			'verify-cli',
			'--dir',
			root,
			'--sha',
			SHA,
			'--version',
			VERSION,
			'--report',
			join(dirname(root), `cli-report-${reportCounter}.json`),
			...extra
		],
		{ env: { PATH: process.env.PATH } }
	);
}

test('the CLI deliverables must be the three exact-source archives', () => {
	const root = cliFixture();
	const result = verifyCli(root);
	assert.equal(result.status, 0, result.stderr);
	const report = JSON.parse(
		readFileSync(join(dirname(root), `cli-report-${reportCounter}.json`), 'utf8')
	);
	assert.equal(report.sha, SHA);
	assert.equal(report.version, VERSION);
	assert.equal(report.archives.length, 3);
	for (const archive of report.archives) {
		assert.match(archive.name, /^deckmark-cli-2\.6\.0-/);
		assert.match(archive.sha256, /^[a-f0-9]{64}$/);
	}
});

test('the CLI verifier refuses a missing, extra or foreign artifact', () => {
	const missingRoot = cliFixture();
	const removed = join(missingRoot, TARGETS[0].artifact);
	rmSync(removed, { recursive: true, force: true });
	const missing = verifyCli(missingRoot);
	assert.notEqual(missing.status, 0);
	assert.match(missing.stderr, /Missing CLI artifact/);

	const extraRoot = cliFixture();
	mkdirSync(join(extraRoot, `deckmark-cli-${SHA}-linux-arm64`));
	writeFileSync(
		join(
			extraRoot,
			`deckmark-cli-${SHA}-linux-arm64`,
			`deckmark-cli-${VERSION}-linux-arm64.tar.gz`
		),
		tarGz([{ name: 'placeholder', data: 'x' }])
	);
	const extra = verifyCli(extraRoot);
	assert.notEqual(extra.status, 0);
	assert.match(extra.stderr, /Unexpected CLI artifact/);

	const foreignRoot = cliFixture();
	const foreign = verifyCli(foreignRoot, ['--sha', OTHER_SHA]);
	assert.notEqual(foreign.status, 0);
	assert.match(foreign.stderr, /Missing CLI artifact/);
});

test('the CLI verifier refuses a wrong archive name or a foreign manifest', () => {
	const renamedRoot = cliFixture();
	const renamed = join(renamedRoot, TARGETS[1].artifact);
	renameSync(
		join(renamed, TARGETS[1].archive),
		join(renamed, `deckmark-cli-${VERSION}-windows-arm64.zip`)
	);
	const wrongName = verifyCli(renamedRoot);
	assert.notEqual(wrongName.status, 0);
	assert.match(wrongName.stderr, /Unexpected CLI archive/);

	const sourceRoot = cliFixture();
	buildTargetDirectory(sourceRoot, TARGETS[0], 'linux', { gitSha: OTHER_SHA });
	const wrongSource = verifyCli(sourceRoot);
	assert.notEqual(wrongSource.status, 0);
	assert.match(wrongSource.stderr, /different source commit/);

	const dirtyRoot = cliFixture();
	buildTargetDirectory(dirtyRoot, TARGETS[2], 'darwin', { dirty: true });
	const dirty = verifyCli(dirtyRoot);
	assert.notEqual(dirty.status, 0);
	assert.match(dirty.stderr, /dirty source tree/);

	const versionRoot = cliFixture();
	buildTargetDirectory(versionRoot, TARGETS[0], 'linux', { version: '2.5.0' });
	const wrongVersion = verifyCli(versionRoot);
	assert.notEqual(wrongVersion.status, 0);
	assert.match(wrongVersion.stderr, /different package version/);

	const targetRoot = cliFixture();
	buildTargetDirectory(targetRoot, TARGETS[0], 'linux', {
		target: { platform: 'linux', arch: 'arm64' }
	});
	const wrongTarget = verifyCli(targetRoot);
	assert.notEqual(wrongTarget.status, 0);
	assert.match(wrongTarget.stderr, /different target/);
});

test('the CLI verifier refuses an archive without its build manifest', () => {
	const root = cliFixture();
	const target = TARGETS[0];
	const targetDirectory = join(root, target.artifact);
	writeFileSync(
		join(targetDirectory, target.archive),
		tarGz([{ name: `${ARCHIVE_ROOT}-linux-x64/SHA256SUMS`, data: 'x\n' }])
	);
	const result = verifyCli(root);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /no deckmark-build.json/);
});

test('the coordinator refuses an unknown command and a missing directory', () => {
	const unknown = run(['publish']);
	assert.notEqual(unknown.status, 0);
	assert.match(unknown.stderr, /unknown command: publish/);

	const absent = verifyCli(join(directory(), 'absent'));
	assert.notEqual(absent.status, 0);
	assert.match(absent.stderr, /CLI artifact directory does not exist/);
});

/**
 * Collect the job block of one workflow.
 * @param {string} workflow
 * @param {string} job
 */
function jobBlock(workflow, job) {
	const lines = workflow.split('\n');
	const start = lines.findIndex((line) => line === `  ${job}:`);
	assert.notEqual(start, -1, `missing job ${job}`);
	let end = lines.length;
	for (let index = start + 1; index < lines.length; index += 1) {
		if (/^ {2}[a-zA-Z0-9_-]+:$/.test(lines[index])) {
			end = index;
			break;
		}
	}
	return lines.slice(start, end).join('\n');
}

test('the Desktop workflow owns validation, release creation and publication', () => {
	for (const job of [
		'changes',
		'resolve-source',
		'validate-desktop',
		'web-build',
		'web-benchmark',
		'native-validation',
		'desktop-validation',
		'release-please',
		'plan-release',
		'build-desktop',
		'verify-packaging',
		'publish-desktop-beta',
		'cli-package',
		'cli-verify'
	]) {
		assert.ok(jobBlock(DESKTOP_WORKFLOW, job), `missing job ${job}`);
	}

	// The polling job is gone and no workflow subscribes to another run.
	for (const workflow of [DESKTOP_WORKFLOW, RELEASE_WORKFLOW]) {
		assert.doesNotMatch(workflow, /gh run watch|await-desktop-validation|validation_run_id/);
		assert.doesNotMatch(workflow, /^\s*workflow_run:/m);
	}

	// The policy tests run in this workflow, so a broken route fails before
	// packaging.
	const changes = jobBlock(DESKTOP_WORKFLOW, 'changes');
	assert.match(
		changes,
		/node --test scripts\/desktop-release-orchestration\.test\.mjs scripts\/ci-release-coordinator\.test\.mjs/
	);

	const releaseJob = jobBlock(DESKTOP_WORKFLOW, 'release-please');
	assert.match(releaseJob, /googleapis\/release-please-action@[0-9a-f]{40}/);
	assert.match(releaseJob, /needs: desktop-validation/);
	assert.match(releaseJob, /contents: write/);
	assert.match(releaseJob, /pull-requests: write/);
	assert.match(releaseJob, /release_created: \$\{\{ steps\.release\.outputs\.release_created \}\}/);
	assert.match(releaseJob, /tag_name: \$\{\{ steps\.release\.outputs\.tag_name \}\}/);
	assert.match(releaseJob, /concurrency:\n\s+group: release-please/);

	const planJob = jobBlock(DESKTOP_WORKFLOW, 'plan-release');
	assert.match(planJob, /needs: \[changes, resolve-source, release-please, desktop-validation\]/);
	assert.match(planJob, /node scripts\/ci-release-coordinator\.mjs plan/);
	assert.match(planJob, /build: \$\{\{ steps\.plan\.outputs\.build \}\}/);
	assert.match(planJob, /publish: \$\{\{ steps\.plan\.outputs\.publish \}\}/);
	assert.match(planJob, /packaging: \$\{\{ steps\.plan\.outputs\.packaging \}\}/);
	assert.match(planJob, /tag: \$\{\{ steps\.plan\.outputs\.tag \}\}/);
	assert.match(planJob, /sha: \$\{\{ steps\.plan\.outputs\.sha \}\}/);

	const gate = jobBlock(DESKTOP_WORKFLOW, 'desktop-validation');
	assert.match(gate, /name: desktop-validation/);
	assert.match(gate, /run: node scripts\/ci-release-coordinator\.mjs gate/);
	assert.doesNotMatch(gate, /VALIDATED_SHA/);

	const build = jobBlock(DESKTOP_WORKFLOW, 'build-desktop');
	assert.match(build, /needs: \[plan-release\]/);
	assert.match(build, /needs\.plan-release\.outputs\.build == 'true'/);
	assert.match(build, /ref: \$\{\{ needs\.plan-release\.outputs\.sha \}\}/);
	assert.match(build, /SOURCE_TAG: \$\{\{ needs\.plan-release\.outputs\.tag \}\}/);

	const verify = jobBlock(DESKTOP_WORKFLOW, 'verify-packaging');
	assert.match(verify, /needs: \[plan-release, build-desktop\]/);
	assert.match(verify, /needs\.plan-release\.outputs\.packaging == 'true'/);

	const publish = jobBlock(DESKTOP_WORKFLOW, 'publish-desktop-beta');
	assert.match(publish, /needs: \[plan-release, build-desktop\]/);
	assert.match(publish, /needs\.plan-release\.outputs\.publish == 'true'/);
	assert.match(publish, /SOURCE_TAG: \$\{\{ needs\.plan-release\.outputs\.tag \}\}/);
	assert.match(publish, /SOURCE_SHA: \$\{\{ needs\.plan-release\.outputs\.sha \}\}/);
	// Immutable old assets stay refused.
	assert.match(publish, /plan-upload/);
	assert.match(publish, /\*\.msi\|\*\.rpm/);

	const cli = jobBlock(DESKTOP_WORKFLOW, 'cli-package');
	assert.match(cli, /uses: \.\/\.github\/workflows\/cli-package\.yml/);
	assert.match(cli, /needs\.plan-release\.outputs\.publish == 'true'/);

	const cliVerify = jobBlock(DESKTOP_WORKFLOW, 'cli-verify');
	assert.match(cliVerify, /needs: \[plan-release, cli-package\]/);
	assert.match(cliVerify, /run-id: \$\{\{ github\.run_id \}\}/);
	assert.match(cliVerify, /node scripts\/ci-release-coordinator\.mjs verify-cli/);
});

test('the plan resolves the tag commit from the release result and the input', () => {
	// A push run has no release_tag input. The tag that must be verified comes
	// from release-please, so a plan that reads only the input would fail every
	// real release.
	const planJob = jobBlock(DESKTOP_WORKFLOW, 'plan-release');
	assert.match(planJob, /tag_name="\$\{RELEASE_TAG_NAME:-\$RELEASE_TAG\}"/);
	assert.match(planJob, /git rev-parse "refs\/tags\/\$tag_name\^\{commit\}"/);
	assert.match(planJob, /--tag-sha "\$tag_sha"/);
});

test('the source command validates the tag and the run commit', () => {
	const base = ['source', '--sha', SHA, '--run-sha', SHA, '--version', '2.6.0'];
	const plain = run([...base, '--tag', '']);
	assert.equal(plain.status, 0, plain.stderr);
	assert.match(plain.stdout, /has no release tag/);

	const tagged = run([...base, '--tag', 'v2.6.0', '--tag-sha', SHA]);
	assert.equal(tagged.status, 0, tagged.stderr);
	assert.match(tagged.stdout, /matches v2\.6\.0/);

	const missingTagSha = run([...base, '--tag', 'v2.6.0']);
	assert.notEqual(missingTagSha.status, 0);
	assert.match(missingTagSha.stderr, /--tag-sha is required/);

	const wrongTag = run([...base, '--tag', 'v2.5.0', '--tag-sha', SHA]);
	assert.notEqual(wrongTag.status, 0);
	assert.match(wrongTag.stderr, /does not match the package version/);

	const wrongCommit = run([...base, '--tag', 'v2.6.0', '--tag-sha', OTHER_SHA]);
	assert.notEqual(wrongCommit.status, 0);
	assert.match(wrongCommit.stderr, /tag identifies a different commit/);

	const foreignRun = run([
		'source',
		'--tag',
		'',
		'--sha',
		SHA,
		'--run-sha',
		OTHER_SHA,
		'--version',
		'2.6.0'
	]);
	assert.notEqual(foreignRun.status, 0);
	assert.match(foreignRun.stderr, /run started from a different commit/);
});

test('the validation matrix keeps its existing job names and inputs', () => {
	const validate = jobBlock(DESKTOP_WORKFLOW, 'validate-desktop');
	assert.match(validate, /platform: \[ubuntu-24\.04, windows-2022, macos-15\]/);
	const native = jobBlock(DESKTOP_WORKFLOW, 'native-validation');
	assert.match(native, /platform: \[ubuntu-24\.04, windows-2022, macos-15\]/);
	// The cached Rust dependency audit stays in the Rust matrix.
	assert.match(validate, /cargo-audit/);
	assert.match(validate, /--deny unsound/);
	// The required aggregate still requires every matrix result.
	const gate = jobBlock(DESKTOP_WORKFLOW, 'desktop-validation');
	assert.match(gate, /VALIDATE_RESULT/);
	assert.match(gate, /NATIVE_RESULT/);
	assert.match(gate, /WEB_BENCHMARK_RESULT/);
});

test('the release caller explicitly requests CLI archives', () => {
	const cli = jobBlock(DESKTOP_WORKFLOW, 'cli-package');
	assert.match(cli, /with:\n\s+upload_build_artifacts: true/);
});

test('publication reads asset digests from REST and cannot overwrite existing bytes', () => {
	const publish = jobBlock(DESKTOP_WORKFLOW, 'publish-desktop-beta');
	assert.doesNotMatch(publish, /--clobber/);
	assert.match(publish, /gh api "repos\/\$GH_REPO\/releases\/tags\/\$DESKTOP_TAG"/);
	assert.match(publish, /assets: \.assets/);
});

test('the standalone release workflow keeps only manual release management', () => {
	assert.equal(
		(RELEASE_WORKFLOW.match(/group: release-please/g) ?? []).length,
		1,
		'a workflow and its job must not acquire the same concurrency group'
	);
	assert.doesNotMatch(RELEASE_WORKFLOW, /^\s*push:/m);
	assert.match(RELEASE_WORKFLOW, /^on:\n {2}workflow_dispatch:/m);
	assert.doesNotMatch(RELEASE_WORKFLOW, /uses: \.\/\.github\/workflows\/desktop\.yml/);
	assert.match(RELEASE_WORKFLOW, /concurrency:\n {2}group: release-please/);
	assert.match(RELEASE_WORKFLOW, /googleapis\/release-please-action@[0-9a-f]{40}/);
});

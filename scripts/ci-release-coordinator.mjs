// Release coordination for one Desktop workflow run.
//
// One run owns the complete release path. The Desktop matrix validates the
// pushed commit, the release-please job creates the source release after the
// Desktop validation gate succeeds, and the packaging jobs read the exact
// source identity from the plan job. No job waits for another workflow run, so
// no runner polls `gh run watch` and no privileged `workflow_run` event is
// needed.
//
// `source` validates the tag and commit identity for the validation checkout.
// `plan` decides whether this run builds, publishes or only validates, and it
// fails closed when a required result is missing or unsuccessful. `gate` is the
// required Desktop validation aggregate. `verify-cli` checks the exact-source
// CLI build deliverables of this run against an explicit allowlist.
//
// All commands are pure functions over their inputs, so the tests execute the
// real command line and the workflow keeps only the wiring.

import {
	appendFileSync,
	existsSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { basename, join, resolve } from 'node:path';

const SHA_PATTERN = /^[a-f0-9]{40}$/;
const TAG_PATTERN = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

const RELEASE_EVENTS = new Set(['push', 'workflow_dispatch']);
const CLI_MANIFEST_SCHEMA = 'deckmark-cli-install/1';

/**
 * CLI build deliverables for one source commit.
 * The artifact name uses the Node platform name. The archive name uses the
 * packer release name, which spells Windows as `windows`.
 */
export const CLI_TARGETS = Object.freeze([
	Object.freeze({
		nodePlatform: 'linux',
		nodeArch: 'x64',
		platform: 'linux',
		arch: 'x64',
		os: 'linux',
		extension: '.tar.gz'
	}),
	Object.freeze({
		nodePlatform: 'win32',
		nodeArch: 'x64',
		platform: 'win32',
		arch: 'x64',
		os: 'windows',
		extension: '.zip'
	}),
	Object.freeze({
		nodePlatform: 'darwin',
		nodeArch: 'arm64',
		platform: 'darwin',
		arch: 'arm64',
		os: 'darwin',
		extension: '.tar.gz'
	})
]);

/**
 * Validate a release tag against the package version.
 * @param {string} tag
 * @param {string} version
 */
export function assertTagName(tag, version) {
	if (!TAG_PATTERN.test(tag)) throw new Error(`Invalid release tag: ${tag}`);
	if (tag !== `v${version}`) {
		throw new Error(`The release tag ${tag} does not match the package version ${version}`);
	}
}

/**
 * Refuse a result that is not a successful completed job.
 * @param {string} label
 * @param {string} value
 */
function requireSuccess(label, value) {
	if (value !== 'success') {
		throw new Error(`${label} is not successful: ${value === '' ? '(missing)' : value}`);
	}
}

/**
 * A release commit must change a Desktop path, otherwise the validation jobs
 * and the source resolution are skipped. Say so, instead of reporting only a
 * skipped dependency.
 * @param {string} value
 */
function requireResolution(value) {
	if (value === 'success') return;
	if (value === 'skipped') {
		throw new Error(
			'The source resolution was skipped because the release commit changed no Desktop path. Package this tag with a manual Desktop run that sets release_tag.'
		);
	}
	throw new Error(`the source resolution is not successful: ${value === '' ? '(missing)' : value}`);
}

/**
 * Validate the source identity of one committed tag.
 * @param {{ tag: string, version: string, sha: string, runSha: string, tagSha: string }} input
 */
export function verifySourceIdentity({ tag, version, sha, runSha, tagSha }) {
	if (!SHA_PATTERN.test(sha)) throw new Error(`Invalid source commit: ${sha}`);
	if (!VERSION_PATTERN.test(version)) throw new Error(`Invalid package version: ${version}`);
	if (tag !== '') {
		assertTagName(tag, version);
		if (!SHA_PATTERN.test(tagSha)) throw new Error('The release tag commit is missing');
		if (tagSha !== sha) {
			throw new Error(`The release tag identifies a different commit: ${tagSha}`);
		}
		if (runSha !== sha) {
			throw new Error(`The run started from a different commit: ${runSha}`);
		}
	} else if (runSha !== sha) {
		throw new Error(`The run started from a different commit: ${runSha}`);
	}
	return sha;
}

/**
 * Decide what this run does.
 * @param {{
 *   eventName: string,
 *   ref: string,
 *   releaseCreated: string,
 *   tagName: string,
 *   inputTag: string,
 *   packagingOnly: boolean,
 *   releasePleaseResult: string,
 *   validationResult: string,
 *   resolveResult: string,
 *   changesResult: string,
 *   sha: string,
 *   runSha: string,
 *   tagSha: string,
 *   version: string
 * }} input
 */
export function planRelease(input) {
	const {
		eventName,
		ref,
		releaseCreated,
		tagName,
		inputTag,
		packagingOnly,
		releasePleaseResult,
		validationResult,
		resolveResult,
		changesResult,
		sha,
		runSha,
		tagSha,
		version
	} = input;
	if (!RELEASE_EVENTS.has(eventName)) {
		throw new Error(`${eventName} is not a release event`);
	}
	if (!SHA_PATTERN.test(sha)) throw new Error(`Invalid source commit: ${sha}`);
	if (!VERSION_PATTERN.test(version)) throw new Error(`Invalid package version: ${version}`);
	requireSuccess('Desktop change detection', changesResult);

	/** @type {{ build: boolean, publish: boolean, packaging: boolean, tag: string, sha: string, reason: string }} */
	const plan = { build: false, publish: false, packaging: false, tag: '', sha, reason: '' };

	if (eventName === 'push') {
		if (ref !== 'refs/heads/main')
			throw new Error(`A push run outside main cannot release: ${ref}`);
		if (!['', 'true', 'false'].includes(releaseCreated)) {
			throw new Error(`Unexpected release_created value: ${releaseCreated}`);
		}
		if (releaseCreated !== 'true') {
			return { ...plan, reason: 'push:no-release' };
		}
		if (tagName === '') throw new Error('release-please reported a release without a tag name');
		requireSuccess('release-please', releasePleaseResult);
		requireSuccess('Desktop validation', validationResult);
		requireResolution(resolveResult);
		verifySourceIdentity({ tag: tagName, version, sha, runSha, tagSha });
		return { ...plan, build: true, publish: true, tag: tagName, reason: 'push:release' };
	}

	// A manual run.
	if (inputTag !== '' && packagingOnly) {
		throw new Error('A packaging-only run cannot publish a release');
	}
	if (inputTag !== '') {
		requireSuccess('Desktop validation', validationResult);
		requireResolution(resolveResult);
		verifySourceIdentity({ tag: inputTag, version, sha, runSha, tagSha });
		return { ...plan, build: true, publish: true, tag: inputTag, reason: 'dispatch:release' };
	}
	if (packagingOnly) {
		requireSuccess('Desktop validation', validationResult);
		requireResolution(resolveResult);
		verifySourceIdentity({ tag: '', version, sha, runSha, tagSha });
		return {
			...plan,
			build: true,
			packaging: true,
			tag: `v${version}`,
			reason: 'dispatch:packaging'
		};
	}
	return { ...plan, reason: 'dispatch:validate' };
}

/**
 * Evaluate the required Desktop validation aggregate.
 * @param {{
 *   changesResult: string,
 *   validationRequired: string,
 *   full: string,
 *   tier: string,
 *   resolveResult: string,
 *   validateResult: string,
 *   nativeResult: string,
 *   webBuildResult: string,
 *   webBenchmarkResult: string
 * }} input
 */
export function evaluateValidationGate(input) {
	const { changesResult, validationRequired, full, tier } = input;
	if (changesResult !== 'success') {
		throw new Error('Desktop change detection failed. The matrix result is not a pass.');
	}
	if (!['true', 'false'].includes(validationRequired)) {
		throw new Error(
			`VALIDATION_REQUIRED must be true or false, not ${validationRequired === '' ? '(missing)' : validationRequired}`
		);
	}
	if (validationRequired === 'false') {
		return { message: 'Desktop validation is not required for these paths.' };
	}
	if (full !== 'true' || tier !== 'full') {
		throw new Error(
			[
				`Desktop validation tier is '${tier}' (full='${full}').`,
				'Draft runs defer the native and benchmark matrix. This check is incomplete and is not a pass.',
				'Mark the pull request ready for review to run the full matrix on the exact HEAD.'
			].join('\n')
		);
	}
	const expected = [
		['RESOLVE_RESULT', input.resolveResult],
		['VALIDATE_RESULT', input.validateResult],
		['NATIVE_RESULT', input.nativeResult],
		['WEB_BUILD_RESULT', input.webBuildResult],
		['WEB_BENCHMARK_RESULT', input.webBenchmarkResult]
	];
	const failures = expected
		.filter(([, value]) => value !== 'success')
		.map(([name, value]) => `${name}=${value === '' ? '(missing)' : value}`);
	if (failures.length > 0) {
		throw new Error(`Desktop validation is incomplete and is not a pass: ${failures.join(', ')}`);
	}
	return { message: 'Desktop validation passed. Every required job succeeded.' };
}

/** @param {Buffer} buffer @param {number} start @param {number} length */
function readText(buffer, start, length) {
	const slice = buffer.subarray(start, start + length);
	const end = slice.indexOf(0);
	return slice.toString('utf8', 0, end === -1 ? slice.length : end);
}

/**
 * Read the entry names and data of a tar archive.
 * @param {Buffer} buffer
 */
function readTarEntries(buffer) {
	/** @type {{ name: string, data: Buffer }[]} */
	const entries = [];
	let offset = 0;
	while (offset + 512 <= buffer.length) {
		const header = buffer.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;
		const name = readText(header, 0, 100);
		const prefix = readText(header, 345, 155);
		const size = Number.parseInt(readText(header, 124, 12).trim() || '0', 8);
		if (!Number.isInteger(size) || size < 0) throw new Error('Invalid tar entry size');
		const type = String.fromCharCode(header[156]);
		const dataStart = offset + 512;
		if (type === '0' || type === '\0') {
			entries.push({
				name: prefix === '' ? name : `${prefix}/${name}`,
				data: buffer.subarray(dataStart, dataStart + size)
			});
		}
		offset = dataStart + Math.ceil(size / 512) * 512;
	}
	return entries;
}

/**
 * Read the entry names of a zip archive from its central directory.
 * @param {Buffer} buffer
 */
function readZipNames(buffer) {
	let end = -1;
	const floor = Math.max(0, buffer.length - 22 - 65535);
	for (let index = buffer.length - 22; index >= floor; index -= 1) {
		if (buffer.readUInt32LE(index) === 0x06054b50) {
			end = index;
			break;
		}
	}
	if (end === -1) throw new Error('Not a zip archive');
	const count = buffer.readUInt16LE(end + 10);
	let offset = buffer.readUInt32LE(end + 16);
	/** @type {string[]} */
	const names = [];
	for (let index = 0; index < count; index += 1) {
		if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
			throw new Error('Invalid zip central directory');
		}
		const nameLength = buffer.readUInt16LE(offset + 28);
		const extraLength = buffer.readUInt16LE(offset + 30);
		const commentLength = buffer.readUInt16LE(offset + 32);
		names.push(buffer.toString('utf8', offset + 46, offset + 46 + nameLength));
		offset += 46 + nameLength + extraLength + commentLength;
	}
	return names;
}

/**
 * Read `deckmark-build.json` from an archive and validate it.
 * @param {{ name: string, bytes: Buffer, target: (typeof CLI_TARGETS)[number] }} input
 * @param {{ sha: string, version: string }} expected
 */
function verifyArchiveManifest({ name, bytes, target }, expected) {
	let manifest;
	if (target.extension === '.zip') {
		const names = readZipNames(bytes);
		const root = archiveRoot(expected.version, target);
		for (const required of [`${root}/deckmark-build.json`, `${root}/SHA256SUMS`]) {
			if (!names.includes(required)) {
				throw new Error(`The archive ${name} has no ${basename(required)} entry.`);
			}
		}
		// The zip reader lists central-directory names only. The installed
		// package suite of the called workflow reads the manifest content, and
		// this job binds the artifact to that exact run and commit.
		return;
	}
	const entries = readTarEntries(gunzipSync(bytes));
	const entry = entries.find((candidate) => candidate.name.endsWith('/deckmark-build.json'));
	if (!entry) throw new Error(`The archive ${name} has no deckmark-build.json manifest.`);
	try {
		manifest = JSON.parse(entry.data.toString('utf8'));
	} catch {
		throw new Error(`The archive ${name} records a manifest that is not JSON.`);
	}
	if (manifest.schema !== CLI_MANIFEST_SCHEMA) {
		throw new Error(`The archive ${name} records an unsupported manifest schema.`);
	}
	if (manifest.version !== expected.version) {
		throw new Error(
			`The archive ${name} records a different package version: ${String(manifest.version)}`
		);
	}
	if (manifest.source?.gitSha !== expected.sha) {
		throw new Error(
			`The archive ${name} records a different source commit: ${String(manifest.source?.gitSha)}`
		);
	}
	if (manifest.source?.dirty !== false) {
		throw new Error(`The archive ${name} records a dirty source tree.`);
	}
	if (manifest.target?.platform !== target.platform || manifest.target?.arch !== target.arch) {
		throw new Error(
			`The archive ${name} records a different target: ${String(manifest.target?.platform)}-${String(manifest.target?.arch)}`
		);
	}
}

/** @param {string} version @param {(typeof CLI_TARGETS)[number]} target */
function artifactName(sha, target) {
	return `deckmark-cli-${sha}-${target.nodePlatform}-${target.nodeArch}`;
}

/** @param {string} version @param {(typeof CLI_TARGETS)[number]} target */
function archiveRoot(version, target) {
	return `deckmark-cli-${version}-${target.os}-${target.arch}`;
}

/** @param {string} version @param {(typeof CLI_TARGETS)[number]} target */
function archiveName(version, target) {
	return `${archiveRoot(version, target)}${target.extension}`;
}

/**
 * Verify the exact-source CLI build deliverables of this run.
 * The allowlist is the three supported targets. A missing, extra, foreign or
 * modified archive fails the check.
 * @param {{ directory: string, sha: string, version: string }} input
 */
export function verifyCliDeliverables({ directory, sha, version }) {
	if (!SHA_PATTERN.test(sha)) throw new Error(`Invalid source commit: ${sha}`);
	if (!VERSION_PATTERN.test(version)) throw new Error(`Invalid package version: ${version}`);
	if (!existsSync(directory) || !statSync(directory).isDirectory()) {
		throw new Error(`The CLI artifact directory does not exist: ${directory}`);
	}
	const actual = readdirSync(directory, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
	const expected = CLI_TARGETS.map((target) => artifactName(sha, target)).sort();
	const missing = expected.filter((name) => !actual.includes(name));
	if (missing.length > 0) {
		throw new Error(`Missing CLI artifact: ${missing.join(', ')}`);
	}
	const unexpected = actual.filter((name) => !expected.includes(name));
	if (unexpected.length > 0) {
		throw new Error(`Unexpected CLI artifact: ${unexpected.join(', ')}`);
	}

	const archives = CLI_TARGETS.map((target) => {
		const artifact = artifactName(sha, target);
		const directoryEntries = readdirSync(join(directory, artifact)).sort();
		const expectedArchive = archiveName(version, target);
		const unexpectedArchive = directoryEntries.filter((name) => name !== expectedArchive);
		if (unexpectedArchive.length > 0) {
			throw new Error(`Unexpected CLI archive in ${artifact}: ${unexpectedArchive.join(', ')}`);
		}
		if (!directoryEntries.includes(expectedArchive)) {
			throw new Error(`Missing CLI archive in ${artifact}: ${expectedArchive}`);
		}
		const bytes = readFileSync(join(directory, artifact, expectedArchive));
		verifyArchiveManifest({ name: expectedArchive, bytes, target }, { sha, version });
		return {
			name: expectedArchive,
			artifact,
			platform: target.platform,
			arch: target.arch,
			bytes: bytes.length,
			sha256: createHash('sha256').update(bytes).digest('hex')
		};
	});
	return { sha, version, archives };
}

/** @param {string[]} argv */
function parseArguments(argv) {
	/** @type {Record<string, string>} */
	const values = {};
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (!argument.startsWith('--')) throw new Error(`unknown argument: ${argument}`);
		const value = argv[index + 1];
		if (typeof value !== 'string' || value.startsWith('--')) {
			throw new Error(`missing value for ${argument}`);
		}
		values[argument.slice(2)] = value;
		index += 1;
	}
	return values;
}

/** @param {Record<string, string>} values @param {string} name */
function readFlag(values, name) {
	const value = values[name];
	if (value === undefined) throw new Error(`--${name} is required`);
	return value;
}

/** @param {Record<string, string>} values @param {string} name */
function optionalFlag(values, name, fallback = '') {
	const value = values[name];
	if (value === undefined) return fallback;
	return value;
}

/** @param {Record<string, string>} values */
function assertKnown(values, allowed) {
	for (const name of Object.keys(values)) {
		if (!allowed.includes(name)) throw new Error(`unknown argument: --${name}`);
	}
}

/** @param {Record<string, string | boolean>} outputs @param {string} path */
function writeOutputs(outputs, path) {
	const text = Object.entries(outputs)
		.map(([key, value]) => `${key}=${String(value)}\n`)
		.join('');
	if (path === '') {
		process.stdout.write(text);
	} else {
		appendFileSync(path, text);
	}
}

/** @param {Record<string, string>} values */
function runSource(values) {
	assertKnown(values, ['tag', 'tag-sha', 'sha', 'run-sha', 'version', 'output']);
	const tag = optionalFlag(values, 'tag');
	const tagSha = optionalFlag(values, 'tag-sha');
	if (tag !== '' && tagSha === '') throw new Error('--tag-sha is required with --tag');
	const sha = readFlag(values, 'sha');
	const runSha = readFlag(values, 'run-sha');
	const version = readFlag(values, 'version');
	verifySourceIdentity({ tag, version, sha, runSha, tagSha });
	process.stdout.write(`Source ${sha} ${tag === '' ? 'has no release tag' : `matches ${tag}`}.\n`);
	writeOutputs({ sha }, optionalFlag(values, 'output'));
}

/** @param {Record<string, string>} values */
function runPlan(values) {
	assertKnown(values, [
		'event-name',
		'ref',
		'release-created',
		'tag-name',
		'input-tag',
		'packaging-only',
		'release-please-result',
		'validation-result',
		'resolve-result',
		'changes-result',
		'sha',
		'run-sha',
		'tag-sha',
		'version',
		'output'
	]);
	const packagingOnly = optionalFlag(values, 'packaging-only');
	if (!['', 'true', 'false'].includes(packagingOnly)) {
		throw new Error(`packaging_only must be true or false: ${packagingOnly}`);
	}
	const plan = planRelease({
		eventName: readFlag(values, 'event-name'),
		ref: readFlag(values, 'ref'),
		releaseCreated: optionalFlag(values, 'release-created'),
		tagName: optionalFlag(values, 'tag-name'),
		inputTag: optionalFlag(values, 'input-tag'),
		packagingOnly: packagingOnly === 'true',
		releasePleaseResult: optionalFlag(values, 'release-please-result'),
		validationResult: optionalFlag(values, 'validation-result'),
		resolveResult: optionalFlag(values, 'resolve-result'),
		changesResult: optionalFlag(values, 'changes-result'),
		sha: readFlag(values, 'sha'),
		runSha: readFlag(values, 'run-sha'),
		tagSha: optionalFlag(values, 'tag-sha'),
		version: readFlag(values, 'version')
	});
	writeOutputs(plan, optionalFlag(values, 'output'));
}

function runGate() {
	const read = (name) => process.env[name] ?? '';
	const { message } = evaluateValidationGate({
		changesResult: read('CHANGES_RESULT'),
		validationRequired: read('VALIDATION_REQUIRED'),
		full: read('FULL'),
		tier: read('TIER'),
		resolveResult: read('RESOLVE_RESULT'),
		validateResult: read('VALIDATE_RESULT'),
		nativeResult: read('NATIVE_RESULT'),
		webBuildResult: read('WEB_BUILD_RESULT'),
		webBenchmarkResult: read('WEB_BENCHMARK_RESULT')
	});
	process.stdout.write(`${message}\n`);
}

/** @param {Record<string, string>} values */
function runVerifyCli(values) {
	assertKnown(values, ['dir', 'sha', 'version', 'report']);
	const report = verifyCliDeliverables({
		directory: resolve(readFlag(values, 'dir')),
		sha: readFlag(values, 'sha'),
		version: readFlag(values, 'version')
	});
	const path = optionalFlag(values, 'report');
	if (path !== '') writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
	process.stdout.write(
		`CLI deliverables for ${report.sha}: ${report.archives.map((archive) => archive.name).join(', ')}.\n`
	);
}

function main(argv) {
	const [command, ...rest] = argv;
	const values = parseArguments(rest);
	if (command === 'source') return runSource(values);
	if (command === 'plan') return runPlan(values);
	if (command === 'gate') {
		assertKnown(values, []);
		return runGate();
	}
	if (command === 'verify-cli') return runVerifyCli(values);
	throw new Error(`unknown command: ${command ?? '(none)'}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
	try {
		main(process.argv.slice(2));
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	}
}

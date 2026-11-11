// Release orchestration for the Desktop Beta channel.
//
// The publish job must prove three things before it uploads a byte:
// the source release identifies the validated commit, the release is the
// expected prerelease channel, and an existing asset is never replaced with
// different bytes. The Beta notes carry a download table and the exact source
// link. The functions are pure so the local tests can cover each refusal.

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { basename, resolve } from 'node:path';
import { DESKTOP_RELEASE_FORMATS, formatForFile } from './desktop-release-policy.mjs';

/** The published checksum file. It never lists its own digest. */
export const CHECKSUM_ASSET = 'SHA256SUMS';

/**
 * @typedef {{ name: string, digest?: string }} ReleaseAsset
 * @typedef {{ name: string, sha256: string }} Checksum
 */

/**
 * Verify that the source release identifies the validated commit.
 * @param {{ release: any, tag: string, sha: string, tagSha: string }} input
 */
export function verifyReleaseSource({ release, tag, sha, tagSha }) {
	if (!release) throw new Error('The source release does not exist');
	if (!Number.isInteger(release.id)) throw new Error('The source release id is missing');
	if (release.tag_name !== tag) {
		throw new Error(`The source release tag does not match the packaging tag: ${release.tag_name}`);
	}
	if (release.draft === true) throw new Error('The source release is a draft release');
	if (release.prerelease === true) {
		throw new Error('The source release is a prerelease source release');
	}
	if (tagSha !== sha) {
		throw new Error('The source release tag and the validated commit differ');
	}
	return true;
}

/** @param {string} path @returns {Checksum[]} */
export function readChecksums(path) {
	const lines = readFileSync(path, 'utf8')
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length === 0) throw new Error('The checksum file is empty');
	return lines.map((line) => {
		const match = /^([a-f0-9]{64}) {2}(\S+)$/.exec(line);
		if (!match) throw new Error(`Invalid checksum line: ${line}`);
		if (match[2] === CHECKSUM_ASSET) {
			throw new Error(`The checksum file must not list itself: ${CHECKSUM_ASSET}`);
		}
		return { sha256: match[1], name: match[2] };
	});
}

/**
 * Hash the checksum file as published. The digest is attached to the asset
 * plan; it is never written back into SHA256SUMS.
 * @param {string} path
 * @returns {{ name: string, sha256: string }}
 */
export function checksumFileAsset(path) {
	const name = basename(path);
	if (name !== CHECKSUM_ASSET) {
		throw new Error(`The checksum file must be named ${CHECKSUM_ASSET}: ${name}`);
	}
	return {
		name,
		sha256: createHash('sha256').update(readFileSync(path)).digest('hex')
	};
}

/**
 * Attach the policy platform and format to each released file.
 * @param {Checksum[]} checksums
 */
export function describeReleaseAssets(checksums) {
	return checksums.map(({ name }) => {
		const format = formatForFile(name);
		if (!format) throw new Error(`Unsupported installer format: ${name}`);
		return { name, platform: format.platform, format: format.bundle, label: format.label };
	});
}

/** @param {{ format: string, platform: string }[]} assets */
export function assertCompleteReleaseAssets(assets) {
	for (const format of DESKTOP_RELEASE_FORMATS) {
		if (
			!assets.some((asset) => asset.format === format.bundle && asset.platform === format.platform)
		) {
			throw new Error(`Missing installer format: ${format.id}`);
		}
	}
}

/**
 * Decide which files to upload. An asset with the same name and the same
 * digest is skipped, a different digest is refused, and an asset outside the
 * policy is refused. This keeps an old release tag from changing silently.
 * The published checksum file is one more expected asset. A release that
 * already carries SHA256SUMS is verified by the actual GitHub digest.
 * @param {{ existingAssets?: ReleaseAsset[], checksums: Checksum[], checksumFile?: { name: string, sha256: string } }} input
 */
export function planAssetUpload({ existingAssets = [], checksums, checksumFile }) {
	const expected = new Map(checksums.map(({ name, sha256 }) => [name, sha256]));
	if (checksumFile) {
		if (checksumFile.name !== CHECKSUM_ASSET) {
			throw new Error(`The checksum asset must be named ${CHECKSUM_ASSET}`);
		}
		if (!/^[a-f0-9]{64}$/.test(checksumFile.sha256)) {
			throw new Error(`Invalid checksum file digest: ${checksumFile.sha256}`);
		}
		expected.set(checksumFile.name, checksumFile.sha256);
	}
	const present = new Set();
	const skip = [];
	for (const asset of existingAssets) {
		if (!expected.has(asset.name)) {
			throw new Error(`Unexpected asset in the existing release: ${asset.name}`);
		}
		if (typeof asset.digest !== 'string' || !asset.digest.startsWith('sha256:')) {
			throw new Error(`Cannot verify the existing digest of ${asset.name}`);
		}
		if (asset.digest.slice('sha256:'.length) !== expected.get(asset.name)) {
			throw new Error(`Refusing to replace ${asset.name}: the release holds different bytes`);
		}
		present.add(asset.name);
		skip.push(asset.name);
	}
	const names = checksums.map(({ name }) => name);
	if (checksumFile) names.push(checksumFile.name);
	const upload = names.filter((name) => !present.has(name));
	return { upload, skip };
}

/**
 * Render the Desktop Beta release notes.
 * @param {{
 *   tag: string,
 *   version: string,
 *   sha: string,
 *   repository: string,
 *   assets: { name: string, platform: string, format: string, label?: string }[]
 * }} input
 */
export function renderBetaReleaseNotes({ tag, version, sha, repository, assets }) {
	if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid source commit');
	if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid repository');
	assertCompleteReleaseAssets(assets);
	const order = DESKTOP_RELEASE_FORMATS.map((format) => format.id);
	const rows = [...assets]
		.sort((a, b) => {
			const left = order.indexOf(
				DESKTOP_RELEASE_FORMATS.find((f) => f.bundle === a.format && f.platform === a.platform)
					?.id ?? ''
			);
			const right = order.indexOf(
				DESKTOP_RELEASE_FORMATS.find((f) => f.bundle === b.format && f.platform === b.platform)
					?.id ?? ''
			);
			return left - right;
		})
		.map((asset) => {
			const format = DESKTOP_RELEASE_FORMATS.find(
				(candidate) => candidate.bundle === asset.format && candidate.platform === asset.platform
			);
			return `| \`${asset.name}\` | ${format?.label ?? asset.label ?? asset.format} |`;
		});
	return [
		`## Desktop Beta installers`,
		'',
		`Unsigned beta build of DeckMark ${version} from source ${sha.slice(0, 7)}.`,
		'',
		'| File | Build |',
		'| --- | --- |',
		...rows,
		'',
		'Verify each file against `SHA256SUMS`:',
		'',
		'```sh',
		'sha256sum --check SHA256SUMS',
		'```',
		'',
		'Check the GitHub build provenance attestation before you install. macOS Gatekeeper and Windows SmartScreen can show a warning for an unsigned build.',
		'',
		'This prerelease is the Desktop Beta channel. It is not the stable Web Light release.',
		'',
		`[Source at ${sha.slice(0, 7)}](https://github.com/${repository}/tree/${sha})`,
		`[Stable release ${tag}](https://github.com/${repository}/releases/tag/${tag})`,
		''
	].join('\n');
}

/** @param {string[]} argv @param {string} name */
function argument(argv, name) {
	const index = argv.indexOf(`--${name}`);
	if (index === -1 || index === argv.length - 1) throw new Error(`--${name} is required`);
	return argv[index + 1];
}

function runNotes(argv) {
	const tag = argument(argv, 'tag');
	const sha = argument(argv, 'sha');
	const repository = argument(argv, 'repository');
	const checksums = readChecksums(argument(argv, 'sums'));
	const output = argument(argv, 'output');
	const version = tag.replace(/^v/, '');
	const assets = describeReleaseAssets(checksums);
	writeFileSync(output, renderBetaReleaseNotes({ tag, version, sha, repository, assets }));
	process.stdout.write(`Desktop Beta notes for ${tag} list ${assets.length} installers.\n`);
}

function runPlanUpload(argv) {
	const tag = argument(argv, 'tag');
	const sums = argument(argv, 'sums');
	const checksums = readChecksums(sums);
	const checksumFile = checksumFileAsset(sums);
	const output = argument(argv, 'output');
	/** @type {ReleaseAsset[]} */
	let existingAssets = [];
	const releaseIndex = argv.indexOf('--release');
	if (releaseIndex !== -1) {
		const release = JSON.parse(readFileSync(argument(argv, 'release'), 'utf8'));
		if (release.tagName !== tag) {
			throw new Error('The existing Desktop release does not match the expected tag');
		}
		existingAssets = release.assets ?? [];
	}
	const plan = planAssetUpload({ existingAssets, checksums, checksumFile });
	writeFileSync(output, plan.upload.map((name) => `${name}\n`).join(''));
	process.stdout.write(
		`Upload plan for ${tag}: ${plan.upload.length} upload, ${plan.skip.length} unchanged.\n`
	);
}

function runVerifySource(argv) {
	const release = JSON.parse(readFileSync(argument(argv, 'release'), 'utf8'));
	verifyReleaseSource({
		release,
		tag: argument(argv, 'tag'),
		sha: argument(argv, 'sha'),
		tagSha: argument(argv, 'tag-sha')
	});
	process.stdout.write(
		`The source release ${release.tag_name} identifies the validated commits.\n`
	);
}

function main(argv) {
	const [command] = argv;
	if (command === 'notes') return runNotes(argv);
	if (command === 'plan-upload') return runPlanUpload(argv);
	if (command === 'verify-source') return runVerifySource(argv);
	throw new Error(`Unknown command: ${command ?? '(none)'}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	try {
		main(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}

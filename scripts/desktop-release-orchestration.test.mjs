import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const moduleUrl = new URL('./desktop-release-orchestration.mjs', import.meta.url);
const { verifyReleaseSource, planAssetUpload, renderBetaReleaseNotes, readChecksums } =
	await import(moduleUrl.href);

const sha = 'c'.repeat(40);

test('the source release must identify the validated commit', () => {
	const release = {
		id: 42,
		tag_name: 'v2.5.3',
		draft: false,
		prerelease: false,
		target_commitish: 'main',
		assets: []
	};
	assert.doesNotThrow(() => verifyReleaseSource({ release, tag: 'v2.5.3', sha, tagSha: sha }));
	for (const [overrides, pattern] of [
		[{ tag_name: 'v2.5.4' }, /release tag does not match/],
		[{ draft: true }, /draft release/],
		[{ prerelease: true }, /prerelease source release/],
		[{ id: undefined }, /release id is missing/]
	]) {
		assert.throws(
			() =>
				verifyReleaseSource({
					release: { ...release, ...overrides },
					tag: 'v2.5.3',
					sha,
					tagSha: sha
				}),
			/** @type {RegExp} */ (pattern)
		);
	}
	assert.throws(
		() => verifyReleaseSource({ release, tag: 'v2.5.3', sha, tagSha: 'd'.repeat(40) }),
		/release tag and the validated commit differ/
	);
	assert.throws(
		() => verifyReleaseSource({ release: null, tag: 'v2.5.3', sha, tagSha: sha }),
		/The source release does not exist/
	);
});

test('an unchanged asset is skipped and a changed asset is refused', () => {
	const checksums = [
		{ name: 'deckmark_2.5.3_amd64.deb', sha256: '1'.repeat(64) },
		{ name: 'deckmark_2.5.3_x64-setup.exe', sha256: '2'.repeat(64) }
	];
	const plan = planAssetUpload({
		existingAssets: [{ name: 'deckmark_2.5.3_amd64.deb', digest: `sha256:${'1'.repeat(64)}` }],
		checksums
	});
	assert.deepEqual(plan.upload, ['deckmark_2.5.3_x64-setup.exe']);
	assert.deepEqual(plan.skip, ['deckmark_2.5.3_amd64.deb']);

	assert.throws(
		() =>
			planAssetUpload({
				existingAssets: [{ name: 'deckmark_2.5.3_amd64.deb', digest: `sha256:${'9'.repeat(64)}` }],
				checksums
			}),
		/Refusing to replace deckmark_2\.5\.3_amd64\.deb/
	);
	assert.throws(
		() => planAssetUpload({ existingAssets: [{ name: 'deckmark_2.5.3_amd64.deb' }], checksums }),
		/Cannot verify the existing digest of deckmark_2\.5\.3_amd64\.deb/
	);
	assert.throws(
		() =>
			planAssetUpload({
				existingAssets: [{ name: 'deckmark_2.5.2_amd64.deb', digest: `sha256:${'1'.repeat(64)}` }],
				checksums
			}),
		/Unexpected asset in the existing release: deckmark_2\.5\.2_amd64\.deb/
	);
});

test('the checksum file is parsed strictly', () => {
	const directory = mkdtempSync(join(tmpdir(), 'desktop-checksums-'));
	const path = join(directory, 'SHA256SUMS');
	writeFileSync(path, `${'a'.repeat(64)}  deckmark_2.5.3_amd64.deb\n${'b'.repeat(64)}  b.exe\n`);
	assert.deepEqual(readChecksums(path), [
		{ name: 'deckmark_2.5.3_amd64.deb', sha256: 'a'.repeat(64) },
		{ name: 'b.exe', sha256: 'b'.repeat(64) }
	]);
	writeFileSync(path, 'not a checksum\n');
	assert.throws(() => readChecksums(path), /Invalid checksum line: not a checksum/);
	writeFileSync(path, '\n');
	assert.throws(() => readChecksums(path), /The checksum file is empty/);
});

test('the Beta notes list every accepted download and the exact source', () => {
	const notes = renderBetaReleaseNotes({
		tag: 'v2.5.3',
		version: '2.5.3',
		sha,
		repository: 'ThomasCrouzet/deckmark',
		assets: [
			{ name: 'deckmark_2.5.3_aarch64.dmg', platform: 'macos-15', format: 'dmg' },
			{ name: 'deckmark_2.5.3_amd64.AppImage', platform: 'ubuntu-24.04', format: 'appimage' },
			{ name: 'deckmark_2.5.3_amd64.deb', platform: 'ubuntu-24.04', format: 'deb' },
			{ name: 'deckmark_2.5.3_x64-setup.exe', platform: 'windows-2022', format: 'nsis' }
		],
		sha256sums: 'SHA256SUMS'
	});
	assert.match(
		notes,
		/\[Source at c{7}\]\(https:\/\/github\.com\/ThomasCrouzet\/deckmark\/tree\/c{40}\)/
	);
	for (const name of [
		'deckmark_2.5.3_aarch64.dmg',
		'deckmark_2.5.3_amd64.AppImage',
		'deckmark_2.5.3_amd64.deb',
		'deckmark_2.5.3_x64-setup.exe'
	]) {
		assert.ok(notes.includes(name), name);
	}
	assert.match(notes, /unsigned/);
	assert.match(notes, /prerelease/);
	assert.match(notes, /SHA256SUMS/);
	assert.doesNotMatch(notes, /[\u2013\u2014]/);
	assert.doesNotMatch(notes, /\.msi|\.rpm/);
});

test('the notes command refuses a removed format and an incomplete table', () => {
	const directory = mkdtempSync(join(tmpdir(), 'desktop-notes-'));
	const sums = join(directory, 'SHA256SUMS');
	const output = join(directory, 'notes.md');
	writeFileSync(
		sums,
		[
			`${'a'.repeat(64)}  deckmark_2.5.3_macOS_Apple-Silicon.dmg`,
			`${'b'.repeat(64)}  deckmark_2.5.3_amd64.deb`,
			`${'c'.repeat(64)}  deckmark_2.5.3_amd64.AppImage`,
			`${'d'.repeat(64)}  deckmark_2.5.3_x64-setup.exe`
		].join('\n') + '\n'
	);
	const ok = spawnSync(
		process.execPath,
		[
			moduleUrl.pathname,
			'notes',
			'--tag',
			'v2.5.3',
			'--sha',
			sha,
			'--repository',
			'ThomasCrouzet/deckmark',
			'--sums',
			sums,
			'--output',
			output
		],
		{ encoding: 'utf8' }
	);
	assert.equal(ok.status, 0, ok.stderr);
	const notes = readFileSync(output, 'utf8');
	assert.equal((notes.match(/\| `deckmark_/g) ?? []).length, 4);
	assert.match(notes, /deckmark_2\.5\.3_macOS_Apple-Silicon\.dmg/);

	writeFileSync(sums, `${'a'.repeat(64)}  deckmark_2.5.3_aarch64.dmg\n`);
	const missing = spawnSync(
		process.execPath,
		[
			moduleUrl.pathname,
			'notes',
			'--tag',
			'v2.5.3',
			'--sha',
			sha,
			'--repository',
			'ThomasCrouzet/deckmark',
			'--sums',
			sums,
			'--output',
			join(directory, 'missing.md')
		],
		{ encoding: 'utf8' }
	);
	assert.notEqual(missing.status, 0);
	assert.match(missing.stderr, /Missing installer format/);

	writeFileSync(
		sums,
		[
			`${'a'.repeat(64)}  deckmark_2.5.3_aarch64.dmg`,
			`${'b'.repeat(64)}  deckmark_2.5.3_amd64.deb`,
			`${'c'.repeat(64)}  deckmark_2.5.3_amd64.AppImage`,
			`${'d'.repeat(64)}  deckmark_2.5.3_x64-setup.exe`,
			`${'e'.repeat(64)}  deckmark_2.5.3_x64_en-US.msi`
		].join('\n') + '\n'
	);
	const removed = spawnSync(
		process.execPath,
		[
			moduleUrl.pathname,
			'notes',
			'--tag',
			'v2.5.3',
			'--sha',
			sha,
			'--repository',
			'ThomasCrouzet/deckmark',
			'--sums',
			sums,
			'--output',
			join(directory, 'removed.md')
		],
		{ encoding: 'utf8' }
	);
	assert.notEqual(removed.status, 0);
	assert.match(removed.stderr, /Unsupported installer format/);
});

test('the upload plan command refuses an unknown tag and writes the upload list', () => {
	const directory = mkdtempSync(join(tmpdir(), 'desktop-plan-'));
	const sums = join(directory, 'SHA256SUMS');
	const release = join(directory, 'release.json');
	writeFileSync(sums, `${'a'.repeat(64)}  deckmark_2.5.3_amd64.deb\n`);
	writeFileSync(release, JSON.stringify({ tagName: 'desktop-v2.5.3', assets: [] }));
	const result = spawnSync(
		process.execPath,
		[
			moduleUrl.pathname,
			'plan-upload',
			'--release',
			release,
			'--sums',
			sums,
			'--tag',
			'desktop-v2.5.3',
			'--output',
			join(directory, 'upload.txt')
		],
		{ encoding: 'utf8' }
	);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(readFileSync(join(directory, 'upload.txt'), 'utf8'), 'deckmark_2.5.3_amd64.deb\n');
	const mismatch = spawnSync(
		process.execPath,
		[
			moduleUrl.pathname,
			'plan-upload',
			'--release',
			release,
			'--sums',
			sums,
			'--tag',
			'desktop-v2.5.2',
			'--output',
			join(directory, 'other.txt')
		],
		{ encoding: 'utf8' }
	);
	assert.notEqual(mismatch.status, 0);
	assert.match(mismatch.stderr, /The existing Desktop release does not match the expected tag/);
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const moduleUrl = new URL('./desktop-release-orchestration.mjs', import.meta.url);
const {
	verifyReleaseSource,
	planAssetUpload,
	renderBetaReleaseNotes,
	readChecksums,
	checksumFileAsset,
	CHECKSUM_ASSET
} = await import(moduleUrl.href);

const INSTALLERS = [
	'deckmark_2.5.3_aarch64.dmg',
	'deckmark_2.5.3_amd64.deb',
	'deckmark_2.5.3_amd64.AppImage',
	'deckmark_2.5.3_x64-setup.exe'
];

/** @param {string} line @param {string} name */
const sumLine = (line, name) => `${line.repeat(64)}  ${name}`;

/** @param {string} path */
function digestOf(path) {
	return createHash('sha256').update(readFileSync(path)).digest('hex');
}

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
	assert.deepEqual(readFileSync(join(directory, 'upload.txt'), 'utf8').trim().split('\n'), [
		'deckmark_2.5.3_amd64.deb',
		'SHA256SUMS'
	]);
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

test('the checksum file never lists its own digest', () => {
	const directory = mkdtempSync(join(tmpdir(), 'desktop-selfsum-'));
	const path = join(directory, 'SHA256SUMS');
	writeFileSync(
		path,
		`${sumLine('a', 'deckmark_2.5.3_amd64.deb')}\n${sumLine('b', 'SHA256SUMS')}\n`
	);
	assert.throws(() => readChecksums(path), /must not list itself/);
});

test('the checksum file digest is computed from the published bytes', () => {
	const directory = mkdtempSync(join(tmpdir(), 'desktop-sumdigest-'));
	const path = join(directory, 'SHA256SUMS');
	writeFileSync(
		path,
		`${INSTALLERS.map((name, index) => sumLine(String(index), name)).join('\n')}\n`
	);
	assert.deepEqual(checksumFileAsset(path), { name: CHECKSUM_ASSET, sha256: digestOf(path) });
	assert.equal(CHECKSUM_ASSET, 'SHA256SUMS');
});

test('the upload plan always includes the checksum file', () => {
	const checksums = INSTALLERS.map((name, index) => ({ name, sha256: String(index).repeat(64) }));
	const checksumFile = { name: CHECKSUM_ASSET, sha256: 'e'.repeat(64) };
	const plan = planAssetUpload({ checksums, checksumFile });
	assert.deepEqual(plan.upload, [...INSTALLERS, CHECKSUM_ASSET]);
	assert.deepEqual(plan.skip, []);
});

test('an existing checksum asset is skipped only when GitHub reports the same digest', () => {
	const checksums = [{ name: INSTALLERS[0], sha256: '1'.repeat(64) }];
	const checksumFile = { name: CHECKSUM_ASSET, sha256: 'e'.repeat(64) };
	const same = planAssetUpload({
		existingAssets: [
			{ name: INSTALLERS[0], digest: `sha256:${'1'.repeat(64)}` },
			{ name: CHECKSUM_ASSET, digest: `sha256:${'e'.repeat(64)}` }
		],
		checksums,
		checksumFile
	});
	assert.deepEqual(same.upload, []);
	assert.deepEqual(same.skip, [INSTALLERS[0], CHECKSUM_ASSET]);

	assert.throws(
		() =>
			planAssetUpload({
				existingAssets: [{ name: CHECKSUM_ASSET, digest: `sha256:${'f'.repeat(64)}` }],
				checksums,
				checksumFile
			}),
		/Refusing to replace SHA256SUMS: the release holds different bytes/
	);
	assert.throws(
		() => planAssetUpload({ existingAssets: [{ name: CHECKSUM_ASSET }], checksums, checksumFile }),
		/Cannot verify the existing digest of SHA256SUMS/
	);
});

test('the plan-upload command publishes SHA256SUMS beside the installers', () => {
	const directory = mkdtempSync(join(tmpdir(), 'desktop-plan-sums-'));
	const sums = join(directory, 'SHA256SUMS');
	const release = join(directory, 'release.json');
	const output = join(directory, 'upload.txt');
	writeFileSync(
		sums,
		`${INSTALLERS.map((name, index) => sumLine(String(index), name)).join('\n')}\n`
	);
	const original = readFileSync(sums);
	const checksumDigest = digestOf(sums);

	const fresh = spawnSync(
		process.execPath,
		[
			moduleUrl.pathname,
			'plan-upload',
			'--sums',
			sums,
			'--tag',
			'desktop-v2.5.3',
			'--output',
			output
		],
		{ encoding: 'utf8' }
	);
	assert.equal(fresh.status, 0, fresh.stderr);
	assert.deepEqual(readFileSync(output, 'utf8').trim().split('\n'), [
		...INSTALLERS,
		CHECKSUM_ASSET
	]);
	assert.deepEqual(readFileSync(sums), original, 'the checksum file must not be rewritten');
	assert.doesNotMatch(readFileSync(sums, 'utf8'), /^[a-f0-9]{64} {2}SHA256SUMS$/m);

	writeFileSync(
		release,
		JSON.stringify({
			tagName: 'desktop-v2.5.3',
			assets: [
				{ name: INSTALLERS[0], digest: `sha256:${'0'.repeat(64)}` },
				{ name: CHECKSUM_ASSET, digest: `sha256:${checksumDigest}` }
			]
		})
	);
	const unchanged = spawnSync(
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
			output
		],
		{ encoding: 'utf8' }
	);
	assert.equal(unchanged.status, 0, unchanged.stderr);
	assert.deepEqual(readFileSync(output, 'utf8').trim().split('\n'), INSTALLERS.slice(1));

	writeFileSync(
		release,
		JSON.stringify({
			tagName: 'desktop-v2.5.3',
			assets: [{ name: CHECKSUM_ASSET, digest: `sha256:${'f'.repeat(64)}` }]
		})
	);
	const changed = spawnSync(
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
			output
		],
		{ encoding: 'utf8' }
	);
	assert.notEqual(changed.status, 0);
	assert.match(changed.stderr, /Refusing to replace SHA256SUMS/);
});

test('the Desktop workflow installs Node from .node-version with a positive guard', () => {
	const desktop = readFileSync(
		new URL('../.github/workflows/desktop.yml', import.meta.url),
		'utf8'
	);
	const setups = desktop.match(/uses: actions\/setup-node@/g) ?? [];
	assert.ok(setups.length >= 10, 'every job sets up Node');
	assert.equal((desktop.match(/node-version-file: \.node-version/g) ?? []).length, setups.length);
	assert.doesNotMatch(desktop, /^\s+node-version: 22$/m);
	const pinned = readFileSync(new URL('../.node-version', import.meta.url), 'utf8').trim();
	assert.match(pinned, /^[1-9][0-9]*$/);
	const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
	const minimum = /^>=(\d+)$/.exec(pkg.engines.node);
	assert.ok(minimum, 'the package declares a minimum Node major');
	assert.ok(Number(pinned) >= Number(minimum[1]));
});

test('the Desktop cargo-audit cache checks the exact pinned version', () => {
	const desktop = readFileSync(
		new URL('../.github/workflows/desktop.yml', import.meta.url),
		'utf8'
	);
	assert.doesNotMatch(desktop, /grep -q '0\.22\.2'/);
	assert.match(desktop, /\[ "\$\([^)]*--version[^)]*\)" = "cargo-audit \$version" \]/);
	assert.match(desktop, /audit --file src-tauri\/Cargo\.lock --deny unsound/);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
const { load } = await import('js-yaml');

const root = new URL('..', import.meta.url);

/** @param {string} path */
function read(path) {
	return readFileSync(new URL(path, root), 'utf8');
}

const policy = await import(new URL('scripts/desktop-release-policy.mjs', root).href);

test('the accepted policy keeps three operating-system builds and four installers', () => {
	assert.deepEqual(Object.keys(policy.DESKTOP_PLATFORM_BUNDLES).sort(), [
		'macos-15',
		'ubuntu-24.04',
		'windows-2022'
	]);
	const formats = policy.DESKTOP_RELEASE_FORMATS;
	assert.equal(formats.length, 4);
	assert.equal(new Set(formats.map((format) => format.id)).size, 4);
	assert.deepEqual(formats.map((format) => format.bundle).sort(), [
		'appimage',
		'deb',
		'dmg',
		'nsis'
	]);
	for (const format of formats) {
		assert.ok(format.pattern instanceof RegExp, format.id);
		assert.ok(
			policy.DESKTOP_PLATFORM_BUNDLES[format.platform].includes(format.bundle),
			`${format.id} belongs to its platform`
		);
	}
});

test('a removed installer format is never part of the policy', () => {
	for (const name of ['deckmark_2.5.3_x64_en-US.msi', 'deckmark-2.5.3-1.x86_64.rpm']) {
		assert.equal(policy.isInstallerName(name), false, name);
		assert.throws(() => policy.formatForFile(name), /Unsupported installer format/, name);
	}
});

test('accepted installer names map to their platform and release name', () => {
	assert.equal(policy.platformForFile('deckmark_2.5.3_aarch64.dmg'), 'macos-15');
	assert.equal(policy.platformForFile('deckmark_2.5.3_amd64.deb'), 'ubuntu-24.04');
	assert.equal(policy.platformForFile('deckmark_2.5.3_amd64.AppImage'), 'ubuntu-24.04');
	assert.equal(policy.platformForFile('deckmark_2.5.3_x64-setup.exe'), 'windows-2022');
	assert.equal(
		policy.releaseNameFor('deckmark_2.5.3_aarch64.dmg'),
		'deckmark_2.5.3_macOS_Apple-Silicon.dmg'
	);
	assert.equal(policy.releaseNameFor('deckmark_2.5.3_amd64.deb'), 'deckmark_2.5.3_amd64.deb');
});

test('bundle targets are explicit for each operating system', () => {
	assert.equal(policy.bundleTargets('macos-15'), 'dmg');
	assert.equal(policy.bundleTargets('ubuntu-24.04'), 'deb,appimage');
	assert.equal(policy.bundleTargets('windows-2022'), 'nsis');
	assert.throws(() => policy.bundleTargets('linux-386'), /Unknown desktop platform/);
});

test('the Tauri configuration selects the policy targets and never target all', () => {
	const base = JSON.parse(read('src-tauri/tauri.conf.json'));
	assert.deepEqual(base.bundle.targets, policy.DESKTOP_PLATFORM_BUNDLES['ubuntu-24.04']);
	const perPlatform = {
		'macos-15': 'src-tauri/tauri.macos.conf.json',
		'ubuntu-24.04': 'src-tauri/tauri.linux.conf.json',
		'windows-2022': 'src-tauri/tauri.windows.conf.json'
	};
	for (const [platform, path] of Object.entries(perPlatform)) {
		const config = JSON.parse(read(path));
		assert.deepEqual(config.bundle.targets, policy.DESKTOP_PLATFORM_BUNDLES[platform], path);
	}
});

test('the Desktop workflow builds and collects exactly the policy formats', () => {
	const workflow = load(read('.github/workflows/desktop.yml'));
	const matrix = workflow.jobs['build-desktop'].strategy.matrix.include;
	for (const entry of matrix) {
		assert.deepEqual(
			entry.bundles,
			policy.DESKTOP_PLATFORM_BUNDLES[entry.platform].join(','),
			`${entry.platform} bundles`
		);
		assert.match(entry.args, /--bundles/, `${entry.platform} args keep the explicit selection`);
	}
	assert.equal(matrix.length, Object.keys(policy.DESKTOP_PLATFORM_BUNDLES).length);
	assert.equal(
		workflow.jobs['build-desktop'].steps.find((step) => step.uses?.includes('upload-artifact')).with
			.name,
		`${policy.DESKTOP_ARTIFACT_PREFIX}\${{ matrix.platform }}`
	);
});

test('the collector delegates its format list to the shared policy', () => {
	const collector = read('scripts/collect-desktop-assets.mjs');
	assert.match(collector, /from '\.\/desktop-release-policy\.mjs'/);
	assert.doesNotMatch(collector, /\\\.rpm\$|\\\.msi\$/, 'no private format list');
});

test('published install tables describe the accepted formats only', () => {
	for (const path of ['docs/EDITIONS.md', 'docs/USER_GUIDE.md', 'README.md']) {
		const text = read(path);
		assert.doesNotMatch(text, /\.msi\b/i, path);
		assert.doesNotMatch(text, /\.rpm\b/i, path);
		assert.match(text, /x64-setup\.exe/, `${path} lists the NSIS installer`);
	}
});

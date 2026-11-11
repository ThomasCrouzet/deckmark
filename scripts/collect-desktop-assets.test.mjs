import assert from 'node:assert/strict';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const { collectDesktopAssets } = await import(
	new URL('./collect-desktop-assets.mjs', import.meta.url).href
);

const sha = 'a'.repeat(40);
const expected = { sha, tag: 'v2.5.3', version: '2.5.3' };

/** @param {string} prefix */
function workspace(prefix) {
	return mkdtempSync(join(tmpdir(), `desktop-assets-${prefix}-`));
}

/**
 * @param {string} root
 * @param {string} artifact
 * @param {string[]} installers
 * @param {{ sha?: string, tag?: string, version?: string, manifests?: number }} [options]
 */
function artifact(root, name, installers, options = {}) {
	const directory = join(root, name);
	mkdirSync(directory, { recursive: true });
	for (const installer of installers) {
		writeFileSync(join(directory, installer), `payload:${installer}`);
	}
	const manifests = options.manifests ?? 1;
	for (let index = 0; index < manifests; index += 1) {
		const manifest = join(
			directory,
			index === 0 ? 'desktop-source.json' : `nested/source-${index}.json`
		);
		mkdirSync(join(manifest, '..'), { recursive: true });
		writeFileSync(
			manifest,
			JSON.stringify({
				sha: options.sha ?? sha,
				tag: options.tag ?? expected.tag,
				version: options.version ?? expected.version
			})
		);
	}
	return directory;
}

/** @param {string} root */
function completeInput(root) {
	artifact(root, 'desktop-installers-macos-15', ['deckmark_2.5.3_aarch64.dmg']);
	artifact(root, 'desktop-installers-ubuntu-24.04', [
		'deckmark_2.5.3_amd64.deb',
		'deckmark_2.5.3_amd64.AppImage'
	]);
	artifact(root, 'desktop-installers-windows-2022', ['deckmark_2.5.3_x64-setup.exe']);
}

test('the four accepted installers are collected with the source identity', () => {
	const root = workspace('ok');
	completeInput(join(root, 'downloaded-assets'));
	const published = collectDesktopAssets(
		join(root, 'downloaded-assets'),
		join(root, 'release-assets'),
		expected
	);
	assert.deepEqual(published.sort(), [
		'deckmark_2.5.3_amd64.AppImage',
		'deckmark_2.5.3_amd64.deb',
		'deckmark_2.5.3_macOS_Apple-Silicon.dmg',
		'deckmark_2.5.3_x64-setup.exe'
	]);
	const sums = readFileSync(join(root, 'release-assets/SHA256SUMS'), 'utf8').trim().split('\n');
	assert.equal(sums.length, 4);
	for (const line of sums) assert.match(line, /^[a-f0-9]{64} {2}\S+$/);
	assert.ok(existsSync(join(root, 'release-assets/deckmark_2.5.3_macOS_Apple-Silicon.dmg')));
	assert.deepEqual(
		readdirSync(join(root, 'release-assets')).sort(),
		[...published, 'SHA256SUMS'].sort()
	);
});

test('a missing installer format is refused', () => {
	const root = workspace('missing');
	const input = join(root, 'downloaded-assets');
	artifact(input, 'desktop-installers-macos-15', ['deckmark_2.5.3_aarch64.dmg']);
	artifact(input, 'desktop-installers-ubuntu-24.04', ['deckmark_2.5.3_amd64.deb']);
	artifact(input, 'desktop-installers-windows-2022', ['deckmark_2.5.3_x64-setup.exe']);
	assert.throws(
		() => collectDesktopAssets(input, join(root, 'release-assets'), expected),
		/Required installer format is missing: linux-appimage/
	);
});

test('an extra or removed installer format is refused', () => {
	const root = workspace('extra');
	const input = join(root, 'downloaded-assets');
	completeInput(input);
	writeFileSync(join(input, 'desktop-installers-windows-2022/deckmark_2.5.3_x64_en-US.msi'), 'msi');
	assert.throws(
		() => collectDesktopAssets(input, join(root, 'release-assets'), expected),
		/Unsupported installer format: deckmark_2.5.3_x64_en-US.msi/
	);
	const root2 = workspace('rpm');
	const input2 = join(root2, 'downloaded-assets');
	completeInput(input2);
	writeFileSync(join(input2, 'desktop-installers-ubuntu-24.04/deckmark-2.5.3-1.x86_64.rpm'), 'rpm');
	assert.throws(
		() => collectDesktopAssets(input2, join(root2, 'release-assets'), expected),
		/Unsupported installer format: deckmark-2.5.3-1.x86_64.rpm/
	);
});

test('two installers of the same format are refused', () => {
	const root = workspace('duplicate');
	const input = join(root, 'downloaded-assets');
	completeInput(input);
	writeFileSync(join(input, 'desktop-installers-macos-15/deckmark_2.5.4_aarch64.dmg'), 'payload');
	assert.throws(
		() => collectDesktopAssets(input, join(root, 'release-assets'), expected),
		/Duplicate installer format: macos-dmg/
	);
});

test('an installer from the wrong platform artifact is refused', () => {
	const root = workspace('platform');
	const input = join(root, 'downloaded-assets');
	completeInput(input);
	writeFileSync(
		join(input, 'desktop-installers-windows-2022/deckmark_2.5.3_aarch64.dmg'),
		'payload:dmg'
	);
	assert.throws(
		() => collectDesktopAssets(input, join(root, 'release-assets'), expected),
		/appears in the windows-2022 artifact but belongs to macos-15/
	);
});

test('a tampered artifact source manifest is refused', () => {
	const root = workspace('tamper');
	const input = join(root, 'downloaded-assets');
	completeInput(input);
	writeFileSync(
		join(input, 'desktop-installers-ubuntu-24.04/desktop-source.json'),
		JSON.stringify({ ...expected, sha: 'b'.repeat(40) })
	);
	assert.throws(
		() => collectDesktopAssets(input, join(root, 'release-assets'), expected),
		/The artifacts do not match the specified source/
	);
});

test('a mismatched source tag or version is refused', () => {
	const root = workspace('source');
	const input = join(root, 'downloaded-assets');
	completeInput(input);
	writeFileSync(
		join(input, 'desktop-installers-macos-15/desktop-source.json'),
		JSON.stringify({ sha, tag: 'v2.5.4', version: '2.5.4' })
	);
	assert.throws(
		() => collectDesktopAssets(input, join(root, 'release-assets'), expected),
		/The artifacts do not match the specified source/
	);
});

test('an invalid expected identity or missing manifest is refused', () => {
	const root = workspace('identity');
	const input = join(root, 'downloaded-assets');
	completeInput(input);
	assert.throws(
		() =>
			collectDesktopAssets(input, join(root, 'release-assets'), {
				...expected,
				sha: 'not-a-sha'
			}),
		/Invalid source identity/
	);
	assert.throws(
		() =>
			collectDesktopAssets(input, join(root, 'release-assets'), {
				...expected,
				tag: 'v2.5.4'
			}),
		/Invalid source identity/
	);
	const extra = join(root, 'downloaded-assets/desktop-installers-linux-x64');
	mkdirSync(extra, { recursive: true });
	writeFileSync(join(extra, 'deckmark_2.5.3_amd64.deb'), 'payload');
	assert.throws(
		() => collectDesktopAssets(input, join(root, 'release-assets'), expected),
		/Unknown desktop artifact directory: desktop-installers-linux-x64/
	);
});

test('a missing or duplicated source manifest is refused', () => {
	const root = workspace('manifest');
	const input = join(root, 'downloaded-assets');
	completeInput(input);
	mkdirSync(join(input, 'desktop-installers-linux-x64'), { recursive: true });
	assert.throws(
		() => collectDesktopAssets(input, join(root, 'release-assets'), expected),
		/Unknown desktop artifact directory: desktop-installers-linux-x64/
	);
	const root2 = workspace('manifest-two');
	const input2 = join(root2, 'downloaded-assets');
	completeInput(input2);
	mkdirSync(join(input2, 'desktop-installers-ubuntu-24.04/nested'), { recursive: true });
	writeFileSync(
		join(input2, 'desktop-installers-ubuntu-24.04/nested/desktop-source.json'),
		JSON.stringify(expected)
	);
	assert.throws(
		() => collectDesktopAssets(input2, join(root2, 'release-assets'), expected),
		/Each installer artifact must contain one source manifest/
	);
});

test('an existing output file is not replaced', () => {
	const root = workspace('clobber');
	completeInput(join(root, 'downloaded-assets'));
	collectDesktopAssets(join(root, 'downloaded-assets'), join(root, 'release-assets'), expected);
	assert.throws(
		() =>
			collectDesktopAssets(join(root, 'downloaded-assets'), join(root, 'release-assets'), expected),
		/EEXIST/
	);
	assert.equal(
		readFileSync(join(root, 'release-assets/deckmark_2.5.3_amd64.deb'), 'utf8'),
		'payload:deckmark_2.5.3_amd64.deb'
	);
});

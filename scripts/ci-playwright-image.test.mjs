import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const script = new URL('../scripts/ci-playwright-image.mjs', import.meta.url);

const digest = 'sha256:' + 'a1'.repeat(32);
const baseManifest = {
	playwrightVersion: '1.65.0',
	image: 'mcr.microsoft.com/playwright',
	tag: 'v1.65.0-noble',
	digest,
	platform: 'linux/amd64'
};

function fixture(overrides = {}) {
	const directory = mkdtempSync(join(tmpdir(), 'deckmark-playwright-image-'));
	const manifest = { ...baseManifest, ...(overrides.manifest ?? {}) };
	const packageJson = {
		name: 'deckmark',
		version: '2.5.3',
		devDependencies: {
			'@playwright/test': overrides.packageVersion ?? '1.65.0',
			...(overrides.packageExtra ?? {})
		}
	};
	const lock = {
		name: 'deckmark',
		version: '2.5.3',
		lockfileVersion: 3,
		packages: {
			'': {
				name: 'deckmark',
				version: '2.5.3',
				devDependencies: {
					'@playwright/test': overrides.packageVersion ?? '1.65.0'
				}
			},
			'node_modules/@playwright/test': {
				version: overrides.lockTestVersion ?? '1.65.0',
				dependencies: { playwright: overrides.lockPlaywrightVersion ?? '1.65.0' }
			},
			'node_modules/playwright': {
				version: overrides.lockPlaywrightVersion ?? '1.65.0'
			},
			'node_modules/playwright-core': {
				version: overrides.lockCoreVersion ?? '1.65.0'
			}
		}
	};
	const paths = {
		manifest: join(directory, 'playwright-image.json'),
		pkg: join(directory, 'package.json'),
		lock: join(directory, 'package-lock.json')
	};
	if (overrides.manifestRaw !== undefined) {
		writeFileSync(paths.manifest, overrides.manifestRaw);
	} else if (overrides.omitManifest !== true) {
		writeFileSync(paths.manifest, JSON.stringify(manifest, null, 2) + '\n');
	}
	if (overrides.lockRaw !== undefined) {
		writeFileSync(paths.lock, overrides.lockRaw);
	} else {
		writeFileSync(paths.lock, JSON.stringify(lock, null, 2) + '\n');
	}
	writeFileSync(paths.pkg, JSON.stringify(packageJson, null, 2) + '\n');
	return { directory, paths };
}

function run(paths) {
	return spawnSync(
		process.execPath,
		[script.pathname, '--manifest', paths.manifest, '--package', paths.pkg, '--lock', paths.lock],
		{ encoding: 'utf8' }
	);
}

test('a consistent manifest prints only the pinned image reference', () => {
	const { paths } = fixture();
	const result = run(paths);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, `mcr.microsoft.com/playwright:v1.65.0-noble@${digest}\n`);
	assert.equal(result.stderr, '');
});

test('the repository manifest matches the repository lockfile', () => {
	const result = spawnSync(process.execPath, [script.pathname], {
		cwd: new URL('..', import.meta.url).pathname,
		encoding: 'utf8'
	});
	assert.equal(result.status, 0, result.stderr);
	const manifest = JSON.parse(
		readFileSync(new URL('../.github/ci/playwright-image.json', import.meta.url), 'utf8')
	);
	assert.equal(result.stdout, `${manifest.image}:${manifest.tag}@${manifest.digest}\n`);
});

test('a package.json version mismatch fails closed with no stdout', () => {
	for (const packageVersion of ['1.64.0', '^1.65.0', '~1.65.0', '']) {
		const { paths } = fixture({ packageVersion });
		const result = run(paths);
		assert.notEqual(result.status, 0, `package version ${JSON.stringify(packageVersion)}`);
		assert.equal(result.stdout, '');
		assert.match(result.stderr, /package\.json/i);
	}
});

test('a package-lock version mismatch fails closed', () => {
	for (const field of ['lockTestVersion', 'lockPlaywrightVersion', 'lockCoreVersion']) {
		const { paths } = fixture({ [field]: '1.64.0' });
		const result = run(paths);
		assert.notEqual(result.status, 0, field);
		assert.equal(result.stdout, '');
		assert.match(result.stderr, /package-lock\.json/);
	}
});

test('a manifest version mismatch fails closed', () => {
	for (const playwrightVersion of ['1.64.0', '1.65', '1.65.0-beta.1', 'latest']) {
		const { paths } = fixture({
			manifest: { playwrightVersion, tag: `v${playwrightVersion}-noble` }
		});
		const result = run(paths);
		assert.notEqual(result.status, 0, playwrightVersion);
		assert.equal(result.stdout, '');
		assert.match(result.stderr, /version/i);
	}
});

test('a tag that does not match the version fails closed', () => {
	for (const tag of ['v1.64.0-noble', '1.65.0-noble', 'v1.65.0-jammy', 'v1.65.0-noble ']) {
		const { paths } = fixture({ manifest: { tag } });
		const result = run(paths);
		assert.notEqual(result.status, 0, tag);
		assert.equal(result.stdout, '');
		assert.match(result.stderr, /tag/i);
	}
});

test('an invalid digest fails closed', () => {
	const invalid = [
		'',
		'a1'.repeat(32),
		'sha256:' + 'a1'.repeat(31),
		'sha256:' + 'a1'.repeat(33),
		'sha256:' + 'A1'.repeat(32),
		'sha256:' + 'g1'.repeat(32),
		'sha512:' + 'a1'.repeat(32)
	];
	for (const value of invalid) {
		const { paths } = fixture({ manifest: { digest: value } });
		const result = run(paths);
		assert.notEqual(result.status, 0, value);
		assert.equal(result.stdout, '');
		assert.match(result.stderr, /digest/i);
	}
});

test('an untrusted image repository fails closed', () => {
	for (const image of [
		'docker.io/playwright',
		'mcr.microsoft.com/playwright/evil',
		'mcr.microsoft.com/Playwright',
		'playwright'
	]) {
		const { paths } = fixture({ manifest: { image } });
		const result = run(paths);
		assert.notEqual(result.status, 0, image);
		assert.equal(result.stdout, '');
		assert.match(result.stderr, /image/i);
	}
});

test('a missing or malformed manifest fails closed', () => {
	const missing = fixture({ omitManifest: true });
	assert.notEqual(run(missing.paths).status, 0);
	assert.equal(run(missing.paths).stdout, '');

	for (const raw of ['', 'null', '[]', '{"playwrightVersion":', '{}']) {
		const { paths } = fixture({ manifestRaw: raw });
		const result = run(paths);
		assert.notEqual(result.status, 0, raw);
		assert.equal(result.stdout, '');
	}
});

test('a lockfile without the Playwright package entry fails closed', () => {
	const { paths } = fixture();
	const lock = JSON.parse(readFileSync(paths.lock, 'utf8'));
	delete lock.packages['node_modules/@playwright/test'];
	writeFileSync(paths.lock, JSON.stringify(lock));
	const result = run(paths);
	assert.notEqual(result.status, 0);
	assert.equal(result.stdout, '');
	assert.match(result.stderr, /@playwright\/test/);
});

test('an unreadable lockfile fails closed', () => {
	const { paths } = fixture();
	writeFileSync(paths.lock, '{"packages":');
	const result = run(paths);
	assert.notEqual(result.status, 0);
	assert.equal(result.stdout, '');
});

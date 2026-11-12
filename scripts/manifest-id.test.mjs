import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { applyManifestId, manifestIdForBase } from './manifest-id.mjs';

const sourceManifest = JSON.parse(readFileSync('static/manifest.webmanifest', 'utf8'));
const directories = [];

function artifact() {
	const directory = mkdtempSync(join(tmpdir(), 'deckmark-manifest-'));
	directories.push(directory);
	copyFileSync('static/manifest.webmanifest', join(directory, 'manifest.webmanifest'));
	return directory;
}

afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

test('root host emits the stable origin-root identity', () => {
	const directory = artifact();
	const manifest = applyManifestId(directory, '');
	const manifestUrl = 'https://www.deckmark.dev/manifest.webmanifest';

	assert.equal(manifest.id, '/');
	assert.deepEqual(manifest, { ...sourceManifest, id: '/' });
	assert.equal(new URL(manifest.id, manifestUrl).href, 'https://www.deckmark.dev/');
	assert.equal(new URL(manifest.start_url, manifestUrl).href, 'https://www.deckmark.dev/');
	assert.equal(new URL(manifest.scope, manifestUrl).href, 'https://www.deckmark.dev/');
});

test('GitHub Pages emits a project identity without changing start_url or scope', () => {
	const directory = artifact();
	const manifest = applyManifestId(directory, '/deckmark');
	const manifestUrl = 'https://thomascrouzet.github.io/deckmark/manifest.webmanifest';

	assert.equal(manifest.id, '/deckmark/');
	assert.equal(manifest.start_url, '.');
	assert.equal(manifest.scope, '.');
	assert.deepEqual(manifest, { ...sourceManifest, id: '/deckmark/' });
	assert.equal(new URL(manifest.id, manifestUrl).href, 'https://thomascrouzet.github.io/deckmark/');
	assert.equal(
		new URL(manifest.start_url, manifestUrl).href,
		'https://thomascrouzet.github.io/deckmark/'
	);
	assert.equal(
		new URL(manifest.scope, manifestUrl).href,
		'https://thomascrouzet.github.io/deckmark/'
	);
	assert.notEqual(manifest.id, '/');
	assert.notEqual(new URL(manifest.id, manifestUrl).href, 'https://thomascrouzet.github.io/');
});

test('the two Web Light origins receive different identities', () => {
	assert.notEqual(manifestIdForBase(''), manifestIdForBase('/deckmark'));
});

test('an invalid base path fails before it can write an ambiguous identity', () => {
	for (const value of ['deckmark', '/deckmark/', '/deck mark', '/deckmark//nested']) {
		assert.throws(() => manifestIdForBase(value), /BASE_PATH/, value);
	}
});

// The Web Light build emits one manifest for two origins. The manifest ID is the
// installed application identity, so it must stay at the origin root on the
// canonical host and follow the project path on GitHub Pages. Keep start_url and
// scope relative to the manifest; only the ID changes.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE_PATH = /^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)$/;
// A fixed origin keeps URL resolution independent from the local server port.
const MANIFEST_ORIGIN = 'https://manifest.invalid';

export function normalizeBasePath(basePath = '') {
	if (basePath === '') return '';
	if (!BASE_PATH.test(basePath)) {
		throw new Error('BASE_PATH must be empty or a leading-slash path without a final slash.');
	}
	return basePath;
}

export function manifestIdForBase(basePath = '') {
	const normalized = normalizeBasePath(basePath);
	return normalized ? `${normalized}/` : '/';
}

/**
 * The emitted manifest is the installation identity. Resolve id, start_url and
 * scope through the same manifest URL that a browser uses, and stop the build
 * when any field leaves the intended app root.
 */
export function verifyManifestIdentity(buildDirectory, basePath = '') {
	const normalized = normalizeBasePath(basePath);
	const manifestPath = join(buildDirectory, 'manifest.webmanifest');
	const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
	const appRoot = new URL(`${normalized}/`, MANIFEST_ORIGIN);
	const manifestUrl = new URL(`${normalized}/manifest.webmanifest`, MANIFEST_ORIGIN);
	const expectedId = manifestIdForBase(normalized);

	if (manifest.id !== expectedId) {
		throw new Error(
			`The manifest identity ${JSON.stringify(manifest.id)} must be ${JSON.stringify(
				expectedId
			)} for BASE_PATH ${JSON.stringify(normalized)}.`
		);
	}
	for (const key of ['id', 'start_url', 'scope']) {
		if (typeof manifest[key] !== 'string' || manifest[key].length === 0) {
			throw new Error(`The manifest ${key} is absent for BASE_PATH ${JSON.stringify(normalized)}.`);
		}
		const resolved = new URL(manifest[key], manifestUrl);
		if (resolved.href !== appRoot.href) {
			throw new Error(
				`The manifest ${key} resolves to ${resolved.href} instead of the app root ${appRoot.href}.`
			);
		}
	}
	if (normalized !== '' && new URL(manifest.id, manifestUrl).href === `${MANIFEST_ORIGIN}/`) {
		throw new Error(
			`The manifest identity must not be the bare origin root for BASE_PATH ${JSON.stringify(
				normalized
			)}.`
		);
	}
	return manifest;
}

export function applyManifestId(buildDirectory, basePath = '') {
	const manifestPath = join(buildDirectory, 'manifest.webmanifest');
	const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
	manifest.id = manifestIdForBase(basePath);
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, '\t')}\n`);
	return verifyManifestIdentity(buildDirectory, basePath);
}

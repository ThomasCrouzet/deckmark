// The Web Light build emits one manifest for two origins. The manifest ID is the
// installed application identity, so it must stay at the origin root on the
// canonical host and follow the project path on GitHub Pages. Keep start_url and
// scope relative to the manifest; only the ID changes.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE_PATH = /^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)$/;

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

export function applyManifestId(buildDirectory, basePath = '') {
	const manifestPath = join(buildDirectory, 'manifest.webmanifest');
	const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
	manifest.id = manifestIdForBase(basePath);
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, '\t')}\n`);
	return manifest;
}

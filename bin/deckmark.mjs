#!/usr/bin/env node

import { existsSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const bundle = resolve(root, '.cli/deckmark.mjs');

function newestMtime(path) {
	const info = statSync(path);
	if (!info.isDirectory()) return info.mtimeMs;
	let newest = info.mtimeMs;
	for (const entry of readdirSync(path, { withFileTypes: true })) {
		if (entry.name === 'node_modules' || entry.name === 'test-results') continue;
		newest = Math.max(newest, newestMtime(resolve(path, entry.name)));
	}
	return newest;
}

function bundleIsStale() {
	if (!existsSync(bundle)) return true;
	const built = statSync(bundle).mtimeMs;
	const sources = [
		resolve(root, 'cli'),
		resolve(root, 'src/lib'),
		resolve(root, 'package.json'),
		resolve(root, 'scripts/build-cli.mjs')
	];
	return sources.some((source) => newestMtime(source) > built);
}

if (bundleIsStale()) {
	const result = spawnSync(process.execPath, [resolve(root, 'scripts/build-cli.mjs')], {
		stdio: 'inherit',
		cwd: root
	});
	if (result.status !== 0) {
		process.stderr.write('deckmark: cannot build the command-line interface\n');
		process.exit(1);
	}
}

await import(pathToFileURL(bundle).href);

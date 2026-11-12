#!/usr/bin/env node
// Builds one edition. The edition is a compile-time input: the Web build aliases
// native Tauri packages to a stub and then verifies the output boundary.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyManifestId } from './manifest-id.mjs';

const edition = process.argv[2] === 'desktop' ? 'desktop' : 'web';
const env = { ...process.env, VITE_EDITION: edition };
const sourceSha =
	spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout?.trim() || null;

function run(command, args) {
	const result = spawnSync(command, args, {
		stdio: 'inherit',
		env,
		shell: process.platform === 'win32'
	});
	if (result.status !== 0) process.exit(result.status ?? 1);
}

run('node', ['scripts/patch-milkdown-images.mjs', '--write']);
run('npx', ['vite', 'build']);
// Desktop Complete does not install the web manifest. Keep its copied bytes
// unchanged and scope this identity to the two Web Light origins.
if (edition === 'web') applyManifestId('build', process.env.BASE_PATH ?? '');
run('node', ['scripts/generate-service-worker.mjs']);

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const features =
	edition === 'desktop'
		? [
				'notes',
				'presentations',
				'code',
				'images',
				'projects',
				'pwa-offline',
				'native-disk',
				'native-projects',
				'git',
				'native-vault',
				'native-ai',
				'global-capture'
			]
		: ['notes', 'presentations', 'code', 'images', 'projects', 'pwa-offline'];
const excluded =
	edition === 'desktop'
		? []
		: [
				'native-disk',
				'native-projects',
				'native-vault',
				'native-ai',
				'git',
				'cli',
				'mcp',
				'global-capture'
			];
mkdirSync('build', { recursive: true });
writeFileSync(
	join('build', 'edition.json'),
	JSON.stringify(
		{
			format: 'mdsh-edition',
			schemaVersion: 1,
			edition,
			version: packageJson.version,
			sourceSha,
			htmlSha256: createHash('sha256').update(readFileSync('build/index.html')).digest('hex'),
			basePath: process.env.BASE_PATH ?? '',
			features,
			excluded
		},
		null,
		2
	) + '\n'
);

run('node', ['scripts/check-edition-boundaries.mjs', edition]);
console.log(`Built ${edition} edition.`);

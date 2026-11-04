#!/usr/bin/env node
// Builds one edition. The edition is a compile-time input: the Web build aliases
// native Tauri packages to a stub and then verifies the output boundary.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const edition = process.argv[2] === 'desktop' ? 'desktop' : 'web';
const env = { ...process.env, VITE_EDITION: edition };

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
				'global-capture'
			]
		: ['notes', 'presentations', 'code', 'images', 'projects', 'pwa-offline'];
const excluded =
	edition === 'desktop'
		? []
		: ['native-disk', 'native-projects', 'native-vault', 'git', 'cli', 'mcp', 'global-capture'];
mkdirSync('build', { recursive: true });
writeFileSync(
	join('build', 'edition.json'),
	JSON.stringify(
		{
			format: 'mdsh-edition',
			schemaVersion: 1,
			edition,
			version: packageJson.version,
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

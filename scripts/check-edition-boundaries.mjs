#!/usr/bin/env node
// Verifies the compile-time edition contract on built artifacts. This is a
// negative assertion: a Web build must not contain a native bridge or a
// desktop-only service.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const edition = process.argv[2] === 'desktop' ? 'desktop' : 'web';
const root = 'build';
const forbidden = [
	'@tauri-apps/',
	'__TAURI_INTERNALS__',
	'tauri://localhost',
	'tauri-plugin-',
	'desktop_open_external',
	'desktop_arm_close_guard',
	'take_pending_open_paths',
	'git_status',
	'git_diff',
	'git_log',
	'git_stage',
	'git_unstage',
	'git_commit',
	'vault_set',
	'vault_status',
	'vault_delete',
	'ai_chat',
	'keyring'
];

function files(directory) {
	const result = [];
	for (const entry of readdirSync(directory)) {
		const path = join(directory, entry);
		if (statSync(path).isDirectory()) result.push(...files(path));
		else result.push(path);
	}
	return result;
}

function fail(message) {
	console.error(`edition boundary: ${message}`);
	process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(root, 'edition.json'), 'utf8'));
if (manifest.edition !== edition)
	fail(`manifest edition ${manifest.edition} does not match ${edition}`);
if (!Array.isArray(manifest.features) || manifest.features.length === 0)
	fail('edition manifest has no features');

if (edition === 'web') {
	const violations = [];
	let scanned = 0;
	for (const path of files(root)) {
		if (!/\.(?:js|mjs|html|json|webmanifest)$/.test(path)) continue;
		scanned++;
		const content = readFileSync(path, 'utf8');
		for (const needle of forbidden) {
			if (content.includes(needle)) violations.push(`${path}: ${needle}`);
		}
	}
	if (violations.length > 0) {
		for (const violation of violations) console.error(violation);
		fail(`${violations.length} Web artifact violation(s)`);
	}
	console.log(`edition boundary ok: web, ${scanned} files scanned, no native bridge.`);
} else {
	console.log('edition boundary ok: desktop manifest present.');
}

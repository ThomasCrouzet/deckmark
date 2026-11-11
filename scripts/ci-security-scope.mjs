#!/usr/bin/env node
// Classify a changed file set for the security workflow.
// The classifier fails closed: malformed input, an empty change set, and an
// unknown top-level path require both audits. The workflow keeps the required
// aggregate names and fails when this job fails.
// The security control files are inputs of both audits. A diff that changes
// this classifier, an audit wrapper, a control test, or the secret-scan
// workflow therefore requests the audits it implements. No path in that group
// is accepted as a non-security change.

import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const EVENTS = ['push', 'pull_request', 'schedule', 'workflow_dispatch'];

const RUST_PATTERNS = [
	/^src-tauri\//,
	/^patches\/glib\//,
	/^rust-toolchain\.toml$/,
	/^scripts\/annotate-cargo-sbom\.mjs$/,
	/^scripts\/vendor-glib\.mjs$/,
	/^scripts\/ci-security-[^/]+$/,
	/^\.github\/workflows\/security\.yml$/,
	/^\.github\/workflows\/gitleaks\.yml$/,
	/^\.github\/workflows\/desktop\.yml$/,
	/^\.github\/scripts\//,
	/^\.github\/actions\//,
	/(^|\/)Cargo\.(toml|lock)$/,
	/(^|\/)build\.rs$/,
	/\.rs$/
];

const NPM_PATTERNS = [
	/^package\.json$/,
	/^package-lock\.json$/,
	/^\.npmrc$/,
	/^\.node-version$/,
	/^scripts\/build-cli\.mjs$/,
	/^scripts\/pack-cli\.mjs$/,
	/^scripts\/pack-cli\.test\.mjs$/,
	/^scripts\/ci-security-[^/]+$/,
	/^\.github\/workflows\/security\.yml$/,
	/^\.github\/workflows\/gitleaks\.yml$/,
	/^\.github\/scripts\//,
	/^\.github\/actions\//,
	/(^|\/)package(-lock)?\.json$/
];

const KNOWN_NON_SECURITY_PREFIXES = [
	'src/',
	'e2e/',
	'e2e-production/',
	'static/',
	'cli/',
	'bin/',
	'docs/',
	'scripts/',
	'patches/',
	'test-results/'
];

const KNOWN_ROOT_FILES = new Set([
	'.editorconfig',
	'.gitattributes',
	'.gitignore',
	'.gitleaks.toml',
	'.node-version',
	'.npmrc',
	'.prettierignore',
	'.prettierrc',
	'AGENTS.md',
	'ARCHITECTURE.md',
	'CHANGELOG.md',
	'CODE_OF_CONDUCT.md',
	'CONTRIBUTING.md',
	'GOVERNANCE.md',
	'LICENSE',
	'Makefile',
	'README.md',
	'SECURITY.md',
	'SUPPORT.md',
	'THIRD_PARTY_NOTICES.md',
	'eslint.config.js',
	'lefthook.yml',
	'package-lock.json',
	'package.json',
	'playwright.config.ts',
	'playwright.production.config.ts',
	'rust-toolchain.toml',
	'tsconfig.json',
	'vite.config.ts',
	'vitest.config.ts'
]);

function normalizePath(value) {
	if (typeof value !== 'string') throw new Error('A changed path is not a string.');
	const path = value.trim();
	if (path.length === 0) throw new Error('A changed path is empty.');
	if (path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/.test(path)) {
		throw new Error(`A changed path is absolute: ${path}`);
	}
	if (path.includes('\\')) throw new Error(`A changed path uses a backslash: ${path}`);
	const segments = path.split('/');
	if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
		throw new Error(`A changed path is not a normalized repository path: ${path}`);
	}
	return path;
}

function isKnownNonSecurity(path) {
	if (KNOWN_NON_SECURITY_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;
	if (path.startsWith('.github/')) return true;
	if (!path.includes('/')) return KNOWN_ROOT_FILES.has(path);
	return false;
}

function fullScope(reason) {
	return { rust: true, npm: true, failClosed: false, reason: `full:${reason}` };
}

export function classifyChangedPaths(input) {
	if (!Array.isArray(input)) throw new Error('The changed file list is not an array.');
	const paths = input.map(normalizePath);
	if (paths.length === 0) {
		return { rust: true, npm: true, failClosed: true, reason: 'empty:changed-set' };
	}
	const reasons = [];
	const unknown = [];
	let rust = false;
	let npm = false;
	for (const path of paths) {
		let matched = false;
		if (RUST_PATTERNS.some((pattern) => pattern.test(path))) {
			rust = true;
			reasons.push(`rust:${path}`);
			matched = true;
		}
		if (NPM_PATTERNS.some((pattern) => pattern.test(path))) {
			npm = true;
			reasons.push(`npm:${path}`);
			matched = true;
		}
		if (matched) continue;
		if (isKnownNonSecurity(path)) continue;
		unknown.push(path);
	}
	let failClosed = false;
	if (unknown.length > 0) {
		failClosed = true;
		rust = true;
		npm = true;
		reasons.push(`unknown:${unknown.join(',')}`);
	}
	return { rust, npm, failClosed, reason: reasons.join(';') };
}

export function classifySecurityScope({ eventName, files }) {
	if (!EVENTS.includes(eventName)) throw new Error(`Unknown event: ${eventName}`);
	if (eventName === 'schedule' || eventName === 'workflow_dispatch') {
		return fullScope(eventName);
	}
	if (!Array.isArray(files)) throw new Error(`Event ${eventName} requires a changed file list.`);
	return classifyChangedPaths(files);
}

function parseArgs(argv) {
	const options = { eventName: undefined, files: undefined, githubOutput: undefined };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		const next = () => {
			const value = argv[index + 1];
			if (value === undefined || value.startsWith('--')) {
				throw new Error(`Missing value for ${arg}`);
			}
			index += 1;
			return value;
		};
		switch (arg) {
			case '--event-name':
				options.eventName = next();
				break;
			case '--files':
				options.files = next();
				break;
			case '--github-output':
				options.githubOutput = next();
				break;
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}
	if (!options.eventName) throw new Error('--event-name is required.');
	return options;
}

function readFileList(path) {
	return readFileSync(path, 'utf8')
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

function main() {
	try {
		const options = parseArgs(process.argv.slice(2));
		const files = options.files === undefined ? undefined : readFileList(options.files);
		const scope = classifySecurityScope({ eventName: options.eventName, files });
		const lines = [
			`rust=${scope.rust}`,
			`npm=${scope.npm}`,
			`fail_closed=${scope.failClosed}`,
			`reason=${scope.reason}`
		];
		const text = `${lines.join('\n')}\n`;
		process.stdout.write(text);
		if (options.githubOutput) appendFileSync(options.githubOutput, text);
	} catch (error) {
		process.stderr.write(`ci-security-scope: ${error.message}\n`);
		process.exit(2);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

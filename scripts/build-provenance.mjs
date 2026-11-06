#!/usr/bin/env node
// Bind a reusable build artifact to its source, inputs and exact bytes.
// Usage:
//   node scripts/build-provenance.mjs write --kind e2e --instrumentation source-fidelity
//   node scripts/build-provenance.mjs verify --kind e2e
// The manifest stays inside build/ and is excluded from the tree hash.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { arch, platform, release } from 'node:os';

const BUILD_ROOT = resolve('build');
const MANIFEST_NAME = 'build-provenance.json';
const MANIFEST_PATH = join(BUILD_ROOT, MANIFEST_NAME);
const SCHEMA_VERSION = 1;

// These files change the build output. A change to any of them invalidates a
// reused artifact even when the source commit looks compatible.
const INPUT_FILES = [
	'package.json',
	'package-lock.json',
	'vite.config.ts',
	'tsconfig.json',
	'scripts/build-edition.mjs',
	'scripts/generate-service-worker.mjs',
	'scripts/patch-milkdown-images.mjs',
	'.github/workflows/deploy.yml',
	'.github/workflows/desktop.yml'
];

const KINDS = new Set(['e2e', 'web-benchmark']);

function usage(message) {
	if (message) console.error(message);
	console.error(
		'Usage: node scripts/build-provenance.mjs <write|verify> --kind <e2e|web-benchmark> [--instrumentation source-fidelity] [--source-sha <sha>] [--base-path <path>]'
	);
	process.exit(2);
}

function parseArgs(argv) {
	const [command, ...rest] = argv;
	if (command !== 'write' && command !== 'verify') usage('Missing command.');
	const options = { command, kind: '', instrumentation: 'none', sourceSha: '', basePath: '' };
	for (let index = 0; index < rest.length; index += 1) {
		const arg = rest[index];
		if (arg === '--kind') options.kind = rest[++index] ?? '';
		else if (arg === '--instrumentation') options.instrumentation = rest[++index] ?? 'none';
		else if (arg === '--source-sha') options.sourceSha = rest[++index] ?? '';
		else if (arg === '--base-path') options.basePath = rest[++index] ?? '';
		else usage(`Unknown argument: ${arg}`);
	}
	if (!KINDS.has(options.kind)) usage('Invalid or missing --kind.');
	return options;
}

function sha256(data) {
	return createHash('sha256').update(data).digest('hex');
}

function git(...args) {
	return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function fileSha(path) {
	return sha256(readFileSync(resolve(path)));
}

function inputHashes() {
	const hashes = {};
	for (const path of INPUT_FILES) {
		if (!existsSync(resolve(path))) throw new Error(`Missing provenance input: ${path}`);
		hashes[path] = fileSha(path);
	}
	return hashes;
}

function listFiles(root) {
	const files = [];
	function walk(directory) {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const full = join(directory, entry.name);
			const name = relative(root, full).split(sep).join('/');
			if (name === MANIFEST_NAME) continue;
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile()) files.push({ name, full });
		}
	}
	walk(root);
	return files.sort((left, right) => left.name.localeCompare(right.name));
}

function treeHash() {
	const hash = createHash('sha256');
	const files = listFiles(BUILD_ROOT);
	for (const file of files) {
		hash.update(file.name);
		hash.update('\0');
		hash.update(readFileSync(file.full));
		hash.update('\0');
	}
	return { files: files.length, sha256: hash.digest('hex') };
}

function workingTreeState() {
	const diff = execFileSync('git', ['diff', '--binary', 'HEAD'], {
		maxBuffer: 64 * 1024 * 1024
	});
	const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
		maxBuffer: 64 * 1024 * 1024
	})
		.toString()
		.split('\0')
		.filter(Boolean);
	return {
		workingDiffSha256: sha256(diff),
		untrackedCount: untracked.length
	};
}

function editionIdentity() {
	const path = join(BUILD_ROOT, 'edition.json');
	if (!existsSync(path)) throw new Error('Missing build/edition.json.');
	return JSON.parse(readFileSync(path, 'utf8'));
}

function write(options) {
	if (!existsSync(BUILD_ROOT)) throw new Error('The build directory does not exist.');
	const state = workingTreeState();
	if (state.workingDiffSha256 !== sha256(Buffer.alloc(0)) || state.untrackedCount > 0) {
		throw new Error(
			'Refusing to record provenance for a dirty working tree. Commit the tested source first.'
		);
	}
	const source = git('rev-parse', 'HEAD');
	const edition = editionIdentity();
	if (edition.sourceSha !== source) {
		throw new Error('build/edition.json names a different source revision.');
	}
	if ((edition.basePath ?? '') !== options.basePath) {
		throw new Error(
			`build/edition.json base path ${edition.basePath ?? ''} does not match ${options.basePath}.`
		);
	}
	const manifest = {
		schemaVersion: SCHEMA_VERSION,
		kind: options.kind,
		createdAt: new Date().toISOString(),
		source,
		sourceTree: git('rev-parse', 'HEAD^{tree}'),
		edition: edition.edition,
		version: edition.version,
		basePath: edition.basePath ?? '',
		buildMode: 'production-static',
		instrumentation: options.instrumentation,
		inputs: inputHashes(),
		builder: { node: process.version, platform: platform(), release: release(), arch: arch() },
		tree: treeHash()
	};
	mkdirSync(BUILD_ROOT, { recursive: true });
	writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
	console.log(
		`Recorded ${options.kind} provenance for ${source} with ${manifest.tree.files} files.`
	);
}

function verify(options) {
	if (!existsSync(MANIFEST_PATH)) throw new Error(`Missing ${MANIFEST_NAME}.`);
	const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
	if (manifest.schemaVersion !== SCHEMA_VERSION) throw new Error('Unsupported manifest schema.');
	if (manifest.kind !== options.kind) {
		throw new Error(`Manifest kind ${manifest.kind} does not match ${options.kind}.`);
	}
	if (manifest.instrumentation !== options.instrumentation) {
		throw new Error(
			`Manifest instrumentation ${manifest.instrumentation} does not match ${options.instrumentation}.`
		);
	}
	const source = options.sourceSha || process.env.GITHUB_SHA || git('rev-parse', 'HEAD');
	const head = git('rev-parse', 'HEAD');
	if (source !== head) {
		throw new Error(`Requested source ${source} is not the checked out revision ${head}.`);
	}
	if (manifest.source !== source) {
		throw new Error(`Manifest source ${manifest.source} does not match ${source}.`);
	}
	const state = workingTreeState();
	if (state.workingDiffSha256 !== sha256(Buffer.alloc(0)) || state.untrackedCount > 0) {
		throw new Error('The working tree is dirty. A reused artifact needs the recorded source.');
	}
	const inputs = inputHashes();
	for (const [path, expected] of Object.entries(manifest.inputs)) {
		if (inputs[path] !== expected) throw new Error(`Build input changed: ${path}.`);
	}
	const edition = editionIdentity();
	if (edition.sourceSha !== manifest.source) throw new Error('edition.json source mismatch.');
	if ((edition.basePath ?? '') !== manifest.basePath) {
		throw new Error('edition.json base path mismatch.');
	}
	const tree = treeHash();
	if (tree.files !== manifest.tree.files || tree.sha256 !== manifest.tree.sha256) {
		throw new Error('The build tree does not match the recorded artifact.');
	}
	console.log(
		`Verified ${options.kind} provenance for ${manifest.source} with ${tree.files} files.`
	);
}

const options = parseArgs(process.argv.slice(2));
try {
	if (options.command === 'write') write(options);
	else verify(options);
} catch (error) {
	console.error(`build-provenance: ${error instanceof Error ? error.message : error}`);
	process.exit(1);
}

#!/usr/bin/env node
// Resolve the pinned Playwright container reference for CI.
// The command prints only the fully pinned image reference on success.
// It fails closed when the manifest, package.json or package-lock.json disagree.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXACT_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const IMAGE = 'mcr.microsoft.com/playwright';
const SUITE = 'noble';
const PLATFORM = 'linux/amd64';

function parseArguments(argv) {
	const options = {
		manifest: join(repositoryRoot, '.github', 'ci', 'playwright-image.json'),
		packageFile: join(repositoryRoot, 'package.json'),
		lockFile: join(repositoryRoot, 'package-lock.json')
	};
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (flag === '--manifest') options.manifest = value;
		else if (flag === '--package') options.packageFile = value;
		else if (flag === '--lock') options.lockFile = value;
		else if (flag === '--help' || flag === '-h') {
			process.stdout.write(
				'Usage: node scripts/ci-playwright-image.mjs [--manifest FILE] [--package FILE] [--lock FILE]\n'
			);
			process.exit(0);
		} else {
			throw new Error(`unknown argument: ${flag}`);
		}
		if (!value) throw new Error(`missing value for ${flag}`);
		index += 1;
	}
	return options;
}

function readJson(file, label) {
	let raw;
	try {
		raw = readFileSync(file, 'utf8');
	} catch (error) {
		throw new Error(`cannot read ${label} (${file}): ${error.message}`);
	}
	let value;
	try {
		value = JSON.parse(raw);
	} catch (error) {
		throw new Error(`invalid JSON in ${label} (${file}): ${error.message}`);
	}
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`${label} must contain a JSON object (${file})`);
	}
	return value;
}

function requireExactVersion(value, label) {
	if (typeof value !== 'string' || !EXACT_VERSION.test(value)) {
		throw new Error(`${label} is not an exact version: ${JSON.stringify(value)}`);
	}
	return value;
}

function validateManifest(manifestFile) {
	const manifest = readJson(manifestFile, 'manifest');
	const version = requireExactVersion(manifest.playwrightVersion, 'manifest playwright version');
	if (manifest.image !== IMAGE) {
		throw new Error(`manifest image must be ${IMAGE}: ${JSON.stringify(manifest.image)}`);
	}
	const expectedTag = `v${version}-${SUITE}`;
	if (manifest.tag !== expectedTag) {
		throw new Error(`manifest tag ${JSON.stringify(manifest.tag)} must equal ${expectedTag}`);
	}
	if (typeof manifest.digest !== 'string' || !DIGEST.test(manifest.digest)) {
		throw new Error(
			`manifest digest must be sha256:<64 lowercase hex>: ${JSON.stringify(manifest.digest)}`
		);
	}
	if (manifest.platform !== PLATFORM) {
		throw new Error(`manifest platform must be ${PLATFORM}: ${JSON.stringify(manifest.platform)}`);
	}
	return { version, reference: `${manifest.image}:${manifest.tag}@${manifest.digest}` };
}

function validatePackage(packageFile, version) {
	const packageJson = readJson(packageFile, 'package.json');
	const declared = packageJson.devDependencies?.['@playwright/test'];
	if (declared !== version) {
		throw new Error(
			`package.json @playwright/test ${JSON.stringify(declared)} differs from manifest version ${version}`
		);
	}
}

function validateLockfile(lockFile, version) {
	const lock = readJson(lockFile, 'package-lock.json');
	const packages = lock.packages;
	if (packages === null || typeof packages !== 'object') {
		throw new Error('package-lock.json has no packages map');
	}
	const expected = {
		'node_modules/@playwright/test': version,
		'node_modules/playwright': version,
		'node_modules/playwright-core': version
	};
	for (const [name, wanted] of Object.entries(expected)) {
		const entry = packages[name];
		if (entry === undefined) {
			throw new Error(`package-lock.json has no entry for ${name}`);
		}
		if (entry.version !== wanted) {
			throw new Error(
				`package-lock.json ${name} version ${JSON.stringify(entry.version)} differs from manifest version ${wanted}`
			);
		}
	}
	const shipped = packages['node_modules/@playwright/test'].dependencies?.playwright;
	if (shipped !== version) {
		throw new Error(
			`package-lock.json @playwright/test depends on playwright ${JSON.stringify(shipped)}, not ${version}`
		);
	}
	const rootDeclaration = packages['']?.devDependencies?.['@playwright/test'];
	if (rootDeclaration !== undefined && rootDeclaration !== version) {
		throw new Error(
			`package-lock.json root devDependency ${JSON.stringify(rootDeclaration)} differs from manifest version ${version}`
		);
	}
}

function main() {
	const options = parseArguments(process.argv.slice(2));
	const { version, reference } = validateManifest(options.manifest);
	validatePackage(options.packageFile, version);
	validateLockfile(options.lockFile, version);
	process.stdout.write(`${reference}\n`);
}

try {
	main();
} catch (error) {
	process.stderr.write(`ci-playwright-image: ${error.message}\n`);
	process.exit(1);
}

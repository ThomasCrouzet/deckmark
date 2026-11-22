import { copyFile, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2];
if (mode !== '--write' && mode !== '--check') {
	throw new Error('Usage: node scripts/patch-milkdown-images.mjs --write|--check');
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Each entry keeps one patched npm package verifiable. The image patch has a
 * pinned pristine copy because the CI cache key does not include the patch file.
 * The KaTeX patch is a new patch with no earlier variant, so a forward apply
 * from the installed package is enough.
 */
const patches = [
	{
		name: 'Milkdown image patch',
		packageDirectory: 'node_modules/@milkdown/components',
		expectedVersion: '7.23.0',
		patchPath: resolve(root, 'patches/milkdown/image-proxy-race.patch'),
		pristineDirectory: resolve(root, 'patches/milkdown/pristine')
	},
	{
		name: 'Milkdown deferred KaTeX patch',
		packageDirectory: 'node_modules/@milkdown/crepe',
		expectedVersion: '7.23.0',
		patchPath: resolve(root, 'patches/milkdown/deferred-katex.patch')
	}
];

async function readPackageVersion(packageDirectory) {
	const packageJson = JSON.parse(
		await readFile(resolve(root, packageDirectory, 'package.json'), 'utf8')
	);
	return packageJson.version;
}

function applyStatus(patch, flags) {
	return spawnSync(
		'git',
		[
			'apply',
			'--whitespace=nowarn',
			`--directory=${patch.packageDirectory}`,
			...flags,
			patch.patchPath
		],
		{ cwd: root, encoding: 'utf8' }
	);
}

async function restorePristineFiles(patch, patchedPaths) {
	for (const path of patchedPaths) {
		await copyFile(
			resolve(patch.pristineDirectory, path),
			resolve(root, patch.packageDirectory, path)
		);
	}
	console.log(
		`${patch.name} ${patch.expectedVersion}: restored ${patchedPaths.length} package files from the pinned copy.`
	);
}

async function patchPackage(patch) {
	const version = await readPackageVersion(patch.packageDirectory);
	if (version !== patch.expectedVersion) {
		throw new Error(`Expected ${patch.name} ${patch.expectedVersion}, found ${String(version)}`);
	}

	const patchText = await readFile(patch.patchPath, 'utf8');
	const patchedPaths = [...patchText.matchAll(/^diff --git a\/(\S+) b\//gm)].map(
		(match) => match[1]
	);

	const reverseCheck = applyStatus(patch, ['--reverse', '--check']);
	if (reverseCheck.status === 0) {
		console.log(`${patch.name} ${patch.expectedVersion}: verified.`);
		return;
	}

	let forwardCheck = applyStatus(patch, ['--check']);
	if (forwardCheck.status !== 0 && mode === '--write' && patch.pristineDirectory) {
		await restorePristineFiles(patch, patchedPaths);
		forwardCheck = applyStatus(patch, ['--check']);
	}
	if (forwardCheck.status !== 0) {
		const details = [reverseCheck.stderr, forwardCheck.stderr].filter(Boolean).join('\n');
		throw new Error(`Milkdown patch cannot be verified or applied.\n${details}`);
	}
	if (mode === '--check') {
		throw new Error(`${patch.name} is not applied. Run npm run patch:milkdown.`);
	}

	const applied = applyStatus(patch, []);
	if (applied.status !== 0) {
		throw new Error(`${patch.name} failed.\n${applied.stderr}`);
	}
	const verified = applyStatus(patch, ['--reverse', '--check']);
	if (verified.status !== 0) {
		throw new Error(`${patch.name} verification failed.\n${verified.stderr}`);
	}
	console.log(`${patch.name} ${patch.expectedVersion}: applied and verified.`);
}

for (const patch of patches) await patchPackage(patch);

import { copyFile, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const expectedVersion = '7.23.0';
const mode = process.argv[2];
if (mode !== '--write' && mode !== '--check') {
	throw new Error('Usage: node scripts/patch-milkdown-images.mjs --write|--check');
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageDirectory = 'node_modules/@milkdown/components';
const packageJsonPath = resolve(root, packageDirectory, 'package.json');
const patchPath = resolve(root, 'patches/milkdown/image-proxy-race.patch');
const pristineDirectory = resolve(root, 'patches/milkdown/pristine');
const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
if (packageJson.version !== expectedVersion) {
	throw new Error(
		`Expected @milkdown/components ${expectedVersion}, found ${String(packageJson.version)}`
	);
}

const patchText = await readFile(patchPath, 'utf8');
const patchedPaths = [...patchText.matchAll(/^diff --git a\/(\S+) b\//gm)].map((match) => match[1]);

function applyStatus(flags) {
	return spawnSync(
		'git',
		['apply', '--whitespace=nowarn', `--directory=${packageDirectory}`, ...flags, patchPath],
		{ cwd: root, encoding: 'utf8' }
	);
}

/**
 * The CI node_modules cache key does not include the patch file. A cache entry
 * from another branch can hold an older applied patch and make both the reverse
 * and the forward check fail. Restore only the files named by the patch.
 */
async function restorePristineFiles() {
	for (const path of patchedPaths) {
		await copyFile(resolve(pristineDirectory, path), resolve(root, packageDirectory, path));
	}
	console.log(
		`Milkdown image patch ${expectedVersion}: restored ${patchedPaths.length} package files from the pinned copy.`
	);
}

const reverseCheck = applyStatus(['--reverse', '--check']);
if (reverseCheck.status === 0) {
	console.log(`Milkdown image patch ${expectedVersion}: verified.`);
	process.exit(0);
}

let forwardCheck = applyStatus(['--check']);
if (forwardCheck.status !== 0 && mode === '--write') {
	await restorePristineFiles();
	forwardCheck = applyStatus(['--check']);
}
if (forwardCheck.status !== 0) {
	const details = [reverseCheck.stderr, forwardCheck.stderr].filter(Boolean).join('\n');
	throw new Error(`Milkdown image patch cannot be verified or applied.\n${details}`);
}
if (mode === '--check') {
	throw new Error('Milkdown image patch is not applied. Run npm run patch:milkdown.');
}

const applied = applyStatus([]);
if (applied.status !== 0) {
	throw new Error(`Milkdown image patch failed.\n${applied.stderr}`);
}
const verified = applyStatus(['--reverse', '--check']);
if (verified.status !== 0) {
	throw new Error(`Milkdown image patch verification failed.\n${verified.stderr}`);
}
console.log(`Milkdown image patch ${expectedVersion}: applied and verified.`);

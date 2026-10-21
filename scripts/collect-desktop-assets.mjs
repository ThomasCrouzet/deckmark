import { createHash } from 'node:crypto';
import {
	copyFileSync,
	constants,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** @param {string} root @returns {string[]} */
function walk(root) {
	return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		if (entry.isSymbolicLink() || entry.name.endsWith('.app')) return [];
		const path = join(root, entry.name);
		return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : [];
	});
}

/** @param {string} name */
function releaseName(name) {
	return name
		.replace(/_aarch64\.dmg$/, '_macOS_Apple-Silicon.dmg')
		.replace(/_x64\.dmg$/, '_macOS_Intel.dmg');
}

/** @param {string} input @param {string} output */
export function collectDesktopAssets(input, output) {
	const candidates = walk(input).filter((path) =>
		/\.(?:dmg|AppImage|deb|rpm|msi)$|-setup\.exe$/.test(basename(path))
	);
	const names = candidates.map((path) => basename(path));
	if (new Set(names).size !== names.length) throw new Error('Duplicate artifact names');
	for (const pattern of [
		/aarch64\.dmg$/,
		/x64\.dmg$/,
		/\.AppImage$/,
		/\.deb$/,
		/\.rpm$/,
		/-setup\.exe$/,
		/\.msi$/
	]) {
		if (!names.some((name) => pattern.test(name)))
			throw new Error(`Required artifact is missing: ${pattern}`);
	}
	const publishedNames = names.map(releaseName);
	if (new Set(publishedNames).size !== publishedNames.length)
		throw new Error('Duplicate artifact names');
	mkdirSync(output, { recursive: true });
	const checksums = candidates
		.sort((a, b) => basename(a).localeCompare(basename(b)))
		.map((path) => {
			const name = releaseName(basename(path));
			if (/[\r\n]/.test(name)) throw new Error('Invalid filename');
			copyFileSync(path, join(output, name), constants.COPYFILE_EXCL);
			return `${createHash('sha256').update(readFileSync(path)).digest('hex')}  ${name}`;
		});
	writeFileSync(join(output, 'SHA256SUMS'), `${checksums.join('\n')}\n`, { flag: 'wx' });
	return publishedNames;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	collectDesktopAssets(process.argv[2] ?? 'downloaded-assets', process.argv[3] ?? 'release-assets');
}

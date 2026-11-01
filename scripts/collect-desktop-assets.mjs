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
	return name.replace(/_aarch64\.dmg$/, '_macOS_Apple-Silicon.dmg');
}

const installerPattern = /\.(?:dmg|AppImage|deb|rpm|msi)$|-setup\.exe$/;

/** @param {string} input @param {string} output @param {{ sha: string, tag: string, version: string }} expected */
export function collectDesktopAssets(input, output, expected) {
	if (
		!/^[a-f0-9]{40}$/.test(expected.sha) ||
		!/^v\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(expected.tag) ||
		!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(expected.version) ||
		expected.tag !== `v${expected.version}`
	) {
		throw new Error('Invalid source identity');
	}
	const artifactPaths = readdirSync(input, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
		.map((entry) => join(input, entry.name));
	const candidates = artifactPaths.flatMap((artifactPath) => {
		const files = walk(artifactPath);
		const sourcePaths = files.filter((path) => basename(path) === 'desktop-source.json');
		const sourcePath = sourcePaths[0];
		if (!sourcePath || sourcePaths.length !== 1) {
			throw new Error('Each installer artifact must contain one source manifest');
		}
		let source;
		try {
			source = JSON.parse(readFileSync(sourcePath, 'utf8'));
		} catch {
			throw new Error('Invalid source manifest');
		}
		if (
			!source ||
			typeof source !== 'object' ||
			Array.isArray(source) ||
			source.sha !== expected.sha ||
			source.tag !== expected.tag ||
			source.version !== expected.version
		) {
			throw new Error('The artifacts do not match the specified source');
		}
		return files.filter((path) => installerPattern.test(basename(path)));
	});
	const names = candidates.map((path) => basename(path));
	if (new Set(names).size !== names.length) throw new Error('Duplicate artifact names');
	for (const pattern of [
		/aarch64\.dmg$/,
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
	collectDesktopAssets(
		process.argv[2] ?? 'downloaded-assets',
		process.argv[3] ?? 'release-assets',
		{
			sha: process.env.SOURCE_SHA ?? '',
			tag: process.env.RELEASE_TAG ?? '',
			version: JSON.parse(readFileSync('package.json', 'utf8')).version
		}
	);
}

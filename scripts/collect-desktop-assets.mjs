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
import {
	DESKTOP_RELEASE_FORMATS,
	formatForFile,
	platformFromArtifact,
	releaseNameFor
} from './desktop-release-policy.mjs';

/** @param {string} root @returns {string[]} */
function walk(root) {
	return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		if (entry.isSymbolicLink() || entry.name.endsWith('.app')) return [];
		const path = join(root, entry.name);
		return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : [];
	});
}

/**
 * Collect the accepted installers from the per-runner workflow artifacts.
 * The policy is the single format list. A missing format, an extra format,
 * an installer from the wrong runner artifact and a different source identity
 * all fail before any byte reaches the release directory.
 * @param {string} input @param {string} output @param {{ sha: string, tag: string, version: string }} expected
 */
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
	if (artifactPaths.length === 0) throw new Error('No installer artifact was downloaded');
	/** @type {{ path: string, formatId: string }[]} */
	const candidates = [];
	for (const artifactPath of artifactPaths) {
		const platform = platformFromArtifact(basename(artifactPath));
		const files = walk(artifactPath);
		const sourcePaths = files.filter((path) => basename(path) === 'desktop-source.json');
		if (sourcePaths.length !== 1) {
			throw new Error('Each installer artifact must contain one source manifest');
		}
		let source;
		try {
			source = JSON.parse(readFileSync(sourcePaths[0], 'utf8'));
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
		for (const path of files) {
			const name = basename(path);
			const format = formatForFile(name);
			if (!format) continue;
			if (format.platform !== platform) {
				throw new Error(
					`${name} appears in the ${platform} artifact but belongs to ${format.platform}`
				);
			}
			candidates.push({ path, formatId: format.id });
		}
	}
	const seenFormats = new Set();
	for (const candidate of candidates) {
		if (seenFormats.has(candidate.formatId)) {
			throw new Error(`Duplicate installer format: ${candidate.formatId}`);
		}
		seenFormats.add(candidate.formatId);
	}
	for (const format of DESKTOP_RELEASE_FORMATS) {
		if (!seenFormats.has(format.id)) {
			throw new Error(`Required installer format is missing: ${format.id}`);
		}
	}
	const publishedNames = candidates.map((candidate) => releaseNameFor(basename(candidate.path)));
	if (new Set(publishedNames).size !== publishedNames.length) {
		throw new Error('Duplicate artifact names');
	}
	mkdirSync(output, { recursive: true });
	const checksums = candidates
		.sort((a, b) => basename(a.path).localeCompare(basename(b.path)))
		.map((candidate) => {
			const name = releaseNameFor(basename(candidate.path));
			if (/[\r\n]/.test(name)) throw new Error('Invalid filename');
			copyFileSync(candidate.path, join(output, name), constants.COPYFILE_EXCL);
			return `${createHash('sha256').update(readFileSync(candidate.path)).digest('hex')}  ${name}`;
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

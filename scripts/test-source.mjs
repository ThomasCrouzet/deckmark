import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { platform, release, arch } from 'node:os';

/** @param {string} [artifactDirectory] */
export function testSource(artifactDirectory) {
	/** @param {string[]} args */
	const git = (...args) => execFileSync('git', args, { maxBuffer: 64 * 1024 * 1024 });
	/** @param {string | Buffer} data */
	const hash = (data) => createHash('sha256').update(data).digest('hex');
	const diff = git('diff', '--binary', 'HEAD');
	const untracked = git('ls-files', '--others', '--exclude-standard', '-z')
		.toString()
		.split('\0')
		.filter(Boolean)
		.map((path) => {
			const bytes = readFileSync(path);
			if (artifactDirectory) {
				const destination = join(artifactDirectory, 'untracked', path);
				mkdirSync(dirname(destination), { recursive: true });
				writeFileSync(destination, bytes);
			}
			return { path, sha256: hash(bytes) };
		});
	const metadata = {
		capturedAt: new Date().toISOString(),
		command: [process.execPath, ...process.argv.slice(1)],
		source: git('rev-parse', 'HEAD').toString().trim(),
		sourceTree: git('rev-parse', 'HEAD^{tree}').toString().trim(),
		workingDiffSha256: hash(diff),
		untracked,
		environment: { platform: platform(), release: release(), arch: arch(), node: process.version }
	};
	if (artifactDirectory) {
		mkdirSync(artifactDirectory, { recursive: true });
		writeFileSync(join(artifactDirectory, 'working.diff'), diff);
		writeFileSync(
			join(artifactDirectory, 'status.txt'),
			git('status', '--porcelain=v1', '--untracked-files=all')
		);
		writeFileSync(join(artifactDirectory, 'metadata.json'), JSON.stringify(metadata, null, 2));
	}
	return metadata;
}

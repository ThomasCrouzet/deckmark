import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { platform, release, arch } from 'node:os';

export function testSource() {
	/** @param {string[]} args */
	const git = (...args) => execFileSync('git', args, { maxBuffer: 64 * 1024 * 1024 });
	/** @param {string | Buffer} data */
	const hash = (data) => createHash('sha256').update(data).digest('hex');
	return {
		command: [process.execPath, ...process.argv.slice(1)],
		source: git('rev-parse', 'HEAD').toString().trim(),
		workingDiffSha256: hash(git('diff', '--binary', 'HEAD')),
		untracked: git('ls-files', '--others', '--exclude-standard', '-z')
			.toString()
			.split('\0')
			.filter(Boolean)
			.map((path) => ({ path, sha256: hash(readFileSync(path)) })),
		environment: { platform: platform(), release: release(), arch: arch(), node: process.version }
	};
}

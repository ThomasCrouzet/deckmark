import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readBytes, readText, walkFiles } from './paths';

const isWindows = process.platform === 'win32';
const directoryLinkType = isWindows ? 'junction' : 'dir';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(repoRoot, 'bin/deckmark.mjs');

let base: string;

function runCli(
	cwd: string,
	args: readonly string[]
): { status: number; stdout: string; stderr: string } {
	const result = spawnSync(process.execPath, [cliPath, ...args], {
		cwd,
		encoding: 'utf8',
		timeout: 60_000
	});
	return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

beforeAll(async () => {
	base = await mkdtemp(join(tmpdir(), 'deckmark-cli-security-'));
});

afterAll(async () => {
	await rm(base, { recursive: true, force: true });
});

describe('CLI input confinement', () => {
	it('refuses a walked file replaced by a symlink to an outside root', async () => {
		const approved = join(base, 'leaf-swap', 'approved');
		const outside = join(base, 'leaf-swap', 'outside');
		await mkdir(join(approved, 'docs'), { recursive: true });
		await mkdir(outside, { recursive: true });
		await writeFile(join(approved, 'docs', 'note.md'), '# Inside\n');
		await writeFile(join(outside, 'note.md'), 'OUTSIDE-SECRET\n');
		expect(await walkFiles(approved)).toEqual(['docs/note.md']);

		await rm(join(approved, 'docs', 'note.md'));
		await symlink(join(outside, 'note.md'), join(approved, 'docs', 'note.md'));

		await expect(readText(approved, 'docs/note.md')).rejects.toMatchObject({
			name: 'CliError',
			code: 'input-unreadable'
		});
	});

	it('refuses a walked directory replaced by a symlink to an outside root', async () => {
		const approved = join(base, 'directory-swap', 'approved');
		const outside = join(base, 'directory-swap', 'outside');
		await mkdir(join(approved, 'docs'), { recursive: true });
		await mkdir(outside, { recursive: true });
		await writeFile(join(approved, 'docs', 'note.md'), '# Inside\n');
		await writeFile(join(outside, 'note.md'), 'OUTSIDE-SECRET\n');
		expect(await walkFiles(approved)).toEqual(['docs/note.md']);

		await rename(join(approved, 'docs'), join(approved, 'docs-old'));
		await symlink(outside, join(approved, 'docs'), directoryLinkType);

		await expect(readText(approved, 'docs/note.md')).rejects.toMatchObject({
			name: 'CliError',
			code: 'input-outside-root'
		});
	});

	it('applies the same confinement to binary reads', async () => {
		const approved = join(base, 'binary-swap', 'approved');
		const outside = join(base, 'binary-swap', 'outside');
		await mkdir(join(approved, 'assets'), { recursive: true });
		await mkdir(outside, { recursive: true });
		await writeFile(join(approved, 'assets', 'image.png'), Buffer.from([1, 2, 3]));
		await writeFile(join(outside, 'image.png'), Buffer.from('OUTSIDE-SECRET'));
		expect(await walkFiles(approved)).toEqual(['assets/image.png']);

		await rm(join(approved, 'assets', 'image.png'));
		await symlink(join(outside, 'image.png'), join(approved, 'assets', 'image.png'));

		await expect(readBytes(approved, 'assets/image.png')).rejects.toMatchObject({
			name: 'CliError',
			code: 'input-unreadable'
		});
	});

	it('bounds the bytes that one read can return', async () => {
		const approved = join(base, 'bounded-read', 'approved');
		await mkdir(approved, { recursive: true });
		await writeFile(join(approved, 'note.md'), 'x'.repeat(200));

		await expect(readText(approved, 'note.md', { maxBytes: 50 })).rejects.toMatchObject({
			name: 'CliError',
			code: 'file-too-large'
		});
	});

	it('still reads a regular file under an approved root', async () => {
		const approved = join(base, 'regular', 'approved');
		await mkdir(join(approved, 'docs'), { recursive: true });
		await writeFile(join(approved, 'docs', 'note.md'), '# Regular\n');

		expect(await readText(approved, 'docs/note.md')).toBe('# Regular\n');
		expect(new TextDecoder().decode(await readBytes(approved, 'docs/note.md'))).toBe('# Regular\n');
	});

	it('refuses a relative path that leaves the approved root', async () => {
		const approved = join(base, 'lexical', 'approved');
		const outside = join(base, 'lexical', 'outside');
		await mkdir(approved, { recursive: true });
		await mkdir(outside, { recursive: true });
		await writeFile(join(outside, 'note.md'), 'OUTSIDE-SECRET\n');

		await expect(readText(approved, '../outside/note.md')).rejects.toMatchObject({
			name: 'CliError'
		});
	});

	it.skipIf(isWindows)('keeps an explicitly selected symlink input readable', async () => {
		const project = join(base, 'selected-link');
		await mkdir(project, { recursive: true });
		await writeFile(join(project, 'real.md'), '# Real note\n\nText.\n');
		await symlink(join(project, 'real.md'), join(project, 'link.md'));

		const result = runCli(project, ['inspect', 'link.md', '--json']);

		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout).title).toBe('Real note');
	});
});

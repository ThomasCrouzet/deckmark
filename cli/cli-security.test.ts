import { spawnSync } from 'node:child_process';
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	symlink,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readBytes, readText, resolveOutput, walkFiles, writeOutput } from './paths';

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

describe('CLI root scope with double-dot names', () => {
	it('accepts an in-root file under a directory whose name starts with two dots', async () => {
		const project = join(base, 'dot-name', 'project');
		await mkdir(join(project, '..notes'), { recursive: true });
		await writeFile(join(project, '..notes', 'guide.md'), '# Valid\n\nText.\n');

		const result = runCli(project, ['check', '..notes/guide.md', '--root', '.', '--json']);

		expect(result.status, result.stderr).toBe(0);
		const report = JSON.parse(result.stdout);
		expect(report.schema).toBe('mdsh-docs-check/1');
		expect(report.documents).toBe(1);
		expect(report.summary).toEqual({ errors: 0, warnings: 0 });
	});

	it('accepts an in-root directory whose name starts with two dots', async () => {
		const project = join(base, 'dot-directory', 'project');
		await mkdir(join(project, '..notes'), { recursive: true });
		await writeFile(join(project, '..notes', 'guide.md'), '# Valid\n\nText.\n');

		const result = runCli(project, ['check', '..notes', '--root', '.', '--json']);

		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout).documents).toBe(1);
	});

	it('accepts an in-root file name that starts with two dots', async () => {
		const project = join(base, 'dot-file', 'project');
		await mkdir(project, { recursive: true });
		await writeFile(join(project, '...md'), '# Dots\n\nText.\n');

		const result = runCli(project, ['check', '...md', '--root', '.', '--json']);

		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout).documents).toBe(1);
	});

	it('accepts an in-root Unicode directory whose name starts with two dots', async () => {
		const project = join(base, 'dot-unicode', 'project');
		await mkdir(join(project, '..café'), { recursive: true });
		await writeFile(join(project, '..café', 'guide.md'), '# Valid\n\nText.\n');

		const result = runCli(project, ['check', '..café', '--root', '.', '--json']);

		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout).documents).toBe(1);
	});

	it('still denies a parent-directory escape and an outside symlink', async () => {
		const project = join(base, 'escape', 'project');
		const outside = join(base, 'escape', 'outside');
		await mkdir(project, { recursive: true });
		await mkdir(outside, { recursive: true });
		await writeFile(join(outside, 'guide.md'), '# Outside\n');

		const parent = runCli(project, ['check', '../outside/guide.md', '--root', '.', '--json']);
		expect(parent.status).toBe(3);
		expect(JSON.parse(parent.stderr).code).toBe('input-outside-root');

		const absolute = runCli(project, ['check', join(outside, 'guide.md'), '--root', '.', '--json']);
		expect(absolute.status).toBe(3);
		expect(JSON.parse(absolute.stderr).code).toBe('input-outside-root');
	});

	it.skipIf(isWindows)('still denies an in-root symlink to an outside root', async () => {
		const project = join(base, 'escape-link', 'project');
		const outside = join(base, 'escape-link', 'outside');
		await mkdir(project, { recursive: true });
		await mkdir(outside, { recursive: true });
		await writeFile(join(outside, 'guide.md'), '# Outside\n');
		await symlink(join(outside, 'guide.md'), join(project, 'guide.md'));

		const result = runCli(project, ['check', 'guide.md', '--root', '.', '--json']);

		expect(result.status).toBe(3);
		expect(JSON.parse(result.stderr).code).toBe('input-outside-root');
	});

	it('reports a stable relative display path for a double-dot name in the working directory', async () => {
		const project = join(base, 'display', 'project');
		await mkdir(join(project, '..notes'), { recursive: true });
		await writeFile(join(project, '..notes', 'guide.md'), '# Valid\n\nText.\n');

		const result = runCli(project, ['render', '..notes/guide.md', '--json']);

		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout).input).toBe('..notes/guide.md');
	});
});

describe('CLI output confinement', () => {
	it('refuses an absent parent directory swapped to an outside symlink after approval', async () => {
		const cwd = join(base, 'output-absent', 'cwd');
		const outside = join(base, 'output-absent', 'outside');
		await mkdir(cwd, { recursive: true });
		await mkdir(outside, { recursive: true });
		await writeFile(join(outside, 'result.zip'), 'OUTSIDE-SENTINEL');

		const target = await resolveOutput('export/result.zip', 'zip', { cwd });
		await symlink(outside, join(cwd, 'export'), directoryLinkType);

		await expect(writeOutput(target, 'NEW-CONTENT')).rejects.toMatchObject({
			name: 'CliError',
			code: 'unsafe-output'
		});
		expect(await readFile(join(outside, 'result.zip'), 'utf8')).toBe('OUTSIDE-SENTINEL');
		expect(await readdir(outside)).toEqual(['result.zip']);
	});

	it('refuses an existing parent directory swapped to an outside symlink after approval', async () => {
		const cwd = join(base, 'output-existing', 'cwd');
		const outside = join(base, 'output-existing', 'outside');
		await mkdir(join(cwd, 'export'), { recursive: true });
		await mkdir(outside, { recursive: true });
		await writeFile(join(outside, 'result.html'), 'OUTSIDE-SENTINEL');

		const target = await resolveOutput('export/result.html', 'html', { cwd });
		await rename(join(cwd, 'export'), join(cwd, 'export-old'));
		await symlink(outside, join(cwd, 'export'), directoryLinkType);

		await expect(writeOutput(target, '<p>NEW</p>')).rejects.toMatchObject({
			name: 'CliError',
			code: 'unsafe-output'
		});
		expect(await readFile(join(outside, 'result.html'), 'utf8')).toBe('OUTSIDE-SENTINEL');
		expect(await readdir(outside)).toEqual(['result.html']);
	});

	it('does not follow a leaf symlink to an outside file', async () => {
		const cwd = join(base, 'output-leaf', 'cwd');
		const outside = join(base, 'output-leaf', 'outside');
		await mkdir(cwd, { recursive: true });
		await mkdir(outside, { recursive: true });
		await writeFile(join(outside, 'keep.md'), 'OUTSIDE-SENTINEL');

		const target = await resolveOutput('note.md', 'md', { cwd });
		await symlink(join(outside, 'keep.md'), target);

		await writeOutput(target, 'LOCAL');

		expect(await readFile(join(outside, 'keep.md'), 'utf8')).toBe('OUTSIDE-SENTINEL');
		expect(await readFile(target, 'utf8')).toBe('LOCAL');
	});

	it('writes an ordinary relative output and an absolute output', async () => {
		const cwd = join(base, 'output-normal', 'cwd');
		await mkdir(cwd, { recursive: true });

		const relative = await resolveOutput('nested/result.md', 'md', { cwd });
		await writeOutput(relative, 'RELATIVE');
		expect(await readFile(join(cwd, 'nested', 'result.md'), 'utf8')).toBe('RELATIVE');

		const absoluteTarget = join(base, 'output-normal', 'absolute', 'result.html');
		const absolute = await resolveOutput(absoluteTarget, 'html', { cwd });
		await writeOutput(absolute, '<p>ABSOLUTE</p>');
		expect(await readFile(absoluteTarget, 'utf8')).toBe('<p>ABSOLUTE</p>');
	});

	it('keeps the outside sentinel and its own temporary files apart on failure', async () => {
		const cwd = join(base, 'output-cleanup', 'cwd');
		const outside = join(base, 'output-cleanup', 'outside');
		await mkdir(cwd, { recursive: true });
		await mkdir(outside, { recursive: true });
		await writeFile(join(outside, 'result.md'), 'OUTSIDE-SENTINEL');

		const target = await resolveOutput('export/result.md', 'md', { cwd });
		await symlink(outside, join(cwd, 'export'), directoryLinkType);

		await expect(writeOutput(target, 'NEW')).rejects.toBeInstanceOf(Error);
		const outsideNames = await readdir(outside);
		expect(outsideNames).toEqual(['result.md']);
	});

	it.skipIf(process.getuid?.() === 0)(
		'reports a write failure without a temporary file',
		async () => {
			const cwd = join(base, 'output-failure', 'cwd');
			await mkdir(join(cwd, 'locked'), { recursive: true });
			const target = await resolveOutput('locked/result.md', 'md', { cwd });
			await chmod(join(cwd, 'locked'), 0o500);
			try {
				await expect(writeOutput(target, 'NEW')).rejects.toMatchObject({
					name: 'CliError',
					code: 'output-failed'
				});
				expect(await readdir(join(cwd, 'locked'))).toEqual([]);
			} finally {
				await chmod(join(cwd, 'locked'), 0o700);
			}
		}
	);
});

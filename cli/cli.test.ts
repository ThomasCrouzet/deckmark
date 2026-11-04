import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(repoRoot, 'bin/deckmark.mjs');
const fixtureRoot = join(repoRoot, 'cli/test/fixtures/project');
const goldenRoot = join(repoRoot, 'cli/test/golden');

let temporaryRoot: string;
let project: string;

interface CommandResult {
	status: number;
	stdout: string;
	stderr: string;
}

function run(cwd: string, args: readonly string[], timeout = 30_000): CommandResult {
	const result = spawnSync(process.execPath, [cliPath, ...args], {
		cwd,
		encoding: 'utf8',
		timeout
	});
	return {
		status: result.status ?? -1,
		stdout: result.stdout,
		stderr: result.stderr
	};
}

async function golden(name: string): Promise<string> {
	return readFile(join(goldenRoot, name), 'utf8');
}

beforeAll(async () => {
	execFileSync(process.execPath, [join(repoRoot, 'scripts/build-cli.mjs')], {
		cwd: repoRoot,
		stdio: 'pipe'
	});
	temporaryRoot = await mkdtemp(join(tmpdir(), 'deckmark-cli-'));
	project = join(temporaryRoot, 'project');
	await cp(fixtureRoot, project, { recursive: true });
}, 120_000);

afterAll(async () => {
	await rm(temporaryRoot, { recursive: true, force: true });
});

describe('deckmark CLI', () => {
	it('documents its commands and exit codes', () => {
		const help = run(project, ['--help']);
		expect(help.status).toBe(0);
		expect(help.stdout).toContain('check [path]');
		expect(help.stdout).toContain('5 check failed');
		const version = run(project, ['--version']);
		expect(version.status).toBe(0);
		expect(version.stdout).toMatch(/^deckmark \d+\.\d+\.\d+\n$/);
	});

	it('writes the golden documentation check report and exits 5', async () => {
		const result = run(project, ['check', '.', '--json']);
		expect(result.status).toBe(5);
		expect(JSON.parse(result.stdout)).toEqual(JSON.parse(await golden('check.json')));
	});

	it('filters check issues to one document with an explicit root', () => {
		const result = run(project, ['check', 'notes/valid.md', '--root', '.', '--strict', '--json']);
		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout).summary).toEqual({ errors: 0, warnings: 0 });
	});

	it('writes deterministic search matches', async () => {
		const first = run(project, ['search', 'needle', '.', '--json']);
		const second = run(project, ['search', 'needle', '.', '--json']);
		expect(first.status).toBe(0);
		expect(first.stdout).toEqual(second.stdout);
		expect(JSON.parse(first.stdout)).toEqual(JSON.parse(await golden('search.json')));
		const empty = run(project, ['search', 'absent-term', '.', '--json']);
		expect(empty.status).toBe(0);
		expect(JSON.parse(empty.stdout).total).toBe(0);
	});

	it('reports the inspection of a note and a presentation', async () => {
		const note = run(project, ['inspect', 'notes/valid.md', '--json']);
		expect(note.status).toBe(0);
		expect(JSON.parse(note.stdout)).toEqual(JSON.parse(await golden('inspect.json')));
		const presentation = run(project, ['inspect', 'notes/slides.md', '--json']);
		expect(presentation.status).toBe(0);
		expect(JSON.parse(presentation.stdout).kind).toBe('presentation');
	});

	it('renders golden standalone HTML', async () => {
		const result = run(project, ['render', 'README.md']);
		expect(result.status).toBe(0);
		expect(result.stdout).toEqual(await golden('render.html'));
		expect(result.stdout).toContain('<meta name="generator" content="DeckMark CLI">');
		expect(result.stdout).toContain('id="links"');
	});

	it('exports HTML and Markdown without the GUI', async () => {
		const htmlTarget = join(temporaryRoot, 'valid.html');
		const html = run(project, [
			'export',
			'notes/valid.md',
			'--format',
			'html',
			'--out',
			htmlTarget
		]);
		expect(html.status).toBe(0);
		expect(await readFile(htmlTarget, 'utf8')).toContain('<h1 id="valid-note">');

		const markdownTarget = join(temporaryRoot, 'readme.md');
		const markdown = run(project, [
			'export',
			'README.md',
			'--format',
			'md',
			'--out',
			markdownTarget
		]);
		expect(markdown.status).toBe(0);
		expect(await readFile(markdownTarget, 'utf8')).toEqual(
			await readFile(join(project, 'README.md'), 'utf8')
		);
	});

	it('builds a reproducible project archive', async () => {
		const first = join(temporaryRoot, 'first.zip');
		const second = join(temporaryRoot, 'second.zip');
		const args = ['export', '.', '--format', 'zip', '--out', first, '--name', 'fixture-project'];
		const one = run(project, args);
		expect(one.status).toBe(0);
		const two = run(project, [
			'export',
			'.',
			'--format',
			'zip',
			'--out',
			second,
			'--name',
			'fixture-project'
		]);
		expect(two.status).toBe(0);
		const firstBytes = await readFile(first);
		const secondBytes = await readFile(second);
		const digest = createHash('sha256').update(firstBytes).digest('hex');
		expect(digest).toBe((await golden('project.sha256')).trim());
		expect(createHash('sha256').update(secondBytes).digest('hex')).toBe(digest);
		const zip = await JSZip.loadAsync(firstBytes);
		expect(Object.keys(zip.files)).toContain('README.md');
		expect(Object.keys(zip.files)).toContain('.mdsh/link-report.json');
	});

	it('rejects path traversal and unsupported targets', () => {
		const traversal = run(project, ['render', 'README.md', '--out', '../escape.html', '--json']);
		expect(traversal.status).toBe(4);
		expect(JSON.parse(traversal.stderr).code).toBe('unsafe-output');

		const format = run(project, ['export', '.', '--format', 'rar', '--out', 'out/a.rar']);
		expect(format.status).toBe(2);

		const extension = run(project, ['render', 'README.md', '--out', 'out/readme.txt']);
		expect(extension.status).toBe(2);
	});

	it('uses documented exit codes for input and option failures', () => {
		expect(run(project, ['check', 'missing-directory']).status).toBe(3);
		expect(run(project, ['inspect', 'missing.md']).status).toBe(3);
		expect(run(project, ['check', '.', '--concurrency', '0']).status).toBe(2);
		expect(run(project, ['search', 'a', '.']).status).toBe(2);
		expect(run(project, ['unknown-command']).status).toBe(2);
	});
});

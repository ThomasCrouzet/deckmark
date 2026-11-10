import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// A browser cannot run the Node CLI or its real filesystem boundary. These
// cases retain the text-only input policy for inspect, HTML export and Markdown
// export, including PDF bytes that happen to decode as valid UTF-8. ZIP keeps
// its explicit binary asset support.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(repoRoot, 'bin/deckmark.mjs');

const ASCII_PDF = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>
endobj
trailer
<< /Root 1 0 R >>
%%EOF
`;

// Invalid UTF-8 sequences stay in a real PDF body, not in a text file.
const BINARY_PDF = Buffer.concat([
	Buffer.from(
		'%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n1 0 obj\n<< /Type /Catalog >>\nendobj\n',
		'latin1'
	),
	Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x81, 0x82, 0x00]),
	Buffer.from('\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1')
]);

let temporaryRoot: string;
let project: string;

interface CommandResult {
	status: number;
	stdout: string;
	stderr: string;
}

function run(cwd: string, args: readonly string[]): CommandResult {
	const result = spawnSync(process.execPath, [cliPath, ...args], {
		cwd,
		encoding: 'utf8',
		timeout: 30_000
	});
	return {
		status: result.status ?? -1,
		stdout: result.stdout,
		stderr: result.stderr
	};
}

async function exists(path: string): Promise<boolean> {
	try {
		await readFile(path);
		return true;
	} catch {
		return false;
	}
}

function errorCode(result: CommandResult): string {
	return JSON.parse(result.stderr).code as string;
}

beforeAll(async () => {
	execFileSync(process.execPath, [join(repoRoot, 'scripts/build-cli.mjs')], {
		cwd: repoRoot,
		stdio: 'pipe'
	});
	temporaryRoot = await mkdtemp(join(tmpdir(), 'deckmark-cli-text-'));
	project = join(temporaryRoot, 'project');
	await mkdir(project, { recursive: true });
	await writeFile(join(project, 'sample.pdf'), ASCII_PDF);
	await writeFile(join(project, 'binary.pdf'), BINARY_PDF);
	await writeFile(join(project, 'note.md'), '# Note\n\nA [link](other.md).\n');
	await writeFile(join(project, 'plain.txt'), 'plain text\n');
	await writeFile(join(project, 'sample.ts'), 'export const value = 1;\n');
	await writeFile(
		join(project, 'slides.md'),
		'# Slide\n\n<!-- mdsh-presentation\n{"version":1,"width":1280,"height":720,"theme":"light","slides":[]}\n-->\n'
	);
}, 120_000);

afterAll(async () => {
	await rm(temporaryRoot, { recursive: true, force: true });
});

describe('text-only CLI inputs', () => {
	it('rejects an ASCII PDF in inspect without a report', () => {
		const result = run(project, ['inspect', 'sample.pdf', '--json']);
		expect(result.status).toBe(3);
		expect(result.stdout).toBe('');
		expect(JSON.parse(result.stderr)).toMatchObject({
			schema: 'deckmark-error/1',
			code: 'input-not-text'
		});

		const human = run(project, ['inspect', 'sample.pdf']);
		expect(human.status).toBe(3);
		expect(human.stdout).toBe('');
		expect(human.stderr).toContain('Text inspection is not supported');
	});

	it('rejects a binary PDF in inspect without a report', () => {
		const result = run(project, ['inspect', 'binary.pdf', '--json']);
		expect(result.status).toBe(3);
		expect(result.stdout).toBe('');
		expect(errorCode(result)).toBe('input-not-text');
	});

	it('rejects PDF inputs in HTML export and leaves no output', async () => {
		for (const input of ['sample.pdf', 'binary.pdf']) {
			const target = join(temporaryRoot, `${input}.html`);
			const result = run(project, ['export', input, '--format', 'html', '--out', target, '--json']);
			expect(result.status).toBe(2);
			expect(result.stdout).toBe('');
			expect(errorCode(result)).toBe('unsupported-format');
			expect(JSON.parse(result.stderr).message).toContain('The input is pdf.');
			expect(await exists(target)).toBe(false);
		}
	});

	it('rejects PDF inputs in Markdown export and leaves no output', async () => {
		for (const input of ['sample.pdf', 'binary.pdf']) {
			const target = join(temporaryRoot, `${input}.md`);
			const result = run(project, ['export', input, '--format', 'md', '--out', target, '--json']);
			expect(result.status).toBe(2);
			expect(result.stdout).toBe('');
			expect(errorCode(result)).toBe('unsupported-format');
			expect(await exists(target)).toBe(false);

			const human = run(project, ['export', input, '--format', 'md', '--out', target]);
			expect(human.status).toBe(2);
			expect(human.stderr).toContain('The input is pdf.');
			expect(await exists(target)).toBe(false);
		}
	});

	it('keeps render rejection for PDF inputs', () => {
		const result = run(project, ['render', 'sample.pdf']);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain('The input is pdf.');
	});

	it('keeps text, code, and presentation inspection', () => {
		const note = run(project, ['inspect', 'note.md', '--json']);
		expect(note.status).toBe(0);
		expect(JSON.parse(note.stdout).kind).toBe('note');

		const text = run(project, ['inspect', 'plain.txt', '--json']);
		expect(text.status).toBe(0);
		expect(JSON.parse(text.stdout).kind).toBe('code');

		const code = run(project, ['inspect', 'sample.ts', '--json']);
		expect(code.status).toBe(0);
		expect(JSON.parse(code.stdout).kind).toBe('code');

		const presentation = run(project, ['inspect', 'slides.md', '--json']);
		expect(presentation.status).toBe(0);
		expect(JSON.parse(presentation.stdout).kind).toBe('presentation');
	});

	it('keeps HTML output for notes and exact copies for text and presentations', async () => {
		const htmlTarget = join(temporaryRoot, 'note.html');
		const html = run(project, ['export', 'note.md', '--format', 'html', '--out', htmlTarget]);
		expect(html.status).toBe(0);
		expect(await readFile(htmlTarget, 'utf8')).toContain('<h1 id="note">');

		for (const input of ['plain.txt', 'sample.ts', 'slides.md']) {
			const target = join(temporaryRoot, `${input}.copy.md`);
			const result = run(project, ['export', input, '--format', 'md', '--out', target]);
			expect(result.status).toBe(0);
			expect(await readFile(target, 'utf8')).toEqual(await readFile(join(project, input), 'utf8'));
		}
	});

	it('keeps PDF files as ZIP assets', async () => {
		const target = join(temporaryRoot, 'project.zip');
		const result = run(project, ['export', '.', '--format', 'zip', '--out', target]);
		expect(result.status).toBe(0);
		const zip = await JSZip.loadAsync(await readFile(target));
		expect(zip.files).toHaveProperty('sample.pdf');
		expect(await zip.files['sample.pdf']!.async('uint8array')).toEqual(
			Uint8Array.from(await readFile(join(project, 'sample.pdf')))
		);
	});
});

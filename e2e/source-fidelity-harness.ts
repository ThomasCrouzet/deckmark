import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { openPalette } from './helpers';

async function selectText(page: Page, editor: Locator, before: string) {
	await expect(editor).toBeVisible();
	await editor.evaluate((root, text) => {
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		const nodes: { node: Node; from: number; to: number }[] = [];
		let content = '';
		let node: Node | null;
		while ((node = walker.nextNode())) {
			const from = content.length;
			content += node.textContent;
			nodes.push({ node, from, to: content.length });
		}
		const index = content.indexOf(text);
		if (index < 0) throw new Error(`Sentence not found: ${text}`);
		const first = nodes.find(({ from, to }) => from <= index && to > index)!;
		const last = nodes.find(
			({ from, to }) => from < index + text.length && to >= index + text.length
		)!;
		const range = document.createRange();
		range.setStart(first.node, index - first.from);
		range.setEnd(last.node, index + text.length - last.from);
		(root as HTMLElement).focus();
		const selection = window.getSelection()!;
		selection.removeAllRanges();
		selection.addRange(range);
	}, before);
	// Let the browser deliver selectionchange before the first key event.
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			)
	);
	await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(before);
}

export async function editSentence(page: Page, before: string, after: string, paste = false) {
	const editor = page.locator('.ProseMirror');
	await selectText(page, editor, before);
	if (!after) await page.keyboard.press('Backspace');
	else if (paste) await page.keyboard.insertText(after);
	else await page.keyboard.type(after);
	await expect(editor).toContainText(after);
}

export async function exportSource(page: Page, name?: string): Promise<string> {
	await openPalette(page);
	await page.getByRole('combobox').fill('Exporter tous les fichiers (ZIP)');
	const download = page.waitForEvent('download');
	await page.keyboard.press('Enter');
	const chunks: Buffer[] = [];
	for await (const chunk of (await (await download).createReadStream())!) chunks.push(chunk);
	const zip = await (await import('jszip')).default.loadAsync(Buffer.concat(chunks));
	const file = name
		? zip.file(name)!
		: Object.values(zip.files).find((file) => file.name.endsWith('.md'))!;
	return file.async('string');
}

export async function recordFidelity(
	info: TestInfo,
	page: Page,
	id: string,
	source: string,
	expected: string,
	actual: string
) {
	const directory = await mkdtemp(join(tmpdir(), 'deckmark-fidelity-'));
	let diff: string;
	let extraDiff: string;
	try {
		for (const [name, value] of Object.entries({ source, expected, actual })) {
			await writeFile(join(directory, `${name}.md`), value);
			await info.attach(`${id}-${name}.md`, { body: value, contentType: 'text/markdown' });
		}
		const compare = (before: string, after: string) => {
			try {
				return execFileSync('git', ['diff', '--no-index', '--no-ext-diff', '--', before, after], {
					cwd: directory,
					encoding: 'utf8'
				});
			} catch (error) {
				if ((error as { status: number }).status !== 1) throw error;
				return (error as { stdout: string }).stdout;
			}
		};
		diff = compare('source.md', 'actual.md');
		extraDiff = compare('expected.md', 'actual.md');
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
	const count = (diff: string, marker: string) => {
		let inHunk = false;
		let count = 0;
		for (const line of diff.split('\n')) {
			if (line.startsWith('@@ ')) inHunk = true;
			else if (inHunk && line.startsWith(marker)) count++;
		}
		return count;
	};
	await info.attach(`${id}-git.diff`, { body: diff, contentType: 'text/plain' });
	await info.attach(`${id}-unexpected.diff`, { body: extraDiff, contentType: 'text/plain' });
	await info.attach(`${id}-metrics.json`, {
		body: JSON.stringify(
			{
				...info.config.metadata,
				repeatCommand: `E2E_PORT=4287 npm run test:e2e -- source-fidelity.spec.ts --project=${info.project.name} --workers=1`,
				browser: info.project.name,
				browserVersion: page.context().browser()?.version(),
				fixture: id,
				sha256: Object.fromEntries(
					Object.entries({ source, expected, actual }).map(([name, value]) => [
						name,
						createHash('sha256').update(value).digest('hex')
					])
				),
				changedLines: { added: count(diff, '+'), removed: count(diff, '-') },
				unexpectedLines: { added: count(extraDiff, '+'), removed: count(extraDiff, '-') },
				exact: actual === expected
			},
			null,
			2
		),
		contentType: 'application/json'
	});
	expect(actual, `Unexpected source changes in ${id}; see the attached Git diff`).toBe(expected);
}

export async function importSource(page: Page, source: string, name = 'fidelity') {
	await page.locator('input[type=file][accept*="text/markdown"]').setInputFiles({
		name: `${name}.md`,
		mimeType: 'text/markdown',
		buffer: Buffer.from(source)
	});
	await page.getByRole('button', { name: 'Fermer le bilan d’import', exact: true }).click();
}

export async function editCodeLine(
	page: Page,
	before: string,
	after: string,
	selector = '.cm-content'
) {
	const editor = page.locator(selector).filter({ hasText: before }).first();
	await selectText(page, editor, before);
	await page.keyboard.type(after);
}

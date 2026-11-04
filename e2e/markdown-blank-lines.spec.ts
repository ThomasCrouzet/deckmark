import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createFirstFile, openPalette, resetAppState } from './helpers';
import { editSentence, importSource } from './source-fidelity-harness';
import { databaseState } from './storage-evidence';

async function downloadMarkdown(page: Page, info: TestInfo) {
	await openPalette(page);
	const pending = page.waitForEvent('download');
	await page.locator('#cmd-palette-opt-export-md').click();
	const download = await pending;
	const chunks: Buffer[] = [];
	for await (const chunk of (await download.createReadStream())!) chunks.push(chunk);
	const bytes = Buffer.concat(chunks);
	await info.attach('export.md', { body: bytes, contentType: 'text/markdown' });
	await info.attach('export-context.json', {
		body: JSON.stringify({
			...info.config.metadata,
			browser: info.project.name,
			filename: download.suggestedFilename()
		}),
		contentType: 'application/json'
	});
	expect(download.suggestedFilename()).toMatch(/\.md$/);
	return bytes.toString('utf8');
}

test('empty visual paragraphs export as blank Markdown lines', async ({ page }, info) => {
	await resetAppState(page, { mode: 'wysiwyg' });
	await createFirstFile(page);
	const editor = page.locator('.ProseMirror');
	await editor.click();
	await page.keyboard.type('First paragraph.');
	await page.keyboard.press('Enter');
	await page.keyboard.press('Enter');
	await page.keyboard.type('Second paragraph.');
	expect(await downloadMarkdown(page, info)).toBe('First paragraph.\n\n\n\nSecond paragraph.');
	await page.locator('[data-mode="source"]').click();
	await page.locator('[data-mode="wysiwyg"]').click();
	await editSentence(page, 'Second paragraph.', 'Last paragraph.');
	const expected = 'First paragraph.\n\n\n\nLast paragraph.';
	expect(await downloadMarkdown(page, info)).toBe(expected);
	await expect
		.poll(async () => (await databaseState(page)).drafts.map((draft) => draft.content))
		.toEqual([expected]);
	await page.reload();
	await expect(page.locator('.ProseMirror')).toContainText('Last paragraph.');
	expect(await downloadMarkdown(page, info)).toBe(expected);
});

test('visual hard breaks use Markdown syntax in downloaded notes', async ({ page }, info) => {
	await resetAppState(page, { mode: 'wysiwyg' });
	await createFirstFile(page);
	await page.locator('.ProseMirror').click();
	await page.keyboard.type('First line.');
	await page.keyboard.press('Shift+Enter');
	await page.keyboard.type('Second line.');
	expect(await downloadMarkdown(page, info)).toBe('First line.\\\nSecond line.');
});

test('a text edit preserves authored HTML and table breaks in Markdown export', async ({
	page
}, info) => {
	await resetAppState(page);
	const source =
		'# Existing note\n\nBefore<br>After.\n\n<br />\n\n```html\n<br>\n```\n\n| A | B |\n| --- | --- |\n| One<br>Two | Other |\n';
	await importSource(page, source);
	await page.locator('[data-mode="wysiwyg"]').click();
	await editSentence(page, 'Before', 'Edited');
	expect(await downloadMarkdown(page, info)).toBe(source.replace('Before', 'Edited'));
});

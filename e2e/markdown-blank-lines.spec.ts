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

for (const { name, source, inserted } of [
	...[
		{ name: 'LF', newline: '\n' },
		{ name: 'CRLF', newline: '\r\n' }
	].map(({ name, newline }) => ({
		name,
		source: `First paragraph.${newline}${newline}Second paragraph.${newline}`,
		inserted: `First paragraph.${newline.repeat(4)}Second paragraph.${newline}`
	})),
	{
		name: 'reference definition',
		source: 'First paragraph.\n\n[link]: https://example.invalid/\n\nSecond paragraph.\n',
		inserted: 'First paragraph.\n\n[link]: https://example.invalid/\n\n\n\nSecond paragraph.\n'
	},
	{
		name: 'blockquote',
		source: '> First paragraph.\n>\n> Second paragraph.\n',
		inserted: '> First paragraph.\n>\n>\n>\n> Second paragraph.\n'
	}
]) {
	test(`an inserted empty paragraph survives export and reload in an existing ${name} note`, async ({
		page
	}, info) => {
		const edited = inserted.replace('Second paragraph.', 'Last paragraph.');
		await info.attach('fixture.json', {
			body: JSON.stringify({ source, inserted, edited }),
			contentType: 'application/json'
		});
		await resetAppState(page);
		await importSource(page, source);
		await page.locator('[data-mode="wysiwyg"]').click();
		await editSentence(page, 'First paragraph.', 'First paragraph.');
		await page.keyboard.press('Enter');
		await expect(
			page.locator(name === 'blockquote' ? '.ProseMirror blockquote p' : '.ProseMirror > p')
		).toHaveText(['First paragraph.', '', 'Second paragraph.']);
		expect.soft(await downloadMarkdown(page, info), 'After insertion').toBe(inserted);
		await editSentence(page, 'Second paragraph.', 'Last paragraph.');
		const downloaded = await downloadMarkdown(page, info);
		expect.soft(downloaded, 'After nearby edit').toBe(edited);
		await expect
			.poll(async () => (await databaseState(page)).drafts.map((draft) => draft.content))
			.toEqual([downloaded]);
		await page.reload();
		await expect(page.locator('.ProseMirror')).toContainText('Last paragraph.');
		expect.soft(await downloadMarkdown(page, info), 'After reload').toBe(edited);
	});
}

test('visual hard breaks use Markdown syntax in downloaded notes', async ({ page }, info) => {
	await resetAppState(page, { mode: 'wysiwyg' });
	await createFirstFile(page);
	await page.locator('.ProseMirror').click();
	await page.keyboard.type('First line.');
	await page.keyboard.press('Shift+Enter');
	await page.keyboard.type('Second line.');
	expect(await downloadMarkdown(page, info)).toBe('First line.\\\nSecond line.');
});

test('blank lines at document edges preserve adjacent edits and source syntax', async ({
	page
}, info) => {
	await resetAppState(page);
	await importSource(page, 'Keep &amp; this.');
	await page.locator('[data-mode="wysiwyg"]').click();
	await editSentence(page, 'Keep & this.', 'Keep & this.!');
	await page.keyboard.press('Enter');
	await page.keyboard.press('Enter');
	expect
		.soft(await downloadMarkdown(page, info), 'Trailing blank paragraph')
		.toBe('Keep &amp; this.!\n\n');
	await editSentence(page, 'Keep & this.!', 'Keep & this.!');
	await page.keyboard.press('Home');
	await page.keyboard.press('Enter');
	await page.keyboard.type('Now ');
	expect(await downloadMarkdown(page, info)).toBe('\n\nNow Keep &amp; this.!\n\n');
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

import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createFirstFile, resetAppState, writeSourceContent } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

const fixture =
	'# Before\n\n| HEADING | OTHER |\n| --- | --- |\n| ALPHA | BETA |\n| GAMMA | DELTA |\n';

async function savedContent(page: Page): Promise<string> {
	return page.evaluate(
		() =>
			new Promise<string>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const rows = database.transaction('drafts').objectStore('drafts').getAll();
					rows.onerror = () => {
						database.close();
						reject(rows.error);
					};
					rows.onsuccess = () => {
						database.close();
						const row = rows.result.find((item) => item.open !== false);
						if (typeof row?.content !== 'string') reject(new Error('Missing note content'));
						else resolve(row.content);
					};
				};
			})
	);
}

async function openTrailingTable(page: Page) {
	await resetAppState(page);
	await createFirstFile(page);
	await writeSourceContent(page, fixture);
	await page.locator('button[data-mode="wysiwyg"]').click();
	const editor = page.locator('.ProseMirror');
	await expect(editor.locator('table.children')).toBeVisible({ timeout: 20_000 });
	return editor;
}

async function doubleClickBelowTable(page: Page) {
	const table = page.locator('.ProseMirror table.children');
	const box = await table.boundingBox();
	if (!box) throw new Error('Table has no box');
	await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height + 70);
}

test('appends a paragraph below a trailing table by double-click', async ({ page }, info) => {
	const editor = await openTrailingTable(page);
	await expect(editor.locator('[data-testid="add-paragraph-after-table"]')).toBeVisible();

	await doubleClickBelowTable(page);
	const lastParagraph = editor.locator('p').last();
	await expect
		.poll(() =>
			lastParagraph.evaluate((element) =>
				element.contains(window.getSelection()?.anchorNode ?? null)
			)
		)
		.toBe(true);
	await page.keyboard.type('After the table.');
	const paragraph = editor.locator('p').filter({ hasText: 'After the table.' });
	await expect(paragraph).toHaveText('After the table.');
	await expect(editor.locator('table.children')).toBeVisible();
	await expect.poll(() => savedContent(page)).toContain('After the table.');
	expect(await savedContent(page)).toContain('| GAMMA | DELTA |');

	await page.keyboard.press('ControlOrMeta+z');
	await expect(editor.locator('table.children')).toBeVisible();
	await page.keyboard.press('ControlOrMeta+Shift+z');
	await expect(editor.locator('p').filter({ hasText: 'After the table.' })).toBeVisible();

	await page.reload();
	await expect(page.locator('.ProseMirror table.children')).toBeVisible({ timeout: 20_000 });
	await expect(
		page.locator('.ProseMirror p').filter({ hasText: 'After the table.' })
	).toBeVisible();
	await expect(page.locator('.ProseMirror [data-testid="add-paragraph-after-table"]')).toHaveCount(
		0
	);

	await info.attach('trailing-table.json', {
		body: JSON.stringify({ fixture, saved: await savedContent(page) }, null, 2),
		contentType: 'application/json'
	});
	await info.attach('trailing-table.png', { body: await page.screenshot() });
});

test('offers a keyboard button and ignores double-clicks in cells', async ({
	page
}, info: TestInfo) => {
	const editor = await openTrailingTable(page);
	const cell = editor.locator('td').first();
	const before = await savedContent(page);
	await cell.dblclick();
	await expect.poll(() => savedContent(page)).toBe(before);
	await expect(editor.locator('p').filter({ hasText: 'From the keyboard.' })).toHaveCount(0);

	const button = editor.locator('[data-testid="add-paragraph-after-table"]');
	await button.focus();
	await expect(button).toBeFocused();
	await page.keyboard.press('Enter');
	const lastParagraph = editor.locator('p').last();
	await expect
		.poll(() =>
			lastParagraph.evaluate((element) =>
				element.contains(window.getSelection()?.anchorNode ?? null)
			)
		)
		.toBe(true);
	await page.keyboard.type('From the keyboard.');
	const paragraph = editor.locator('p').filter({ hasText: 'From the keyboard.' });
	await expect(paragraph).toBeVisible();
	await expect.poll(() => savedContent(page)).toContain('From the keyboard.');
	await expect(editor.locator('table.children td')).toHaveCount(4);

	await info.attach('trailing-table-keyboard.json', {
		body: JSON.stringify({ before, after: await savedContent(page) }, null, 2),
		contentType: 'application/json'
	});
});

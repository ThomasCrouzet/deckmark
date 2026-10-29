import { expect, test, type Page } from '@playwright/test';
import { createFirstFile, resetAppState, writeSourceContent } from './helpers';

async function activeDraftContent(page: Page): Promise<string> {
	return page.evaluate(
		() =>
			new Promise((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const rows = database.transaction('drafts').objectStore('drafts').getAll();
					rows.onerror = () => reject(rows.error);
					rows.onsuccess = () => {
						database.close();
						const row = rows.result.find((entry) => entry.open !== false) ?? rows.result[0];
						if (!row) reject(new Error('No active draft'));
						else resolve(row.content as string);
					};
				};
			})
	);
}

test('Tab inserts indentation at the caret without moving the page', async ({ page }, testInfo) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await resetAppState(page);
	await createFirstFile(page);
	const fixture = Array.from(
		{ length: 40 },
		(_, index) => `## Section ${index + 1}\n\nParagraph ${index + 1} with enough text.`
	).join('\n\n');
	await writeSourceContent(page, fixture);
	await page.locator('button[data-mode="wysiwyg"]').click();
	const editor = page.locator('.ProseMirror');
	await editor.waitFor();
	await page.locator('.mdsh-editor').evaluate((element) => (element.scrollTop = 0));
	await editor.focus();
	await page.waitForTimeout(200);
	await page.keyboard.press('Control+Home');
	await page.keyboard.press('ArrowRight');
	await page.keyboard.press('ArrowRight');
	const before = await page.locator('.mdsh-editor').evaluate((element) => element.scrollTop);
	await page.keyboard.press('Tab');
	await page.keyboard.type('X');
	await expect(editor).toBeFocused();
	expect(await page.locator('.mdsh-editor').evaluate((element) => element.scrollTop)).toBe(before);
	await expect.poll(() => activeDraftContent(page)).toContain('\tX');
	await testInfo.attach('tab-indent', {
		body: await page.screenshot(),
		contentType: 'image/png'
	});
});

test('Tab still indents a list item in the visual editor', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await resetAppState(page);
	await createFirstFile(page);
	await writeSourceContent(page, '- One\n- Two\n- Three');
	await page.locator('button[data-mode="wysiwyg"]').click();
	const editor = page.locator('.ProseMirror');
	await editor.waitFor();
	await page.waitForTimeout(800);
	await editor.focus();
	await expect(editor).toBeFocused();
	await page.waitForTimeout(300);
	await page.keyboard.press('Control+Home');
	await expect(editor).toBeFocused();
	await page.waitForTimeout(200);
	await page.keyboard.press('ArrowDown');
	await page.waitForTimeout(200);
	await page.keyboard.press('Tab');
	await expect.poll(() => activeDraftContent(page)).toMatch(/\n[ \t]+(?:-|\*) (?:Two|Three)/);
});

import { expect, test, type Page } from '@playwright/test';
import { createFirstFile, resetAppState, switchToSource } from './helpers';

async function savedDrafts(page: Page): Promise<string[]> {
	return page.evaluate(
		() =>
			new Promise<string[]>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const rows = database.transaction('drafts').objectStore('drafts').getAll();
					rows.onerror = () => reject(rows.error);
					rows.onsuccess = () => {
						database.close();
						resolve(rows.result.map((row: { content: string }) => row.content));
					};
				};
			})
	);
}

async function sourceText(page: Page): Promise<string> {
	return (await page.locator('.cm-content').first().innerText()).replace(/\u00a0/g, ' ');
}

test.describe('Visual editor code block language (issue 775)', () => {
	test.beforeEach(async ({ page }) => {
		await resetAppState(page, { mode: 'wysiwyg' });
		await createFirstFile(page);
		await page.locator('button[data-mode="wysiwyg"]').click();
		await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 20_000 });
	});

	test('returns a code block to plain text after a language change', async ({ page }) => {
		const editor = page.locator('.ProseMirror');
		const menu = page.locator('.milkdown-slash-menu');
		const block = editor.locator('.milkdown-code-block');
		const button = block.locator('.language-button');
		const search = block.locator('.search-input');
		const item = (name: string) =>
			block.locator('.language-list-item', { hasText: new RegExp(`^${name}$`) });

		await editor.click();
		await page.keyboard.type('/code');
		await expect(menu).toBeVisible();
		await page.keyboard.press('Enter');
		await page.keyboard.type('print(1)');
		await expect(block).toHaveCount(1);

		await test.step('choose Python', async () => {
			await button.click();
			await item('Python').click();
			await expect(button).toContainText('Python');
		});

		await test.step('the picker still lists plain text and selects it', async () => {
			await button.click();
			await expect(item('text')).toHaveCount(1);
			await search.fill('text');
			await expect(item('text')).toHaveCount(1);
			await item('text').click();
			await expect(button).toHaveText(/^\s*text\s*$/);
			await expect(block.locator('.cm-content')).toContainText('print(1)');
		});

		await test.step('the Markdown source keeps the text info string', async () => {
			await expect(async () => {
				await switchToSource(page);
				expect(await sourceText(page)).toContain('```text');
			}).toPass({ timeout: 10_000 });
			expect(await sourceText(page)).not.toContain('Python');
			await expect
				.poll(async () => (await savedDrafts(page)).join('\n'))
				.toContain('```text\nprint(1)');
		});

		await test.step('the plain text language survives a reload and a second change', async () => {
			await page.reload();
			await page.locator('button[data-mode="wysiwyg"]').click();
			await expect(button).toHaveText(/^\s*text\s*$/, { timeout: 20_000 });
			await button.click();
			await item('text').waitFor();
			await item('Rust').click();
			await expect(button).toContainText('Rust');
			await button.click();
			await item('text').click();
			await expect(button).toHaveText(/^\s*text\s*$/);
		});
	});
});

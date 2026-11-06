import { test, expect } from '@playwright/test';
import { resetAppState, seedFiles } from './helpers';

test('closing the active tab returns to the previously viewed tab', async ({ page }) => {
	await resetAppState(page);
	await seedFiles(page, [
		{ name: 'first', content: 'First document' },
		{ name: 'second', content: 'Second document' },
		{ name: 'third', content: 'Third document' }
	]);
	const tabs = page.locator('aside button[data-file-id]');
	await tabs.nth(0).click();
	await tabs.nth(2).click();
	await expect(page.locator('input[aria-label^="Nom du fichier"]')).toHaveValue('third');
	await page.locator('aside').getByRole('button', { name: 'Fermer third', exact: true }).click();
	await expect(page.locator('input[aria-label^="Nom du fichier"]')).toHaveValue('first');
	await expect(page.locator('.cm-content')).toContainText('First document');
});

test('cycles through workspace files and preserves the final editor input', async ({ page }) => {
	await resetAppState(page);
	await seedFiles(page, [
		{ name: 'first.md', content: 'First document' },
		{ name: 'second.md', content: 'Second document' },
		{ name: 'third.md', content: 'Third document' }
	]);
	const name = page.locator('input[aria-label^="Nom du fichier"]');
	await page.locator('.cm-content').click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.insertText(' final edit');
	await page.keyboard.press('Control+Tab');
	await expect(name).toHaveValue('first');
	await expect(page.locator('.cm-content')).toContainText('First document');
	await page.keyboard.press('Control+Shift+Tab');
	await expect(name).toHaveValue('third');
	await expect(page.locator('.cm-content')).toContainText('final edit');
	await page.locator('button[data-mode="wysiwyg"]').click();
	const editor = page.locator('.milkdown .ProseMirror');
	await expect(editor).toBeVisible();
	await editor.click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.type(' WYSIWYG edit');
	await page.keyboard.press('Control+Tab');
	await expect(name).toHaveValue('first');
	await page.keyboard.press('Control+Shift+Tab');
	await expect(name).toHaveValue('third');
	await expect(editor).toContainText('WYSIWYG edit');
	await page.locator('button[data-mode="read"]').click();
	await page.keyboard.press('Control+Shift+Tab');
	await expect(name).toHaveValue('second');
	await expect(page.locator('.mdsh-preview')).toContainText('Second document');
	await name.fill('Temporary name');
	await name.press('Escape');
	await expect(name).toHaveValue('second');
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					new Promise<string>((resolve, reject) => {
						const request = indexedDB.open('mdsh');
						request.onerror = () => reject(request.error);
						request.onsuccess = () => {
							const database = request.result;
							const transaction = database.transaction('drafts');
							const rows = transaction.objectStore('drafts').getAll();
							rows.onsuccess = () =>
								resolve(
									rows.result.find((row: { name: string }) => row.name === 'third.md')?.content ??
										''
								);
							rows.onerror = () => reject(rows.error);
							transaction.oncomplete = () => database.close();
						};
					})
			)
		)
		.toContain('WYSIWYG edit');
	await page.reload();
	await expect(name).toHaveValue('second');
	await page.keyboard.press('Control+Tab');
	await expect(name).toHaveValue('third');
	await expect(page.locator('.mdsh-preview')).toContainText('WYSIWYG edit');
});

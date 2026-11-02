import { test, expect, type Page } from '@playwright/test';
import {
	createFirstFile,
	renameActiveFile,
	resetAppState,
	seedFiles,
	switchToSource,
	writeSourceContent
} from './helpers';

async function sourceText(page: Page): Promise<string> {
	return page
		.locator('.cm-content')
		.first()
		.evaluate((element) =>
			Array.from(element.querySelectorAll('.cm-line'))
				.map((line) => line.textContent ?? '')
				.join('\n')
		);
}

async function savedPositionContent(page: Page): Promise<string> {
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
						resolve(
							rows.result.find((row: { name: string }) => row.name === 'Position.md')?.content ?? ''
						);
					};
				};
			})
	);
}

async function openDraft(page: Page, name: string): Promise<void> {
	await page.locator('button[data-file-id]').filter({ hasText: name }).click();
}

async function openSettings(page: Page): Promise<void> {
	await page.keyboard.press('ControlOrMeta+,');
	await expect(page.getByRole('dialog', { name: 'Réglages' })).toBeVisible();
}

test.describe('Editor state isolation and restoration', () => {
	test('keeps source undo inside its draft and persists the safe result', async ({ page }) => {
		await resetAppState(page);
		await seedFiles(page, [
			{ name: 'Draft A.md', content: 'CONTENT_FROM_DRAFT_A' },
			{ name: 'Draft B.md', content: 'CONTENT_FROM_DRAFT_B' }
		]);

		const editor = page.locator('.cm-content').first();
		await editor.click();
		await page.keyboard.press('ControlOrMeta+z');
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(() => sourceText(page)).not.toContain('CONTENT_FROM_DRAFT_A');

		await page.waitForTimeout(700);
		await page.reload();
		await switchToSource(page);
		await expect.poll(() => sourceText(page)).not.toContain('CONTENT_FROM_DRAFT_A');

		const savedB = await page.evaluate(
			() =>
				new Promise<string>((resolve, reject) => {
					const request = indexedDB.open('mdsh');
					request.onerror = () => reject(request.error);
					request.onsuccess = () => {
						const database = request.result;
						const rows = database.transaction('drafts').objectStore('drafts').getAll();
						rows.onerror = () => reject(rows.error);
						rows.onsuccess = () => {
							const draft = rows.result.find((row: { name: string }) => row.name === 'Draft B.md');
							database.close();
							resolve(draft?.content ?? '');
						};
					};
				})
		);
		expect(savedB).not.toContain('CONTENT_FROM_DRAFT_A');
	});

	test('localizes source search without losing undo, selection, or scroll', async ({ page }) => {
		await resetAppState(page);
		await createFirstFile(page);
		await renameActiveFile(page, 'Position.md');
		const content = Array.from({ length: 400 }, (_, index) =>
			index === 0 ? 'ALPHA omega' : `line ${index}`
		).join('\n');
		await writeSourceContent(page, content);

		const scroller = page.locator('.cm-scroller');
		await scroller.hover();
		await page.mouse.wheel(0, 600);
		await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
		await scroller.click({ position: { x: 120, y: 120 } });
		await page.keyboard.insertText('POSITIONTOKEN');
		await expect.poll(() => savedPositionContent(page)).toContain('POSITIONTOKEN');
		await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);

		await page.reload();
		await switchToSource(page);
		await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
		await page.locator('.cm-content').first().focus();
		await page.keyboard.insertText('X');
		await expect.poll(() => savedPositionContent(page)).toContain('POSITIONTOKENX');

		await page.keyboard.press('ControlOrMeta+f');
		await expect(page.locator('.cm-search input[name="search"]')).toHaveAttribute(
			'placeholder',
			'Rechercher'
		);
		await openSettings(page);
		await page
			.getByRole('group', { name: 'Langue' })
			.getByRole('button', { name: 'English' })
			.click();
		await page
			.getByRole('dialog', { name: 'Settings' })
			.getByRole('button', { name: 'Close', exact: true })
			.click();

		await expect(page.locator('.cm-content').first()).toHaveAttribute(
			'aria-label',
			'Markdown document editor'
		);
		await expect(page.locator('.cm-search input[name="search"]')).toHaveAttribute(
			'placeholder',
			'Find'
		);
		await expect(page.locator('.cm-search button[name="next"]')).toHaveText('next');

		await page.keyboard.press('Escape');
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(() => savedPositionContent(page)).not.toContain('POSITIONTOKENX');
		await expect.poll(() => savedPositionContent(page)).toContain('POSITIONTOKEN');
	});

	test('keeps the WYSIWYG instance and restores positions in visual and reading modes', async ({
		page
	}) => {
		await resetAppState(page, { mode: 'wysiwyg' });
		await createFirstFile(page);
		await renameActiveFile(page, 'Visual A.md');
		const proseMirror = page.locator('.ProseMirror');
		await expect(proseMirror).toBeVisible({ timeout: 20_000 });
		await proseMirror.fill('Base locale');
		await page.waitForTimeout(600);
		await proseMirror.click();
		await page.keyboard.press('End');
		await page.keyboard.insertText(' TAIL');
		await proseMirror.evaluate((element) => element.setAttribute('data-editor-token', 'same'));

		await openSettings(page);
		await page
			.getByRole('group', { name: 'Langue' })
			.getByRole('button', { name: 'English' })
			.click();
		await page
			.getByRole('dialog', { name: 'Settings' })
			.getByRole('button', { name: 'Close', exact: true })
			.click();
		await expect(proseMirror).toHaveAttribute('data-editor-token', 'same');
		await expect(proseMirror).toHaveAttribute('aria-label', 'Markdown document editor');
		await proseMirror.click();
		await page.keyboard.press('ControlOrMeta+z');
		await expect(proseMirror).not.toContainText('TAIL');
		await expect(proseMirror).toContainText('Base locale');
		await page.keyboard.press('End');
		await page.keyboard.press('Enter');
		await page.keyboard.insertText('/');
		const slashMenu = page.locator('.milkdown-slash-menu');
		await expect(slashMenu).toBeVisible();
		await expect(slashMenu.locator('.tab-group li')).toHaveText(['Text', 'Lists', 'Advanced']);
		await page.keyboard.press('Escape');
		await proseMirror.fill('Base locale');

		await page.keyboard.press('ControlOrMeta+a');
		await page.keyboard.press('ArrowLeft');
		for (let index = 0; index < 4; index++) await page.keyboard.press('ArrowRight');
		await page.keyboard.press('ControlOrMeta+n');
		await page.getByTestId('create-note').click();
		await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 20_000 });
		const fileName = page.locator('input[aria-label^="File name"]');
		await fileName.fill('Visual B.md');
		await fileName.press('Enter');
		await openDraft(page, 'Visual A');
		await expect(page.locator('.ProseMirror')).toContainText('Base locale');
		await page.locator('.ProseMirror').focus();
		await page.keyboard.insertText('X');
		await expect(page.locator('.ProseMirror')).toContainText('BaseX locale');

		await switchToSource(page);
		await writeSourceContent(
			page,
			Array.from({ length: 120 }, (_, index) => `Reading line ${index}`).join('\n')
		);
		await page.locator('button[data-mode="read"]').click();
		await expect(page.locator('.mdsh-preview')).toContainText('Reading line 119');
		await page.locator('.mdsh-read').evaluate((element) => (element.scrollTop = 500));
		await openDraft(page, 'Visual B');
		await openDraft(page, 'Visual A');
		await expect
			.poll(() => page.locator('.mdsh-read').evaluate((element) => element.scrollTop))
			.toBeGreaterThan(100);
	});
});

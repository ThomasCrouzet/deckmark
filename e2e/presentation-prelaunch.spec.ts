import { expect, test, type Download, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resetAppState } from './helpers';
import {
	createPresentation,
	exportPresentation,
	renamePresentation,
	waitForPresentation
} from './presentation-helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

async function resetEnglishApp(page: Page): Promise<void> {
	await resetAppState(page);
	await page.evaluate(() => localStorage.setItem('mdsh:locale', 'en'));
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
}

async function downloadBytes(download: Download): Promise<Buffer> {
	const stream = await download.createReadStream();
	const chunks: Buffer[] = [];
	for await (const chunk of stream!) chunks.push(chunk);
	return Buffer.concat(chunks);
}

async function fullscreenTestId(page: Page): Promise<string | null> {
	return page.evaluate(() => document.fullscreenElement?.getAttribute('data-testid') ?? null);
}

test('Present requests real fullscreen and Exit leaves it', async ({ page }, testInfo) => {
	const pageErrors: string[] = [];
	page.on('pageerror', (error) => pageErrors.push(error.message));
	await resetEnglishApp(page);
	const editor = await createPresentation(page);
	await editor.getByTestId('slide-present').click();
	await expect(editor).toHaveAttribute('aria-modal', 'true');
	// The click handler runs the request, so the browser grants user activation.
	await expect.poll(() => fullscreenTestId(page), { timeout: 5_000 }).toBe('presentation-editor');
	await editor.getByTestId('slide-present-exit').click();
	await expect.poll(() => fullscreenTestId(page), { timeout: 5_000 }).toBeNull();
	await expect(editor).toHaveAttribute('role', 'region');
	expect(pageErrors).toEqual([]);
	await testInfo.attach('presentation-fullscreen.json', {
		body: JSON.stringify(
			{
				fullscreenElement: 'presentation-editor',
				exitLeavesFullscreen: true,
				pageErrors
			},
			null,
			2
		),
		contentType: 'application/json'
	});
});

test('a placeholder stays empty on the projected and exported slide', async ({
	page
}, testInfo) => {
	await resetEnglishApp(page);
	const editor = await createPresentation(page);
	// Creating text opens the inline editor, and the placeholder text is selected.
	await editor.getByTestId('slide-add-text').click();
	const textarea = editor.getByTestId('slide-text-editor');
	await expect(textarea).toBeFocused();
	await expect(textarea).toHaveValue('Your text');
	await textarea.fill('Projected body');
	await textarea.press('Escape');
	await expect(textarea).toHaveCount(0);
	await expect(editor.getByTestId('slide-canvas')).toContainText('Projected body');

	// Double-click enters the same edit session as the toolbar action.
	const textObject = editor.locator('[data-testid="slide-object"][data-object-type="text"]');
	await textObject.dblclick();
	await expect(textarea).toBeFocused();
	await textarea.fill('Revised body');
	await editor.getByTestId('slide-text-done').click();
	await expect(textarea).toHaveCount(0);
	await expect(editor.getByTestId('slide-canvas')).toContainText('Revised body');

	// A second slide keeps the untouched placeholder.
	await editor.getByTestId('slide-add').click();
	await editor.getByTestId('slide-add-text').click();
	await expect(textarea).toHaveValue('Your text');
	await textarea.press('Escape');
	await expect(textarea).toHaveCount(0);

	await editor.getByTestId('slide-present').click();
	await expect(editor).toHaveAttribute('aria-modal', 'true');
	const projected = editor.getByTestId('slide-canvas');
	await expect(projected).not.toContainText('Your text');
	await expect(projected.locator('.mdsh-slide-element-text')).toHaveCount(1);
	await expect(projected.locator('.mdsh-slide-element-content')).toHaveText('');
	await editor.getByTestId('slide-present-exit').click();
	await expect(editor).toHaveAttribute('role', 'region');

	const pending = page.waitForEvent('download');
	await exportPresentation(editor, 'html');
	const path = testInfo.outputPath('placeholder-export.html');
	await (await pending).saveAs(path);
	const html = await readFile(path, 'utf8');
	expect(html).not.toContain('Your text');
	await testInfo.attach('presentation-placeholder.json', {
		body: JSON.stringify(
			{
				projectedSlideOmitsPlaceholder: true,
				exportedHtmlOmitsPlaceholder: true,
				autoEditOnCreate: true,
				doubleClickEdits: true,
				exportPath: path
			},
			null,
			2
		),
		contentType: 'application/json'
	});
});

test('keeps saving after a backup restore recreates the file objects', async ({
	page
}, testInfo) => {
	await resetEnglishApp(page);
	const editor = await createPresentation(page);
	await renamePresentation(page, 'Identity deck');
	await editor.getByTestId('slide-add-text').click();
	await editor.getByTestId('slide-text-editor').fill('Before restore');
	await editor.getByTestId('slide-text-done').click();
	await expect(editor.locator('.save-state')).toHaveText('saved', { timeout: 10_000 });

	await page.keyboard.press('ControlOrMeta+,');
	await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
	const pending = page.waitForEvent('download');
	await page.getByRole('button', { name: 'Export a backup', exact: true }).click();
	const backup = await downloadBytes(await pending);

	// A restore reloads the whole library from IndexedDB. The reload recreates
	// every FileItem with the same id while this editor stays open.
	await page.locator('input[type=file][accept*="json"]').setInputFiles({
		name: 'identity-backup.json',
		mimeType: 'application/json',
		buffer: backup
	});
	const choice = page.getByRole('dialog', { name: 'Restore the backup' });
	await expect(choice).toBeVisible({ timeout: 15_000 });
	await choice.getByRole('button', { name: 'Merge', exact: true }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Backup restored' }).first()).toBeVisible(
		{ timeout: 20_000 }
	);
	await page.keyboard.press('Escape');

	const restored = await waitForPresentation(page);
	await expect(restored.getByTestId('slide-canvas')).toContainText('Before restore');
	await restored.locator('[data-testid="slide-object"][data-object-type="text"]').click();
	await page.keyboard.press('ArrowRight');
	await expect(restored.locator('.save-state')).toHaveText('saved', { timeout: 10_000 });
	await expect(restored.getByTestId('slide-save-copy')).toHaveCount(0);
	await expect(restored.getByTestId('slide-source-error')).toHaveCount(0);
	await expect(restored.getByTestId('slide-canvas')).toContainText('Before restore');

	await testInfo.attach('presentation-identity.json', {
		body: JSON.stringify(
			{
				reloadPath: 'Settings backup restore (merge)',
				editorStayedOpen: true,
				movePublished: true,
				saveCopyOffered: false
			},
			null,
			2
		),
		contentType: 'application/json'
	});
});

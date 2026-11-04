import { test, expect } from '@playwright/test';
import { resetAppState, createFirstFile, openPalette } from './helpers';

test.describe('Command palette', () => {
	test.beforeEach(async ({ page }) => {
		await resetAppState(page);
		await createFirstFile(page);
	});

	test('opens, filters, and closes with Escape', async ({ page }) => {
		await openPalette(page);
		const dialog = page.getByRole('dialog', { name: 'Palette de commandes' });

		// The input has focus.
		const input = dialog.locator('input[type="text"]');
		await expect(input).toBeFocused();

		// The "wysiwyg" filter returns only the WYSIWYG mode command.
		await input.fill('wysiwyg');
		await expect(dialog.getByRole('option')).toHaveCount(1);

		// Escape closes the palette.
		await page.keyboard.press('Escape');
		await expect(dialog).not.toBeVisible();
	});

	test('changes to read mode from the command palette', async ({ page }) => {
		await openPalette(page);
		const dialog = page.getByRole('dialog', { name: 'Palette de commandes' });
		// Select the exact name because several commands contain "mode".
		await dialog.getByRole('option', { name: /Mode lecture/i }).click();

		// Read mode must show the preview.
		await expect(page.locator('.mdsh-preview')).toBeVisible({ timeout: 15_000 });
	});

	test('toggles focus mode from the command palette in Read mode', async ({ page }) => {
		await page.locator('[data-mode="read"]').click();
		await openPalette(page);
		const dialog = page.getByRole('dialog', { name: 'Palette de commandes' });
		await dialog.getByRole('option', { name: /Activer le mode focus/i }).click();

		await expect(page.locator('body')).toHaveClass(/focus-mode/);
	});
});

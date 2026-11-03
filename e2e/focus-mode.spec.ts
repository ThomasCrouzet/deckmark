import { test, expect } from '@playwright/test';
import { resetAppState, createFirstFile, openPalette } from './helpers';

test.describe('Focus mode', () => {
	test.beforeEach(async ({ page }) => {
		await resetAppState(page);
		await createFirstFile(page);
		// Focus mode is offered only while Read is selected.
		await page.locator('button[data-mode="read"]').click();
		await expect(page.locator('.mdsh-preview')).toBeVisible({ timeout: 20_000 });
	});

	test('enables and disables focus mode from the command palette', async ({ page }) => {
		const body = page.locator('body');
		await expect(body).not.toHaveClass(/focus-mode/);

		// Select "Activer le mode focus" directly because several commands contain
		// "mode" and "focus".
		await openPalette(page);
		const dialog = page.getByRole('dialog', { name: 'Palette de commandes' });
		await dialog.getByRole('option', { name: /Activer le mode focus/i }).click();
		await expect(body).toHaveClass(/focus-mode/);

		// §B1.1 - The header is inert in focus mode, so its palette button cannot receive
		// a click. Use the window-level keyboard shortcut instead.
		const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
		await page.keyboard.press(`${mod}+Shift+P`);
		await expect(dialog).toBeVisible();
		await dialog.getByRole('option', { name: /Désactiver le mode focus/i }).click();
		await expect(body).not.toHaveClass(/focus-mode/);
	});

	test('updates the screen reader status', async ({ page }) => {
		// The app has separate live regions for focus mode and typewriter mode.
		// Select the focus mode region by its initial text.
		const focusStatus = page
			.locator('[role="status"][aria-live="polite"]')
			.filter({ hasText: /Mode focus/i });
		await expect(focusStatus).toContainText(/désactivé/i);

		await openPalette(page);
		const dialog = page.getByRole('dialog', { name: 'Palette de commandes' });
		await dialog.getByRole('option', { name: /Activer le mode focus/i }).click();
		await expect(focusStatus).toContainText(/activé/i);
	});
});

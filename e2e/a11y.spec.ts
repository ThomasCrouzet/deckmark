import { test, expect } from '@playwright/test';
import { resetAppState, createFirstFile, openPalette } from './helpers';

// Mirror the shared focus trap: native summaries are tab stops.
const FOCUSABLE =
	'a[href], button:not([disabled]), summary, input:not([disabled]), [tabindex]:not([tabindex="-1"])';

test.describe('Accessibility - skip link and focus trap', () => {
	test.beforeEach(async ({ page }) => {
		await resetAppState(page);
	});

	test('shows the skip link on keyboard focus and moves focus to #main', async ({ page }) => {
		const link = page.locator('a.skip-link');
		await expect(link).toHaveAttribute('href', '#main');
		await expect(link).not.toBeInViewport();
		await page.keyboard.press('Tab');
		await expect(link).toBeFocused();
		await expect(link).toBeInViewport();
		await page.keyboard.press('Enter');
		await expect(page.locator('#main')).toBeFocused();
		await expect(link).not.toBeInViewport();
	});

	test('CommandPalette - wraps Tab from the last focusable element', async ({ page }) => {
		await createFirstFile(page);
		await openPalette(page);
		const dialog = page.getByRole('dialog', { name: 'Palette de commandes' });

		const focusables = dialog.locator(FOCUSABLE);
		const count = await focusables.count();
		expect(count).toBeGreaterThan(1);

		// Focus the last element. Tab must move focus to the first input.
		await focusables.nth(count - 1).focus();
		await page.keyboard.press('Tab');
		await expect(dialog.locator('input[type="text"]')).toBeFocused();
	});

	test('CommandPalette - wraps Shift+Tab from the first focusable element', async ({ page }) => {
		await createFirstFile(page);
		await openPalette(page);
		const dialog = page.getByRole('dialog', { name: 'Palette de commandes' });

		const focusables = dialog.locator(FOCUSABLE);
		const count = await focusables.count();

		// Focus the first input. Shift+Tab must move focus to the last element.
		await dialog.locator('input[type="text"]').focus();
		await page.keyboard.press('Shift+Tab');
		await expect(focusables.nth(count - 1)).toBeFocused();
	});

	test('GraphPanel - includes native details summaries in the Tab loop', async ({ page }) => {
		await createFirstFile(page);
		await openPalette(page);
		await page.getByRole('combobox').fill('Graphe des liens');
		await page.keyboard.press('Enter');
		const dialog = page.getByRole('dialog', { name: 'Graphe des liens' });
		const summary = dialog.locator('summary', { hasText: 'Documents et liens' });
		const close = dialog.getByRole('button', { name: 'Fermer' });
		const nodes = dialog.locator('g[role="button"]');
		await expect(summary).toBeVisible();
		await expect(nodes.first()).toBeVisible();

		// Reverse traversal from the first control reaches the final summary.
		await close.focus();
		await page.keyboard.press('Shift+Tab');
		await expect(summary).toBeFocused();

		// Forward traversal from the last graph node reaches the summary.
		await nodes.last().focus();
		await page.keyboard.press('Tab');
		await expect(summary).toBeFocused();

		// The summary is the last stop, so Tab wraps to the first control.
		await page.keyboard.press('Tab');
		await expect(close).toBeFocused();

		// Expanding the disclosure exposes its action between summary and wrap.
		await summary.focus();
		await page.keyboard.press('Enter');
		await expect(dialog.locator('details')).toHaveAttribute('open', '');
		await page.keyboard.press('Tab');
		const firstAction = dialog.locator('details li button').first();
		await expect(firstAction).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(close).toBeFocused();
	});
});

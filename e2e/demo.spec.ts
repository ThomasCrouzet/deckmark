import { test, expect } from '@playwright/test';
import { resetAppState } from './helpers';

test.describe('Welcome demo document', () => {
	test.beforeEach(async ({ page }) => {
		await resetAppState(page);
	});

	test('creates three linked demo files and opens the sidebar', async ({ page }) => {
		const demoBtn = page.locator('main').getByRole('button', { name: /document de démo/ });
		await demoBtn.click();

		// loadDemo creates and activates "Welcome to the DeckMark demo" first.
		const nameInput = page.locator('input[aria-label^="Nom du fichier"]');
		await expect(nameInput).toHaveValue('Welcome to the DeckMark demo', { timeout: 10_000 });

		// The sidebar opens and lists the three demo files.
		const sidebar = page.locator('aside');
		await expect(sidebar.getByText('Math and diagrams').first()).toBeVisible({ timeout: 5000 });
		await expect(sidebar.getByText('Task list').first()).toBeVisible();

		// The two other files link to this file, so its backlinks are visible.
		const backlinksSection = sidebar.locator('[aria-label="Backlinks"]');
		await expect(backlinksSection).toBeVisible({ timeout: 5000 });
		await expect(backlinksSection.getByText('Math and diagrams')).toBeVisible();
		await expect(backlinksSection.getByText('Task list')).toBeVisible();
	});
});

/**
 * Smoke path with the OSS default locale (English).
 * The rest of the e2e suite pins fr-FR; this file locks the English strings
 * of Welcome + palette so a regression on DEFAULT_LOCALE is caught.
 */
import { test, expect } from '@playwright/test';

test.describe('English default locale (OSS)', () => {
	test.use({ locale: 'en-US' });

	test('Welcome and palette use English labels', async ({ page }) => {
		await page.goto('/');
		await page.evaluate(async () => {
			await Promise.all(
				['mdsh', 'mdsh-fs'].map(
					(name) =>
						new Promise<void>((resolve) => {
							const req = indexedDB.deleteDatabase(name);
							req.onsuccess = () => resolve();
							req.onerror = () => resolve();
							req.onblocked = () => resolve();
						})
				)
			);
			localStorage.clear();
			// Explicit EN (default); do not set mdsh:locale so detectLocale follows en-US.
			localStorage.setItem('mdsh:mode', 'source');
		});
		await page.reload();
		await expect(page.getByTestId('welcome-new')).toBeVisible({ timeout: 15_000 });
		await expect(page.getByTestId('welcome-new')).toContainText(/New file|Nouveau/i);
		// With en-US navigator + no saved locale → English.
		await expect(page.getByTestId('welcome-new')).toContainText('New file');

		await page.getByTestId('welcome-new').click();
		await page.getByTestId('create-note').click();
		await page.getByRole('button', { name: 'Command palette' }).click();
		await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
	});
});

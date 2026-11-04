import { expect, test } from '@playwright/test';
import { openPalette, resetAppState } from './helpers';

// The Web Light build keeps manual backup and export. It must not expose the
// desktop scheduler, the native folder picker, or the snapshot list.
test('Web edition keeps the desktop backup panel out of Settings', async ({ page }) => {
	await resetAppState(page);
	await openPalette(page);
	await page.getByRole('combobox').fill('parametres');
	await page.getByRole('option').first().click();

	const settings = page.getByRole('dialog', { name: 'Réglages', exact: true });
	await expect(settings).toBeVisible();
	await expect(settings.getByTestId('desktop-backup-section')).toHaveCount(0);
	await expect(settings.getByTestId('desktop-backup-panel')).toHaveCount(0);
	await expect(
		settings.getByRole('button', { name: 'Exporter une sauvegarde', exact: true })
	).toBeVisible();
});

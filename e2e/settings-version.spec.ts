import { expect, test } from '@playwright/test';
import { resetAppState } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

/**
 * Issue #747: Settings must show the installed version and a static link to the
 * release page in the desktop edition. The offline rule keeps the block out of
 * Web Light, so the browser suite proves the web boundary and the version
 * source. The desktop block is a manual check in the Tauri window.
 */
test('Settings shows the installed version without an update check', async ({ page }, info) => {
	await resetAppState(page);
	await page.keyboard.press('Control+,');

	const settings = page.getByRole('dialog', { name: 'Réglages', exact: true });
	await expect(settings).toBeVisible();

	const version = settings.getByTestId('about-version');
	await expect(version).toBeVisible();
	await expect(version).toContainText(/\d+\.\d+\.\d+/);

	// Web Light keeps no desktop update block and makes no release request.
	await expect(settings.getByTestId('installed-version')).toHaveCount(0);
	await expect(settings.getByTestId('release-link')).toHaveCount(0);

	await info.attach('settings-version.json', {
		body: JSON.stringify({
			edition: 'web',
			versionText: (await version.textContent())?.trim(),
			installedVersionLines: await settings.getByTestId('installed-version').count(),
			releaseLinks: await settings.getByTestId('release-link').count()
		}),
		contentType: 'application/json'
	});
});

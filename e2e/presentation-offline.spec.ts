import { expect, test } from '@playwright/test';
import { resetAppState } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

test('opens the lazy presentation editor for the first time offline', async ({
	page,
	context,
	browserName
}, testInfo) => {
	test.skip(
		browserName === 'webkit',
		'Playwright 1.62 WebKit offline emulation rejects service worker responses'
	);
	test.setTimeout(60_000);
	await resetAppState(page);
	await page.evaluate(() => localStorage.setItem('mdsh:locale', 'en'));

	// The presentation module must stay unopened until the network is unavailable.
	await expect(page.getByTestId('presentation-editor')).toHaveCount(0);
	await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
	await expect(async () => {
		await page.reload();
		expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
	}).toPass({ timeout: 30_000 });
	const deletedRuntimeCache = await page.evaluate(() => caches.delete('mdsh-immutable-v1'));

	try {
		await context.setOffline(true);
		await page.reload();
		await expect(page.locator('.mdsh-shell[aria-busy="false"]:not([inert])')).toBeVisible({
			timeout: 15_000
		});

		await page.getByTestId('slides-open').click();
		const editor = page.getByTestId('presentation-editor');
		await expect(editor).toBeVisible({ timeout: 15_000 });
		await editor.getByTestId('slide-title').fill('Offline first open');
		await editor.getByTestId('slide-add-text').click();
		await editor.getByTestId('slide-edit-text').click();
		await editor.getByTestId('slide-text-editor').fill('## Created without a network');
		await editor.getByTestId('slide-text-done').click();
		await editor.getByTestId('slide-add').click();
		await editor.getByTestId('slide-add-rectangle').click();
		await expect(editor.locator('.save-state')).toHaveText('saved', { timeout: 10_000 });

		await page.reload();
		await expect(page.locator('.mdsh-shell[aria-busy="false"]:not([inert])')).toBeVisible({
			timeout: 15_000
		});
		await page.getByTestId('slides-open').click();
		const restored = page.getByTestId('presentation-editor');
		await expect(restored.getByTestId('slide-title')).toHaveValue('Offline first open.md');
		await expect(restored.getByTestId('slide-thumbnail')).toHaveCount(2);
		await restored.getByTestId('slide-thumbnail').first().click();
		await expect(
			restored.getByTestId('slide-canvas').getByText('Created without a network', { exact: true })
		).toBeVisible();
		await restored.getByTestId('slide-thumbnail').nth(1).click();
		await expect(
			restored.locator('[data-testid="slide-object"][data-object-type="rectangle"]')
		).toHaveCount(1);

		await testInfo.attach('presentation-first-open-offline.png', {
			body: await page.screenshot({ fullPage: true }),
			contentType: 'image/png'
		});
		await testInfo.attach('presentation-first-open-offline.json', {
			body: JSON.stringify(
				{
					command:
						'npm run test:e2e -- presentation-offline.spec.ts --project=chromium --project=firefox --workers=1',
					project: testInfo.project.name,
					browserName,
					disruption: 'browser-offline',
					deletedRuntimeCache,
					controlled: await page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
					fixture: { slides: 2, objectTypes: ['text', 'rectangle'] }
				},
				null,
				2
			),
			contentType: 'application/json'
		});
	} finally {
		await context.setOffline(false);
	}
});

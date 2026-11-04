import { expect, test, type TestInfo } from '@playwright/test';
import { resetAppState } from './helpers';

// The quick capture window is a Desktop Complete feature. The Web Light build
// must ignore `?capture=1` and must not expose the desktop settings section.
test('Web Light never exposes the global quick capture surface', async ({
	page
}, info: TestInfo) => {
	await resetAppState(page);
	await page.goto('/?capture=1');
	await expect(page.locator('.mdsh-shell[aria-busy="false"]')).toBeVisible({ timeout: 15_000 });
	await expect(page.getByTestId('quick-capture')).toHaveCount(0);
	await expect(page.getByTestId('capture-content')).toHaveCount(0);

	await page.keyboard.press('ControlOrMeta+,');
	const settings = page.getByRole('dialog', { name: 'Réglages' });
	await expect(settings).toBeVisible({ timeout: 15_000 });
	await expect(settings.getByTestId('capture-settings')).toHaveCount(0);

	const manifest = await page.evaluate(() =>
		fetch('edition.json').then((response) => response.json())
	);
	expect(manifest.edition).toBe('web');
	expect(manifest.excluded).toContain('global-capture');

	await info.attach('capture-edition.json', {
		body: JSON.stringify(
			{
				url: page.url(),
				edition: manifest.edition,
				excluded: manifest.excluded,
				captureRoot: 0,
				captureSettings: 0
			},
			null,
			2
		),
		contentType: 'application/json'
	});
});

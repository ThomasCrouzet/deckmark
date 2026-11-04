import { expect, test } from '@playwright/test';
import { resetAppState } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

test('Web Light exposes no native update panel or update runtime', async ({ page }, info) => {
	const external: string[] = [];
	page.on('request', (request) => {
		const url = new URL(request.url());
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
		if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) external.push(url.href);
	});
	await resetAppState(page);
	await page.keyboard.press('ControlOrMeta+,');
	const settings = page.getByRole('dialog', { name: 'Réglages', exact: true });
	await expect(settings).toBeVisible();
	await expect(page.getByTestId('update-panel')).toHaveCount(0);
	await expect(page.getByTestId('update-blocked')).toHaveCount(0);
	await page.keyboard.press('Escape');

	// The desktop commands must not be reachable from the Web build.
	expect(await page.evaluate(() => '__TAURI_INTERNALS__' in window)).toBe(false);
	expect(external).toEqual([]);

	await info.attach('update-panel-absent.json', {
		body: JSON.stringify({ edition: 'web', updatePanel: 0, externalRequests: external }),
		contentType: 'application/json'
	});
});

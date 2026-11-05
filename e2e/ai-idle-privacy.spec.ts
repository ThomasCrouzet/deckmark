import { expect, test, type Page } from '@playwright/test';
import { createFirstFile, resetAppState, writeSourceContent } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

async function configureEnabledProvider(page: Page): Promise<{ requests: () => number }> {
	let count = 0;
	await page.route('https://mock.local/v1/**', async (route) => {
		if (route.request().method() === 'OPTIONS') {
			await route.fulfill({
				status: 204,
				headers: {
					'access-control-allow-origin': '*',
					'access-control-allow-methods': 'GET, POST, OPTIONS',
					'access-control-allow-headers': '*'
				}
			});
			return;
		}
		count++;
		await route.fulfill({
			status: 200,
			headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
			body: JSON.stringify({ data: [{ id: 'mock-model' }] })
		});
	});
	await resetAppState(page);
	await page.keyboard.press('ControlOrMeta+,');
	const dialog = page.getByRole('dialog');
	await expect(dialog).toBeVisible();
	const ai = dialog.getByTestId('ai-settings');
	if (!(await ai.getAttribute('open'))) await ai.locator('summary').click();
	await ai.getByTestId('ai-base-url').fill('https://mock.local/v1');
	await ai.getByTestId('ai-base-url').blur();
	await ai.getByTestId('ai-allow-key').check();
	await ai.getByTestId('ai-key').fill('test-session-value');
	await ai.getByTestId('ai-key-save').click();
	await ai.getByTestId('ai-model').fill('mock-model');
	await ai.getByTestId('ai-enabled').check();
	await page.keyboard.press('Escape');
	return { requests: () => count };
}

test('enabled AI sends no document data while editing or switching files', async ({
	page
}, info) => {
	const provider = await configureEnabledProvider(page);
	const before = provider.requests();
	await createFirstFile(page);
	await writeSourceContent(page, '# Idle\n\nNo request should leave this editor.\n');
	await page.locator('input[type="file"][accept*="text/markdown"]').setInputFiles({
		name: 'second.md',
		mimeType: 'text/markdown',
		buffer: Buffer.from('# Second\n\nAnother local document.\n')
	});
	await expect(page.locator('.cm-content')).toContainText('Another local document');
	await page.waitForTimeout(1_000);
	expect(provider.requests()).toBe(before);
	await info.attach('ai-idle.json', {
		body: JSON.stringify({ requestsBefore: before, requestsAfterEdit: provider.requests() }),
		contentType: 'application/json'
	});
});

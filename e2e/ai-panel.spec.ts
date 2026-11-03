import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createFirstFile, openPalette, resetAppState, writeSourceContent } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

async function configureMockAi(page: Page, options: { delay?: number } = {}) {
	await page.addInitScript(() => {
		localStorage.setItem(
			'mdsh:ai',
			JSON.stringify({
				enabled: true,
				privacyMode: 'direct',
				allowBrowserKey: true,
				baseUrl: 'https://mock.local/v1',
				model: 'mock-model',
				temperature: 0.2,
				maxTokens: 24000
			})
		);
		sessionStorage.setItem('mdsh:ai-key', 'sk-session');
	});
	const requests: Array<Record<string, unknown>> = [];
	await page.route('https://mock.local/v1/**', async (route) => {
		if (route.request().method() === 'OPTIONS') {
			await route.fulfill({
				status: 204,
				headers: {
					'access-control-allow-origin': '*',
					'access-control-allow-methods': 'POST, OPTIONS',
					'access-control-allow-headers': '*'
				}
			});
			return;
		}
		requests.push(route.request().postDataJSON() as Record<string, unknown>);
		if (options.delay) await new Promise((resolve) => setTimeout(resolve, options.delay));
		await route.fulfill({
			status: 200,
			headers: { 'access-control-allow-origin': '*', 'content-type': 'text/event-stream' },
			body:
				'data: {"choices":[{"delta":{"content":"First chunk. "}}]}\n\n' +
				'data: {"choices":[{"delta":{"content":"Second chunk."}}]}\n\n' +
				'data: [DONE]\n\n'
		});
	});
	return requests;
}

async function openAiPanel(page: Page) {
	await openPalette(page);
	const palette = page.getByRole('dialog', { name: 'Palette de commandes' });
	await palette.getByRole('option', { name: /assistant IA/i }).click();
	await expect(page.getByTestId('ai-panel')).toBeVisible();
}

test('sends only the reviewed context and streams a reply', async ({ page }, info: TestInfo) => {
	const requests = await configureMockAi(page);
	await resetAppState(page);
	await createFirstFile(page);
	const note = '# Guide\n\nVisible paragraph.';
	await writeSourceContent(page, note);
	await page.locator('input[type="file"][accept*="text/markdown"]').setInputFiles({
		name: '.env',
		mimeType: 'text/plain',
		buffer: Buffer.from('SECRET_TOKEN=hidden')
	});
	await expect(page.locator('.cm-content').first()).toContainText('SECRET_TOKEN');
	await page
		.locator('aside')
		.getByRole('button', { name: /^Sans titre/ })
		.first()
		.click();
	await expect(page.locator('.cm-content')).toContainText('Visible paragraph');

	await openAiPanel(page);
	await expect(page.getByTestId('ai-provider')).toContainText('mock.local');
	await expect(page.getByTestId('ai-provider')).toContainText('mock-model');
	await expect(page.getByTestId('ai-manifest')).toContainText('Sans titre');
	await expect(page.getByTestId('ai-manifest')).toContainText('mock.local');

	await page.getByTestId('ai-scope-files').click();
	const env = page
		.getByTestId('ai-panel')
		.locator('label')
		.filter({ hasText: '.env' })
		.locator('input');
	await env.check();
	await expect(page.getByTestId('ai-manifest')).toContainText('secret');
	await page.getByTestId('ai-action-explain').click();
	await expect(page.getByTestId('ai-output')).toContainText('First chunk. Second chunk.');
	expect(requests).toHaveLength(1);
	const body = JSON.stringify(requests[0]);
	expect(body).toContain('Visible paragraph');
	expect(body).not.toContain('SECRET_TOKEN');
	expect(body).toContain('<file path=');

	await expect(page.locator('.cm-content')).toContainText('Visible paragraph');
	await info.attach('ai-panel.json', {
		body: JSON.stringify(
			{
				requestCount: requests.length,
				secretExcluded: !body.includes('SECRET_TOKEN'),
				streamed: 'First chunk. Second chunk.',
				documentUnchanged: true
			},
			null,
			2
		),
		contentType: 'application/json'
	});
	await info.attach('ai-panel.png', { body: await page.screenshot() });
});

test('cancels a streaming request without changing files', async ({ page }, info: TestInfo) => {
	await configureMockAi(page, { delay: 4000 });
	await resetAppState(page);
	await createFirstFile(page);
	await writeSourceContent(page, 'Keep this document.');
	await openAiPanel(page);
	await page.getByTestId('ai-prompt').fill('Explain this document.');
	await page.getByTestId('ai-send').click();
	await expect(page.getByTestId('ai-stop')).toBeVisible();
	await page.getByTestId('ai-stop').click();
	await expect(page.getByTestId('ai-output')).toContainText(/Requête arrêtée|Request stopped/);
	await expect(page.getByTestId('ai-send')).toBeVisible();
	await expect(page.locator('.cm-content')).toContainText('Keep this document.');
	await info.attach('ai-cancel.json', {
		body: JSON.stringify({ cancelled: true, documentUnchanged: true }),
		contentType: 'application/json'
	});
});

test('fits a narrow web viewport', async ({ page }) => {
	await configureMockAi(page);
	await resetAppState(page);
	await createFirstFile(page);
	await writeSourceContent(page, 'Mobile context.');
	await page.setViewportSize({ width: 390, height: 720 });
	await openAiPanel(page);
	const panel = page.getByTestId('ai-panel');
	await expect(panel).toBeVisible();
	const box = await panel.boundingBox();
	expect(box?.width ?? 999).toBeLessThanOrEqual(390);
	await expect(page.getByTestId('ai-send')).toBeVisible();
});

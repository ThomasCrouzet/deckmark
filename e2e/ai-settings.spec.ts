import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { resetAppState } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

async function openAiSettings(page: Page) {
	await page.keyboard.press('ControlOrMeta+,');
	const settings = page.getByRole('dialog', { name: 'Réglages', exact: true });
	await expect(settings).toBeVisible();
	const ai = settings.getByTestId('ai-settings');
	if (!(await ai.getAttribute('open'))) await ai.locator('summary').click();
	return { settings, ai };
}

test('keeps AI disabled, stores no key, and configures a mock provider', async ({
	page
}, info: TestInfo) => {
	let modelRequests = 0;
	let chatRequests = 0;
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
		const url = route.request().url();
		if (url.endsWith('/models')) {
			modelRequests++;
			await route.fulfill({
				status: 200,
				headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
				body: JSON.stringify({ data: [{ id: 'mock-model' }, { id: 'other-model' }] })
			});
			return;
		}
		chatRequests++;
		await route.fulfill({
			status: 200,
			headers: {
				'access-control-allow-origin': '*',
				'content-type': 'text/event-stream'
			},
			body:
				'data: {"choices":[{"delta":{"content":"OK"}}]}\n\n' +
				'data: {"choices":[{"delta":{"content":" from mock"}}]}\n\n' +
				'data: [DONE]\n\n'
		});
	});

	await resetAppState(page);
	await expect.poll(() => modelRequests + chatRequests).toBe(0);
	const { ai } = await openAiSettings(page);
	await expect(ai.getByTestId('ai-enabled')).not.toBeChecked();
	await expect(ai.getByTestId('ai-status')).toHaveCount(0);

	await ai.getByTestId('ai-base-url').fill('https://mock.local/v1');
	await ai.getByTestId('ai-base-url').blur();
	await ai.getByTestId('ai-allow-key').check();
	await ai.getByTestId('ai-key').fill('sk-test-secret');
	await ai.getByTestId('ai-key-save').click();
	await ai.getByTestId('ai-load-models').click();
	await expect(ai.getByTestId('ai-status')).toContainText('2 modèle');
	expect(modelRequests).toBe(1);
	await ai.getByTestId('ai-model').fill('mock-model');
	await ai.getByTestId('ai-enabled').check();
	await ai.getByTestId('ai-test').click();
	await expect(ai.getByTestId('ai-status')).toContainText('Connexion réussie');
	expect(chatRequests).toBe(1);
	await expect(ai.getByTestId('ai-destination')).toContainText('mock.local');

	const storage = await page.evaluate(() => ({
		local: JSON.stringify(localStorage),
		session: sessionStorage.getItem('mdsh:ai-key')
	}));
	expect(storage.local).not.toContain('sk-test-secret');
	expect(storage.session).toBe('sk-test-secret');

	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem('mdsh:ai')))
		.toContain('mock.local');
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem('mdsh:ai')))
		.not.toContain('sk-test-secret');

	await info.attach('ai-settings.json', {
		body: JSON.stringify({
			modelRequests,
			chatRequests,
			localStorageHasSecret: storage.local.includes('sk-test-secret'),
			sessionHasSecret: storage.session === 'sk-test-secret'
		}),
		contentType: 'application/json'
	});
	await info.attach('ai-settings.png', { body: await page.screenshot() });
});

test('requires explicit consent and reports unavailable local inference', async ({
	page
}, info: TestInfo) => {
	let requests = 0;
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
		requests++;
		await route.fulfill({
			status: 200,
			headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
			body: '{}'
		});
	});
	await resetAppState(page);
	const { ai } = await openAiSettings(page);
	await ai.getByTestId('ai-enabled').check();
	await ai.getByTestId('ai-base-url').fill('https://mock.local/v1');
	await ai.getByTestId('ai-base-url').blur();
	await ai.getByTestId('ai-key').fill('sk-test');
	await ai.getByTestId('ai-key-save').click();
	await ai.getByTestId('ai-test').click();
	await expect(ai.getByTestId('ai-status')).toContainText('privacy-consent');
	expect(requests).toBe(0);

	await ai.getByTestId('ai-allow-key').check();
	await ai.getByTestId('ai-mode-local').click();
	await ai.getByTestId('ai-test').click();
	await expect(ai.getByTestId('ai-status')).toContainText(/Local inference|pas disponible/);
	expect(requests).toBe(0);
	await expect(ai.getByTestId('ai-allow-key')).toHaveCount(0);

	await info.attach('ai-privacy.json', {
		body: JSON.stringify({ requests, localUnavailable: true }),
		contentType: 'application/json'
	});
});

test('preserves provider query parameters for listing and chat', async ({
	page
}, info: TestInfo) => {
	const urls: string[] = [];
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
		urls.push(route.request().url());
		if (route.request().url().includes('/models')) {
			await route.fulfill({
				status: 200,
				headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
				body: JSON.stringify({ data: [{ id: 'mock-model' }] })
			});
			return;
		}
		await route.fulfill({
			status: 200,
			headers: { 'access-control-allow-origin': '*', 'content-type': 'text/event-stream' },
			body: 'data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n'
		});
	});
	await resetAppState(page);
	const { ai } = await openAiSettings(page);
	await ai.getByTestId('ai-enabled').check();
	await ai.getByTestId('ai-base-url').fill('https://mock.local/v1?api-version=1');
	await ai.getByTestId('ai-base-url').blur();
	await ai.getByTestId('ai-allow-key').check();
	await ai.getByTestId('ai-key').fill('sk-test');
	await ai.getByTestId('ai-key-save').click();
	await ai.getByTestId('ai-load-models').click();
	await expect(ai.getByTestId('ai-status')).toContainText('1 modèle');
	await ai.getByTestId('ai-model').fill('mock-model');
	await ai.getByTestId('ai-test').click();
	await expect(ai.getByTestId('ai-status')).toContainText('Connexion réussie');
	expect(urls).toEqual([
		'https://mock.local/v1/models?api-version=1',
		'https://mock.local/v1/chat/completions?api-version=1'
	]);
	await info.attach('ai-endpoint.json', {
		body: JSON.stringify({ urls }),
		contentType: 'application/json'
	});
});

test('reports an invalid endpoint before a request', async ({ page }, info: TestInfo) => {
	let requests = 0;
	await page.route('https://mock.local/v1/**', async (route) => {
		requests++;
		await route.fulfill({
			status: 200,
			headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
			body: JSON.stringify({ data: [] })
		});
	});
	await resetAppState(page);
	const { ai } = await openAiSettings(page);
	await ai.getByTestId('ai-enabled').check();
	await ai.getByTestId('ai-base-url').fill('https://mock.local/v1#frag');
	await ai.getByTestId('ai-base-url').blur();
	await ai.getByTestId('ai-allow-key').check();
	await ai.getByTestId('ai-key').fill('sk-test');
	await ai.getByTestId('ai-key-save').click();
	await ai.getByTestId('ai-load-models').click();
	await expect(ai.getByTestId('ai-status')).toContainText('invalid-endpoint');
	expect(requests).toBe(0);
	await info.attach('ai-invalid-endpoint.json', {
		body: JSON.stringify({ requests, code: 'invalid-endpoint' }),
		contentType: 'application/json'
	});
});

test('reports an unreachable provider with an actionable error', async ({
	page
}, info: TestInfo) => {
	await resetAppState(page);
	const { ai } = await openAiSettings(page);
	await ai.getByTestId('ai-enabled').check();
	await ai.getByTestId('ai-base-url').fill('https://unreachable.invalid/v1');
	await ai.getByTestId('ai-base-url').blur();
	await ai.getByTestId('ai-allow-key').check();
	await ai.getByTestId('ai-key').fill('sk-test');
	await ai.getByTestId('ai-key-save').click();
	await ai.getByTestId('ai-test').click();
	await expect(ai.getByTestId('ai-status')).toContainText(/cors|network|réseau/i);
	await info.attach('ai-error.png', { body: await page.screenshot() });
});

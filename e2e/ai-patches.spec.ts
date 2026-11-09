import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createFirstFile, openPalette, resetAppState, writeSourceContent } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

async function configureAi(page: Page, mode: 'valid' | 'stale') {
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
		const body = route.request().postDataJSON() as {
			messages: Array<{ content: string }>;
		};
		const prompt = body.messages.at(-1)?.content ?? '';
		const file = /<file path="([^"]+)" hash="([^"]+)">\n([\s\S]*?)\n<\/file>/.exec(prompt);
		if (!file) {
			await route.fulfill({
				status: 200,
				headers: { 'access-control-allow-origin': '*', 'content-type': 'text/event-stream' },
				body: 'data: {"choices":[{"delta":{"content":"No file context."}}]}\n\ndata: [DONE]\n\n'
			});
			return;
		}
		const [, path, hash, content] = file;
		const patch = {
			files: [
				{
					path,
					baseHash: mode === 'valid' ? hash : '00000000',
					hunks: [{ before: 'Visible paragraph.', after: 'Patched paragraph.' }]
				}
			]
		};
		const chunk = JSON.stringify({
			choices: [{ delta: { content: '```json\n' + JSON.stringify(patch) + '\n```' } }]
		});
		await route.fulfill({
			status: 200,
			headers: { 'access-control-allow-origin': '*', 'content-type': 'text/event-stream' },
			body: `data: ${chunk}\n\ndata: [DONE]\n\n`
		});
		void content;
	});
}

type MockHunk = { before: string; after: string; occurrence?: number };

async function configureCustomAi(
	page: Page,
	buildHunks: (content: string) => MockHunk[]
): Promise<void> {
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
		const body = route.request().postDataJSON() as { messages: Array<{ content: string }> };
		const prompt = body.messages.at(-1)?.content ?? '';
		const file = /<file path="([^"]+)" hash="([^"]+)">\n([\s\S]*?)\n<\/file>/.exec(prompt);
		if (!file) {
			await route.fulfill({
				status: 200,
				headers: { 'access-control-allow-origin': '*', 'content-type': 'text/event-stream' },
				body: 'data: {"choices":[{"delta":{"content":"No file context."}}]}\n\ndata: [DONE]\n\n'
			});
			return;
		}
		const [, path, hash, content] = file;
		const patch = {
			files: [{ path, baseHash: hash, hunks: buildHunks(content) }]
		};
		const chunk = JSON.stringify({
			choices: [{ delta: { content: '```json\n' + JSON.stringify(patch) + '\n```' } }]
		});
		await route.fulfill({
			status: 200,
			headers: { 'access-control-allow-origin': '*', 'content-type': 'text/event-stream' },
			body: `data: ${chunk}\n\ndata: [DONE]\n\n`
		});
	});
}

async function openAiPanel(page: Page) {
	await openPalette(page);
	await page
		.getByRole('dialog', { name: 'Palette de commandes' })
		.getByRole('option', { name: /assistant IA/i })
		.click();
	await expect(page.getByTestId('ai-panel')).toBeVisible();
}

test('reviews a patch, applies only after approval, and rolls back', async ({
	page
}, info: TestInfo) => {
	await configureAi(page, 'valid');
	await resetAppState(page);
	await createFirstFile(page);
	await writeSourceContent(page, '# Guide\n\nVisible paragraph.');
	await openAiPanel(page);
	await page.getByTestId('ai-action-patch').click();
	await expect(page.getByTestId('ai-patch-review')).toBeVisible();
	await expect(page.getByTestId('ai-patch-review')).toContainText('Visible paragraph.');
	await expect(page.getByTestId('ai-patch-review')).toContainText('Patched paragraph.');
	await expect(page.locator('.cm-content')).toContainText('Visible paragraph.');

	await page.getByTestId('ai-patch-apply').click();
	await expect.poll(() => page.locator('.cm-content').innerText()).toContain('Patched paragraph.');
	await expect(page.getByTestId('ai-patch-applied')).toContainText('1 fichier');
	const versions = await page.evaluate(
		() =>
			new Promise<number>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const rows = request.result.transaction('versions').objectStore('versions').count();
					rows.onerror = () => reject(rows.error);
					rows.onsuccess = () => {
						request.result.close();
						resolve(rows.result);
					};
				};
			})
	);
	expect(versions).toBeGreaterThan(0);

	await page.getByTestId('ai-patch-revert').click();
	await expect.poll(() => page.locator('.cm-content').innerText()).toContain('Visible paragraph.');
	await expect(page.locator('.cm-content')).not.toContainText('Patched paragraph.');

	await info.attach('ai-patch.json', {
		body: JSON.stringify({
			reviewedBeforeApply: true,
			checkpoints: versions,
			applied: 'Patched paragraph.',
			reverted: 'Visible paragraph.'
		}),
		contentType: 'application/json'
	});
	await info.attach('ai-patch.png', { body: await page.screenshot() });
});

test('applies an explicit occurrence through the review flow', async ({ page }, info: TestInfo) => {
	await configureCustomAi(page, () => [{ before: 'alpha', after: 'beta', occurrence: 2 }]);
	await resetAppState(page);
	await createFirstFile(page);
	await writeSourceContent(page, '# Guide\n\nalpha alpha');
	await openAiPanel(page);
	await page.getByTestId('ai-action-patch').click();
	await expect(page.getByTestId('ai-patch-review')).toContainText('prêt');
	await page.getByTestId('ai-patch-apply').click();
	await expect.poll(() => page.locator('.cm-content').innerText()).toContain('alpha beta');
	expect(await page.locator('.cm-content').innerText()).not.toContain('beta alpha');
	await info.attach('ai-patch-occurrence.json', {
		body: JSON.stringify({ occurrence: 2, result: 'alpha beta' }),
		contentType: 'application/json'
	});
});

test('applies a partial selection without renumbering a later occurrence', async ({
	page
}, info: TestInfo) => {
	await configureCustomAi(page, () => [
		{ before: 'alpha', after: 'ALPHA', occurrence: 1 },
		{ before: 'alpha', after: 'BETA', occurrence: 2 },
		{ before: 'gamma', after: 'GAMMA' }
	]);
	await resetAppState(page);
	await createFirstFile(page);
	await writeSourceContent(page, '# Guide\n\nalpha alpha gamma');
	await openAiPanel(page);
	await page.getByTestId('ai-action-patch').click();
	await expect(page.getByTestId('ai-patch-review')).toContainText('prêt');
	// Uncheck the first hunk; the two remaining ranges must stay exact.
	await page.getByTestId('ai-patch-review').locator('.patch-hunks input').first().uncheck();
	await page.getByTestId('ai-patch-apply').click();
	await expect.poll(() => page.locator('.cm-content').innerText()).toContain('alpha BETA GAMMA');
	await info.attach('ai-patch-partial.json', {
		body: JSON.stringify({ selected: [1, 2], result: 'alpha BETA GAMMA' }),
		contentType: 'application/json'
	});
});

test('rejects a concurrent source edit before applying', async ({ page }, info: TestInfo) => {
	await configureCustomAi(page, () => [{ before: 'alpha', after: 'beta', occurrence: 2 }]);
	await resetAppState(page);
	await createFirstFile(page);
	await writeSourceContent(page, '# Guide\n\nalpha alpha');
	await openAiPanel(page);
	await page.getByTestId('ai-action-patch').click();
	await expect(page.getByTestId('ai-patch-review')).toContainText('prêt');
	// Inject a concurrent external revision while the review stays mounted.
	const injected = await page.evaluate(() => {
		const api = (
			window as unknown as {
				__mdshTest?: { forceNativeConflict: (text: string) => boolean };
			}
		).__mdshTest;
		return api?.forceNativeConflict('# Guide\n\nalpha alpha changed') ?? false;
	});
	expect(injected).toBe(true);
	await expect(page.getByTestId('ai-patch-review')).toContainText('fichier modifié');
	await expect(page.getByTestId('ai-patch-apply')).toBeDisabled();
	expect(await page.locator('.cm-content').innerText()).toContain('alpha alpha changed');
	expect(await page.locator('.cm-content').innerText()).not.toContain('alpha beta');
	await info.attach('ai-patch-concurrent.json', {
		body: JSON.stringify({ concurrentEditBlocked: true, sourceKept: 'alpha alpha changed' }),
		contentType: 'application/json'
	});
});

test('blocks a stale patch and keeps the file unchanged', async ({ page }, info: TestInfo) => {
	await configureAi(page, 'stale');
	await resetAppState(page);
	await createFirstFile(page);
	await writeSourceContent(page, '# Guide\n\nVisible paragraph.');
	await openAiPanel(page);
	await page.getByTestId('ai-action-patch').click();
	await expect(page.getByTestId('ai-patch-review')).toContainText('fichier modifié');
	await expect(page.getByTestId('ai-patch-apply')).toBeDisabled();
	await expect(page.locator('.cm-content')).toContainText('Visible paragraph.');
	expect(await page.locator('.cm-content').innerText()).not.toContain('Patched paragraph.');
	await info.attach('ai-patch-stale.json', {
		body: JSON.stringify({ staleBlocked: true, unchanged: true }),
		contentType: 'application/json'
	});
});

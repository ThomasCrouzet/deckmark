import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
	createFirstFile,
	openPalette,
	resetAppState,
	seedFiles,
	writeSourceContent
} from './helpers';

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
): Promise<Array<Record<string, unknown>>> {
	const requests: Array<Record<string, unknown>> = [];
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
		const body = route.request().postDataJSON() as Record<string, unknown> & {
			messages: Array<{ content: string }>;
		};
		requests.push(body);
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
	return requests;
}

async function configureSequenceAi(
	page: Page,
	sequence: Array<(content: string) => MockHunk[]>
): Promise<Array<Record<string, unknown>>> {
	const requests: Array<Record<string, unknown>> = [];
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
	let index = 0;
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
		const body = route.request().postDataJSON() as Record<string, unknown> & {
			messages: Array<{ content: string }>;
		};
		requests.push(body);
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
		const buildHunks = sequence[Math.min(index, sequence.length - 1)]!;
		index += 1;
		const patch = { files: [{ path, baseHash: hash, hunks: buildHunks(content) }] };
		const chunk = JSON.stringify({
			choices: [{ delta: { content: '```json\n' + JSON.stringify(patch) + '\n```' } }]
		});
		await route.fulfill({
			status: 200,
			headers: { 'access-control-allow-origin': '*', 'content-type': 'text/event-stream' },
			body: `data: ${chunk}\n\ndata: [DONE]\n\n`
		});
	});
	return requests;
}

async function importProject(
	page: Page,
	name: string,
	files: Record<string, string>
): Promise<void> {
	const zip = new (await import('jszip')).default();
	for (const [path, content] of Object.entries(files)) zip.file(path, content);
	await page.getByTestId('projects-open').click();
	const panel = page.getByRole('dialog', { name: 'Projets Markdown' });
	await panel.locator('input[type=file][accept=".zip"]').setInputFiles({
		name: `${name}.zip`,
		mimeType: 'application/zip',
		buffer: await zip.generateAsync({ type: 'nodebuffer' })
	});
	await panel.getByRole('button', { name: 'Fermer les projets' }).click();
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

test('resets hunk approvals when a new proposal reuses the same path and status', async ({
	page
}, info: TestInfo) => {
	await configureSequenceAi(page, [
		() => [
			{ before: 'alpha', after: 'A1' },
			{ before: 'beta', after: 'B1' }
		],
		() => [
			{ before: 'alpha', after: 'A2' },
			{ before: 'gamma', after: 'G2' }
		]
	]);
	await resetAppState(page);
	await createFirstFile(page);
	await writeSourceContent(page, '# Guide\n\nalpha beta gamma');
	await openAiPanel(page);
	await page.getByTestId('ai-action-patch').click();
	await expect(page.getByTestId('ai-patch-review')).toContainText('A1');
	// Uncheck the first hunk of proposal A.
	await page.getByTestId('ai-patch-review').locator('.patch-hunks input').first().uncheck();
	// A second response has the same path and status but different hunks.
	await page.getByTestId('ai-action-patch').click();
	await expect(page.getByTestId('ai-patch-review')).toContainText('A2');
	await expect(page.getByTestId('ai-patch-review').locator('.patch-hunks input')).toHaveCount(2);
	for (const box of await page.getByTestId('ai-patch-review').locator('.patch-hunks input').all())
		await expect(box).toBeChecked();
	await page.getByTestId('ai-patch-apply').click();
	await expect.poll(() => page.locator('.cm-content').innerText()).toContain('A2 beta G2');
	expect(await page.locator('.cm-content').innerText()).not.toContain('A1');
	await info.attach('ai-patch-reset.json', {
		body: JSON.stringify({ proposalA: [0, 1], proposalB: [0, 1], applied: 'A2 beta G2' }),
		contentType: 'application/json'
	});
});

test('rejects a scope change during hydration without sending a request', async ({
	page
}, info: TestInfo) => {
	const requests = await configureSequenceAi(page, [() => [{ before: 'Alpha', after: 'A' }]]);
	await resetAppState(page);
	await seedFiles(page, [
		{ name: 'Alpha.md', content: '# Alpha\n\nAlpha body' },
		{ name: 'Beta.md', content: '# Beta\n\nBeta body' }
	]);
	await openAiPanel(page);
	await page.getByTestId('ai-scope-files').click();
	await page
		.getByTestId('ai-panel')
		.locator('label')
		.filter({ hasText: 'Alpha.md' })
		.locator('input')
		.check();
	await page.evaluate(() => {
		(window as unknown as { __mdshAiHydrationDelay?: number }).__mdshAiHydrationDelay = 600;
	});
	await page.getByTestId('ai-action-explain').click();
	await expect(page.getByTestId('ai-stop')).toBeVisible();
	// Change the approved scope before hydration completes.
	await page.getByTestId('ai-scope-document').click();
	await expect(page.getByTestId('ai-error')).toContainText(/contexte|context/i);
	expect(requests).toHaveLength(0);
	await info.attach('ai-snapshot-scope.json', {
		body: JSON.stringify({ requests: requests.length, scopeChanged: true }),
		contentType: 'application/json'
	});
});

test('rejects a source change during hydration without sending a request', async ({
	page
}, info: TestInfo) => {
	const requests = await configureSequenceAi(page, [() => [{ before: 'Alpha', after: 'A' }]]);
	await resetAppState(page);
	await createFirstFile(page);
	await writeSourceContent(page, '# Guide\n\nAlpha body');
	await openAiPanel(page);
	await page.evaluate(() => {
		(window as unknown as { __mdshAiHydrationDelay?: number }).__mdshAiHydrationDelay = 600;
	});
	await page.getByTestId('ai-action-explain').click();
	await expect(page.getByTestId('ai-stop')).toBeVisible();
	await page.evaluate(() => {
		const api = (
			window as unknown as {
				__mdshTest?: { forceNativeConflict: (text: string) => boolean };
			}
		).__mdshTest;
		api?.forceNativeConflict('# Guide\n\nChanged body');
	});
	await expect(page.getByTestId('ai-error')).toContainText(/contexte|context|modifi/i);
	expect(requests).toHaveLength(0);
	await info.attach('ai-snapshot-source.json', {
		body: JSON.stringify({ requests: requests.length, sourceChanged: true }),
		contentType: 'application/json'
	});
});

test('Project scope sends only the approved project files', async ({ page }, info: TestInfo) => {
	const requests = await configureCustomAi(page, (content) => [
		{ before: content.split('\n')[0]!, after: '# Changed' }
	]);
	await resetAppState(page);
	await importProject(page, 'Alpha', { 'a.md': '# Alpha\n\nALPHA SECRET' });
	await importProject(page, 'Beta', { 'b.md': '# Beta\n\nBETA SECRET' });
	await page.locator('[data-project-root-name="Alpha"] summary').first().click();
	await page
		.locator('[data-project-root-name="Alpha"] [data-project-document="a.md"] button')
		.first()
		.click();
	await openAiPanel(page);
	await page.getByTestId('ai-scope-project').click();
	await expect(page.getByTestId('ai-manifest')).toContainText('a.md');
	await page.getByTestId('ai-action-explain').click();
	await expect(page.getByTestId('ai-output')).toBeVisible();
	const body = JSON.stringify(requests[0]);
	expect(body).toContain('ALPHA SECRET');
	expect(body).not.toContain('BETA SECRET');
	await info.attach('ai-project-scope.json', {
		body: JSON.stringify({
			requests: requests.length,
			betaExcluded: !body.includes('BETA SECRET')
		}),
		contentType: 'application/json'
	});
});

test('refuses an ambiguous basename across project folders', async ({ page }, info: TestInfo) => {
	await configureCustomAi(page, () => [{ before: '# Home', after: '# Changed' }]);
	await resetAppState(page);
	await importProject(page, 'Alpha', { 'README.md': '# Home\n' });
	await importProject(page, 'Beta', { 'README.md': '# Home\n' });
	await page.locator('[data-project-root-name="Alpha"] summary').first().click();
	await page
		.locator('[data-project-root-name="Alpha"] [data-project-document="README.md"] button')
		.first()
		.click();
	await openAiPanel(page);
	await page.getByTestId('ai-scope-project').click();
	await page.getByTestId('ai-action-patch').click();
	await expect(page.getByTestId('ai-patch-review')).toContainText('ambigu');
	await expect(page.getByTestId('ai-patch-apply')).toBeDisabled();
	const rows = await page.evaluate(
		() =>
			new Promise<Array<{ name: string; relativePath?: string; content: string }>>(
				(resolve, reject) => {
					const request = indexedDB.open('mdsh');
					request.onerror = () => reject(request.error);
					request.onsuccess = () => {
						const database = request.result;
						const all = database.transaction('drafts').objectStore('drafts').getAll();
						all.onsuccess = () => {
							database.close();
							resolve(
								all.result.map((row: { name: string; relativePath?: string; content: string }) => ({
									name: row.name,
									relativePath: row.relativePath,
									content: row.content
								}))
							);
						};
						all.onerror = () => reject(all.error);
					};
				}
			)
	);
	const readmes = rows.filter((row) => row.name === 'README.md');
	expect(readmes).toHaveLength(2);
	expect(readmes.every((row) => row.content === '# Home\n')).toBe(true);
	await info.attach('ai-patch-ambiguous.json', {
		body: JSON.stringify({ ambiguous: true, readmes: readmes.length, unchanged: true }),
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

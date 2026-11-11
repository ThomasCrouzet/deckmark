import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
	createFirstFile,
	openPalette,
	resetAppState,
	seedFiles,
	writeSourceContent
} from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce', ignoreHTTPSErrors: true });

interface ContextFile {
	path: string;
	hash: string;
	content: string;
}

function contextFiles(prompt: string): ContextFile[] {
	const start = prompt.indexOf('<context>');
	const end = prompt.indexOf('</context>', start + 1);
	if (start === -1 || end === -1) return [];
	try {
		const parsed = JSON.parse(prompt.slice(start + '<context>'.length, end).trim()) as {
			files?: ContextFile[];
		};
		return Array.isArray(parsed.files) ? parsed.files : [];
	} catch {
		return [];
	}
}

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
		const [file] = contextFiles(prompt);
		if (!file) {
			await route.fulfill({
				status: 200,
				headers: { 'access-control-allow-origin': '*', 'content-type': 'text/event-stream' },
				body: 'data: {"choices":[{"delta":{"content":"No file context."}}]}\n\ndata: [DONE]\n\n'
			});
			return;
		}
		const { path, hash, content } = file;
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
		const [file] = contextFiles(prompt);
		if (!file) {
			await route.fulfill({
				status: 200,
				headers: { 'access-control-allow-origin': '*', 'content-type': 'text/event-stream' },
				body: 'data: {"choices":[{"delta":{"content":"No file context."}}]}\n\ndata: [DONE]\n\n'
			});
			return;
		}
		const { path, hash, content } = file;
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

async function configureMultiFileAi(
	page: Page,
	buildHunks: (path: string, content: string) => MockHunk[]
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
		const files = contextFiles(prompt).map(({ path, hash, content }) => ({
			path,
			baseHash: hash,
			hunks: buildHunks(path, content)
		}));
		const chunk = JSON.stringify({
			choices: [{ delta: { content: '```json\n' + JSON.stringify({ files }) + '\n```' } }]
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
		const [file] = contextFiles(prompt);
		if (!file) {
			await route.fulfill({
				status: 200,
				headers: { 'access-control-allow-origin': '*', 'content-type': 'text/event-stream' },
				body: 'data: {"choices":[{"delta":{"content":"No file context."}}]}\n\ndata: [DONE]\n\n'
			});
			return;
		}
		const { path, hash, content } = file;
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

function listenOnLoopback(server: Server): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (typeof address === 'object' && address) resolve(address.port);
			else reject(new Error('The test provider did not bind a port.'));
		});
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * Creates a short-lived self-signed certificate for the loopback origins. The
 * private key exists only in the test process and in a temporary directory. It
 * is never committed, so the repository stores no key material.
 */
function createTlsMaterial(): { key: Buffer; cert: Buffer; directory: string } {
	const directory = mkdtempSync(join(tmpdir(), 'deckmark-tls-'));
	const keyPath = join(directory, 'key.pem');
	const certPath = join(directory, 'cert.pem');
	execFileSync(
		'openssl',
		[
			'req',
			'-x509',
			'-newkey',
			'rsa:2048',
			'-nodes',
			'-keyout',
			keyPath,
			'-out',
			certPath,
			'-days',
			'1',
			'-subj',
			'/CN=127.0.0.1',
			'-addext',
			'subjectAltName=IP:127.0.0.1'
		],
		{ stdio: 'ignore' }
	);
	return { key: readFileSync(keyPath), cert: readFileSync(certPath), directory };
}

/**
 * Starts two real loopback origins. Origin A answers POST with a 307 to B.
 * Origin B records every request body. A fixed `redirect: 'error'` client must
 * stop at A; a default client forwards the POST body to the unapproved origin.
 */
async function startRedirectProvider(): Promise<{
	baseUrl: string;
	requests: Array<{ method: string; url: string }>;
	destination: Array<{ url: string; body: string }>;
	close: () => Promise<void>;
}> {
	const requests: Array<{ method: string; url: string }> = [];
	const destination: Array<{ url: string; body: string }> = [];
	const tls = createTlsMaterial();
	const cors = {
		'access-control-allow-origin': '*',
		'access-control-allow-methods': 'POST, OPTIONS',
		'access-control-allow-headers': '*'
	};
	const destinationServer = createServer({ key: tls.key, cert: tls.cert }, (request, response) => {
		if (request.method === 'OPTIONS') {
			response.writeHead(204, cors);
			response.end();
			return;
		}
		const chunks: Buffer[] = [];
		request.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
		request.on('end', () => {
			destination.push({
				url: request.url ?? '',
				body: Buffer.concat(chunks).toString('utf8')
			});
			response.writeHead(200, { ...cors, 'content-type': 'text/event-stream' });
			response.end('data: [DONE]\n\n');
		});
	});
	const destinationPort = await listenOnLoopback(destinationServer);
	const redirectServer = createServer({ key: tls.key, cert: tls.cert }, (request, response) => {
		requests.push({ method: request.method ?? '', url: request.url ?? '' });
		if (request.method === 'OPTIONS') {
			response.writeHead(204, cors);
			response.end();
			return;
		}
		response.writeHead(307, {
			...cors,
			location: `https://127.0.0.1:${destinationPort}/collect`
		});
		response.end();
	});
	const redirectPort = await listenOnLoopback(redirectServer);
	return {
		baseUrl: `https://127.0.0.1:${redirectPort}/v1`,
		requests,
		destination,
		close: async () => {
			await Promise.all([closeServer(redirectServer), closeServer(destinationServer)]);
			rmSync(tls.directory, { recursive: true, force: true });
		}
	};
}

async function readDraftRows(
	page: Page
): Promise<Array<{ id: string; name: string; content: string }>> {
	return page.evaluate(
		() =>
			new Promise<Array<{ id: string; name: string; content: string }>>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const all = database.transaction('drafts').objectStore('drafts').getAll();
					all.onsuccess = () => {
						database.close();
						resolve(
							all.result.map((row: { id: string; name: string; content: string }) => ({
								id: row.id,
								name: row.name,
								content: row.content
							}))
						);
					};
					all.onerror = () => reject(all.error);
				};
			})
	);
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

test('refuses a revert when a later edit collides on the 32-bit hash', async ({
	page
}, info: TestInfo) => {
	await configureCustomAi(page, () => [{ before: 'ORIGINAL', after: '4c6d3c14' }]);
	await resetAppState(page);
	await createFirstFile(page);
	await writeSourceContent(page, 'ORIGINAL');
	await openAiPanel(page);
	await page.getByTestId('ai-action-patch').click();
	await expect(page.getByTestId('ai-patch-review')).toContainText('prêt');
	await page.getByTestId('ai-patch-apply').click();
	await expect.poll(() => page.locator('.cm-content').innerText()).toContain('4c6d3c14');
	// This independent edit has the same FNV-1a 32-bit hash as the applied
	// bytes but different exact content. Revert must not trust the hash.
	const edited = await page.evaluate(() => {
		const api = (
			window as unknown as {
				__mdshTest?: { forceNativeConflict: (text: string) => boolean };
			}
		).__mdshTest;
		return api?.forceNativeConflict('34749a0f') ?? false;
	});
	expect(edited).toBe(true);
	await expect.poll(() => page.locator('.cm-content').innerText()).toContain('34749a0f');
	await page.getByTestId('ai-patch-revert').click();
	await expect(page.getByTestId('ai-patch-error')).toBeVisible();
	await expect(page.locator('.cm-content')).toHaveText('34749a0f');
	expect(await page.locator('.cm-content').innerText()).not.toContain('ORIGINAL');
	await info.attach('ai-patch-revert-collision.json', {
		body: JSON.stringify({
			applied: '4c6d3c14',
			laterEdit: '34749a0f',
			hash: 'b8012ee5',
			revertRefused: true,
			kept: '34749a0f'
		}),
		contentType: 'application/json'
	});
});

test('refuses a multi-file revert when one file changed after apply', async ({
	page
}, info: TestInfo) => {
	await configureMultiFileAi(page, (path) =>
		path.includes('Alpha')
			? [{ before: 'alpha body', after: 'alpha patched' }]
			: [{ before: 'beta body', after: 'beta patched' }]
	);
	await resetAppState(page);
	await seedFiles(page, [
		{ name: 'Alpha.md', content: '# Alpha\n\nalpha body' },
		{ name: 'Beta.md', content: '# Beta\n\nbeta body' }
	]);
	await openAiPanel(page);
	await page.getByTestId('ai-scope-files').click();
	for (const name of ['Alpha.md', 'Beta.md'])
		await page
			.getByTestId('ai-panel')
			.locator('label')
			.filter({ hasText: name })
			.locator('input')
			.check();
	await page.getByTestId('ai-action-patch').click();
	await expect(page.getByTestId('ai-patch-review')).toContainText('prêt');
	await page.getByTestId('ai-patch-apply').click();
	await expect(page.getByTestId('ai-patch-applied')).toContainText('2');
	await expect
		.poll(async () => {
			const rows = await readDraftRows(page);
			return rows.map((row) => row.content).sort();
		})
		.toEqual(['# Alpha\n\nalpha patched', '# Beta\n\nbeta patched']);
	const applied = await readDraftRows(page);
	const beta = applied.find((row) => row.name === 'Beta.md')!;
	const edited = await page.evaluate((fileId) => {
		const api = (
			window as unknown as {
				__mdshTest?: {
					forceNativeConflict: (text: string, fileId?: string) => boolean;
				};
			}
		).__mdshTest;
		return api?.forceNativeConflict('# Beta\n\nbeta edited later', fileId) ?? false;
	}, beta.id);
	expect(edited).toBe(true);
	await expect.poll(() => page.locator('.cm-content').innerText()).toContain('beta edited later');
	await page.getByTestId('ai-patch-revert').click();
	await expect(page.getByTestId('ai-patch-error')).toBeVisible();
	await expect
		.poll(async () => {
			const rows = await readDraftRows(page);
			return rows.map((row) => row.content).sort();
		})
		.toEqual(['# Alpha\n\nalpha patched', '# Beta\n\nbeta edited later']);
	expect(await page.locator('.cm-content').innerText()).toContain('beta edited later');
	await info.attach('ai-patch-multi-revert.json', {
		body: JSON.stringify({
			applied: ['alpha patched', 'beta patched'],
			laterEdit: 'beta edited later',
			reverted: false,
			alphaKept: 'alpha patched',
			betaKept: 'beta edited later'
		}),
		contentType: 'application/json'
	});
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

test('refuses a provider redirect before sending the approved body', async ({
	page
}, info: TestInfo) => {
	const provider = await startRedirectProvider();
	try {
		const { baseUrl, requests, destination } = provider;
		await page.addInitScript((providerUrl) => {
			localStorage.setItem(
				'mdsh:ai',
				JSON.stringify({
					enabled: true,
					privacyMode: 'direct',
					allowBrowserKey: true,
					baseUrl: providerUrl,
					model: 'mock-model',
					temperature: 0.2,
					maxTokens: 24000
				})
			);
			sessionStorage.setItem('mdsh:ai-key', 'sk-session');
		}, baseUrl);
		await resetAppState(page);
		await createFirstFile(page);
		await writeSourceContent(page, '# Guide\n\nVisible paragraph.');
		await openAiPanel(page);
		await page.getByTestId('ai-prompt').fill('DECKMARK_CANARY_CONTEXT');
		await page.getByTestId('ai-send').click();
		// Wait for either the refused request or the unapproved destination.
		await expect
			.poll(
				async () => destination.length > 0 || (await page.getByTestId('ai-error').isVisible()),
				{ timeout: 5000 }
			)
			.toBe(true);
		expect(destination).toEqual([]);
		await expect(page.getByTestId('ai-error')).toBeVisible();
		expect(requests.some((entry) => entry.method === 'POST')).toBe(true);
		await info.attach('ai-redirect-refused.json', {
			body: JSON.stringify({
				redirect: 307,
				providerRequests: requests,
				destinationRequests: destination.length,
				canaryTransmitted: destination.some((entry) =>
					entry.body.includes('DECKMARK_CANARY_CONTEXT')
				)
			}),
			contentType: 'application/json'
		});
	} finally {
		await provider.close();
	}
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

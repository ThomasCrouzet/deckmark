import { expect, test as base, type BrowserContext, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { resetAppState, writeSourceContent } from './helpers';
import {
	createPresentation,
	openPresentationSource,
	presentationTitle,
	renamePresentation,
	waitForPresentation
} from './presentation-helpers';
import { createPwaUpdateServer } from './pwa-update-server';

const buildDirectory = resolve(process.env.OFFLINE_REVIEW_BUILD_DIR ?? 'build');
const diagram =
	'flowchart LR\nA[Write locally] --> B[Save locally]\nA --> C[Read offline]\nB --> D[Export locally]\nC --> D\n';
const dagreFixture = '# Offline diagram parity\n\n```mermaid\n' + diagram + '```\n';
const elkFixtures = [
	{
		name: 'layout elk',
		source: dagreFixture.replace('```mermaid\n', '```mermaid\n---\nconfig:\n  layout: elk\n---\n')
	},
	{
		name: 'legacy flowchart renderer elk',
		source: dagreFixture.replace(
			'```mermaid\n',
			'```mermaid\n%%{init: {"flowchart": {"defaultRenderer": "elk"}}}%%\n'
		)
	}
];

base.use({ locale: 'en-US', reducedMotion: 'reduce' });

type Evidence = {
	phase: string;
	events: Record<string, unknown>[];
	observe: (context: BrowserContext) => void;
};

const test = base.extend<{
	originServer: { origin: string; close: () => Promise<void>; elkPath: string };
	evidence: Evidence;
}>({
	// eslint-disable-next-line no-empty-pattern
	originServer: async ({}, use, info) => {
		const hashes: { path: string; bytes: number; sha256: string }[] = [];
		let elkPath = '';
		async function visit(directory: string): Promise<void> {
			for (const item of await readdir(directory, { withFileTypes: true })) {
				const path = join(directory, item.name);
				if (item.isDirectory()) await visit(path);
				else {
					const bytes = await readFile(path);
					const localPath = relative(buildDirectory, path);
					hashes.push({
						path: localPath,
						bytes: bytes.length,
						sha256: createHash('sha256').update(bytes).digest('hex')
					});
					if (localPath.includes('/chunks/') && bytes.includes('org.eclipse.elk')) {
						elkPath = '/' + localPath;
					}
				}
			}
		}
		await visit(buildDirectory);
		expect(elkPath, 'The production fixture must contain the ELK module').not.toBe('');
		await info.attach('build-identity.json', {
			body: JSON.stringify({ buildDirectory, hashes, elkPath }, null, 2),
			contentType: 'application/json'
		});
		const server = await createPwaUpdateServer(buildDirectory);
		let closed = false;
		const close = async () => {
			if (closed) return;
			await server.close();
			closed = true;
		};
		try {
			await use({ origin: server.origin, close, elkPath });
		} finally {
			await close();
		}
	},
	baseURL: async ({ originServer }, use) => use(originServer.origin),
	evidence: [
		async ({ context, page, browser, browserName }, use, info) => {
			const evidence: Evidence = {
				phase: 'installation',
				events: [],
				observe(observed) {
					observed.on('request', (request) => {
						evidence.events.push({ phase: evidence.phase, event: 'request', url: request.url() });
					});
					observed.on('requestfailed', (request) => {
						evidence.events.push({
							phase: evidence.phase,
							event: 'failed',
							url: request.url(),
							error: request.failure()
						});
					});
					observed.on('response', (response) => {
						evidence.events.push({
							phase: evidence.phase,
							event: 'response',
							url: response.url(),
							status: response.status(),
							serviceWorker: response.fromServiceWorker()
						});
					});
				}
			};
			evidence.observe(context);
			try {
				await use(evidence);
			} finally {
				await info.attach('offline-review.json', {
					body: JSON.stringify(
						{
							metadata: info.config.metadata,
							browserName,
							browserVersion: browser.version(),
							status: info.status,
							disruption: browserName === 'webkit' ? 'origin-stopped' : 'browser-offline',
							serverFixture:
								'pwa-update-server: in-memory production assets; root revision and release marker changed for the test',
							events: evidence.events
						},
						null,
						2
					),
					contentType: 'application/json'
				});
				if (!page.isClosed())
					await info.attach('offline-review.png', {
						body: await page.screenshot({ fullPage: true }),
						contentType: 'image/png'
					});
			}
		},
		{ auto: true }
	]
});

async function prepare(page: Page) {
	await resetAppState(page);
	await page.evaluate(() => localStorage.setItem('mdsh:locale', 'en'));
	await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
	await page.reload();
	await expect
		.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
		.toBe(true);
	await expect(page.locator('.mdsh-shell[aria-busy="false"]:not([inert])')).toBeVisible();
	await page.evaluate(() => caches.delete('mdsh-immutable-v1'));
}

async function disconnect(
	page: Page,
	browserName: string,
	server: { origin: string; close: () => Promise<void> },
	evidence: Evidence
) {
	if (browserName === 'webkit') {
		await server.close();
		await expect(page.request.get(server.origin, { timeout: 1000 })).rejects.toThrow();
	} else await page.context().setOffline(true);
	evidence.phase = 'offline';
	evidence.events.push({
		event: 'disconnected',
		controlled: await page.evaluate(() => Boolean(navigator.serviceWorker.controller))
	});
	await page.reload();
	await expect(page.locator('.mdsh-shell[aria-busy="false"]:not([inert])')).toBeVisible();
}

test('first-use presentation creation, reload, and advanced source editing work offline', async ({
	page,
	browserName,
	originServer,
	evidence
}, info) => {
	await prepare(page);
	await expect(page.getByTestId('presentation-editor')).toHaveCount(0);
	await disconnect(page, browserName, originServer, evidence);
	const editor = await createPresentation(page);
	await renamePresentation(page, 'Offline first use');
	await editor.getByTestId('slide-add-text').click();
	await editor.getByTestId('slide-edit-text').click();
	await editor.getByTestId('slide-text-editor').fill('## Created without a network');
	await editor.getByTestId('slide-text-done').click();
	await editor.getByTestId('slide-add').click();
	await editor.getByTestId('slide-add-rectangle').click();
	await expect(editor.locator('.save-state')).toHaveText('saved');
	await page.reload();
	const restored = await waitForPresentation(page);
	await expect(presentationTitle(page)).toHaveValue('Offline first use');
	await expect(restored.getByTestId('slide-thumbnail')).toHaveCount(2);
	await restored.getByTestId('slide-thumbnail').nth(1).click();
	await expect(
		restored.locator('[data-testid="slide-object"][data-object-type="rectangle"]')
	).toHaveCount(1);
	await restored.getByTestId('slide-thumbnail').first().click();
	await expect(restored.getByTestId('slide-canvas')).toContainText('Created without a network');
	await openPresentationSource(restored);
	const source = restored.getByTestId('slide-source-editor');
	const initial = await source.inputValue();
	const edited = initial.replace('Created without a network', 'Source edited without a network');
	expect(edited).not.toBe(initial);
	await info.attach('presentation-before.md', { body: initial, contentType: 'text/markdown' });
	await info.attach('presentation-after.md', { body: edited, contentType: 'text/markdown' });
	await source.fill(edited);
	await restored.getByTestId('slide-source-apply').click();
	await expect(restored.locator('.save-state')).toHaveText('saved');
	await page.reload();
	const finalEditor = await waitForPresentation(page);
	await finalEditor.getByTestId('slide-thumbnail').first().click();
	await expect(finalEditor.getByTestId('slide-canvas')).toContainText(
		'Source edited without a network'
	);
	await openPresentationSource(finalEditor);
	await expect(finalEditor.getByTestId('slide-source-editor')).toHaveValue(edited);
});

async function renderDiagram(page: Page, source: string, create = true) {
	if (create) {
		await page.getByTestId('welcome-new').click();
		await page.getByTestId('create-note').click();
	}
	await writeSourceContent(page, source);
	await page.locator('[data-mode="read"]').click();
	const svg = page.locator('.mdsh-preview .mermaid-block svg');
	await expect(svg).toBeVisible({ timeout: 20_000 });
	await expect(svg.locator('.node')).toHaveCount(4);
	await expect(svg.locator('.edgePaths path')).toHaveCount(4);
	const geometry = await svg.evaluate((element) => ({
		viewBox: element.getAttribute('viewBox'),
		nodes: [...element.querySelectorAll('.node')].map((node) => ({
			text: node.textContent,
			transform: node.getAttribute('transform')
		})),
		edges: [...element.querySelectorAll('.edgePaths path')].map((edge) => edge.getAttribute('d'))
	}));
	await page.locator('[data-mode="source"]').click();
	await expect
		.poll(async () => (await page.locator('.cm-content .cm-line').allTextContents()).join('\n'))
		.toBe(source);
	await page.locator('[data-mode="read"]').click();
	await expect(svg).toBeVisible();
	return geometry;
}

for (const fixture of elkFixtures)
	test(`${fixture.name} uses the same Dagre geometry online and on first use offline`, async ({
		page,
		browser,
		browserName,
		originServer,
		evidence
	}, info) => {
		await info.attach('elk-request-fixture.md', {
			body: fixture.source,
			contentType: 'text/markdown'
		});
		await info.attach('dagre-reference.md', { body: dagreFixture, contentType: 'text/markdown' });
		const online = await browser.newContext({
			baseURL: originServer.origin,
			locale: 'en-US',
			reducedMotion: 'reduce'
		});
		evidence.observe(online);
		let baseline;
		try {
			const onlinePage = await online.newPage();
			await prepare(onlinePage);
			evidence.phase = 'online-render';
			baseline = await renderDiagram(onlinePage, dagreFixture);
			const requested = await renderDiagram(onlinePage, fixture.source, false);
			await info.attach('dagre-online.json', {
				body: JSON.stringify({ baseline, requested }),
				contentType: 'application/json'
			});
			await info.attach('dagre-online.png', {
				body: await onlinePage.screenshot(),
				contentType: 'image/png'
			});
			expect(requested).toEqual(baseline);
			expect(
				evidence.events.some(
					(event) => event.event === 'request' && String(event.url).endsWith(originServer.elkPath)
				)
			).toBe(false);
		} finally {
			await online.close();
		}
		evidence.phase = 'fresh-offline-installation';
		await prepare(page);
		await disconnect(page, browserName, originServer, evidence);
		const offline = await renderDiagram(page, fixture.source);
		await info.attach('dagre-offline.json', {
			body: JSON.stringify(offline),
			contentType: 'application/json'
		});
		expect(offline).toEqual(baseline);
		expect(
			evidence.events.some(
				(event) => event.event === 'request' && String(event.url).endsWith(originServer.elkPath)
			)
		).toBe(false);
	});

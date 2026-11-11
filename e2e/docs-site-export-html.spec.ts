import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { test, expect, type Download, type Page } from '@playwright/test';
import { resetAppState } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

const DEMO_HTML = [
	'<!doctype html>',
	'<html><body>',
	'<script>window.__htmlDocumentMarker = 1</script>',
	'<p id="demo">Executable demo</p>',
	'</body></html>'
].join('');

const PANEL_HTML = [
	'<!doctype html>',
	'<html><body>',
	'<script>window.__htmlAssetMarker = 1</script>',
	'<p id="asset">Asset document</p>',
	'</body></html>'
].join('');

const README = [
	'# Home',
	'',
	'[Demo](examples/demo.html)',
	'',
	'[Panel](assets/panel.html)',
	''
].join('\n');

const contentTypes: Record<string, string> = {
	'.css': 'text/css; charset=utf-8',
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.png': 'image/png',
	'.svg': 'image/svg+xml',
	'.txt': 'text/plain; charset=utf-8'
};

async function seedProject(page: Page): Promise<void> {
	await resetAppState(page);
	await page.evaluate(
		async (values) => {
			await new Promise<void>((resolvePromise, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const transaction = database.transaction(
						['drafts', 'projects', 'projectAssets'],
						'readwrite'
					);
					transaction.objectStore('drafts').put({
						id: 'home',
						name: 'README.md',
						projectId: 'html-project',
						relativePath: 'README.md',
						content: values.readme,
						kind: 'note',
						order: 0,
						open: true,
						createdAt: 1,
						updatedAt: 1
					});
					transaction.objectStore('drafts').put({
						id: 'demo',
						name: 'demo.html',
						projectId: 'html-project',
						relativePath: 'examples/demo.html',
						content: values.demo,
						kind: 'code',
						order: 1,
						open: true,
						createdAt: 1,
						updatedAt: 1
					});
					transaction.objectStore('projects').put({
						id: 'html-project',
						name: 'HTML project',
						createdAt: 1,
						updatedAt: 1
					});
					const panel = new TextEncoder().encode(values.panel);
					transaction.objectStore('projectAssets').put({
						id: 'panel',
						projectId: 'html-project',
						path: 'assets/panel.html',
						mime: 'text/html',
						data: panel,
						bytes: panel.byteLength
					});
					transaction.oncomplete = () => {
						database.close();
						resolvePromise();
					};
					transaction.onerror = () => reject(transaction.error);
				};
			});
			localStorage.setItem('mdsh:locale', 'en');
			localStorage.setItem('mdsh:mode', 'source');
		},
		{ readme: README, demo: DEMO_HTML, panel: PANEL_HTML }
	);
	await page.reload();
}

async function storedRows(page: Page): Promise<unknown[]> {
	return page.evaluate(
		() =>
			new Promise<unknown[]>((resolvePromise, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const transaction = database.transaction(['drafts', 'projectAssets']);
					const drafts = transaction.objectStore('drafts').getAll();
					const assets = transaction.objectStore('projectAssets').getAll();
					transaction.oncomplete = () => {
						database.close();
						resolvePromise([...drafts.result, ...assets.result]);
					};
					transaction.onerror = () => reject(transaction.error);
				};
			})
	);
}

async function openDocsSitePanel(page: Page): Promise<void> {
	await page.getByTestId('projects-open').click();
	const projects = page.getByRole('dialog', { name: 'Markdown projects' });
	await projects.getByRole('button', { name: 'Export documentation site' }).click();
	await expect(page.getByTestId('docs-site-panel')).toBeVisible();
}

async function extractSite(buffer: Buffer, root: string): Promise<void> {
	const JSZip = (await import('jszip')).default;
	const zip = await JSZip.loadAsync(buffer);
	for (const entry of Object.values(zip.files)) {
		if (entry.dir) continue;
		const path = join(root, entry.name);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, await entry.async('nodebuffer'));
	}
}

function serveSite(root: string): Promise<{ origin: string; server: Server }> {
	const server = createServer(async (request, response) => {
		try {
			const url = new URL(request.url ?? '/', 'http://127.0.0.1');
			const requested = decodeURIComponent(url.pathname.replace(/^\/+/, '') || 'index.html');
			const path = resolve(root, requested);
			const fromRoot = relative(root, path);
			if (!fromRoot || fromRoot.startsWith(`..${sep}`)) throw new Error('outside site');
			if (!(await stat(path)).isFile()) throw new Error('missing file');
			response.writeHead(200, {
				'Content-Type': contentTypes[extname(path).toLowerCase()] ?? 'application/octet-stream'
			});
			response.end(await readFile(path));
		} catch {
			response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
			response.end('not found');
		}
	});
	return new Promise((resolvePromise, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (!address || typeof address === 'string') {
				reject(new Error('No site server port'));
				return;
			}
			resolvePromise({ origin: `http://127.0.0.1:${address.port}/`, server });
		});
	});
}

test('published HTML code documents and assets cannot execute as site pages', async ({
	page,
	browser
}, testInfo) => {
	await seedProject(page);
	const before = await storedRows(page);
	await openDocsSitePanel(page);

	const downloadPromise = page.waitForEvent('download');
	await page.getByTestId('docs-site-run').click();
	const download: Download = await downloadPromise;
	const zipPath = testInfo.outputPath('html-site.zip');
	await download.saveAs(zipPath);

	const zipBuffer = await readFile(zipPath);
	const JSZip = (await import('jszip')).default;
	const zip = await JSZip.loadAsync(zipBuffer);
	const paths = Object.keys(zip.files).filter((path) => !zip.files[path]!.dir);
	expect(paths).not.toContain('examples/demo.html');
	expect(paths).not.toContain('assets/panel.html');
	expect(paths).toContain('examples/demo.html.txt');
	expect(paths).toContain('assets/panel.html.txt');

	await expect(page.getByTestId('docs-site-summary')).toContainText('1 page(s)');
	await expect(page.getByTestId('docs-site-summary')).toContainText('0 error(s)');
	await expect(page.getByTestId('docs-site-summary')).toContainText('2 warning(s)');
	const renamed = page.locator('[data-docs-site-issue][data-code="document-renamed"]');
	await expect(renamed).toHaveCount(2);
	expect(
		await renamed.evaluateAll((elements) =>
			elements.map((element) => element.getAttribute('data-path'))
		)
	).toEqual(['assets/panel.html', 'examples/demo.html']);
	expect(await zip.files['examples/demo.html.txt']!.async('string')).toBe(DEMO_HTML);
	expect(await zip.files['assets/panel.html.txt']!.async('string')).toBe(PANEL_HTML);

	const home = await zip.files['index.html']!.async('string');
	expect(home).toContain('href="examples/demo.html.txt"');
	expect(home).toContain('href="assets/panel.html.txt"');

	const siteRoot = testInfo.outputPath('site');
	await extractSite(zipBuffer, siteRoot);
	const { origin, server } = await serveSite(siteRoot);
	const pageErrors: string[] = [];
	const standalone = await browser.newPage();
	standalone.on('pageerror', (error) => pageErrors.push(error.message));
	try {
		const direct = await standalone.goto(`${origin}examples/demo.html`);
		expect(direct?.status()).toBe(404);

		await standalone.goto(`${origin}examples/demo.html.txt`);
		const published = await standalone.evaluate(() => ({
			marker: (window as unknown as { __htmlDocumentMarker?: number }).__htmlDocumentMarker ?? null,
			assetMarker: (window as unknown as { __htmlAssetMarker?: number }).__htmlAssetMarker ?? null,
			scripts: document.scripts.length,
			text: document.body.textContent ?? ''
		}));
		expect(published.marker).toBeNull();
		expect(published.assetMarker).toBeNull();
		expect(published.scripts).toBe(0);
		expect(published.text).toContain('<script>window.__htmlDocumentMarker = 1</script>');

		await standalone.goto(`${origin}index.html`);
		await standalone.getByRole('link', { name: 'Demo' }).click();
		expect(new URL(standalone.url()).pathname).toBe('/examples/demo.html.txt');
		expect(
			await standalone.evaluate(
				() => (window as unknown as { __htmlDocumentMarker?: number }).__htmlDocumentMarker ?? null
			)
		).toBeNull();
		await standalone.goto(`${origin}index.html`);
		await standalone.getByRole('link', { name: 'Panel' }).click();
		expect(new URL(standalone.url()).pathname).toBe('/assets/panel.html.txt');
		expect(
			await standalone.evaluate(
				() => (window as unknown as { __htmlAssetMarker?: number }).__htmlAssetMarker ?? null
			)
		).toBeNull();
		expect(pageErrors).toEqual([]);
	} finally {
		await standalone.close();
		await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
	}

	const after = await storedRows(page);
	expect(after).toEqual(before);

	const artifactPath = testInfo.outputPath('docs-site-html-artifact.json');
	await writeFile(
		artifactPath,
		`${JSON.stringify(
			{
				command:
					'E2E_PORT=4182 npx playwright test e2e/docs-site-export-html.spec.ts --workers=1 --retries=0 --reporter=line',
				revision: execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim(),
				fixtureSha256: createHash('sha256')
					.update(JSON.stringify({ DEMO_HTML, PANEL_HTML, README }))
					.digest('hex'),
				environment: { node: process.version, browser: browser.browserType().name() },
				result: {
					files: paths,
					renamed: ['examples/demo.html.txt', 'assets/panel.html.txt'],
					directOriginalStatus: 404,
					pageErrors,
					sourceRowsUnchanged: JSON.stringify(after) === JSON.stringify(before)
				}
			},
			null,
			2
		)}\n`,
		'utf8'
	);
	await testInfo.attach('docs-site-html-artifact.json', {
		path: artifactPath,
		contentType: 'application/json'
	});
	await testInfo.attach('html-site.zip', { path: zipPath, contentType: 'application/zip' });
});

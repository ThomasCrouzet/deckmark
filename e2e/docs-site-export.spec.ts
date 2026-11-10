import { execSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test, expect, type Download, type Page, type TestInfo } from '@playwright/test';
import { resetAppState } from './helpers';

const png = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
	'base64'
);

const fixtureDocuments: Record<string, string> = {
	'README.md': [
		'---',
		'title: Home',
		'description: Project overview',
		'---',
		'# Home',
		'',
		'[Guide](notes/guide.md#install)',
		'',
		'![Pixel](assets/pixel.png)',
		'',
		'[External reference](https://example.org/docs)',
		'',
		'![Remote figure](https://example.org/figure.png)',
		''
	].join('\n'),
	'notes/guide.md': [
		'# Guide',
		'',
		'## Install',
		'',
		'[Home](../README.md#home)',
		'',
		'[Details](details.md)',
		'',
		'![Pixel](../assets/pixel.png)',
		'',
		'[[Details]]',
		''
	].join('\n'),
	'notes/details.md': ['# Details', '', '## API', '', '[Back](guide.md#install)', ''].join('\n')
};

const localHosts = new Set(['127.0.0.1', 'localhost']);

async function projectFixture(): Promise<Buffer> {
	const zip = new (await import('jszip')).default();
	for (const [path, content] of Object.entries(fixtureDocuments)) zip.file(path, content);
	zip.file('assets/pixel.png', png);
	return zip.generateAsync({ type: 'nodebuffer' });
}

async function importProject(page: Page, buffer: Buffer): Promise<void> {
	await page.getByTestId('projects-open').click();
	const panel = page.getByRole('dialog', { name: 'Projets Markdown' });
	await panel
		.locator('input[type=file][accept=".zip"]')
		.setInputFiles({ name: 'docs-site-project.zip', mimeType: 'application/zip', buffer });
	await expect(
		panel.getByRole('button', { name: 'Exporter le site de documentation' })
	).toBeVisible();
}

interface StoredDocument {
	id: string;
	content: string;
	updatedAt: number;
	relativePath?: string;
}

async function projectDocuments(page: Page): Promise<StoredDocument[]> {
	return page.evaluate(
		() =>
			new Promise<StoredDocument[]>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const transaction = database.transaction('drafts');
					const all = transaction.objectStore('drafts').getAll();
					transaction.oncomplete = () => {
						database.close();
						resolve(
							(all.result as StoredDocument[])
								.map(({ id, content, updatedAt, relativePath }) => ({
									id,
									content,
									updatedAt,
									...(relativePath === undefined ? {} : { relativePath })
								}))
								.sort((a, b) => (a.relativePath ?? '').localeCompare(b.relativePath ?? ''))
						);
					};
				};
			})
	);
}

async function saveDownload(page: Page, testInfo: TestInfo, name: string): Promise<string> {
	const downloadPromise = page.waitForEvent('download');
	await page.getByTestId('docs-site-run').click();
	const download: Download = await downloadPromise;
	const path = testInfo.outputPath(name);
	await download.saveAs(path);
	return path;
}

async function saveReport(page: Page, testInfo: TestInfo, name: string): Promise<string> {
	const downloadPromise = page.waitForEvent('download');
	await page.getByTestId('docs-site-export-report').click();
	const download: Download = await downloadPromise;
	const path = testInfo.outputPath(name);
	await download.saveAs(path);
	return path;
}

function localTarget(pagePath: string, value: string): string | null {
	const trimmed = value.trim();
	if (!trimmed || trimmed.startsWith('#')) return null;
	if (/^(?:data|mailto|tel|javascript):/i.test(trimmed)) return null;
	if (/^(?:https?:)?\/\//i.test(trimmed)) return null;
	const url = new URL(trimmed, `https://site.test/${pagePath}`);
	return decodeURIComponent(url.pathname.replace(/^\/+/, ''));
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

test('documentation site export produces an offline navigable ZIP', async ({
	page,
	browser
}, testInfo) => {
	await resetAppState(page);
	const externalRequests: string[] = [];
	const capture = (request: { url(): string }) => {
		const url = new URL(request.url());
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
		if (!localHosts.has(url.hostname)) externalRequests.push(request.url());
	};
	page.on('request', capture);

	const fixture = await projectFixture();
	await testInfo.attach('docs-site-project.zip', {
		body: fixture,
		contentType: 'application/zip'
	});
	await importProject(page, fixture);
	const before = await projectDocuments(page);
	await page.getByRole('button', { name: 'Exporter le site de documentation' }).click();

	const panel = page.getByRole('dialog', { name: 'Exporter le site de documentation' });
	await expect(panel).toBeVisible();
	await expect(panel.getByTestId('docs-site-project')).not.toHaveValue('');
	await expect(panel.getByTestId('docs-site-search-toggle')).toBeChecked();

	const zipPath = await saveDownload(page, testInfo, 'docs-site.zip');
	await expect(panel.getByTestId('docs-site-summary')).toContainText('3 page(s)');
	await expect(panel.getByTestId('docs-site-summary')).toContainText('0 erreur(s)');
	await expect(panel.getByTestId('docs-site-summary')).toContainText('2 avertissement(s)');
	const issueCodes = await panel
		.locator('[data-docs-site-issue]')
		.evaluateAll((elements) => elements.map((element) => element.getAttribute('data-code')));
	expect(issueCodes).toEqual(['image-external', 'link-external']);

	const reportPath = await saveReport(page, testInfo, 'docs-site-report.json');
	const reportText = await readFile(reportPath, 'utf8');
	const report = JSON.parse(reportText);
	expect(report).toMatchObject({
		schema: 'mdsh-docs-site/1',
		summary: { pages: 3, assets: 1, errors: 0, warnings: 2, searchIndex: true }
	});
	expect(report.pages.map((entry: { path: string }) => entry.path)).toEqual([
		'index.html',
		'notes/details.html',
		'notes/guide.html'
	]);
	expect(reportText).not.toContain('generatedAt');

	const zipBuffer = await readFile(zipPath);
	const JSZip = (await import('jszip')).default;
	const zip = await JSZip.loadAsync(zipBuffer);
	const paths = Object.keys(zip.files).filter((path) => !zip.files[path]!.dir);
	expect(paths).toEqual([
		'.nojekyll',
		'_mdsh/search-index.js',
		'_mdsh/site.css',
		'_mdsh/site.js',
		'assets/pixel.png',
		'index.html',
		'notes/details.html',
		'notes/guide.html'
	]);

	const resolved: string[] = [];
	for (const pagePath of paths.filter((path) => path.endsWith('.html'))) {
		const html = await zip.files[pagePath]!.async('string');
		for (const match of html.matchAll(/(?:href|src)="([^"]*)"/g)) {
			const value = match[1] ?? '';
			const target = localTarget(pagePath, value);
			if (!target) continue;
			resolved.push(`${pagePath} -> ${target}`);
			expect(paths, `${pagePath} references ${value}`).toContain(target);
		}
	}
	expect(resolved.length).toBeGreaterThan(12);
	expect(resolved).toContain('notes/guide.html -> index.html');
	expect(resolved).toContain('notes/guide.html -> assets/pixel.png');

	const guide = await zip.files['notes/guide.html']!.async('string');
	expect(guide).toContain('href="../index.html#home"');
	expect(guide).toContain('href="details.html"');
	expect(guide).not.toContain('href="#mdsh-wiki-');
	const home = await zip.files['index.html']!.async('string');
	expect(home).toContain('href="notes/guide.html#install"');
	expect(home).toContain('data-mdsh-remote-src="https://example.org/figure.png"');
	expect(home).not.toMatch(/\ssrc="https:\/\/example\.org\/figure\.png"/);
	expect(home).toContain('href="https://example.org/docs"');

	const searchIndex = await zip.files['_mdsh/search-index.js']!.async('string');
	expect(searchIndex).toContain('"schema":"mdsh-docs-site-search/1"');
	expect(searchIndex).toContain('"path":"notes/guide.html"');
	expect(searchIndex).toContain('"title":"Guide"');

	const after = await projectDocuments(page);
	expect(after).toEqual(before);
	expect(externalRequests).toEqual([]);

	const siteRoot = testInfo.outputPath('site');
	await extractSite(zipBuffer, siteRoot);
	const offlinePage = await browser.newPage({ offline: true });
	const offlineRequests: string[] = [];
	offlinePage.on('request', (request) => {
		const url = new URL(request.url());
		if (url.protocol === 'http:' || url.protocol === 'https:') {
			if (!localHosts.has(url.hostname)) offlineRequests.push(request.url());
		}
	});
	await offlinePage.goto(`file://${join(siteRoot, 'index.html')}`);
	await expect(offlinePage.locator('.site-page-header h1')).toHaveText('Home');
	await offlinePage.locator('.site-nav').getByRole('link', { name: 'Guide' }).click();
	await expect(offlinePage.locator('.site-page-header h1')).toHaveText('Guide');
	await expect(offlinePage.locator('.site-content h2#install')).toBeVisible();
	expect(offlineRequests).toEqual([]);
	await offlinePage.close();

	const artifactPath = testInfo.outputPath('docs-site-artifact.json');
	await writeFile(
		artifactPath,
		`${JSON.stringify(
			{
				command:
					'E2E_PORT=4178 npx playwright test e2e/docs-site-export.spec.ts --project=chromium --workers=1 --reporter=line',
				revision: execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim(),
				environment: { node: process.version, browser: 'chromium', locale: 'fr-FR' },
				fixtures: {
					archive: 'docs-site-project.zip',
					documents: Object.keys(fixtureDocuments),
					assets: ['assets/pixel.png']
				},
				result: {
					files: paths,
					links: resolved.length,
					issues: report.issues,
					externalRequests,
					offlineRequests,
					filesUnchanged: JSON.stringify(after) === JSON.stringify(before),
					offlineNavigation: 'index.html -> notes/guide.html'
				}
			},
			null,
			2
		)}\n`,
		'utf8'
	);

	await testInfo.attach('docs-site.zip', { path: zipPath, contentType: 'application/zip' });
	await testInfo.attach('docs-site-report.json', {
		path: reportPath,
		contentType: 'application/json'
	});
	await testInfo.attach('docs-site-artifact.json', {
		path: artifactPath,
		contentType: 'application/json'
	});
});

test('documentation site avoids a user asset that has the internal directory name', async ({
	page,
	browser
}, testInfo) => {
	await resetAppState(page);
	await page.evaluate(async () => {
		await new Promise<void>((resolve, reject) => {
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
					projectId: 'collision-project',
					relativePath: 'README.md',
					content: '# Home\n\n[Internal](_mdsh)\n',
					kind: 'note',
					order: 0,
					open: true,
					createdAt: 1,
					updatedAt: 1
				});
				transaction.objectStore('projects').put({
					id: 'collision-project',
					name: 'Collision project',
					createdAt: 1,
					updatedAt: 1
				});
				transaction.objectStore('projectAssets').put({
					id: 'internal',
					projectId: 'collision-project',
					path: '_mdsh',
					mime: 'application/octet-stream',
					data: Uint8Array.of(1, 2, 3),
					bytes: 3
				});
				transaction.oncomplete = () => {
					database.close();
					resolve();
				};
				transaction.onerror = () => reject(transaction.error);
			};
		});
	});
	await page.reload();
	await page.getByTestId('projects-open').click();
	const projects = page.getByRole('dialog', { name: 'Projets Markdown' });
	await projects.getByRole('button', { name: 'Exporter le site de documentation' }).click();
	const panel = page.getByRole('dialog', { name: 'Exporter le site de documentation' });
	await expect(panel).toBeVisible();

	const zipPath = await saveDownload(page, testInfo, 'collision-site.zip');
	await expect(panel.getByTestId('docs-site-summary')).toContainText('0 erreur(s)');
	const zipBuffer = await readFile(zipPath);
	const JSZip = (await import('jszip')).default;
	const zip = await JSZip.loadAsync(zipBuffer);
	const paths = Object.keys(zip.files).filter((path) => !zip.files[path]!.dir);
	expect(paths).toContain('_mdsh');
	expect(paths).toContain('_mdsh-2/site.css');
	expect(paths).toContain('_mdsh-2/site.js');
	expect(paths).toContain('_mdsh-2/search-index.js');
	expect(paths).not.toContain('_mdsh/site.css');
	expect([...((await zip.files['_mdsh']!.async('uint8array')) ?? [])]).toEqual([1, 2, 3]);

	const siteRoot = testInfo.outputPath('site');
	await extractSite(zipBuffer, siteRoot);
	const stylesheet = await readFile(join(siteRoot, '_mdsh-2/site.css'), 'utf8');
	const script = await readFile(join(siteRoot, '_mdsh-2/site.js'), 'utf8');
	expect(stylesheet).toContain('.site-header');
	expect(script).toContain('[data-site-theme]');

	const offlinePage = await browser.newPage();
	await offlinePage.goto(`file://${join(siteRoot, 'index.html')}`);
	await expect(offlinePage.locator('link[rel=stylesheet]')).toHaveAttribute(
		'href',
		'_mdsh-2/site.css'
	);
	const applied = await offlinePage.evaluate(() => ({
		margin: getComputedStyle(document.body).margin,
		theme: document.documentElement.getAttribute('data-theme')
	}));
	expect(applied.margin).toBe('0px');
	expect(applied.theme).toBeNull();
	await offlinePage.locator('[data-site-theme]').click();
	await expect(offlinePage.locator('html')).toHaveAttribute('data-theme', /dark|light/);
	await offlinePage.close();

	await testInfo.attach('collision-site.zip', { path: zipPath, contentType: 'application/zip' });
	await testInfo.attach('collision-paths.json', {
		body: JSON.stringify({ paths, styleBytes: stylesheet.length, scriptBytes: script.length }),
		contentType: 'application/json'
	});
});

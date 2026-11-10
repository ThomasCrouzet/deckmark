import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test, expect, type Download, type Page } from '@playwright/test';
import { resetAppState } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

const MALICIOUS_SVG = [
	'<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4" onload="window.__svgTestMarker=1">',
	'<script>window.__svgTestMarker=2</script>',
	'<rect width="4" height="4" style="fill:url(https://example.org/paint.svg#p)"/>',
	'</svg>'
].join('');

const SAFE_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="#155e48"/></svg>';

interface Seed {
	readme: string;
	vectorSvg: string;
	logoAsset: string;
}

async function seedProject(page: Page, seed: Seed): Promise<void> {
	await resetAppState(page);
	await page.evaluate(
		async (values) => {
			await new Promise<void>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const db = request.result;
					const tx = db.transaction(['drafts', 'projects', 'projectAssets'], 'readwrite');
					const encoder = new TextEncoder();
					tx.objectStore('drafts').put({
						id: 'home',
						name: 'README.md',
						projectId: 'svg-project',
						relativePath: 'README.md',
						content: values.readme,
						kind: 'note',
						order: 0,
						open: true,
						createdAt: 1,
						updatedAt: 1
					});
					tx.objectStore('drafts').put({
						id: 'vector',
						name: 'vector.svg',
						projectId: 'svg-project',
						relativePath: 'assets/vector.svg',
						content: values.vectorSvg,
						kind: 'code',
						order: 1,
						open: true,
						createdAt: 1,
						updatedAt: 1
					});
					tx.objectStore('projects').put({
						id: 'svg-project',
						name: 'SVG project',
						createdAt: 1,
						updatedAt: 1
					});
					const logo = encoder.encode(values.logoAsset);
					tx.objectStore('projectAssets').put({
						id: 'logo',
						projectId: 'svg-project',
						path: 'assets/logo.svg',
						mime: 'image/svg+xml',
						data: logo,
						bytes: logo.byteLength
					});
					tx.oncomplete = () => {
						db.close();
						resolve();
					};
					tx.onerror = () => reject(tx.error);
				};
			});
			localStorage.setItem('mdsh:locale', 'en');
			localStorage.setItem('mdsh:mode', 'source');
		},
		{ readme: seed.readme, vectorSvg: seed.vectorSvg, logoAsset: seed.logoAsset }
	);
	await page.reload();
}

async function openDocsSitePanel(page: Page): Promise<void> {
	await page.getByTestId('projects-open').click();
	const projects = page.getByRole('dialog', { name: 'Markdown projects' });
	await projects.getByRole('button', { name: 'Export documentation site' }).click();
	await expect(page.getByTestId('docs-site-panel')).toBeVisible();
}

async function storedRows(page: Page): Promise<unknown[]> {
	return page.evaluate(
		() =>
			new Promise<unknown[]>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const db = request.result;
					const transaction = db.transaction(['drafts', 'projectAssets']);
					const drafts = transaction.objectStore('drafts').getAll();
					const assets = transaction.objectStore('projectAssets').getAll();
					transaction.oncomplete = () => {
						db.close();
						resolve([...drafts.result, ...assets.result]);
					};
					transaction.onerror = () => reject(transaction.error);
				};
			})
	);
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

test('published SVG code documents and assets cannot execute as standalone documents', async ({
	page,
	browser
}, testInfo) => {
	await seedProject(page, {
		readme: '# Home\n\n[Vector](assets/vector.svg)\n\n![Logo](assets/logo.svg)\n',
		vectorSvg: MALICIOUS_SVG,
		logoAsset: MALICIOUS_SVG
	});
	const before = await storedRows(page);
	await openDocsSitePanel(page);

	const downloadPromise = page.waitForEvent('download');
	await page.getByTestId('docs-site-run').click();
	const download: Download = await downloadPromise;
	const zipPath = testInfo.outputPath('svg-site.zip');
	await download.saveAs(zipPath);
	await expect(page.getByTestId('docs-site-summary')).toContainText('1 page(s)');
	await expect(page.getByTestId('docs-site-summary')).toContainText('0 error(s)');

	const zipBuffer = await readFile(zipPath);
	const JSZip = (await import('jszip')).default;
	const zip = await JSZip.loadAsync(zipBuffer);
	for (const path of ['assets/vector.svg', 'assets/logo.svg']) {
		const published = await zip.files[path]!.async('string');
		expect(published, path).not.toContain('onload');
		expect(published, path).not.toContain('<script');
		expect(published, path).not.toContain('example.org');
		expect(published, path).toContain('<rect');
		expect(published, path).toContain('width="4"');
	}

	const siteRoot = testInfo.outputPath('site');
	await extractSite(zipBuffer, siteRoot);
	const externalRequests: string[] = [];
	const standalone = await browser.newPage();
	standalone.on('request', (request) => {
		const url = new URL(request.url());
		if (url.protocol === 'http:' || url.protocol === 'https:') externalRequests.push(request.url());
	});
	await standalone.goto(`file://${join(siteRoot, 'assets/vector.svg')}`);
	const standaloneState = await standalone.evaluate(() => ({
		marker: (window as unknown as { __svgTestMarker?: number }).__svgTestMarker ?? null,
		width: document.documentElement.getAttribute('width'),
		scripts: document.scripts.length,
		eventHandlers: Array.from(document.querySelectorAll('svg')).map((node) =>
			node.getAttribute('onload')
		)
	}));
	expect(standaloneState.marker).toBeNull();
	expect(standaloneState.scripts).toBe(0);
	expect(standaloneState.eventHandlers).toEqual([null]);
	expect(standaloneState.width).toBe('4');
	await standalone.goto(`file://${join(siteRoot, 'index.html')}`);
	const imageState = await standalone.evaluate(async () => {
		const image = document.createElement('img');
		image.src = 'assets/vector.svg';
		document.body.append(image);
		await new Promise<void>((resolve, reject) => {
			image.onload = () => resolve();
			image.onerror = () => reject(new Error('The published SVG did not load as an image'));
		});
		return { width: image.naturalWidth, height: image.naturalHeight };
	});
	expect(imageState).toEqual({ width: 4, height: 4 });
	expect(externalRequests).toEqual([]);
	await standalone.close();

	const after = await storedRows(page);
	expect(after).toEqual(before);

	const artifactPath = testInfo.outputPath('docs-site-svg-artifact.json');
	await writeFile(
		artifactPath,
		`${JSON.stringify(
			{
				command:
					'E2E_PORT=4179 npx playwright test e2e/docs-site-export-svg.spec.ts --workers=1 --retries=0 --reporter=line',
				revision: execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim(),
				fixtureSha256: createHash('sha256')
					.update(JSON.stringify({ MALICIOUS_SVG, SAFE_SVG }))
					.digest('hex'),
				environment: { node: process.version, browser: browser.browserType().name() },
				result: {
					files: Object.keys(zip.files).filter((path) => !zip.files[path]!.dir),
					standaloneState,
					imageState,
					externalRequests,
					sourceRowsUnchanged: JSON.stringify(after) === JSON.stringify(before)
				}
			},
			null,
			2
		)}\n`,
		'utf8'
	);
	await testInfo.attach('docs-site-svg-artifact.json', {
		path: artifactPath,
		contentType: 'application/json'
	});
});

test('an unsafe SVG code document blocks the published ZIP', async ({ page }, testInfo) => {
	await seedProject(page, {
		readme: '# Home\n\n[Broken](assets/vector.svg)\n',
		vectorSvg: 'not an SVG document',
		logoAsset: SAFE_SVG
	});
	await openDocsSitePanel(page);

	const downloads: string[] = [];
	page.on('download', (download) => downloads.push(download.suggestedFilename()));
	await page.getByTestId('docs-site-run').click();
	await expect(page.getByTestId('docs-site-summary')).toContainText('1 error(s)');
	await expect(page.getByText('Export stopped before the ZIP file was written.')).toBeVisible();
	const issue = page.locator('[data-docs-site-issue][data-code="asset-unsafe"]');
	await expect(issue).toHaveCount(1);
	await expect(issue).toHaveAttribute('data-path', 'assets/vector.svg');
	expect(downloads).toEqual([]);

	await testInfo.attach('docs-site-svg-rejection.json', {
		body: JSON.stringify({ downloads, code: 'asset-unsafe', path: 'assets/vector.svg' }),
		contentType: 'application/json'
	});
});

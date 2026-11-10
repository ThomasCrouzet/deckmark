import { execSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test, expect, type Download, type Page, type TestInfo } from '@playwright/test';
import { resetAppState } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

const documents = {
	'README.md': [
		'# Home',
		'',
		'## Install Guide',
		'',
		'[Encoded same page](#install%2Dguide)',
		'',
		'[Encoded cross page](guide.md#install%2Dguide)',
		'',
		'[Repeated escape](guide.md#install%252Dguide)',
		'',
		'[Absent anchor](guide.md#missing%2Danchor)',
		''
	].join('\n'),
	'guide.md': ['# Guide', '', '## Install Guide', ''].join('\n')
};

async function seedProject(page: Page): Promise<void> {
	await resetAppState(page);
	await page.evaluate(async (fixture) => {
		await new Promise<void>((resolve, reject) => {
			const request = indexedDB.open('mdsh');
			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				const db = request.result;
				const tx = db.transaction(['drafts', 'projects'], 'readwrite');
				const drafts = tx.objectStore('drafts');
				for (const [relativePath, content] of Object.entries(fixture)) {
					drafts.put({
						id: relativePath,
						name: relativePath,
						projectId: 'fragment-project',
						relativePath,
						content,
						kind: 'note',
						order: 0,
						open: true,
						createdAt: 1,
						updatedAt: 1
					});
				}
				tx.objectStore('projects').put({
					id: 'fragment-project',
					name: 'Fragment project',
					createdAt: 1,
					updatedAt: 1
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
	}, documents);
	await page.reload();
}

async function openDocsSitePanel(page: Page): Promise<void> {
	await page.getByTestId('projects-open').click();
	const projects = page.getByRole('dialog', { name: 'Markdown projects' });
	await projects.getByRole('button', { name: 'Export documentation site' }).click();
	await expect(page.getByTestId('docs-site-panel')).toBeVisible();
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

test('documentation site decodes escaped fragments once and keeps navigation', async ({
	page,
	browser
}, testInfo) => {
	await seedProject(page);
	const before = await page.evaluate(
		() =>
			new Promise<string>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const db = request.result;
					const transaction = db.transaction('drafts');
					const rows = transaction.objectStore('drafts').getAll();
					transaction.oncomplete = () => {
						db.close();
						resolve(JSON.stringify(rows.result));
					};
					transaction.onerror = () => reject(transaction.error);
				};
			})
	);
	await openDocsSitePanel(page);

	const zipPath = await saveDownload(page, testInfo, 'fragment-site.zip');
	await expect(page.getByTestId('docs-site-summary')).toContainText('2 page(s)');
	await expect(page.getByTestId('docs-site-summary')).toContainText('0 error(s)');
	await expect(page.getByTestId('docs-site-summary')).toContainText('2 warning(s)');

	const reportPath = await saveReport(page, testInfo, 'fragment-report.json');
	const report = JSON.parse(await readFile(reportPath, 'utf8'));
	const anchors = report.issues
		.filter((issue: { code: string }) => issue.code === 'anchor-missing')
		.map((issue: { target: string; message: string }) => [issue.target, issue.message]);
	expect(anchors).toEqual([
		['guide.md#install%252Dguide', 'Missing anchor "install%2Dguide".'],
		['guide.md#missing%2Danchor', 'Missing anchor "missing-anchor".']
	]);

	const zipBuffer = await readFile(zipPath);
	const JSZip = (await import('jszip')).default;
	const zip = await JSZip.loadAsync(zipBuffer);
	const home = await zip.files['index.html']!.async('string');
	expect(home).toContain('href="#install%2Dguide"');
	expect(home).toContain('href="guide.html#install%2Dguide"');
	expect(home).toContain('href="guide.html#install%252Dguide"');

	const siteRoot = testInfo.outputPath('site');
	await extractSite(zipBuffer, siteRoot);
	const offlinePage = await browser.newPage();
	await offlinePage.goto(`file://${join(siteRoot, 'index.html')}`);
	await offlinePage.getByRole('link', { name: 'Encoded same page' }).click();
	await expect(offlinePage.locator('h2#install-guide')).toBeVisible();
	await offlinePage.getByRole('link', { name: 'Encoded cross page' }).click();
	await expect(offlinePage.locator('.site-page-header h1')).toHaveText('Guide');
	await expect(offlinePage.locator('h2#install-guide')).toBeVisible();
	await offlinePage.close();

	const after = await page.evaluate(
		() =>
			new Promise<string>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const db = request.result;
					const transaction = db.transaction('drafts');
					const rows = transaction.objectStore('drafts').getAll();
					transaction.oncomplete = () => {
						db.close();
						resolve(JSON.stringify(rows.result));
					};
					transaction.onerror = () => reject(transaction.error);
				};
			})
	);
	expect(after).toBe(before);

	const artifactPath = testInfo.outputPath('docs-site-fragment-artifact.json');
	await writeFile(
		artifactPath,
		`${JSON.stringify(
			{
				command:
					'E2E_PORT=4180 npx playwright test e2e/docs-site-fragments.spec.ts --workers=1 --retries=0 --reporter=line',
				revision: execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim(),
				environment: { node: process.version, browser: browser.browserType().name() },
				fixtures: documents,
				result: {
					anchors,
					homeLinks: [
						'href="#install%2Dguide"',
						'href="guide.html#install%2Dguide"',
						'href="guide.html#install%252Dguide"'
					],
					navigation: ['index.html#install-guide', 'guide.html#install-guide'],
					sourceUnchanged: after === before
				}
			},
			null,
			2
		)}\n`,
		'utf8'
	);
	await testInfo.attach('docs-site-fragment-artifact.json', {
		path: artifactPath,
		contentType: 'application/json'
	});
});

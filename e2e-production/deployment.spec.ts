import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { switchToSource, writeSourceContent } from '../e2e/helpers';
import { testSource } from '../scripts/test-source.mjs';

const fixture = '# Deployment check\n\nThis local draft must remain available offline.';

test('serves the expected Web release and keeps a draft offline', async ({
	page,
	request,
	context,
	browser,
	baseURL
}, testInfo) => {
	if (!baseURL) throw new Error('The deployment project must set baseURL.');
	const expectedSha: unknown = testInfo.config.metadata.expectedSha;
	const expectedVersion: unknown = testInfo.config.metadata.expectedVersion;
	const expectedBasePath: unknown = testInfo.project.metadata.expectedBasePath;
	if (
		typeof expectedSha !== 'string' ||
		typeof expectedVersion !== 'string' ||
		typeof expectedBasePath !== 'string'
	) {
		throw new Error('The deployment configuration must set the expected release metadata.');
	}
	const source = testSource(testInfo.outputPath('source'));
	await testInfo.attach('run.json', {
		body: JSON.stringify({ ...source, browserVersion: browser.version(), baseURL, expectedSha }),
		contentType: 'application/json'
	});
	await testInfo.attach('working.diff', {
		path: testInfo.outputPath('source', 'working.diff'),
		contentType: 'text/plain'
	});
	await testInfo.attach('fixture.md', { body: fixture, contentType: 'text/markdown' });

	const expectedHtmlSha = await test.step('Check the normal metadata URL', async () => {
		const editionURL = new URL('edition.json', baseURL).href;
		const response = await request.get(editionURL, { timeout: 30_000 });
		const body = await response.text();
		await testInfo.attach('edition-response.json', {
			body: JSON.stringify({
				requestedURL: editionURL,
				finalURL: response.url(),
				status: response.status(),
				headers: response.headers(),
				body
			}),
			contentType: 'application/json'
		});
		expect.soft(response.status()).toBe(200);
		expect.soft(response.url()).toBe(editionURL);
		expect.soft(response.headers()['content-type']).toMatch(/^application\/json(?:\s*;|$)/i);
		let edition: unknown;
		try {
			edition = JSON.parse(body);
		} catch {
			expect.soft(false, 'The edition response must be valid JSON.').toBe(true);
			return;
		}
		expect.soft(edition).toMatchObject({
			format: 'mdsh-edition',
			schemaVersion: 1,
			edition: 'web',
			version: expectedVersion,
			basePath: expectedBasePath,
			sourceSha: expectedSha,
			htmlSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
			features: expect.any(Array),
			excluded: expect.any(Array)
		});
		if (
			typeof edition === 'object' &&
			edition !== null &&
			'htmlSha256' in edition &&
			typeof edition.htmlSha256 === 'string'
		) {
			return edition.htmlSha256;
		}
	});

	await test.step('Open the normal page URL and edit a note', async () => {
		const response = await page.goto(baseURL);
		expect.soft(response?.status()).toBe(200);
		expect.soft(page.url()).toBe(baseURL);
		if (!response) throw new Error('The page navigation must return an HTML response.');
		const html = await response.body();
		const htmlSha256 = createHash('sha256').update(html).digest('hex');
		await testInfo.attach('page-response.json', {
			body: JSON.stringify({
				requestedURL: baseURL,
				finalURL: page.url(),
				status: response.status(),
				headers: response.headers(),
				htmlSha256,
				expectedHtmlSha
			}),
			contentType: 'application/json'
		});
		await testInfo.attach('page.html', { body: html, contentType: 'text/html' });
		expect.soft(htmlSha256, 'The page HTML must match the expected release.').toBe(expectedHtmlSha);
		await expect(page.locator('.mdsh-shell[aria-busy="false"]:not([inert])')).toBeVisible();
		await page.getByTestId('welcome-new').click();
		await page.getByTestId('create-note').click();
		await expect(page.locator('input[aria-label^="File name"]')).toBeVisible();
		await writeSourceContent(page, fixture);
		await expect(page.locator('#app-statusbar')).toContainText('Local drafts: saved');
		await page.locator('button[data-mode="read"]').click();
		await expect(page.locator('.mdsh-preview').getByRole('heading', { level: 1 })).toHaveText(
			'Deployment check'
		);
		await expect(page.locator('.mdsh-preview')).toContainText(
			'This local draft must remain available offline.'
		);
	});

	await test.step('Reload offline and verify the saved source', async () => {
		await expect(page.getByText('Ready offline', { exact: true })).toBeVisible({
			timeout: 45_000
		});
		await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
		await page.reload();
		await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
		await expect(page.locator('.mdsh-shell[aria-busy="false"]:not([inert])')).toBeVisible();
		await context.setOffline(true);
		await page.reload();
		expect(page.url()).toBe(baseURL);
		await expect(page.locator('.mdsh-shell[aria-busy="false"]:not([inert])')).toBeVisible();
		await switchToSource(page);
		await expect
			.poll(() =>
				page.locator('.cm-content').evaluate((element) =>
					Array.from(element.querySelectorAll('.cm-line'))
						.map((line) => line.textContent ?? '')
						.join('\n')
				)
			)
			.toBe(fixture);
		await expect(page.locator('#app-statusbar')).toContainText('Local drafts: saved');
		await testInfo.attach('offline-draft.png', {
			body: await page.screenshot(),
			contentType: 'image/png'
		});
	});
});

import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resetAppState, seedFiles, openPalette, writeSourceContent } from './helpers';

test.describe('Exports MD / HTML / PDF', () => {
	test.beforeEach(async ({ page }) => {
		await resetAppState(page);
	});

	test('exports Markdown from the toolbar', async ({ page }) => {
		await seedFiles(page, [{ name: 'demo', content: '# Demo\n\nContenu.\n' }]);
		const downloadPromise = page.waitForEvent('download');
		await page.getByRole('button', { name: 'Exporter' }).first().click();
		const download = await downloadPromise;
		expect(download.suggestedFilename()).toMatch(/\.md$/);
	});

	test('exports HTML from the command palette', async ({ page }) => {
		await seedFiles(page, [
			{
				name: 'demo',
				content: '## test défaut c.a.c\n\n- [ ] Case non cochée\n- [X] Case cochée\n'
			}
		]);
		await openPalette(page);
		await page.keyboard.type('Exporter en HTML');
		const downloadPromise = page.waitForEvent('download');
		await page.keyboard.press('Enter');
		const download = await downloadPromise;
		expect(download.suggestedFilename()).toMatch(/\.html$/);

		const downloadPath = await download.path();
		expect(downloadPath).not.toBeNull();
		if (!downloadPath) throw new Error('Le fichier HTML exporté est introuvable');
		const html = await readFile(downloadPath, 'utf8');

		expect(html).toContain('<ul class="contains-task-list">');
		expect(html.match(/<li class="task-list-item">/g)).toHaveLength(2);
		expect(html).toMatch(/li\.task-list-item\s*\{[^}]*list-style:\s*none;/s);
		expect(html).not.toContain('class="mdsh-anchor"');
	});

	test('keeps math in the HTML export available offline', async ({ page, browser }, testInfo) => {
		await seedFiles(page, [{ name: 'offline-math', content: '# Math\n\n$e^{i\\pi}+1=0$\n' }]);
		await openPalette(page);
		await page.keyboard.type('Exporter en HTML');
		const downloadPromise = page.waitForEvent('download');
		await page.keyboard.press('Enter');
		const download = await downloadPromise;
		const downloadPath = testInfo.outputPath('offline-math.html');
		await download.saveAs(downloadPath);
		const html = await readFile(downloadPath, 'utf8');
		expect(html).toContain('data:font/woff2;base64,');
		expect(html).not.toMatch(/url\([^)]*(?:https?:|\/katex\/fonts)/i);

		const context = await browser.newContext({ offline: true });
		const offlinePage = await context.newPage();
		const requests: string[] = [];
		offlinePage.on('request', (request) => {
			if (!request.url().startsWith('file:') && !request.url().startsWith('data:')) {
				requests.push(request.url());
			}
		});
		await offlinePage.goto(pathToFileURL(downloadPath).href);
		await expect(offlinePage.locator('.katex')).toBeVisible();
		expect(requests).toEqual([]);
		await context.close();
	});

	test('reuses standalone assets across HTML exports without caching document content', async ({
		page
	}, testInfo) => {
		await seedFiles(page, [{ name: 'asset-reuse', content: '# Math\n\n$e^{i\\pi}+1=0$\n' }]);
		const assetRequests: string[] = [];
		page.on('request', (request) => {
			const url = request.url();
			if (/\/print\/print\.css$/.test(url) || /\/katex\//.test(url)) assetRequests.push(url);
		});

		const exportHtml = async (name: string) => {
			await openPalette(page);
			await page.keyboard.type('Exporter en HTML');
			const before = assetRequests.length;
			const downloadPromise = page.waitForEvent('download');
			await page.keyboard.press('Enter');
			const download = await downloadPromise;
			const output = testInfo.outputPath(name);
			await download.saveAs(output);
			return { html: await readFile(output, 'utf8'), fetched: assetRequests.length - before };
		};

		const first = await exportHtml('asset-reuse-first.html');
		expect(first.fetched).toBeGreaterThan(0);
		expect(first.html).toContain('data:font/woff2;base64,');
		expect(first.html).toMatch(/<meta http-equiv="Content-Security-Policy"/);
		expect(first.html).toMatch(/script-src 'none'/);

		const second = await exportHtml('asset-reuse-second.html');
		expect(second.fetched).toBe(0);
		expect(second.html).toBe(first.html);

		await writeSourceContent(page, '# Math edited\n\n$e^{i\\pi}+2=1$\n');
		const third = await exportHtml('asset-reuse-third.html');
		expect(third.html).toContain('Math edited');
		expect(third.html).not.toBe(first.html);
		expect(third.fetched).toBe(0);
	});

	test('real PDF contains author content only', async ({ page, browser }, testInfo) => {
		let capturedHtml = '';
		await page.exposeFunction('capturePrintHtml', (html: string) => {
			capturedHtml = html;
		});
		await page.evaluate(() => {
			const capture = (
				globalThis as typeof globalThis & {
					capturePrintHtml: (html: string) => Promise<void>;
				}
			).capturePrintHtml;
			const observer = new MutationObserver((records) => {
				for (const record of records) {
					for (const node of record.addedNodes) {
						if (!(node instanceof HTMLIFrameElement) || !node.contentWindow) continue;
						node.contentWindow.print = () => {
							const html = node.contentDocument?.documentElement.outerHTML ?? '';
							void capture(html);
						};
					}
				}
			});
			observer.observe(document.body, { childList: true, subtree: true });
		});

		await seedFiles(page, [
			{
				name: 'filename-must-not-render',
				content:
					'---\ntitle: Front matter must not render\n---\n# Author title\n\nMath: $e^{i\\pi}+1=0$\n\n```mermaid\ngraph LR\nA --> B\n```\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n![Local image](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=)\n\n' +
					'Author paragraph for pagination.\n\n'.repeat(120)
			}
		]);
		await page.getByRole('button', { name: 'Exporter en PDF' }).click();
		await expect.poll(() => capturedHtml.length).toBeGreaterThan(100);

		const printableBody = /<main class="print-body">([\s\S]*)<\/main>/.exec(capturedHtml)?.[1];
		expect(printableBody).toBeTruthy();
		expect(printableBody).not.toContain('print-header');
		expect(printableBody).not.toContain('filename-must-not-render');
		expect(printableBody).not.toContain('Front matter must not render');
		expect(printableBody?.match(/<h1(?:\s|>)/g)).toHaveLength(1);
		expect(printableBody).toContain('<svg');
		expect(printableBody).toContain('<img');

		const pdfPage = await browser.newPage();
		await pdfPage.goto(page.url());
		await pdfPage.setContent(capturedHtml, { waitUntil: 'networkidle' });
		await expect
			.poll(() => pdfPage.evaluate(() => getComputedStyle(document.body).paddingTop))
			.not.toBe('0px');
		const pdfPath = testInfo.outputPath('content-only.pdf');
		await pdfPage.pdf({
			path: pdfPath,
			format: 'A4',
			displayHeaderFooter: false,
			printBackground: true
		});
		await pdfPage.close();
		await testInfo.attach('content-only-pdf', { path: pdfPath, contentType: 'application/pdf' });
		const bytes = await readFile(pdfPath);
		expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
		expect(bytes.length).toBeGreaterThan(10_000);
	});
});

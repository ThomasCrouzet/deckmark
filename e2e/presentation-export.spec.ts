import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resetAppState } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

const imagePath = resolve('static/pwa-192x192.png');

async function resetEnglishApp(page: Page): Promise<void> {
	await resetAppState(page);
	await page.evaluate(() => localStorage.setItem('mdsh:locale', 'en'));
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
}

async function openPresentation(page: Page): Promise<Locator> {
	await page.getByTestId('slides-open').click();
	const editor = page.getByTestId('presentation-editor');
	await expect(editor).toBeVisible({ timeout: 15_000 });
	return editor;
}

async function addText(editor: Locator, markdown: string): Promise<void> {
	await editor.getByTestId('slide-add-text').click();
	const text = editor.locator('[data-testid="slide-object"][data-object-type="text"]').last();
	await text.dblclick();
	await editor.getByTestId('slide-text-editor').fill(markdown);
	await editor.getByTestId('slide-text-done').click();
}

async function createExportDeck(page: Page): Promise<Locator> {
	const editor = await openPresentation(page);
	await editor.getByTestId('slide-title').fill('Offline launch deck');
	await addText(editor, '# Opening slide\n\nFirst exported page.');
	await editor.getByTestId('slide-add-rectangle').click();
	await editor.locator('[data-testid="slide-object"][data-object-type="rectangle"]').dblclick();
	await editor.getByTestId('slide-text-editor').fill('**Launch block**');
	await editor.getByTestId('slide-text-done').click();
	await editor.getByTestId('slide-background').fill('#fef3c7');

	await editor.getByTestId('slide-add').click();
	await addText(editor, '# Image slide\n\nEmbedded pixels.');
	const chooser = page.waitForEvent('filechooser');
	await editor.getByTestId('slide-add-image').click();
	await (await chooser).setFiles(imagePath);
	await expect(
		editor.getByTestId('slide-canvas').locator('.mdsh-slide-element-image img')
	).toHaveJSProperty('naturalWidth', 192);

	await editor.getByTestId('slide-add').click();
	await addText(editor, '# Closing slide\n\nLast exported page.');
	await editor.getByTestId('slide-add-arrow').click();
	await editor.getByTestId('slide-notes').fill('Notes must not enter exported pages.');
	await expect(editor.getByTestId('slide-thumbnail')).toHaveCount(3);
	return editor;
}

async function saveDownload(
	page: Page,
	action: () => Promise<void>,
	path: string
): Promise<string> {
	const pending = page.waitForEvent('download');
	await action();
	const download = await pending;
	await download.saveAs(path);
	return download.suggestedFilename();
}

async function inspectOfflineHtml(
	browser: Browser,
	path: string
): Promise<{ requests: string[]; slideCount: number; counter: string }> {
	const context = await browser.newContext({ locale: 'en-US' });
	const requests: string[] = [];
	const fixtureUrl = 'https://presentation-export.invalid/offline-launch-deck.html';
	const html = await readFile(path, 'utf8');
	try {
		await context.route('**/*', async (route) => {
			if (route.request().url() === fixtureUrl) {
				await route.fulfill({ status: 200, contentType: 'text/html', body: html });
				return;
			}
			requests.push(route.request().url());
			await route.abort('internetdisconnected');
		});
		const page = await context.newPage();
		await page.goto(fixtureUrl);
		const presentation = page.locator('main.mdsh-presentation');
		await expect(presentation).toBeVisible();
		const slides = presentation.locator('section.mdsh-slide[data-slide-index]');
		await expect(slides).toHaveCount(3);
		await expect(slides.nth(0)).toBeVisible();
		await expect(page.getByText('Opening slide', { exact: true })).toBeVisible();
		await expect(page.getByText('Launch block', { exact: true })).toBeVisible();
		await page.keyboard.press('ArrowRight');
		await expect(page.getByText('Image slide', { exact: true })).toBeVisible();
		await expect(page.locator('img')).toHaveJSProperty('naturalWidth', 192);
		await page.keyboard.press('PageDown');
		await expect(page.getByText('Closing slide', { exact: true })).toBeVisible();
		await page.keyboard.press('Home');
		await expect(page.getByText('Opening slide', { exact: true })).toBeVisible();
		await page.keyboard.press('End');
		await expect(page.getByText('Closing slide', { exact: true })).toBeVisible();
		await expect(page.getByText('Notes must not enter exported pages.')).toHaveCount(0);
		const counter = await page.locator('.mdsh-slide-counter').innerText();
		await page.emulateMedia({ media: 'print' });
		for (const slide of await slides.all()) await expect(slide).toBeVisible();
		await expect(page.locator('.mdsh-slide-counter')).toBeHidden();
		return { requests, slideCount: await slides.count(), counter };
	} finally {
		await context.close();
	}
}

async function capturePrintDocument(page: Page): Promise<() => string> {
	let captured = '';
	await page.exposeFunction('capturePresentationPrint', (html: string) => {
		captured = html;
	});
	await page.evaluate(() => {
		const capture = (
			globalThis as typeof globalThis & {
				capturePresentationPrint: (html: string) => Promise<void>;
			}
		).capturePresentationPrint;
		new MutationObserver((records) => {
			for (const record of records) {
				for (const node of record.addedNodes) {
					if (!(node instanceof HTMLIFrameElement) || !node.contentWindow) continue;
					node.contentWindow.print = () => {
						void capture(node.contentDocument?.documentElement.outerHTML ?? '');
					};
				}
			}
		}).observe(document.body, { childList: true, subtree: true });
	});
	return () => captured;
}

function pdfPageCount(source: string): number {
	return source.match(/\/Type\s*\/Page\b/g)?.length ?? 0;
}

function pdfPageRatios(source: string): number[] {
	return [
		...source.matchAll(/\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/g)
	].map((match) => {
		const width = Number(match[3]) - Number(match[1]);
		const height = Number(match[4]) - Number(match[2]);
		return width / height;
	});
}

test.beforeEach(async ({ page }) => {
	await resetEnglishApp(page);
});

test('downloads a standalone presentation that works offline', async ({
	page,
	browser
}, testInfo) => {
	const editor = await createExportDeck(page);
	const output = testInfo.outputPath('offline-launch-deck.html');
	const filename = await saveDownload(
		page,
		() => editor.getByTestId('slide-export-html').click(),
		output
	);
	expect(filename).toMatch(/offline-launch-deck\.html$/i);
	const html = await readFile(output, 'utf8');
	expect(html).toContain('main class="mdsh-presentation"');
	expect(html).toContain('data:image/png;base64,');
	expect(html).not.toMatch(/<(?:link|script)[^>]+(?:src|href)=["']https?:/i);
	expect(html).not.toContain('Notes must not enter exported pages.');

	const inspection = await inspectOfflineHtml(browser, output);
	expect(inspection.requests).toEqual([]);
	expect(inspection.slideCount).toBe(3);
	expect(inspection.counter).toMatch(/3\s*\/\s*3/);
	await testInfo.attach('presentation-offline-html', { path: output, contentType: 'text/html' });
	await testInfo.attach('presentation-offline-html.json', {
		body: JSON.stringify(
			{
				command: 'npm run test:e2e -- presentation-export.spec.ts --project=chromium --workers=1',
				project: testInfo.project.name,
				fixture: { slides: 3, aspect: '16:9', embeddedImage: 'pwa-192x192.png' },
				filename,
				inspection
			},
			null,
			2
		),
		contentType: 'application/json'
	});
});

test('prints exactly one fixed-ratio PDF page for each slide', async ({
	page,
	browser,
	browserName
}, testInfo) => {
	test.skip(browserName !== 'chromium', 'Playwright PDF output requires Chromium');
	const editor = await createExportDeck(page);
	const captured = await capturePrintDocument(page);
	await editor.getByTestId('slide-export-pdf').click();
	await expect.poll(() => captured().length).toBeGreaterThan(100);
	const printHtml = captured();
	expect(printHtml).not.toContain('Notes must not enter exported pages.');

	const printable = await browser.newPage();
	const pdfPath = testInfo.outputPath('three-slides.pdf');
	try {
		await printable.setContent(printHtml, { waitUntil: 'networkidle' });
		await printable.emulateMedia({ media: 'print' });
		const slides = printable.locator('section.mdsh-slide[data-slide-index]');
		await expect(slides).toHaveCount(3);
		await expect(printable.getByText('Launch block', { exact: true })).toBeVisible();
		for (const slide of await slides.all()) {
			await expect(slide).toBeVisible();
			const overflow = await slide.evaluate((node) => ({
				horizontal: node.scrollWidth - node.clientWidth,
				vertical: node.scrollHeight - node.clientHeight
			}));
			expect(overflow.horizontal).toBeLessThanOrEqual(1);
			expect(overflow.vertical).toBeLessThanOrEqual(1);
		}
		await printable.pdf({
			path: pdfPath,
			preferCSSPageSize: true,
			displayHeaderFooter: false,
			printBackground: true
		});
	} finally {
		await printable.close();
	}
	const bytes = await readFile(pdfPath);
	expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
	const source = bytes.toString('latin1');
	const pageCount = pdfPageCount(source);
	const pageRatios = pdfPageRatios(source);
	expect(pageCount).toBe(3);
	expect(pageRatios.length).toBeGreaterThan(0);
	for (const ratio of pageRatios) expect(Math.abs(ratio - 16 / 9)).toBeLessThan(0.02);

	await testInfo.attach('presentation-print.html', { body: printHtml, contentType: 'text/html' });
	await testInfo.attach('presentation-pdf', { path: pdfPath, contentType: 'application/pdf' });
	await testInfo.attach('presentation-pdf.json', {
		body: JSON.stringify(
			{
				command: 'npm run test:e2e -- presentation-export.spec.ts --project=chromium --workers=1',
				project: testInfo.project.name,
				fixture: { slides: 3, aspect: '16:9' },
				pageCount,
				pageRatios
			},
			null,
			2
		),
		contentType: 'application/json'
	});
});

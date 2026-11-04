import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { resetAppState } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce', channel: 'chromium' });

async function expectRenderedPdf(page: Page) {
	const url = await page.getByTestId('pdf-frame').getAttribute('src');
	// Chromium puts its PDF renderer in a child extension frame.
	const findViewer = () =>
		page
			.frames()
			.find(
				(frame) =>
					frame.parentFrame()?.url() === url &&
					frame.url() === 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html'
			);
	await expect.poll(() => Boolean(findViewer())).toBe(true);
	const viewer = findViewer();
	if (!viewer) throw new Error('The Chromium PDF viewer did not load.');
	await expect(viewer.locator('embed[type="application/x-google-chrome-pdf"]')).toBeVisible();
	await expect(viewer.getByRole('textbox', { name: 'Page number', exact: true })).toHaveValue('1');
	await expect(viewer.locator('viewer-page-selector #pagelength')).toHaveText('1');
	const thumbnail = viewer.locator('viewer-thumbnail canvas');
	await expect(thumbnail).toBeVisible();
	await expect
		.poll(() =>
			thumbnail.evaluate((canvas: HTMLCanvasElement) => {
				const context = canvas.getContext('2d');
				if (!context || !canvas.width || !canvas.height) return false;
				const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
				return data.some(
					(value, index) => index % 4 === 0 && value < 128 && data[index + 3] === 255
				);
			})
		)
		.toBe(true);
	const text = await viewer.locator('pdf-viewer').evaluate(async (element) => {
		if (!('currentController' in element)) throw new Error('The PDF controller is missing.');
		const controller = element.currentController;
		if (
			!controller ||
			typeof controller !== 'object' ||
			!('selectAll' in controller) ||
			typeof controller.selectAll !== 'function' ||
			!('getSelectedText' in controller) ||
			typeof controller.getSelectedText !== 'function'
		)
			throw new Error('The PDF text selection API is missing.');
		controller.selectAll();
		const result: unknown = await controller.getSelectedText();
		if (!result || typeof result !== 'object' || !('selectedText' in result))
			throw new Error('The PDF renderer did not return text.');
		return result.selectedText;
	});
	expect(text).toBe('Binary review PDF\nOne visible page.');
	return { pages: 1, text, thumbnailHasInk: true };
}

test('loads a PDF document under the production CSP and preserves its bytes', async ({
	page,
	browser
}, info: TestInfo) => {
	const fixturePage = await browser.newPage();
	await fixturePage.setContent('<h1>Binary review PDF</h1><p>One visible page.</p>');
	const pdf = await fixturePage.pdf();
	await fixturePage.close();
	await info.attach('input.pdf', { body: pdf, contentType: 'application/pdf' });
	const cspViolations: string[] = [];
	page.on('console', (message) => {
		if (/violates.*Content Security Policy|Refused to frame/i.test(message.text()))
			cspViolations.push(message.text());
	});
	await resetAppState(page);
	const csp = await page
		.locator('meta[http-equiv="content-security-policy"]')
		.getAttribute('content');
	expect(csp).toMatch(/(?:^|;)\s*frame-src blob:\s*(?:;|$)/);
	expect(csp).toMatch(/(?:^|;)\s*object-src 'none'\s*(?:;|$)/);
	await page.locator('input[type="file"][accept*="text/markdown"]').setInputFiles({
		name: 'plan.pdf',
		mimeType: 'application/pdf',
		buffer: pdf
	});
	await expect(page.getByTestId('pdf-document')).toBeVisible();
	await expect(page.getByTestId('document-kind')).toHaveText('PDF');
	await expect(page.getByTestId('pdf-frame')).toHaveAttribute('src', /^blob:/);
	const imported = await expectRenderedPdf(page);
	await expect
		.poll(async () => {
			const handle = await page.getByTestId('pdf-frame').elementHandle();
			const document = await handle?.contentFrame();
			return document?.evaluate(() => ({ type: window.document.contentType, url: location.href }));
		})
		.toEqual({
			type: 'application/pdf',
			url: await page.getByTestId('pdf-frame').getAttribute('src')
		});
	expect(cspViolations).toEqual([]);
	await expect(page.getByRole('button', { name: 'Ouvrir le PDF' })).toBeEnabled();

	const downloadPromise = page.waitForEvent('download');
	await page.getByTestId('pdf-document').getByRole('button', { name: 'Exporter' }).click();
	const download = await downloadPromise;
	expect(download.suggestedFilename()).toBe('plan.pdf');
	expect((await readFile((await download.path())!)).equals(pdf)).toBe(true);

	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	await expect(page.getByTestId('pdf-document')).toBeVisible();
	await expect(page.getByTestId('document-kind')).toHaveText('PDF');
	const restored = await expectRenderedPdf(page);
	expect(cspViolations).toEqual([]);
	await info.attach('pdf-viewer.png', { body: await page.screenshot(), contentType: 'image/png' });
	await info.attach('pdf-viewer.json', {
		body: JSON.stringify({
			command: info.config.metadata.command,
			source: info.config.metadata,
			browser: browser.version(),
			fixture: {
				kind: 'pdf',
				originalBytes: pdf.length,
				sha256: createHash('sha256').update(pdf).digest('hex')
			},
			imported,
			restored,
			csp,
			cspViolations
		}),
		contentType: 'application/json'
	});
});

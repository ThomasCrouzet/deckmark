import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { createFirstFile, resetAppState, writeSourceContent } from './helpers';

const nativeScrollbarTest = test.extend({
	// Headless Firefox hides all scrollbars with an agent stylesheet.
	// Only native thumb drags need a headed browser, with Xvfb on Linux.
	headless: [
		async ({ browserName, headless }, use) => {
			await use(browserName === 'firefox' ? false : headless);
		},
		{ scope: 'worker' }
	],
	launchOptions: [
		async ({ launchOptions }, use) => {
			await use({
				...launchOptions,
				ignoreDefaultArgs: ['--hide-scrollbars'],
				firefoxUserPrefs: { ...launchOptions.firefoxUserPrefs, 'ui.useOverlayScrollbars': 0 }
			});
		},
		{ scope: 'worker' }
	]
});

const modes = [
	{ mode: 'wysiwyg', scroller: '.mdsh-editor', content: '.ProseMirror' },
	{ mode: 'source', scroller: '.mdsh-source-cm .cm-scroller', content: '.mdsh-source-cm' },
	{ mode: 'read', scroller: '.mdsh-read', content: '.mdsh-preview' }
] as const;

const labels = {
	en: {
		settings: 'Settings',
		group: 'Editor width',
		close: 'Close',
		medium: 'Medium',
		palette: 'Command palette',
		pdfCommand: 'Width: PDF (A4)',
		offlineReady: 'Ready offline',
		help: /178 mm.*16 mm.*Fonts, page breaks and print settings can differ/
	},
	fr: {
		settings: 'Réglages',
		group: "Largeur de l'éditeur",
		close: 'Fermer',
		medium: 'Moyenne',
		palette: 'Palette de commandes',
		pdfCommand: 'Largeur : PDF (A4)',
		offlineReady: 'Prêt hors ligne',
		help: /178 mm.*16 mm.*polices, les sauts de page et les réglages d'impression peuvent différer/
	}
} as const;

async function openSettings(page: Page, locale: keyof typeof labels = 'fr') {
	await expect(page.locator('.mdsh-shell[aria-busy="false"]:not([inert])')).toBeVisible();
	await page.keyboard.press('ControlOrMeta+,');
	const dialog = page.getByRole('dialog', { name: labels[locale].settings, exact: true });
	await expect(dialog).toBeVisible();
	return dialog;
}

async function selectWidth(page: Page, name: string, locale: keyof typeof labels = 'fr') {
	const dialog = await openSettings(page, locale);
	const group = dialog.getByRole('group', { name: labels[locale].group, exact: true });
	const button = group.getByRole('button', { name, exact: true });
	await button.click();
	await expect(button).toHaveAttribute('aria-pressed', 'true');
	await expect(group.locator('[aria-pressed="true"]')).toHaveCount(1);
	await dialog.getByRole('button', { name: labels[locale].close, exact: true }).click();
}

async function textWidth(content: Locator) {
	return content.evaluate((element) => {
		const style = getComputedStyle(element);
		return (
			element.getBoundingClientRect().width -
			parseFloat(style.paddingLeft) -
			parseFloat(style.paddingRight) -
			parseFloat(style.borderLeftWidth) -
			parseFloat(style.borderRightWidth)
		);
	});
}

async function expectPdfTextWidth(page: Page, locale: keyof typeof labels = 'fr') {
	await expect(page.locator('.mdsh-shell[aria-busy="false"]:not([inert])')).toBeVisible();
	// The shorter ready label moves the mode buttons. Wait before a pointer click.
	await expect(page.locator('#app-toolbar .mdsh-local-indicator')).toHaveText(
		labels[locale].offlineReady,
		{ timeout: 20_000 }
	);
	for (const mode of ['read', 'wysiwyg'] as const) {
		const button = page.locator(`button[data-mode="${mode}"]`);
		await button.click();
		await expect(button).toHaveAttribute('aria-checked', 'true');
		const content = page.locator(mode === 'read' ? '.mdsh-preview' : '.ProseMirror');
		await expect(content).toContainText('Width reference', { timeout: 20_000 });
		// A4 is 210 mm wide. The print stylesheet sets two 16 mm margins.
		await expect
			.poll(async () => Math.abs((await textWidth(content)) - (178 * 96) / 25.4))
			.toBeLessThan(1);
	}
}

async function capturePrint(page: Page) {
	let html = '';
	await page.exposeFunction('captureWidthPrint', (value: string) => {
		html = value;
	});
	await page.evaluate(() => {
		const capture = (
			globalThis as typeof globalThis & { captureWidthPrint: (html: string) => Promise<void> }
		).captureWidthPrint;
		const observer = new MutationObserver((records) => {
			for (const record of records) {
				for (const node of record.addedNodes) {
					if (!(node instanceof HTMLIFrameElement) || !node.contentWindow) continue;
					node.contentWindow.print = () => {
						void capture(node.contentDocument?.documentElement.outerHTML ?? '');
					};
				}
			}
		});
		observer.observe(document.body, { childList: true, subtree: true });
	});
	return () => html;
}

function pdfRectangle(source: string, pattern: RegExp): [number, number, number, number] {
	const values = pattern.exec(source)?.[1]?.trim().split(/\s+/).map(Number);
	expect(values).toHaveLength(4);
	return values as [number, number, number, number];
}

async function expectScrollbarReachable(page: Page, scroller: Locator) {
	const samples = await scroller.evaluate((element) => {
		const rect = element.getBoundingClientRect();
		return [2, 6, 12, 20].flatMap((inset) =>
			[0.1, 0.5, 0.9].map((fraction) => {
				const hit = document.elementFromPoint(
					rect.right - inset,
					rect.top + rect.height * fraction
				);
				return {
					inset,
					fraction,
					hitGrip: Boolean(hit?.closest('.resize-handle')),
					hitScroller: hit === element || element.contains(hit),
					// The floating scroll navigation is a deliberate overlay. It must
					// never cover the resize handle, but it may sit over the edge.
					hitScrollNav: Boolean(hit?.closest('.mdsh-scroll-nav'))
				};
			})
		);
	});
	for (const sample of samples) {
		expect(sample.hitGrip, JSON.stringify(sample)).toBe(false);
		expect(sample.hitScroller || sample.hitScrollNav, JSON.stringify(sample)).toBe(true);
	}
	const rect = await scroller.boundingBox();
	if (!rect) throw new Error('The scroll container has no bounds');
	await page.mouse.move(rect.x + rect.width - 6, rect.y + rect.height / 2);
	await page.mouse.wheel(0, 350);
	await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
}

async function dragNativeScrollbar(
	page: Page,
	scroller: Locator,
	preset: string,
	testInfo: TestInfo
) {
	await scroller.evaluate((element) => {
		element.scrollTop = 0;
	});
	await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(0);
	const geometry = await scroller.evaluate((element) => {
		const node = element as HTMLElement;
		const rect = node.getBoundingClientRect();
		const style = getComputedStyle(node);
		const gutter =
			node.offsetWidth -
			node.clientWidth -
			parseFloat(style.borderLeftWidth) -
			parseFloat(style.borderRightWidth);
		const thumbHeight = (node.clientHeight * node.clientHeight) / node.scrollHeight;
		return {
			gutter,
			thumbHeight,
			clientHeight: node.clientHeight,
			scrollHeight: node.scrollHeight,
			startTop: node.scrollTop,
			x: rect.left + node.clientLeft + node.clientWidth + gutter / 2,
			y: rect.top + node.clientTop + thumbHeight / 2
		};
	});
	expect(geometry.gutter, 'The native scrollbar must reserve visible space').toBeGreaterThan(0);
	// This document gives the thumb enough height to avoid platform minimum sizes.
	expect(geometry.thumbHeight).toBeGreaterThan(40);
	await testInfo.attach(`scrollbar-${preset}-before`, {
		body: await page.screenshot(),
		contentType: 'image/png'
	});
	await page.mouse.move(geometry.x, geometry.y);
	await page.mouse.down();
	let downTop = 0;
	let upTop = 0;
	try {
		await expect(page.locator('.resize-handle')).not.toHaveClass(/resizing/);
		// A track click scrolls immediately. A thumb press must keep its position.
		expect(await scroller.evaluate((element) => element.scrollTop)).toBe(geometry.startTop);
		const distance = Math.min(180, (geometry.clientHeight - geometry.thumbHeight) / 2);
		await page.mouse.move(geometry.x, geometry.y + distance, { steps: 12 });
		await expect
			.poll(() => scroller.evaluate((element) => element.scrollTop))
			.toBeGreaterThan(geometry.startTop + 100);
		downTop = await scroller.evaluate((element) => element.scrollTop);
		await page.mouse.move(geometry.x, geometry.y + distance / 2, { steps: 8 });
		await expect
			.poll(() => scroller.evaluate((element) => element.scrollTop))
			.toBeLessThan(downTop - 100);
		upTop = await scroller.evaluate((element) => element.scrollTop);
	} finally {
		await page.mouse.up();
		await testInfo.attach(`scrollbar-${preset}-geometry`, {
			body: JSON.stringify({ ...geometry, downTop, upTop }, null, 2),
			contentType: 'application/json'
		});
	}
	await testInfo.attach(`scrollbar-${preset}-after`, {
		body: await page.screenshot(),
		contentType: 'image/png'
	});
}

test.use({
	viewport: { width: 1440, height: 1000 }
});

test.describe('Editor width', () => {
	test.setTimeout(60_000);

	test.beforeEach(async ({ page, headless }, testInfo) => {
		testInfo.annotations.push({
			type: 'browser-mode',
			description: headless ? 'headless' : 'headed'
		});
		await resetAppState(page);
		await createFirstFile(page);
	});

	for (const locale of ['en', 'fr'] as const) {
		test(`keeps the PDF preset and its localized width guide in ${locale}`, async ({ page }) => {
			await writeSourceContent(page, '# Width reference\n\nA paragraph for the PDF width guide.');
			if (locale === 'en') {
				const dialog = await openSettings(page);
				await dialog
					.getByRole('group', { name: 'Langue' })
					.getByRole('button', { name: 'English' })
					.click();
				await page
					.getByRole('dialog', { name: 'Settings', exact: true })
					.getByRole('button', { name: 'Close', exact: true })
					.click();
			}
			await selectWidth(page, 'PDF (A4)', locale);
			await expectPdfTextWidth(page, locale);

			await page.setViewportSize({ width: 1680, height: 1000 });
			await expectPdfTextWidth(page, locale);
			await page.setViewportSize({ width: 800, height: 1000 });
			await page.reload();
			const dialog = await openSettings(page, locale);
			const group = dialog.getByRole('group', { name: labels[locale].group, exact: true });
			await expect(group.getByRole('button', { name: 'PDF (A4)', exact: true })).toHaveAttribute(
				'aria-pressed',
				'true'
			);
			await expect(group.locator('[aria-pressed="true"]')).toHaveCount(1);
			await expect(dialog.getByText(labels[locale].help)).toBeVisible();
			await dialog.getByRole('button', { name: labels[locale].close, exact: true }).click();
			await page.setViewportSize({ width: 1440, height: 1000 });
			await expectPdfTextWidth(page, locale);

			await selectWidth(page, labels[locale].medium, locale);
			await page.getByRole('button', { name: labels[locale].palette, exact: true }).click();
			const palette = page.getByRole('dialog', { name: labels[locale].palette, exact: true });
			await palette.getByRole('combobox').fill('PDF');
			const command = palette.getByRole('option', { name: labels[locale].pdfCommand, exact: true });
			await expect(command).toHaveAttribute('title', labels[locale].help);
			await command.click();
			await page.reload();
			await expectPdfTextWidth(page, locale);
		});
	}

	test('matches the actual PDF text area rather than the screen print preview', async ({
		page,
		browser,
		browserName
	}, testInfo) => {
		test.skip(browserName !== 'chromium', 'PDF output requires Chromium');
		await writeSourceContent(
			page,
			'# Width reference\n\n[PDF width probe](https://width-probe.invalid/)'
		);
		await selectWidth(page, 'PDF (A4)');
		await expectPdfTextWidth(page);
		const editorWidth = await textWidth(page.locator('.ProseMirror'));
		const captured = await capturePrint(page);
		await page.getByRole('button', { name: 'Exporter en PDF', exact: true }).click();
		await expect.poll(() => captured().length).toBeGreaterThan(100);

		const printable = await browser.newPage();
		try {
			await printable.goto(page.url());
			await printable.setContent(captured(), { waitUntil: 'networkidle' });
			// A block link exposes the full text area as a rectangle in the real PDF.
			await printable.locator('a[href="https://width-probe.invalid/"]').evaluate((element) => {
				(element as HTMLElement).style.display = 'block';
			});
			const pdf = await printable.pdf({
				preferCSSPageSize: true,
				displayHeaderFooter: false,
				printBackground: true
			});
			await testInfo.attach('editor-width-pdf', { body: pdf, contentType: 'application/pdf' });
			const source = pdf.toString('latin1');
			const mediaBox = pdfRectangle(source, /\/MediaBox\s*\[([\d.\s-]+)\]/);
			expect(Math.abs(mediaBox[2] - (210 * 72) / 25.4)).toBeLessThan(1);
			expect(Math.abs(mediaBox[3] - (297 * 72) / 25.4)).toBeLessThan(1);
			const annotation = source
				.split('endobj')
				.find((object) => object.includes('/URI (https://width-probe.invalid/)'));
			const rect = pdfRectangle(annotation ?? '', /\/Rect\s*\[([\d.\s-]+)\]/);
			expect(Math.abs(rect[0] - (16 * 72) / 25.4)).toBeLessThan(1);
			expect(Math.abs(mediaBox[2] - rect[2] - (16 * 72) / 25.4)).toBeLessThan(1);
			expect(Math.abs(editorWidth - ((rect[2] - rect[0]) * 96) / 72)).toBeLessThan(2);
		} finally {
			await printable.close();
		}
	});

	for (const { mode, scroller: selector, content } of modes) {
		for (const zeroGutter of [false, true]) {
			const scrollbarTest = zeroGutter ? test : nativeScrollbarTest;
			scrollbarTest(
				`keeps the ${mode} scrollbar reachable with ${zeroGutter ? 'zero' : 'native'} gutter`,
				async ({ page, browserName }, testInfo) => {
					await writeSourceContent(
						page,
						'# Scroll reference\n\n' +
							Array.from(
								{ length: 100 },
								(_, index) => `Paragraph ${index}. Text for the scrollbar test.`
							).join('\n\n')
					);
					await page.locator(`button[data-mode="${mode}"]`).click();
					await expect(page.locator(content)).toBeVisible({ timeout: 20_000 });
					if (mode === 'read') await expect(page.locator('.mdsh-toc-col')).toBeVisible();
					const scroller = page.locator(selector);
					await expect
						.poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight))
						.toBeGreaterThan(1000);
					if (zeroGutter) {
						// Reproduce the zero reserved width of macOS overlay scrollbars on any host.
						// The native case below also tests a real scrollbar drag.
						await page.addStyleTag({
							content: `${selector} { scrollbar-width: none !important; } ${selector}::-webkit-scrollbar { display: none !important; }`
						});
						await expect
							.poll(() =>
								scroller.evaluate(
									(element) => (element as HTMLElement).offsetWidth - element.clientWidth
								)
							)
							.toBe(0);
					} else {
						// Keep a real browser scrollbar visible. A non-auto scrollbar-color
						// disables WebKit scrollbar sizing, so only Firefox uses that property.
						await page.addStyleTag({
							content: `
							${selector} {
								overflow-y: scroll !important;
								scrollbar-gutter: stable !important;
								scrollbar-width: auto !important;
								scrollbar-color: ${browserName === 'firefox' ? '#555 #eee' : 'auto'} !important;
							}
							${selector}::-webkit-scrollbar { display: block !important; width: 16px !important; }
							${selector}::-webkit-scrollbar-track { background: #eee !important; }
							${selector}::-webkit-scrollbar-thumb { background: #555 !important; border: 0 !important; }
							${selector}::-webkit-scrollbar-button { display: none !important; }
						`
						});
					}
					for (const preset of ['Pleine', 'Moyenne']) {
						await selectWidth(page, preset);
						await scroller.evaluate((element) => {
							element.scrollTop = 0;
						});
						await expectScrollbarReachable(page, scroller);
						const savedWidth = await page.evaluate(() => localStorage.getItem('mdsh:editor-width'));
						if (zeroGutter) {
							const rect = await scroller.boundingBox();
							if (!rect) throw new Error('The scroll container has no bounds');
							await page.mouse.move(rect.x + rect.width - 5, rect.y + 10);
							await page.mouse.down();
							await expect(page.locator('.resize-handle')).not.toHaveClass(/resizing/);
							await page.mouse.move(rect.x + rect.width - 5, rect.y + rect.height * 0.7, {
								steps: 12
							});
							await page.mouse.up();
						} else {
							await dragNativeScrollbar(page, scroller, preset, testInfo);
						}
						expect(await page.evaluate(() => localStorage.getItem('mdsh:editor-width'))).toBe(
							savedWidth
						);
					}

					// The grip must still resize, save a custom width, and reset on double-click.
					const grip = page.locator('.resize-handle');
					const before = (await page.locator(content).boundingBox())?.width;
					const bounds = await grip.boundingBox();
					if (!bounds || before === undefined) throw new Error('The resize grip has no bounds');
					const x = bounds.x + bounds.width / 2;
					const y = bounds.y + bounds.height / 2;
					await page.mouse.move(x, y);
					await page.mouse.down();
					await expect(grip).toHaveClass(/resizing/);
					await page.mouse.move(x - 40, y, { steps: 4 });
					await page.mouse.up();
					await expect
						.poll(async () => (await page.locator(content).boundingBox())?.width ?? 0)
						.toBeLessThan(before - 60);
					await page.reload();
					await expect(page.locator(content)).toBeVisible({ timeout: 20_000 });
					// Each mode adds its outline after rendering, which moves the grip.
					await expect(page.locator('.mdsh-toc-col')).toBeVisible();
					await expect
						.poll(async () => (await page.locator(content).boundingBox())?.width ?? 0)
						.toBeLessThan(before - 60);
					await grip.dblclick();
					await expect
						.poll(async () => (await page.locator(content).boundingBox())?.width ?? 0)
						.toBeCloseTo(before, 0);
					await selectWidth(page, 'Pleine');
					await page.setViewportSize({ width: 1100, height: 900 });
					await page.reload();
					const dialog = await openSettings(page);
					const group = dialog.getByRole('group', { name: labels.fr.group, exact: true });
					await expect(group.getByRole('button', { name: 'Pleine', exact: true })).toHaveAttribute(
						'aria-pressed',
						'true'
					);
					await expect(group.locator('[aria-pressed="true"]')).toHaveCount(1);
				}
			);
		}
	}
});

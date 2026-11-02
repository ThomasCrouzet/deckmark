import { chromium, expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const labels = {
	en: { settings: 'Settings', search: 'Cross-file search', close: 'Close', medium: 'Medium' },
	fr: {
		settings: 'Réglages',
		search: 'Recherche cross-fichiers',
		close: 'Fermer',
		medium: 'Moyenne'
	}
};

async function start(page: Page, locale: 'en' | 'fr') {
	await page.addInitScript((value) => {
		localStorage.setItem('mdsh:locale', value);
		localStorage.setItem('mdsh:mode', 'source');
	}, locale);
	await page.goto('/');
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
}

async function note(page: Page) {
	await page.getByTestId('welcome-new').click();
	await page.getByTestId('create-note').click();
	await page.locator('.cm-content').fill('# Review note\n\nA local document.');
}

async function targets(controls: Locator) {
	const sizes = await controls.evaluateAll((elements) =>
		elements
			.filter((element) => element.getClientRects().length > 0)
			.map((element) => {
				const rect = element.getBoundingClientRect();
				return {
					name: element.getAttribute('aria-label') ?? element.textContent,
					width: rect.width,
					height: rect.height
				};
			})
	);
	expect(sizes.length).toBeGreaterThan(0);
	expect(sizes.filter((size) => size.width < 44 || size.height < 44)).toEqual([]);
}

test.afterEach(async ({ page }, info) => {
	await info.attach('screen.png', { body: await page.screenshot(), contentType: 'image/png' });
	await info.attach('screen.aria.txt', {
		body: await page.locator('body').ariaSnapshot(),
		contentType: 'text/plain'
	});
});

for (const locale of ['en', 'fr'] as const) {
	test(`creation fits real 200 percent browser zoom at 320 pixels in ${locale}`, async ({
		browserName,
		baseURL
	}, info) => {
		test.skip(browserName !== 'chromium', 'The zoom extension requires Chromium.');
		const extension = info.outputPath('zoom-extension');
		await mkdir(extension, { recursive: true });
		await writeFile(
			resolve(extension, 'manifest.json'),
			JSON.stringify({
				manifest_version: 3,
				name: 'Local page zoom check',
				version: '1.0',
				permissions: ['tabs'],
				background: { service_worker: 'worker.js' }
			})
		);
		await writeFile(
			resolve(extension, 'worker.js'),
			'chrome.runtime.onInstalled.addListener(() => {});'
		);
		const context = await chromium.launchPersistentContext('', {
			channel: 'chromium',
			headless: true,
			baseURL,
			viewport: { width: 320, height: 844 },
			args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
		});
		try {
			const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
			const zoomPage = await context.newPage();
			await start(zoomPage, locale);
			// Use the browser zoom API. CSS zoom does not change layout breakpoints.
			await worker.evaluate(async (origin) => {
				const api = (
					globalThis as unknown as {
						chrome: {
							tabs: {
								query: (query: object) => Promise<{ id: number; url: string }[]>;
								setZoom: (id: number, factor: number) => Promise<void>;
							};
						};
					}
				).chrome.tabs;
				const tab = (await api.query({})).find((entry) => entry.url.startsWith(origin!));
				if (!tab) throw new Error('The application tab was not found.');
				await api.setZoom(tab.id, 2);
			}, baseURL);
			for (const action of ['welcome-new', 'welcome-import', 'welcome-demo']) {
				const button = zoomPage.getByTestId(action);
				await button.scrollIntoViewIfNeeded();
				const bounds = await button.evaluate((element) => {
					const box = element.getBoundingClientRect();
					const shell = element.closest('.welcome-shell')!.getBoundingClientRect();
					const label = element.querySelector('.flex-1')!;
					const range = document.createRange();
					range.selectNodeContents(label);
					return {
						viewport: innerWidth,
						cssZoom: getComputedStyle(document.documentElement).zoom,
						button: box.toJSON(),
						scrollWidth: element.scrollWidth,
						clientWidth: element.clientWidth,
						label: label.textContent,
						textFits: [...range.getClientRects()].every(
							(rect) =>
								rect.left >= box.left &&
								rect.right <= box.right &&
								rect.top >= box.top &&
								rect.bottom <= box.bottom
						),
						insideScrollViewport:
							box.left >= Math.max(0, shell.left) &&
							box.right <= Math.min(innerWidth, shell.right) &&
							box.top >= Math.max(0, shell.top) &&
							box.bottom <= Math.min(innerHeight, shell.bottom)
					};
				});
				await info.attach(`${action}-zoom.json`, {
					body: JSON.stringify(bounds),
					contentType: 'application/json'
				});
				await info.attach(`${action}-zoom.png`, {
					body: await zoomPage.screenshot(),
					contentType: 'image/png'
				});
				expect(bounds.viewport).toBe(160);
				expect(bounds.cssZoom).toBe('1');
				expect(bounds.insideScrollViewport).toBe(true);
				expect(bounds.textFits).toBe(true);
				expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth);
				await targets(button);
				await expect(button).toBeInViewport({ ratio: 1 });
			}
			await zoomPage.getByTestId('welcome-new').click();
			const dialog = zoomPage.getByRole('dialog');
			const dimensions = await dialog.evaluate((element) => ({
				viewport: innerWidth,
				cssZoom: getComputedStyle(document.documentElement).zoom,
				width: element.clientWidth,
				scroll: element.scrollWidth,
				cards: [...element.querySelectorAll('.cards button')].map((button) => {
					const box = button.getBoundingClientRect();
					return {
						width: button.clientWidth,
						scroll: button.scrollWidth,
						contentFits: [...button.children].every((child) => {
							const rect = child.getBoundingClientRect();
							return (
								rect.top >= box.top &&
								rect.bottom <= box.bottom &&
								rect.left >= box.left &&
								rect.right <= box.right
							);
						})
					};
				})
			}));
			await info.attach('real-zoom.json', {
				body: JSON.stringify(dimensions),
				contentType: 'application/json'
			});
			await info.attach('real-zoom.png', {
				body: await zoomPage.screenshot(),
				contentType: 'image/png'
			});
			expect(dimensions.viewport).toBe(160);
			expect(dimensions.cssZoom).toBe('1');
			expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width);
			for (const card of dimensions.cards) {
				expect(card.scroll).toBeLessThanOrEqual(card.width);
				expect(card.contentFits).toBe(true);
			}
			await expect(dialog.locator('.cancel')).toBeInViewport({ ratio: 1 });
			await expect(zoomPage.getByTestId('create-note')).toBeFocused();
			await zoomPage.keyboard.press('Tab');
			await expect(zoomPage.getByTestId('create-presentation')).toBeFocused();
			await expect(zoomPage.getByTestId('create-presentation').locator('strong')).toBeInViewport({
				ratio: 1
			});
			await zoomPage.keyboard.press('Enter');
			await expect(zoomPage.getByTestId('presentation-editor')).toBeVisible();
			const title = zoomPage.locator('#app-toolbar input');
			const titleBox = await title.boundingBox();
			await info.attach('real-zoom-title.json', {
				body: JSON.stringify(titleBox),
				contentType: 'application/json'
			});
			expect(titleBox!.x).toBeGreaterThanOrEqual(0);
			expect(titleBox!.x + titleBox!.width).toBeLessThanOrEqual(160);
			expect(titleBox!.width).toBeGreaterThanOrEqual(64);
			expect(titleBox!.height).toBeGreaterThanOrEqual(44);
			await expect(title).toBeInViewport({ ratio: 1 });
			await title.fill('Zoom deck');
			await title.press('Enter');
			await expect(title).toHaveValue('Zoom deck');
			await info.attach('real-zoom-title.png', {
				body: await zoomPage.screenshot(),
				contentType: 'image/png'
			});
		} finally {
			await context.close();
		}
	});

	test(`note title can be read and renamed with Files open at 1280 in ${locale}`, async ({
		page
	}, info) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		await start(page, locale);
		await note(page);
		await expect(page.locator('#files-panel')).toBeVisible();
		const title = page.locator('#app-toolbar input');
		await expect
			.poll(async () => (await title.boundingBox())?.width ?? 0)
			.toBeGreaterThanOrEqual(160);
		await title.fill('Field review');
		await title.press('Enter');
		await expect(title).toHaveValue('Field review');
		const geometry = await title.boundingBox();
		await info.attach('title.json', {
			body: JSON.stringify(geometry),
			contentType: 'application/json'
		});
		await expect(page.locator('#files-panel')).toContainText('Field review');
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
			true
		);
	});

	test(`title has a 44 pixel touch target on narrow and coarse layouts in ${locale}`, async ({
		browser,
		baseURL
	}, info) => {
		for (const touch of [false, true]) {
			const context = await browser.newContext({
				baseURL,
				hasTouch: touch,
				viewport: { width: touch ? 1280 : 320, height: 900 }
			});
			try {
				const page = await context.newPage();
				await start(page, locale);
				await note(page);
				const title = page.locator('#app-toolbar input');
				await info.attach(`title-touch-${touch}.json`, {
					body: JSON.stringify(await title.boundingBox()),
					contentType: 'application/json'
				});
				await targets(title);
				await expect(title).toBeInViewport({ ratio: 1 });
				await title.click({ position: { x: 8, y: 40 } });
				await expect(title).toBeFocused();
				await title.fill('Touch title');
				await title.press('Enter');
				await expect(title).toHaveValue('Touch title');
			} finally {
				await context.close();
			}
		}
	});

	test(`backup prompts show one visual layer and restore Settings in ${locale}`, async ({
		page
	}, info) => {
		await start(page, locale);
		await note(page);
		await page.keyboard.press('Control+,');
		const settings = page.locator('[role="dialog"][aria-labelledby="settings-title"]');
		const prompt = page.locator('[role="dialog"][aria-labelledby="prompt-modal-title"]');
		const exportButton = settings.getByRole('button', {
			name: locale === 'en' ? 'Export (encrypted)...' : 'Exporter (chiffré)…',
			exact: true
		});
		const details = settings.locator('details').first();
		await details.locator('summary').click();
		await expect(details).toHaveAttribute('open', '');
		await exportButton.click();
		await expect(prompt).toBeVisible();
		await info.attach('backup-first-prompt.png', {
			body: await page.screenshot(),
			contentType: 'image/png'
		});
		// CSS visibility must exclude the Settings panel and its full-screen backdrop.
		await expect(page.locator('[role="dialog"]:visible')).toHaveCount(1);
		await expect(settings).toBeHidden();
		await expect(settings.locator('.mdsh-dialog-panel')).toBeHidden();
		await expect(prompt.locator('input')).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(settings).toBeVisible();
		await expect(page.locator('[role="dialog"]:visible')).toHaveCount(1);
		await expect(details).toHaveAttribute('open', '');
		await expect(exportButton).toBeFocused();
		await exportButton.click();
		await prompt.locator('input').fill('Local test passphrase');
		await prompt.locator('input').press('Enter');
		await expect(prompt).toContainText(
			locale === 'en' ? 'Confirm the passphrase' : 'Confirmer la phrase secrète'
		);
		await expect(prompt.locator('input')).toBeFocused();
		await expect(prompt.locator('input')).toHaveValue('');
		await expect(page.locator('[role="dialog"]:visible')).toHaveCount(1);
		await expect(settings).toBeHidden();
		await info.attach('backup-second-prompt.png', {
			body: await page.screenshot(),
			contentType: 'image/png'
		});
		await prompt
			.getByRole('button', { name: locale === 'en' ? 'Cancel' : 'Annuler', exact: true })
			.click();
		await expect(settings).toBeVisible();
		await expect(details).toHaveAttribute('open', '');
		await expect(exportButton).toBeFocused();
		await expect(page.locator('[role="dialog"]:visible')).toHaveCount(1);
		await page.keyboard.press('Tab');
		await expect
			.poll(() => settings.evaluate((element) => element.contains(document.activeElement)))
			.toBe(true);
	});

	test(`note mode labels and touch targets remain available at tablet and phone widths in ${locale}`, async ({
		page
	}) => {
		await start(page, locale);
		await note(page);
		for (const width of [768, 320]) {
			await page.setViewportSize({ width, height: 900 });
			for (const mode of ['wysiwyg', 'source', 'read']) {
				const control = page.locator(`[data-mode="${mode}"]`);
				await expect(control.locator('span')).toBeVisible();
				await targets(control);
				await control.click();
				await expect(control).toHaveAttribute('aria-checked', 'true');
			}
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
				true
			);
		}
	});

	test(`settings has usable touch controls in ${locale}`, async ({ page }) => {
		await page.setViewportSize({ width: 320, height: 844 });
		await start(page, locale);
		await note(page);
		await page.keyboard.press('Control+,');
		const settings = page.getByRole('dialog', { name: labels[locale].settings, exact: true });
		await expect(settings).toBeVisible();
		await targets(settings.locator('button'));
	});

	test(`PDF width help appears only for the selected PDF guide in ${locale}`, async ({ page }) => {
		await page.setViewportSize({ width: 320, height: 844 });
		await start(page, locale);
		await note(page);
		await page.keyboard.press('Control+,');
		const settings = page.getByRole('dialog', { name: labels[locale].settings, exact: true });
		await expect(settings).toBeVisible();
		await expect(settings.locator('#editor-width-pdf-help')).toBeHidden();
		await settings.getByRole('button', { name: 'PDF (A4)', exact: true }).click();
		await expect(settings.locator('#editor-width-pdf-help')).toBeVisible();
		await settings.getByRole('button', { name: labels[locale].medium, exact: true }).click();
		await expect(settings.locator('#editor-width-pdf-help')).toBeHidden();
		await settings.getByRole('button', { name: labels[locale].close, exact: true }).click();
	});

	test(`search has usable touch controls in ${locale}`, async ({ page }) => {
		await page.setViewportSize({ width: 320, height: 844 });
		await start(page, locale);
		await note(page);
		await page.getByRole('button', { name: 'Actions', exact: true }).click();
		await page
			.getByRole('dialog', { name: 'Actions', exact: true })
			.getByRole('button', { name: labels[locale].search, exact: true })
			.click();
		const search = page.getByRole('dialog', { name: labels[locale].search, exact: true });
		await expect(search).toBeVisible();
		await targets(search.locator('button'));
		await search.getByRole('combobox').fill('Review');
		await expect(search.getByRole('option').filter({ hasText: 'Review note' })).toBeVisible();
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
			true
		);
	});

	test(`welcome identifies both file types in ${locale}`, async ({ page }) => {
		await page.setViewportSize({ width: 320, height: 844 });
		await start(page, locale);
		await expect(page.locator('.welcome-intro')).toContainText(
			locale === 'en'
				? 'Write notes and create presentations.'
				: 'Écrivez des notes et créez des présentations.'
		);
		await expect(page.locator('.welcome-actions .mdsh-kicker')).toHaveCount(0);
		await expect(page.getByTestId('welcome-new')).toBeInViewport();
	});
}

import { expect, test, chromium, type Locator, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resetAppState } from './helpers';
import { presentationFixture } from './presentation-helpers';

type Locale = 'en' | 'fr';
const fixture = presentationFixture(['# Compact deck']);

async function start(page: Page, locale: Locale) {
	await resetAppState(page);
	await page.evaluate((value) => localStorage.setItem('mdsh:locale', value), locale);
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	await page.getByTestId('welcome-new').click();
	await page.getByTestId('create-presentation').click();
	await expect(page.getByTestId('presentation-editor')).toBeVisible();
}

async function reachable(control: Locator) {
	await control.scrollIntoViewIfNeeded();
	await expect(control).toBeInViewport({ ratio: 1 });
	await expect
		.poll(() =>
			control.evaluate((element) => {
				const box = element.getBoundingClientRect();
				const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
				return hit === element || (hit !== null && element.contains(hit));
			})
		)
		.toBe(true);
}

async function workflow(page: Page, info: TestInfo, locale: Locale, touch: boolean) {
	const editor = page.getByTestId('presentation-editor');
	const inspector = editor.getByTestId('slide-inspector');
	if (
		(await inspector.isVisible()) &&
		(await inspector.evaluate((element) => getComputedStyle(element).position === 'absolute'))
	) {
		await inspector
			.getByRole('button', { name: locale === 'en' ? 'Close' : 'Fermer', exact: true })
			.click();
	}
	const activate = async (id: string) => {
		const control = editor.getByTestId(id);
		await reachable(control);
		if (touch) await control.tap();
		else await control.click();
	};
	const geometry = await editor.evaluate((root) => {
		const measure = (selector: string) => {
			const row = root.querySelector(selector)!;
			return {
				box: row.getBoundingClientRect().toJSON(),
				clientWidth: row.clientWidth,
				scrollWidth: row.scrollWidth,
				controls: [...row.querySelectorAll(':scope > button, :scope > details > summary')].map(
					(control) => ({
						id: control.getAttribute('data-testid'),
						box: control.getBoundingClientRect().toJSON()
					})
				)
			};
		};
		return {
			header: measure('.header-actions'),
			headerBox: root.querySelector('.presentation-header')!.getBoundingClientRect().toJSON(),
			insert: measure('.presentation-tools'),
			selection: measure('.selection-tools'),
			viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
			pageWidth: document.documentElement.scrollWidth
		};
	});
	await info.attach('chrome-geometry.json', {
		body: JSON.stringify(geometry, null, 2),
		contentType: 'application/json'
	});
	await info.attach('chrome.png', { body: await page.screenshot(), contentType: 'image/png' });
	expect.soft(geometry.headerBox.height, 'Header fits one compact row').toBeLessThanOrEqual(49);
	for (const row of [geometry.header, geometry.insert, geometry.selection]) {
		expect.soft(row.box.height, 'Controls do not wrap').toBeLessThanOrEqual(55);
		const tops = row.controls.map((control) => control.box.y);
		expect
			.soft(Math.max(...tops) - Math.min(...tops), 'All controls share one row')
			.toBeLessThanOrEqual(2);
		for (const control of row.controls) {
			expect.soft(control.box.height, control.id!).toBeGreaterThanOrEqual(touch ? 44 : 32);
			expect.soft(control.box.width, control.id!).toBeGreaterThanOrEqual(touch ? 44 : 32);
		}
	}
	expect.soft(geometry.pageWidth).toBeLessThanOrEqual(geometry.viewport.width);
	for (const id of ['slide-advanced', 'slide-export', 'slide-notes-toggle', 'slide-present']) {
		await expect(editor.getByTestId(id)).toHaveAccessibleName(/\S/);
		await reachable(editor.getByTestId(id));
	}
	// Tab must bring the final insertion action into the horizontal scroll viewport.
	await editor.getByTestId('slide-add-text').focus();
	for (let index = 0; index < 7; index++) await page.keyboard.press('Tab');
	await expect(editor.getByTestId('slide-properties')).toBeFocused();
	await reachable(editor.getByTestId('slide-properties'));
	await activate('slide-add-arrow');
	await expect(editor.locator('[data-object-type="arrow"]')).toHaveCount(1);
	await activate('slide-delete');
	await expect(editor.locator('[data-object-type="arrow"]')).toHaveCount(0);
	await activate('slide-notes-toggle');
	await expect(editor.getByTestId('slide-notes')).toHaveCount(0);
	await activate('slide-notes-toggle');
	await expect(editor.getByTestId('slide-notes')).toBeVisible();
	await activate('slide-advanced');
	await activate('slide-source');
	await editor.getByTestId('slide-source-editor').fill('# Invalid replacement');
	await activate('slide-source-apply');
	await expect(editor.getByRole('alert')).toBeVisible();
	await expect(editor.getByTestId('slide-present')).toBeDisabled();
	await expect(editor.getByTestId('slide-present')).toHaveAccessibleDescription(/\S/);
	await editor.getByTestId('slide-source-editor').fill(fixture);
	await activate('slide-source-apply');
	await expect(editor.getByTestId('slide-canvas')).toContainText('Compact deck');
	await activate('slide-export');
	for (const kind of ['md', 'html', 'pdf'])
		await reachable(editor.getByTestId(`slide-export-${kind}`));
	const download = page.waitForEvent('download');
	await activate('slide-export-md');
	const exported = await download;
	const chunks: Buffer[] = [];
	for await (const chunk of (await exported.createReadStream())!) chunks.push(chunk);
	const bytes = Buffer.concat(chunks);
	expect(bytes.toString()).toBe(fixture);
	await info.attach('export.md', { body: bytes, contentType: 'text/markdown' });
	await activate('slide-present');
	await expect(editor).toHaveAttribute('aria-modal', 'true');
	await expect(editor.getByTestId('slide-canvas')).toBeInViewport();
	await info.attach('present.png', { body: await page.screenshot(), contentType: 'image/png' });
	await activate('slide-present-exit');
	await expect(editor.getByTestId('slide-present')).toBeFocused();
	await expect(editor.getByTestId('slide-present')).toHaveText(
		locale === 'en' ? 'Present' : 'Présenter'
	);
}

test.afterEach(async ({ browser }, info) => {
	await info.attach('run.json', {
		body: JSON.stringify(
			{
				command:
					info.config.metadata.command ??
					'npx playwright test e2e/presentation-toolbar-density.spec.ts',
				revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
				sourceSha256: createHash('sha256')
					.update(await readFile('src/lib/presentation/SlideEditor.svelte'))
					.digest('hex'),
				environment: {
					node: process.version,
					platform: process.platform,
					browser: browser.version()
				},
				fixture,
				status: info.status
			},
			null,
			2
		),
		contentType: 'application/json'
	});
});

for (const locale of ['en', 'fr'] as const) {
	for (const viewport of [
		{ width: 390, height: 844 },
		{ width: 768, height: 1024 },
		{ width: 1280, height: 900 },
		{ width: 844, height: 390 }
	]) {
		test.describe(`${locale} ${viewport.width}x${viewport.height}`, () => {
			const touch = viewport.width !== 1280;
			test.use({ viewport, hasTouch: touch, reducedMotion: 'reduce' });
			test('compact presentation controls remain reachable', async ({ page }, info) => {
				await start(page, locale);
				await workflow(page, info, locale, touch);
			});
		});
	}
	test(`compact presentation at real 200 percent zoom in ${locale}`, async ({
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
				name: 'Local zoom check',
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
			viewport: { width: 780, height: 900 },
			args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
		});
		try {
			const page = await context.newPage();
			await start(page, locale);
			const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
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
				if (!tab) throw new Error('Application tab not found.');
				await api.setZoom(tab.id, 2);
			}, baseURL);
			await expect.poll(() => page.evaluate(() => innerWidth)).toBe(390);
			expect(await page.evaluate(() => getComputedStyle(document.documentElement).zoom)).toBe('1');
			await workflow(page, info, locale, false);
		} finally {
			await context.close();
		}
	});
}

test('presentation resize settles without browser notification errors', async ({ page }, info) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await page.exposeFunction('recordResizeError', (message: string) => errors.push(message));
	await page.addInitScript(() => {
		window.addEventListener('error', (event) => {
			if (event.message.includes('ResizeObserver')) {
				const record = Reflect.get(window, 'recordResizeError');
				void record(event.message);
			}
		});
	});
	await page.setViewportSize({ width: 320, height: 844 });
	await start(page, 'en');
	await page.getByTestId('slide-add-text').click();
	for (const width of [390, 768, 320, 1280, 320]) {
		await page.setViewportSize({ width, height: 844 });
		await page.getByTestId('slide-notes-toggle').click();
		await expect(page.getByTestId('slide-canvas')).toBeInViewport();
		await info.attach(`resize-${width}.png`, {
			body: await page.screenshot(),
			contentType: 'image/png'
		});
	}
	await info.attach('browser-errors.json', {
		body: JSON.stringify(errors),
		contentType: 'application/json'
	});
	expect(errors).toEqual([]);
});

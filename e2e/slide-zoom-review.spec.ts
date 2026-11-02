import { chromium, expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Let the test runner retain traces for the persistent browser context.
test.use({ trace: 'on' });

// Reach each control through the browser tab order. Do not scroll or focus it with script.
async function tabTo(page: Page, target: Locator) {
	for (let step = 0; step < 180; step++) {
		if (await target.evaluate((element) => element === document.activeElement)) return;
		await page.keyboard.press('Tab');
	}
	await expect(target).toBeFocused();
}

for (const { locale, holdSave } of [
	{ locale: 'en', holdSave: false },
	{ locale: 'fr', holdSave: false },
	{ locale: 'en', holdSave: true },
	{ locale: 'fr', holdSave: true }
] as const) {
	const title = `full slide workflow at native 200 percent zoom in ${locale}${holdSave ? ' across save completion' : ''}`;
	test(title, async ({ baseURL }, info) => {
		test.setTimeout(120_000);
		const extension = info.outputPath('zoom-extension');
		await mkdir(extension, { recursive: true });
		await writeFile(
			resolve(extension, 'manifest.json'),
			JSON.stringify({
				manifest_version: 3,
				name: 'Local slide zoom check',
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
			locale,
			reducedMotion: 'reduce',
			args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
		});
		const page = await context.newPage();
		if (holdSave) await page.clock.install({ time: new Date('2026-11-02T12:00:00Z') });
		const observations: object[] = [];
		async function inspect(control: Locator, state: string) {
			await expect(control).toBeFocused();
			const measure = () =>
				control.evaluate((element) => {
					const box = element.getBoundingClientRect();
					let left = 0,
						top = 0,
						right = innerWidth,
						bottom = innerHeight;
					for (let parent = element.parentElement; parent; parent = parent.parentElement) {
						const style = getComputedStyle(parent);
						const rect = parent.getBoundingClientRect();
						if (style.overflowX !== 'visible') {
							left = Math.max(left, rect.left);
							right = Math.min(right, rect.right);
						}
						if (style.overflowY !== 'visible') {
							top = Math.max(top, rect.top);
							bottom = Math.min(bottom, rect.bottom);
						}
					}
					const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
					const style = getComputedStyle(element);
					return {
						time: performance.now(),
						bounds: { left, top, right, bottom },
						hit: hit?.outerHTML,
						dpr: devicePixelRatio,
						visualScale: visualViewport?.scale,
						active: document.activeElement?.outerHTML,
						save: document.querySelector('.title-save')?.textContent,
						box: box.toJSON(),
						viewport: { width: innerWidth, height: innerHeight },
						fits:
							box.left >= left - 1 &&
							box.right <= right + 1 &&
							box.top >= top - 1 &&
							box.bottom <= bottom + 1,
						uncovered: hit === element || element.contains(hit),
						pageOverflow: document.documentElement.scrollWidth > innerWidth,
						cssZoom: getComputedStyle(document.documentElement).zoom,
						contentHeight:
							element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
						lineHeight: parseFloat(style.lineHeight),
						label: element.getAttribute('aria-label') ?? element.textContent,
						editorScroll: document.querySelector('[data-testid="presentation-editor"]')?.scrollTop
					};
				});
			let geometry = await measure();
			const samples = [geometry];
			await expect.soft
				.poll(
					async () => {
						geometry = await measure();
						samples.push(geometry);
						return {
							fits: state === 'welcome-new' || geometry.fits,
							uncovered: geometry.uncovered
						};
					},
					{ message: `${state}: focused control remains visible after layout`, timeout: 5000 }
				)
				.toEqual({ fits: true, uncovered: true });
			await expect(control).toBeFocused();
			observations.push({ state, ...geometry, samples });
			await info.attach(`${state}.png`, {
				body: await page.screenshot(),
				contentType: 'image/png'
			});
			expect.soft(geometry.viewport.width, state).toBe(160);
			expect.soft(geometry.cssZoom, state).toBe('1');
			expect.soft(geometry.dpr, state).toBe(2);
			expect.soft(geometry.visualScale, state).toBe(1);
			expect.soft(geometry.pageOverflow, state).toBe(false);
			if (state !== 'welcome-new')
				expect.soft(geometry.fits, `${state}: focused control fits its scroll viewport`).toBe(true);
			expect.soft(geometry.uncovered, `${state}: focused control is not covered`).toBe(true);
			expect.soft(geometry.box.height, `${state}: control has usable height`).toBeGreaterThan(10);
			if (state === 'source-input')
				expect
					.soft(geometry.contentHeight, 'Source shows at least one complete text line')
					.toBeGreaterThanOrEqual(geometry.lineHeight);
		}
		async function activate(id: string) {
			const target = page.getByTestId(id);
			await tabTo(page, target);
			await inspect(target, id);
			await page.keyboard.press('Enter');
		}
		try {
			await page.addInitScript((value) => localStorage.setItem('mdsh:locale', value), locale);
			await page.goto('/');
			await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
			// Wait for installation before checking that its temporary notice has closed.
			await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
			await expect(page.locator('[role="status"].pointer-events-auto')).toHaveCount(0, {
				timeout: 15_000
			});
			const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
			await worker.evaluate(async (origin) => {
				const tabs = (
					globalThis as unknown as {
						chrome: {
							tabs: {
								query: (query: object) => Promise<{ id: number; url: string }[]>;
								setZoom: (id: number, factor: number) => Promise<void>;
							};
						};
					}
				).chrome.tabs;
				const tab = (await tabs.query({})).find((entry) => entry.url.startsWith(origin!));
				if (!tab) throw new Error('The application tab was not found.');
				await tabs.setZoom(tab.id, 2);
			}, baseURL);
			await activate('welcome-new');
			await activate('create-presentation');
			await expect(page.getByTestId('slide-canvas')).toBeVisible();
			await expect(page.locator('[role="status"].pointer-events-auto')).toHaveCount(0);
			await activate('slide-add-text');
			await activate('slide-edit-text');
			const text = page.getByTestId('slide-text-editor');
			await expect(text).toBeFocused();
			await inspect(text, 'text-input');
			await page.keyboard.press('Control+A');
			await page.keyboard.insertText('Zoom text');
			await activate('slide-text-done');
			const notes = page.getByTestId('slide-notes');
			await tabTo(page, notes);
			await inspect(notes, 'notes-input');
			if (holdSave) await page.clock.pauseAt(new Date('2026-11-02T12:01:00Z'));
			await page.keyboard.insertText('Zoom speaker notes');
			if (holdSave) {
				const properties = page.getByTestId('slide-properties');
				await tabTo(page, properties);
				await expect(page.locator('.title-save')).toHaveText(
					locale === 'en' ? 'saving...' : 'enregistrement…'
				);
				await inspect(properties, 'properties-before-save');
				await page.clock.runFor(400);
				await page.clock.resume();
				await expect(page.locator('.title-save')).toHaveText(
					locale === 'en' ? 'saved' : 'enregistré'
				);
				await inspect(properties, 'slide-properties');
				await page.keyboard.press('Enter');
			} else await activate('slide-properties');
			const fontSize = page.getByTestId('slide-prop-fontSize');
			await tabTo(page, fontSize);
			await inspect(fontSize, 'font-size');
			await page.keyboard.press('Control+A');
			await page.keyboard.insertText('32');
			await page.keyboard.press('Tab');
			const closeProperties = page.locator('.close-properties');
			await tabTo(page, closeProperties);
			await inspect(closeProperties, 'close-properties');
			await page.keyboard.press('Enter');
			await activate('slide-advanced');
			await activate('slide-source');
			const source = page.getByTestId('slide-source-editor');
			await expect(source).toBeFocused();
			await inspect(source, 'source-input');
			const original = await source.inputValue();
			expect(original).toContain('Zoom text');
			expect(original).toContain('Zoom speaker notes');
			await page.keyboard.press('Control+A');
			const expectedSource = original.replace('Zoom text', 'Zoom source edit');
			await page.keyboard.insertText(expectedSource);
			await activate('slide-source-apply');
			await expect(page.locator('[role="status"].pointer-events-auto')).toHaveCount(0);
			await activate('slide-present');
			await expect(page.getByTestId('presentation-editor')).toHaveAttribute('role', 'dialog');
			await expect(page.locator('.slide-render')).toContainText('Zoom source edit');
			await activate('slide-present-exit');
			await expect(page.getByTestId('slide-present')).toBeFocused();
			await activate('slide-export');
			const downloadPromise = page.waitForEvent('download');
			await activate('slide-export-md');
			const download = await downloadPromise;
			const downloaded = await readFile((await download.path())!, 'utf8');
			expect(downloaded).toContain('Zoom source edit');
			expect(downloaded).toContain('Zoom speaker notes');
			expect(downloaded).toContain('"fontSize":32');
			expect(downloaded).toBe(expectedSource);
			await info.attach('exported-deck.md', { body: downloaded, contentType: 'text/markdown' });
			await expect(page.locator('.title-save')).toHaveText(
				locale === 'en' ? 'saved' : 'enregistré'
			);
			await page.reload();
			await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
			await activate('slide-advanced');
			await activate('slide-source');
			await expect(source).toHaveValue(expectedSource);
			await info.attach('reopened-deck.md', {
				body: await source.inputValue(),
				contentType: 'text/markdown'
			});
		} finally {
			await info.attach('observations.json', {
				body: JSON.stringify(
					{
						locale,
						holdSave,
						observations,
						command: process.env.REVIEW_COMMAND,
						metadata: info.config.metadata,
						browser: context.browser()?.version(),
						fixture: {
							text: 'Zoom text',
							sourceEdit: 'Zoom source edit',
							notes: 'Zoom speaker notes'
						}
					},
					null,
					2
				),
				contentType: 'application/json'
			});
			await info.attach('final.png', { body: await page.screenshot(), contentType: 'image/png' });
			await info.attach('final.aria.txt', {
				body: await page.locator('body').ariaSnapshot(),
				contentType: 'text/plain'
			});
			await context.close();
		}
	});
}

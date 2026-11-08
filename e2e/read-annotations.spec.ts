import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { largeNote } from '../scripts/benchmark-fixtures/corpus.mjs';
import { testSource } from '../scripts/test-source.mjs';
import { createFirstFile, resetAppState, writeSourceContent } from './helpers';
import { importSource } from './source-fidelity-harness';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

test('does not allocate a full-document canvas for inactive annotations', async ({
	page,
	browser
}, info) => {
	test.setTimeout(120_000);
	const content = largeNote();
	const source = testSource(info.outputPath('source'));
	const samples: {
		cycle: number;
		devicePixelRatio: number;
		scrollHeight: number;
		clientHeight: number;
		canvases: { width: number; height: number }[];
	}[] = [];
	try {
		await resetAppState(page);
		await importSource(page, content, 'large-note');
		for (let cycle = 1; cycle <= 5; cycle++) {
			await page.locator('[data-mode="read"]').click();
			await expect(page.locator('.mdsh-preview')).toBeVisible({ timeout: 30_000 });
			await expect(page.getByTestId('annotation-toggle')).toHaveAttribute('aria-pressed', 'false');
			await page.evaluate(
				() =>
					new Promise<void>((resolve) =>
						requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
					)
			);
			const dimensions = await page.locator('.mdsh-read').evaluate((scroller) => ({
				devicePixelRatio: window.devicePixelRatio,
				scrollHeight: scroller.scrollHeight,
				clientHeight: scroller.clientHeight,
				canvases: Array.from(
					scroller.parentElement!.querySelectorAll('canvas.annotation-canvas'),
					(canvas) => {
						if (!(canvas instanceof HTMLCanvasElement))
							throw new Error('Expected an annotation canvas');
						return { width: canvas.width, height: canvas.height };
					}
				)
			}));
			samples.push({ cycle, ...dimensions });
			expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);
			expect
				.soft(
					dimensions.canvases.filter(
						(canvas) =>
							canvas.width > 0 &&
							canvas.height >= Math.round(dimensions.scrollHeight * dimensions.devicePixelRatio)
					),
					`Cycle ${cycle} must not allocate a full-document annotation canvas`
				)
				.toHaveLength(0);
			if (cycle === 5) {
				await info.attach('inactive-annotations.png', {
					body: await page.screenshot(),
					contentType: 'image/png'
				});
			}
			await page.locator('[data-mode="source"]').click();
			await expect(page.locator('.cm-content').first()).toBeVisible();
		}
	} finally {
		await info.attach('inactive-annotations.json', {
			body: JSON.stringify(
				{
					...source,
					baseURL: info.project.use.baseURL,
					browser: { project: info.project.name, version: browser.version() },
					fixture: {
						generator: 'scripts/benchmark-fixtures/corpus.mjs#largeNote()',
						bytes: Buffer.byteLength(content),
						sha256: createHash('sha256').update(content).digest('hex')
					},
					samples,
					failures: info.errors.map((error) => error.message)
				},
				null,
				2
			),
			contentType: 'application/json'
		});
	}
});

async function readMode(page: Page, content = 'Annotated paragraph. '.repeat(120)) {
	await resetAppState(page);
	await createFirstFile(page);
	await writeSourceContent(page, `# Annotation\n\n${content}`);
	await page.waitForTimeout(500);
	await page.locator('[data-mode="read"]').click();
	await expect(page.locator('.mdsh-preview')).toBeVisible({ timeout: 20_000 });
}

async function inkPixels(page: Page): Promise<number> {
	return page.locator('[data-testid="annotation-canvas"]').evaluate((element) => {
		const canvas = element as HTMLCanvasElement;
		const context = canvas.getContext('2d');
		if (!context) return 0;
		const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
		let count = 0;
		for (let index = 3; index < data.length; index += 4) if (data[index] !== 0) count++;
		return count;
	});
}

async function drawOnCanvas(page: Page) {
	const box = await page.getByTestId('annotation-canvas').boundingBox();
	if (!box) throw new Error('Canvas has no box');
	await page.mouse.move(box.x + 80, box.y + 80);
	await page.mouse.down();
	await page.mouse.move(box.x + 220, box.y + 120, { steps: 8 });
	await page.mouse.move(box.x + 300, box.y + 170, { steps: 8 });
	await page.mouse.up();
}

test('draws ephemeral ink without changing the document and clears on reload', async ({
	page
}, info: TestInfo) => {
	await readMode(page);
	const contentBefore = await page.locator('.mdsh-preview').innerText();
	await page.getByTestId('annotation-toggle').click();
	await expect(page.getByTestId('annotation-toggle')).toHaveAttribute('aria-pressed', 'true');
	await expect(page.getByTestId('annotation-pen')).toHaveAttribute('aria-pressed', 'true');
	await drawOnCanvas(page);
	expect(await inkPixels(page)).toBeGreaterThan(100);

	await page.getByTestId('annotation-highlighter').click();
	await drawOnCanvas(page);
	await page.getByTestId('annotation-eraser').click();
	await expect(page.getByTestId('annotation-eraser')).toHaveAttribute('aria-pressed', 'true');
	await page.getByTestId('annotation-toggle').click();
	await expect(page.getByTestId('annotation-toggle')).toHaveAttribute('aria-pressed', 'false');
	await expect(page.getByTestId('annotation-pen')).toHaveCount(0);
	await expect(page.getByTestId('annotation-canvas')).toBeVisible();
	expect(await inkPixels(page)).toBeGreaterThan(100);

	const canvasBefore = await page.getByTestId('annotation-canvas').boundingBox();
	await page.locator('.mdsh-read').evaluate((element) => (element.scrollTop = 160));
	await inkFrame(page);
	const canvasAfter = await page.getByTestId('annotation-canvas').boundingBox();
	expect(canvasAfter?.y).toBe(canvasBefore?.y);
	expect(await inkPixels(page)).toBeGreaterThan(100);

	expect(await page.locator('.mdsh-preview').innerText()).toBe(contentBefore);
	expect(await page.locator('.title-save').innerText()).toContain('enregistré');

	await page.emulateMedia({ media: 'print' });
	await expect(page.getByTestId('annotation-canvas')).toBeHidden();
	await page.emulateMedia({ media: 'screen' });
	const pixelsBeforeReload = await inkPixels(page);

	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	await page.locator('[data-mode="read"]').click();
	await expect(page.locator('.mdsh-preview')).toBeVisible();
	await expect(page.getByTestId('annotation-canvas')).toHaveCount(0);
	await page.getByTestId('annotation-toggle').click();
	await expect(page.getByTestId('annotation-canvas')).toBeVisible();
	expect(await inkPixels(page)).toBe(0);
	expect(await page.locator('.mdsh-preview').innerText()).toContain('Annotated paragraph.');

	await info.attach('annotations.json', {
		body: JSON.stringify({
			documentUnchanged: true,
			pixelsBeforeReload,
			printHidden: true,
			clearedOnReload: true
		}),
		contentType: 'application/json'
	});
	await info.attach('annotations.png', { body: await page.screenshot() });
});

async function inkFrame(page: Page) {
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			)
	);
}

async function readLargeNote(page: Page) {
	await page.locator('[data-mode="read"]').click();
	const prompt = page.getByRole('dialog', { name: 'Afficher ce document volumineux ?' });
	await expect(prompt).toBeVisible();
	await prompt.getByRole('button', { name: 'Afficher le document', exact: true }).click();
	await expect(page.locator('.mdsh-preview')).toBeVisible({ timeout: 60_000 });
}

async function inkAlpha(page: Page, x: number, y: number) {
	return page.getByTestId('annotation-canvas').evaluate(
		(element, point) => {
			const canvas = element as HTMLCanvasElement;
			const rect = canvas.getBoundingClientRect();
			return canvas
				.getContext('2d')!
				.getImageData(
					Math.round((point.x * canvas.width) / rect.width),
					Math.round((point.y * canvas.height) / rect.height),
					1,
					1
				).data[3]!;
		},
		{ x, y }
	);
}

async function inkLine(page: Page, y: number, from = 100, to = 280) {
	const box = await page.getByTestId('annotation-canvas').boundingBox();
	if (!box) throw new Error('Canvas has no box');
	await page.mouse.move(box.x + from, box.y + y);
	await page.mouse.down();
	await page.mouse.move(box.x + to, box.y + y, { steps: 12 });
	await page.mouse.up();
	await inkFrame(page);
}

test.describe('viewport ink', () => {
	test.use({ deviceScaleFactor: 2 });

	for (const bytes of [1_000_000, 5_000_000]) {
		test(`bounds active ink on a ${bytes} byte note`, async ({ page, browser }, info) => {
			test.setTimeout(120_000);
			const paragraph = 'Long annotation target. '.repeat(100) + '\n\n';
			const content = paragraph.repeat(Math.ceil(bytes / paragraph.length)).slice(0, bytes);
			const source = testSource(info.outputPath('source'));
			const samples: unknown[] = [];
			try {
				await resetAppState(page);
				await importSource(page, content, `ink-${bytes}`);
				await readLargeNote(page);
				await page.getByTestId('annotation-toggle').click();
				await inkFrame(page);
				const dimensions = await page.locator('.mdsh-read').evaluate((scroller) => {
					const canvas = document.querySelector<HTMLCanvasElement>(
						'[data-testid="annotation-canvas"]'
					)!;
					return {
						dpr: devicePixelRatio,
						viewport: { width: scroller.clientWidth, height: scroller.clientHeight },
						document: { width: scroller.scrollWidth, height: scroller.scrollHeight },
						canvas: {
							width: canvas.width,
							height: canvas.height,
							bytes: canvas.width * canvas.height * 4
						}
					};
				});
				samples.push({ dimensions });
				expect(dimensions.document.height).toBeGreaterThan(dimensions.viewport.height * 100);
				expect(dimensions.canvas.width).toBeLessThanOrEqual(
					Math.ceil(dimensions.viewport.width * dimensions.dpr)
				);
				expect(dimensions.canvas.height).toBeLessThanOrEqual(
					Math.ceil(dimensions.viewport.height * dimensions.dpr)
				);
				expect(dimensions.canvas.width).toBeLessThanOrEqual(4096);
				expect(dimensions.canvas.height).toBeLessThanOrEqual(4096);
				expect(dimensions.canvas.bytes).toBeLessThanOrEqual(16 * 1024 * 1024);
				await inkLine(page, 180);
				expect(await inkAlpha(page, 180, 180)).toBeGreaterThan(240);
				await page.getByTestId('annotation-eraser').click();
				await inkLine(page, 180, 170, 190);
				expect(await inkAlpha(page, 180, 180)).toBe(0);
				const timings = await page.locator('.mdsh-read').evaluate(async (scroller) => {
					const raw: number[] = [];
					for (let step = 1; step <= 20; step++) {
						const start = performance.now();
						scroller.scrollTop = step * 300;
						await new Promise<void>((resolve) =>
							requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
						);
						raw.push(performance.now() - start);
					}
					return raw;
				});
				const sorted = [...timings].sort((a, b) => a - b);
				const heap =
					info.project.name === 'chromium'
						? await (async () => {
								const session = await page.context().newCDPSession(page);
								try {
									return await session.send('Runtime.getHeapUsage');
								} finally {
									await session.detach();
								}
							})()
						: { unavailable: 'This engine has no Chromium heap endpoint.' };
				samples.push({
					scrollToTwoFramesMs: { raw: timings, p50: sorted[9], p95: sorted[18] },
					heap,
					timingGate: false
				});
				await info.attach('long-note-ink.png', {
					body: await page.screenshot(),
					contentType: 'image/png'
				});
				await page.reload();
				await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
				await readLargeNote(page);
				await expect(page.getByTestId('annotation-canvas')).toHaveCount(0);
			} finally {
				await info.attach('viewport-ink.json', {
					body: JSON.stringify(
						{
							...source,
							browser: { project: info.project.name, version: browser.version() },
							buildMode: 'production, source-fidelity instrumentation',
							fixture: {
								bytes: Buffer.byteLength(content),
								sha256: createHash('sha256').update(content).digest('hex'),
								generator:
									'100 copies of Long annotation target. per paragraph, repeated and sliced to bytes'
							},
							samples,
							failures: info.errors.map((error) => error.message)
						},
						null,
						2
					),
					contentType: 'application/json'
				});
			}
		});
	}

	test('projects pen, highlighter and eraser in document space and culls offscreen ink', async ({
		page
	}, info) => {
		await readMode(
			page,
			'Scroll target. '.repeat(4000) + '\n\n```text\n' + 'wide'.repeat(800) + '\n```'
		);
		await page.locator('.mdsh-preview').evaluate((article) => {
			(article as HTMLElement).style.minWidth = '2200px';
		});
		await page.getByTestId('annotation-toggle').click();
		await inkFrame(page);
		await inkLine(page, 180);
		await page.getByTestId('annotation-highlighter').click();
		await inkLine(page, 240);
		const alpha = await inkAlpha(page, 180, 240);
		expect(alpha).toBeGreaterThan(70);
		expect(alpha).toBeLessThan(110);
		await page.getByTestId('annotation-eraser').click();
		await inkLine(page, 180, 170, 190);
		expect(await inkAlpha(page, 180, 180)).toBe(0);
		expect(await inkAlpha(page, 130, 180)).toBeGreaterThan(240);
		await info.attach('ink-before-scroll.png', { body: await page.screenshot() });
		await page.locator('.mdsh-read').evaluate((scroller) => {
			scroller.scrollTop = 100;
			scroller.scrollLeft = 60;
		});
		await inkFrame(page);
		expect(await inkAlpha(page, 70, 80)).toBeGreaterThan(240);
		expect(await inkAlpha(page, 120, 80)).toBe(0);
		expect(await inkAlpha(page, 120, 140)).toBe(alpha);
		await page.setViewportSize({ width: 1100, height: 800 });
		await inkFrame(page);
		expect(await inkAlpha(page, 120, 140)).toBe(alpha);
		await info.attach('ink-after-resize.png', { body: await page.screenshot() });
		const replayed = await page.evaluate(async () => {
			const original = CanvasRenderingContext2D.prototype.stroke;
			let count = 0;
			CanvasRenderingContext2D.prototype.stroke = function (...args: Parameters<typeof original>) {
				count++;
				return original.apply(this, args);
			};
			try {
				document.querySelector('.mdsh-read')!.scrollTop = 3000;
				await new Promise<void>((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
				);
				return count;
			} finally {
				CanvasRenderingContext2D.prototype.stroke = original;
			}
		});
		expect(replayed).toBe(0);
		expect(await inkPixels(page)).toBe(0);
		await page.getByTestId('annotation-pen').click();
		await inkLine(page, 200);
		expect(await inkAlpha(page, 180, 200)).toBeGreaterThan(240);
		await page.locator('.mdsh-read').evaluate((scroller) => {
			scroller.scrollTop = 100;
		});
		await inkFrame(page);
		expect(await inkAlpha(page, 70, 80)).toBeGreaterThan(240);
		expect(await inkAlpha(page, 120, 80)).toBe(0);
		await info.attach('ink-return.png', { body: await page.screenshot() });
		const firstId = await page
			.locator('aside button[data-file-id][aria-current="true"]')
			.getAttribute('data-file-id');
		await importSource(page, '# Separate file\n\nNo inherited ink.', 'separate-ink');
		await expect(page.locator('.mdsh-preview')).toContainText('No inherited ink.');
		await inkFrame(page);
		expect(await inkPixels(page)).toBe(0);
		await page.locator(`aside button[data-file-id="${firstId}"]`).click();
		await expect(page.locator('.mdsh-preview')).toContainText('Scroll target.');
		await inkFrame(page);
		expect(await inkPixels(page)).toBe(0);
		await info.attach('projection.json', {
			body: JSON.stringify({
				...testSource(info.outputPath('source')),
				highlighterAlpha: alpha,
				offscreenReplayCount: replayed,
				documentSpace: true,
				fileIsolation: true
			}),
			contentType: 'application/json'
		});
	});

	test('retains ink through DPR changes and scaled pointer input with a fixed bitmap cap', async ({
		page
	}, info) => {
		await readMode(page);
		await page.getByTestId('annotation-toggle').click();
		await inkFrame(page);
		await inkLine(page, 180);
		await page.evaluate(() => {
			Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 16 });
			window.dispatchEvent(new Event('resize'));
		});
		await inkFrame(page);
		const capped = await page.getByTestId('annotation-canvas').evaluate((el) => {
			const c = el as HTMLCanvasElement;
			return { width: c.width, height: c.height, bytes: c.width * c.height * 4 };
		});
		expect(capped.width).toBeLessThanOrEqual(4096);
		expect(capped.height).toBeLessThanOrEqual(4096);
		expect(capped.bytes).toBeLessThanOrEqual(16 * 1024 * 1024);
		expect(await inkAlpha(page, 180, 180)).toBeGreaterThan(240);
		await page.evaluate(() => {
			Reflect.deleteProperty(window, 'devicePixelRatio');
			(document.querySelector('.mdsh-read-wrapper') as HTMLElement).style.zoom = '1.25';
			window.dispatchEvent(new Event('resize'));
		});
		await inkFrame(page);
		const box = await page.getByTestId('annotation-canvas').boundingBox();
		if (!box) throw new Error('Canvas has no box');
		await page.mouse.move(box.x + 100 * 1.25, box.y + 240 * 1.25);
		await page.mouse.down();
		await page.mouse.move(box.x + 280 * 1.25, box.y + 240 * 1.25, { steps: 12 });
		await page.mouse.up();
		await inkFrame(page);
		await page.locator('.mdsh-read-wrapper').evaluate((el) => {
			(el as HTMLElement).style.zoom = '1';
		});
		await inkFrame(page);
		expect(await inkAlpha(page, 180, 180)).toBeGreaterThan(240);
		expect(await inkAlpha(page, 180, 240)).toBeGreaterThan(240);
		await info.attach('dpr-and-scale.png', { body: await page.screenshot() });
		await info.attach('dpr-and-scale.json', {
			body: JSON.stringify({
				...testSource(info.outputPath('source')),
				capped,
				physicalDpr: 2,
				injectedDpr: 16,
				cssZoom: 1.25,
				nativeBrowserZoom: 'not tested'
			}),
			contentType: 'application/json'
		});
	});

	test('keeps a captured stroke that crosses many offscreen ranges', async ({ page }, info) => {
		test.setTimeout(120_000);
		await resetAppState(page);
		await importSource(page, 'Long annotation target. '.repeat(16000), 'long-stroke');
		await readLargeNote(page);
		await page.getByTestId('annotation-toggle').click();
		await inkFrame(page);
		const box = await page.getByTestId('annotation-canvas').boundingBox();
		if (!box) throw new Error('Canvas has no box');
		await page.mouse.move(box.x + 100, box.y + 180);
		await page.mouse.down();
		await page.locator('.mdsh-read').evaluate((scroller) => {
			scroller.scrollTop = 80000;
		});
		await inkFrame(page);
		await page.mouse.move(box.x + 100, box.y + 220);
		await page.mouse.up();
		await page.locator('.mdsh-read').evaluate((scroller) => {
			scroller.scrollTop = 40000;
		});
		await inkFrame(page);
		expect(await inkAlpha(page, 100, 200)).toBeGreaterThan(240);
		await info.attach('long-stroke.png', { body: await page.screenshot() });
	});
});

test('clears all ink and exposes tools to the keyboard', async ({ page }) => {
	await readMode(page, 'Short annotation target.');
	await page.getByTestId('annotation-toggle').click();
	await drawOnCanvas(page);
	expect(await inkPixels(page)).toBeGreaterThan(0);
	await page.getByTestId('annotation-clear').click();
	await inkFrame(page);
	expect(await inkPixels(page)).toBe(0);

	await page.getByTestId('annotation-toggle').focus();
	await page.keyboard.press('Space');
	await expect(page.getByTestId('annotation-toggle')).toHaveAttribute('aria-pressed', 'false');
	await expect(page.getByTestId('annotation-pen')).toHaveCount(0);
	await expect(page.getByTestId('annotation-canvas')).toHaveCount(0);
	await page.setViewportSize({ width: 390, height: 700 });
	await page.getByTestId('annotation-toggle').click();
	await expect(page.getByTestId('annotation-pen')).toBeVisible();
	await expect(page.getByTestId('annotation-clear')).toBeVisible();
});

test('keeps the ink viewport fixed in the native scroll task', async ({ page, browser }, info) => {
	const content = 'Scroll target. '.repeat(4000) + '\n\n```text\n' + 'wide'.repeat(800) + '\n```';
	await readMode(page, content);
	await page.locator('.mdsh-preview').evaluate((article) => {
		(article as HTMLElement).style.minWidth = '2200px';
	});
	await page.getByTestId('annotation-toggle').click();
	await inkLine(page, 180);
	const sample = await page.locator('.mdsh-read').evaluate((scroller) => {
		const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="annotation-canvas"]');
		if (!canvas) throw new Error('Canvas is missing');
		const box = (element: Element) => {
			const { x, y, width, height } = element.getBoundingClientRect();
			return { x, y, width, height };
		};
		const before = {
			scroll: { left: scroller.scrollLeft, top: scroller.scrollTop },
			scroller: box(scroller),
			canvas: box(canvas),
			client: { width: scroller.clientWidth, height: scroller.clientHeight },
			transform: getComputedStyle(canvas).transform
		};
		scroller.scrollTop = before.scroll.top + 160;
		scroller.scrollLeft = before.scroll.left + 60;
		return {
			before,
			after: {
				scroll: { left: scroller.scrollLeft, top: scroller.scrollTop },
				scroller: box(scroller),
				canvas: box(canvas),
				client: { width: scroller.clientWidth, height: scroller.clientHeight },
				transform: getComputedStyle(canvas).transform
			},
			sameCanvas:
				canvas.isConnected &&
				document.querySelector('[data-testid="annotation-canvas"]') === canvas,
			sameScroller: scroller.isConnected && document.querySelector('.mdsh-read') === scroller
		};
	});
	try {
		expect(sample.sameCanvas).toBe(true);
		expect(sample.sameScroller).toBe(true);
		expect(sample.after.scroller).toEqual(sample.before.scroller);
		expect(sample.after.client).toEqual(sample.before.client);
		expect(sample.after.scroll.top - sample.before.scroll.top).toBe(160);
		expect(sample.after.scroll.left - sample.before.scroll.left).toBe(60);
		expect(sample.after.canvas.y).toBe(sample.before.canvas.y);
		expect(sample.after.canvas.x).toBe(sample.before.canvas.x);
		expect(sample.after.canvas.width).toBe(sample.after.client.width);
		expect(sample.after.canvas.height).toBe(sample.after.client.height);
	} finally {
		await info.attach('native-scroll-position.json', {
			body: JSON.stringify({
				...testSource(info.outputPath('source')),
				browser: { project: info.project.name, version: browser.version() },
				fixture: {
					bytes: Buffer.byteLength(content),
					sha256: createHash('sha256').update(content).digest('hex')
				},
				sample,
				failures: info.errors.map((error) => error.message)
			}),
			contentType: 'application/json'
		});
		await info.attach('native-scroll-position.png', { body: await page.screenshot() });
	}
});

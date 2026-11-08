import { createHash } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { resetAppState } from './helpers';
import {
	createPresentation,
	openPresentationSource,
	presentationFixture
} from './presentation-helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

async function resetEnglishApp(page: Page): Promise<void> {
	await resetAppState(page);
	await page.evaluate(() => localStorage.setItem('mdsh:locale', 'en'));
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
}

interface PresentationCacheStats {
	entries: number;
	bytes: number;
	limitBytes: number;
	limitEntries: number;
	hits: number;
	misses: number;
	evictions: number;
	oversized: number;
	inFlight: number;
}

async function presentationCacheStats(page: Page): Promise<PresentationCacheStats> {
	return page.evaluate(() => {
		const read = (
			window as unknown as { __MDSH_PRESENTATION_CACHE__?: () => PresentationCacheStats }
		).__MDSH_PRESENTATION_CACHE__;
		if (!read) throw new Error('Presentation cache instrumentation is unavailable.');
		return read();
	});
}

async function waitForVisibleThumbnailText(strip: Locator): Promise<void> {
	await expect
		.poll(
			() =>
				strip.evaluate((element) => {
					const bounds = element.getBoundingClientRect();
					return Array.from(
						element.querySelectorAll<HTMLButtonElement>('[data-testid="slide-thumbnail"]')
					).filter((button) => {
						const preview = button.querySelector('.thumbnail');
						if (!preview) return false;
						const box = preview.getBoundingClientRect();
						const inViewport = box.bottom > bounds.top && box.top < bounds.bottom;
						return inViewport && !preview.textContent?.includes('Thumbnail retention sentinel');
					}).length;
				}),
			{ timeout: 5_000, intervals: [50, 100, 200] }
		)
		.toBe(0);
}

test('keeps a representative 20-slide deck responsive during a real drag', async ({
	page
}, testInfo) => {
	test.skip(testInfo.project.name !== 'chromium', 'performance evidence uses Chromium timing');
	test.setTimeout(90_000);
	await resetEnglishApp(page);
	const editor = await createPresentation(page);

	for (let index = 0; index < 10; index++) {
		await editor.getByTestId('slide-add-rectangle').click();
	}
	for (let index = 1; index < 20; index++) {
		await editor.getByTestId('slide-duplicate-slide').click();
	}
	await expect(editor.getByTestId('slide-thumbnail')).toHaveCount(20);
	const firstRectangle = editor
		.locator('[data-testid="slide-object"][data-object-type="rectangle"]')
		.first();
	const firstRectangleId = await firstRectangle.getAttribute('data-object-id');
	if (!firstRectangleId) throw new Error('The performance target identifier is missing.');
	await editor.getByTestId('slide-object-list-item').first().click();
	await editor.getByTestId('slide-front').click();

	await openPresentationSource(editor);
	const source = await editor.getByTestId('slide-source-editor').inputValue();
	const metadataMatch = source.match(/<!-- mdsh-presentation\n([\s\S]*?)\n-->\s*$/);
	if (!metadataMatch) throw new Error('Presentation metadata is missing.');
	const metadata = JSON.parse(metadataMatch[1]) as {
		slides: Array<{ elements: unknown[] }>;
	};
	const objectCount = metadata.slides.reduce((total, slide) => total + slide.elements.length, 0);
	expect(metadata.slides).toHaveLength(20);
	expect(objectCount).toBe(200);
	await editor.getByTestId('slide-source-cancel').click();

	const rectangle = editor.locator(
		`[data-testid="slide-object"][data-object-id="${firstRectangleId}"]`
	);
	// Wait for the fitted canvas to settle after the Source view closes.
	await rectangle.click({ trial: true });
	const before = await rectangle.boundingBox();
	if (!before) throw new Error('The performance target is not visible.');

	await page.evaluate(() => {
		const state = {
			frames: [] as number[],
			longTasks: [] as number[],
			running: true,
			lastFrame: 0,
			observer: undefined as PerformanceObserver | undefined
		};
		const tick = (timestamp: number) => {
			if (!state.running) return;
			if (state.lastFrame > 0) state.frames.push(timestamp - state.lastFrame);
			state.lastFrame = timestamp;
			requestAnimationFrame(tick);
		};
		if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
			state.observer = new PerformanceObserver((list) => {
				state.longTasks.push(...list.getEntries().map((entry) => entry.duration));
			});
			state.observer.observe({ entryTypes: ['longtask'] });
		}
		(
			globalThis as typeof globalThis & { __presentationTiming?: typeof state }
		).__presentationTiming = state;
		requestAnimationFrame(tick);
	});

	const startX = before.x + before.width / 2;
	const startY = before.y + before.height / 2;
	await page.mouse.move(startX, startY);
	await page.mouse.down();
	for (let step = 1; step <= 40; step++) {
		await page.mouse.move(startX + step * 2, startY + step, { steps: 1 });
		await page.evaluate(
			() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
		);
	}
	await page.mouse.up();

	const metrics = await page.evaluate(() => {
		const state = (
			globalThis as typeof globalThis & {
				__presentationTiming: {
					frames: number[];
					longTasks: number[];
					running: boolean;
					observer?: PerformanceObserver;
				};
			}
		).__presentationTiming;
		state.running = false;
		state.observer?.disconnect();
		const frames = [...state.frames].sort((a, b) => a - b);
		const percentile = (fraction: number) =>
			frames[Math.min(frames.length - 1, Math.floor(frames.length * fraction))] ?? Infinity;
		return {
			frameCount: frames.length,
			medianFrameMs: percentile(0.5),
			p95FrameMs: percentile(0.95),
			maxFrameMs: frames.at(-1) ?? Infinity,
			longTasksMs: state.longTasks,
			maxLongTaskMs: Math.max(0, ...state.longTasks)
		};
	});
	const after = await rectangle.boundingBox();

	await testInfo.attach('presentation-performance.md', {
		body: source,
		contentType: 'text/markdown'
	});
	await testInfo.attach('presentation-performance.json', {
		body: JSON.stringify(
			{
				command:
					'npm run test:e2e -- presentation-performance.spec.ts --project=chromium --workers=1',
				project: testInfo.project.name,
				fixture: { slides: metadata.slides.length, objects: objectCount },
				movement: { x: after!.x - before.x, y: after!.y - before.y },
				metrics
			},
			null,
			2
		),
		contentType: 'application/json'
	});
	expect(after!.x - before.x).toBeGreaterThan(50);
	expect(after!.y - before.y).toBeGreaterThan(20);
	expect(metrics.frameCount).toBeGreaterThanOrEqual(30);
	expect(metrics.p95FrameMs).toBeLessThanOrEqual(50);
	expect(metrics.maxLongTaskMs).toBeLessThanOrEqual(100);
});

test('releases offscreen thumbnail previews after visiting a 300-slide deck', async ({
	page
}, testInfo) => {
	test.setTimeout(180_000);
	await page.setViewportSize({ width: 1280, height: 900 });
	const fixture = presentationFixture(
		Array.from({ length: 300 }, (_, index) => `Thumbnail retention sentinel ${index + 1}`)
	);
	await testInfo.attach('thumbnail-retention-fixture.md', {
		body: fixture,
		contentType: 'text/markdown'
	});
	await resetEnglishApp(page);
	const editor = await createPresentation(page);
	await openPresentationSource(editor);
	await editor.getByTestId('slide-source-editor').fill(fixture);
	await editor.getByTestId('slide-source-apply').click();
	await expect(editor.getByTestId('slide-thumbnail')).toHaveCount(300);
	const strip = editor.locator('.thumbnails');
	await expect(strip.locator('.thumbnail .mdsh-slide').first()).toBeVisible();
	const dimensions = await strip.evaluate((element) => ({
		height: element.clientHeight,
		maximum: element.scrollHeight - element.clientHeight
	}));
	expect(dimensions.height).toBeGreaterThan(0);
	expect(dimensions.maximum).toBeGreaterThan(dimensions.height * 2);
	const steps = Math.ceil(dimensions.maximum / (dimensions.height * 0.8));
	const samples = [];
	for (let cycle = 0; cycle < 2; cycle++) {
		for (const direction of ['forward', 'backward'] as const) {
			for (let step = 0; step <= steps; step++) {
				const fraction = direction === 'forward' ? step / steps : 1 - step / steps;
				await strip.evaluate(
					(element, top) => element.scrollTo({ top, behavior: 'instant' }),
					dimensions.maximum * fraction
				);
				// IntersectionObserver delivers after layout, not with the scroll assignment.
				await page.waitForTimeout(60);
				await waitForVisibleThumbnailText(strip);
				const sample = await strip.evaluate(async (element) => {
					await new Promise<void>((resolve) =>
						requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
					);
					const bounds = element.getBoundingClientRect();
					const visible: string[] = [];
					const eligible: string[] = [];
					const mounted: string[] = [];
					const missingVisible: string[] = [];
					for (const button of element.querySelectorAll<HTMLButtonElement>(
						'[data-testid="slide-thumbnail"]'
					)) {
						const id = button.dataset.slideId ?? '';
						const preview = button.querySelector('.thumbnail');
						if (!preview) throw new Error('A thumbnail preview placeholder is missing.');
						const box = preview.getBoundingClientRect();
						const inViewport = box.bottom > bounds.top && box.top < bounds.bottom;
						const inOverscan = box.bottom > bounds.top - 160 && box.top < bounds.bottom + 160;
						const pinned =
							button.getAttribute('aria-current') === 'true' ||
							button.contains(document.activeElement);
						if (inViewport) visible.push(id);
						if (inOverscan || pinned) eligible.push(id);
						if (preview.querySelector('.mdsh-slide')) mounted.push(id);
						if (inViewport && !preview.textContent?.includes('Thumbnail retention sentinel'))
							missingVisible.push(id);
					}
					return {
						scrollTop: element.scrollTop,
						viewport: { top: bounds.top, bottom: bounds.bottom, height: element.clientHeight },
						visible,
						eligible,
						mounted,
						missingVisible,
						nodes: element.querySelectorAll('*').length,
						focusedSlide:
							document.activeElement?.closest('[data-slide-id]')?.getAttribute('data-slide-id') ??
							null
					};
				});
				samples.push({ cycle, direction, step, ...sample });
			}
		}
	}
	await testInfo.attach('thumbnail-retention.json', {
		body: JSON.stringify(
			{
				command:
					"npm run test:e2e -- e2e/presentation-performance.spec.ts --project=chromium --workers=1 --retries=0 --grep 'releases offscreen thumbnail previews'",
				fixture: {
					slides: 300,
					bytes: Buffer.byteLength(fixture),
					sha256: createHash('sha256').update(fixture).digest('hex')
				},
				browser: { project: testInfo.project.name, version: page.context().browser()?.version() },
				method: {
					overscanCssPx: 160,
					cycles: 2,
					stepViewportFraction: 0.8,
					observerSettleMs: 60,
					dimensions,
					steps
				},
				cache: await presentationCacheStats(page),
				samples
			},
			null,
			2
		),
		contentType: 'application/json'
	});
	await testInfo.attach('thumbnail-retention.png', {
		body: await page.screenshot(),
		contentType: 'image/png'
	});
	expect(samples.every((sample) => sample.visible.length > 0)).toBe(true);
	expect(samples.flatMap((sample) => sample.missingVisible)).toEqual([]);
	expect(
		Math.max(...samples.map((sample) => sample.mounted.length - sample.eligible.length)),
		'Only visible, overscan and explicitly pinned rich previews can remain mounted.'
	).toBeLessThanOrEqual(0);
	const cache = await presentationCacheStats(page);
	console.log('thumbnail-retention-cache', JSON.stringify(cache));
	console.log(
		'thumbnail-retention-mounts',
		JSON.stringify({ maxMounted: Math.max(...samples.map((sample) => sample.mounted.length)) })
	);
	expect(cache.bytes).toBeLessThanOrEqual(cache.limitBytes);
	expect(cache.entries).toBeLessThanOrEqual(cache.limitEntries);
	await expect(editor.getByTestId('slide-thumbnail')).toHaveCount(300);
	await expect(editor.getByTestId('slide-thumbnail').first()).toHaveAttribute(
		'aria-current',
		'true'
	);
});

test('bounds the presentation content cache under unique large slides', async ({
	page
}, testInfo) => {
	test.skip(testInfo.project.name !== 'chromium', 'performance evidence uses Chromium timing');
	test.setTimeout(120_000);
	await page.setViewportSize({ width: 1280, height: 900 });
	const payload = 'Cache pressure sentence with unique words. '.repeat(240);
	const fixture = presentationFixture(
		Array.from({ length: 300 }, (_, index) => `${payload} Unique slide ${index + 1}`)
	);
	await resetEnglishApp(page);
	const editor = await createPresentation(page);
	await openPresentationSource(editor);
	await editor.getByTestId('slide-source-editor').fill(fixture);
	await editor.getByTestId('slide-source-apply').click();
	await expect(editor.getByTestId('slide-thumbnail')).toHaveCount(300);
	const strip = editor.locator('.thumbnails');
	await expect(strip.locator('.thumbnail .mdsh-slide').first()).toBeVisible();
	const maximum = await strip.evaluate((element) => element.scrollHeight - element.clientHeight);
	expect(maximum).toBeGreaterThan(0);
	for (let top = 0; top <= maximum; top += 600) {
		await strip.evaluate(
			(element, value) => element.scrollTo({ top: value, behavior: 'instant' }),
			Math.min(top, maximum)
		);
		await page.waitForTimeout(40);
	}
	await expect
		.poll(async () => (await presentationCacheStats(page)).misses, { timeout: 45_000 })
		.toBeGreaterThanOrEqual(300);
	await expect
		.poll(async () => (await presentationCacheStats(page)).inFlight, { timeout: 45_000 })
		.toBe(0);
	const stats = await presentationCacheStats(page);
	console.log('presentation-cache-bounds', JSON.stringify(stats));
	await testInfo.attach('presentation-cache-bounds.json', {
		body: JSON.stringify(
			{
				command:
					"npm run test:e2e -- e2e/presentation-performance.spec.ts --project=chromium --workers=1 --retries=0 --grep 'bounds the presentation content cache'",
				fixture: {
					slides: 300,
					bytes: Buffer.byteLength(fixture),
					sha256: createHash('sha256').update(fixture).digest('hex')
				},
				browser: { project: testInfo.project.name, version: page.context().browser()?.version() },
				stats
			},
			null,
			2
		),
		contentType: 'application/json'
	});
	expect(stats.entries).toBeLessThanOrEqual(stats.limitEntries);
	expect(stats.bytes).toBeLessThanOrEqual(stats.limitBytes);
	expect(stats.evictions).toBeGreaterThan(0);
	expect(stats.inFlight).toBe(0);
});

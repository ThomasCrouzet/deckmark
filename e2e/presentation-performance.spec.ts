import { expect, test, type Page } from '@playwright/test';
import { resetAppState } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

async function resetEnglishApp(page: Page): Promise<void> {
	await resetAppState(page);
	await page.evaluate(() => localStorage.setItem('mdsh:locale', 'en'));
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
}

test('keeps a representative 20-slide deck responsive during a real drag', async ({
	page
}, testInfo) => {
	test.skip(testInfo.project.name !== 'chromium', 'performance evidence uses Chromium timing');
	test.setTimeout(90_000);
	await resetEnglishApp(page);
	await page.getByTestId('slides-open').click();
	const editor = page.getByTestId('presentation-editor');
	await expect(editor).toBeVisible({ timeout: 15_000 });

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

	await editor.getByTestId('slide-source').click();
	const source = await editor.getByTestId('slide-source-editor').inputValue();
	const metadataMatch = source.match(/<!-- mdsh-presentation\n([\s\S]*?)\n-->\s*$/);
	if (!metadataMatch) throw new Error('Presentation metadata is missing.');
	const metadata = JSON.parse(metadataMatch[1]) as {
		slides: Array<{ elements: unknown[] }>;
	};
	const objectCount = metadata.slides.reduce((total, slide) => total + slide.elements.length, 0);
	expect(metadata.slides).toHaveLength(20);
	expect(objectCount).toBe(200);
	await editor.getByTestId('slide-source').click();

	const rectangle = editor.locator(
		`[data-testid="slide-object"][data-object-id="${firstRectangleId}"]`
	);
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
	expect(after!.x - before.x).toBeGreaterThan(50);
	expect(after!.y - before.y).toBeGreaterThan(20);
	expect(metrics.frameCount).toBeGreaterThanOrEqual(30);
	expect(metrics.p95FrameMs).toBeLessThanOrEqual(50);
	expect(metrics.maxLongTaskMs).toBeLessThanOrEqual(100);

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
});

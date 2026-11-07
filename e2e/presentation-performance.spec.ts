import { expect, test, type Page } from '@playwright/test';
import { resetAppState } from './helpers';
import {
	createPresentation,
	importMarkdown,
	openPresentationSource,
	presentationFixture,
	waitForPresentation
} from './presentation-helpers';
import { createHash } from 'node:crypto';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

async function resetEnglishApp(page: Page): Promise<void> {
	await resetAppState(page);
	await page.evaluate(() => localStorage.setItem('mdsh:locale', 'en'));
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
}

for (const slideCount of [100, 300]) {
	for (const inputKind of ['text', 'notes']) {
		test(`coalesces large deck ${slideCount} ${inputKind} typing`, async ({ page }, info) => {
			test.setTimeout(90_000);
			await resetEnglishApp(page);
			const fixture = presentationFixture(
				Array.from({ length: slideCount }, (_, index) => `# Slide ${index + 1}\n\nLocal text.`)
			);
			await importMarkdown(page, fixture);
			const editor = await waitForPresentation(page);
			if (inputKind === 'text') await editor.getByTestId('slide-object').first().dblclick();
			const input = editor.getByTestId(inputKind === 'text' ? 'slide-text-editor' : 'slide-notes');
			await input.focus();
			await input.press('End');
			const initial = await input.inputValue();
			const session = await page.context().newCDPSession(page);
			await session.send('Performance.enable');
			const before = await session.send('Performance.getMetrics');
			await session.send('Profiler.enable');
			await session.send('Profiler.start');
			const samples = await input.evaluate(async (field: HTMLTextAreaElement) => {
				const counts: Record<string, number> = {};
				const count = (event: Event) => {
					const detail = (event as CustomEvent<{ kind: string; name: string }>).detail;
					if (detail.kind === 'counter') counts[detail.name] = (counts[detail.name] ?? 0) + 1;
				};
				window.addEventListener('deckmark:editor-perf', count);
				const paint: number[] = [];
				const synchronous: number[] = [];
				const frames: number[] = [];
				let lastFrame = performance.now();
				for (const character of 'abcdefghijklmnopqrstuvwx') {
					const start = performance.now();
					field.setRangeText(character, field.selectionStart, field.selectionEnd, 'end');
					field.dispatchEvent(new InputEvent('input', { bubbles: true, data: character }));
					synchronous.push(performance.now() - start);
					await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
					paint.push(performance.now() - start);
					frames.push(performance.now() - lastFrame);
					lastFrame = performance.now();
				}
				window.removeEventListener('deckmark:editor-perf', count);
				return {
					paint,
					synchronous,
					frames,
					counts,
					value: field.value,
					focused: document.activeElement === field
				};
			});
			const profile = await session.send('Profiler.stop');
			const after = await session.send('Performance.getMetrics');
			await info.attach('typing-cpu-profile.json', {
				body: JSON.stringify(profile),
				contentType: 'application/json'
			});
			const percentile = (values: number[], fraction: number) =>
				[...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
			await info.attach('large-deck-typing.json', {
				body: JSON.stringify(
					{
						slideCount,
						inputKind,
						fixtureSha256: createHash('sha256').update(fixture).digest('hex'),
						browser: await page.context().browser()!.version(),
						samples,
						before,
						after,
						p50: percentile(samples.paint, 0.5),
						p95: percentile(samples.paint, 0.95),
						method:
							'24 in-page textarea insertions, each followed by one animation frame; excludes driver IPC'
					},
					null,
					2
				),
				contentType: 'application/json'
			});
			await info.attach('large-deck-fixture.md', { body: fixture, contentType: 'text/markdown' });
			expect(samples.value).toBe(initial + 'abcdefghijklmnopqrstuvwx');
			expect(samples.focused).toBe(true);
			expect(samples.counts['presentation.serialize'] ?? 0).toBeLessThan(12);
			expect(samples.counts['presentation.parse'] ?? 0).toBeLessThan(12);
			await expect(editor.locator('.save-state')).toHaveText('saved');
			await expect(input).toBeFocused();
			await expect(input).toHaveValue(samples.value);
			await page.reload();
			if (inputKind === 'text') {
				await editor.getByTestId('slide-object').first().dblclick();
				await expect(editor.getByTestId('slide-text-editor')).toHaveValue(samples.value);
			} else await expect(editor.getByTestId('slide-notes')).toHaveValue(samples.value);
		});
	}
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

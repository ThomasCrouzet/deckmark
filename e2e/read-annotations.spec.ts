import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { largeNote } from '../scripts/benchmark-fixtures/corpus.mjs';
import { testSource } from '../scripts/test-source.mjs';
import { createFirstFile, resetAppState, seedFiles, writeSourceContent } from './helpers';

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
		await seedFiles(page, [{ name: 'large-note.md', content }]);
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
				canvases: Array.from(scroller.querySelectorAll('canvas.annotation-canvas'), (canvas) => {
					if (!(canvas instanceof HTMLCanvasElement))
						throw new Error('Expected an annotation canvas');
					return { width: canvas.width, height: canvas.height };
				})
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
	const canvasAfter = await page.getByTestId('annotation-canvas').boundingBox();
	expect((canvasAfter?.y ?? 0) < (canvasBefore?.y ?? 0)).toBe(true);
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

test('clears all ink and exposes tools to the keyboard', async ({ page }) => {
	await readMode(page, 'Short annotation target.');
	await page.getByTestId('annotation-toggle').click();
	await drawOnCanvas(page);
	expect(await inkPixels(page)).toBeGreaterThan(0);
	await page.getByTestId('annotation-clear').click();
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

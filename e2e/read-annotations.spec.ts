import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createFirstFile, resetAppState, writeSourceContent } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

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

	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	await page.locator('[data-mode="read"]').click();
	await expect(page.getByTestId('annotation-canvas')).toBeVisible();
	expect(await inkPixels(page)).toBe(0);
	expect(await page.locator('.mdsh-preview').innerText()).toContain('Annotated paragraph.');

	await info.attach('annotations.json', {
		body: JSON.stringify({
			documentUnchanged: true,
			pixelsBeforeReload: await inkPixels(page),
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
	await page.setViewportSize({ width: 390, height: 700 });
	await page.getByTestId('annotation-toggle').click();
	await expect(page.getByTestId('annotation-pen')).toBeVisible();
	await expect(page.getByTestId('annotation-clear')).toBeVisible();
});

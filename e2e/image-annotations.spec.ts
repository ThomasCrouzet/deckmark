import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { resetAppState } from './helpers';
import { importSource } from './source-fidelity-harness';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

async function importImage(page: Page) {
	const bytes = await readFile('static/pwa-192x192.png');
	await page.locator('input[type="file"][accept*="text/markdown"]').setInputFiles({
		name: 'plan.png',
		mimeType: 'image/png',
		buffer: bytes
	});
	await expect(page.getByTestId('image-document')).toBeVisible();
	await expect
		.poll(() =>
			page.getByTestId('image-canvas').evaluate((element) => (element as HTMLCanvasElement).width)
		)
		.toBeGreaterThan(0);
}

async function draw(page: Page) {
	const box = await page.getByTestId('image-canvas').boundingBox();
	if (!box) throw new Error('Image canvas has no box');
	await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.55, { steps: 10 });
	await page.mouse.up();
}

async function redPixels(page: Page, bytes: Buffer): Promise<number> {
	return page.evaluate(async (base64) => {
		const image = new Image();
		image.src = `data:image/png;base64,${base64}`;
		await image.decode();
		const canvas = document.createElement('canvas');
		canvas.width = image.naturalWidth;
		canvas.height = image.naturalHeight;
		const context = canvas.getContext('2d')!;
		context.drawImage(image, 0, 0);
		const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
		let count = 0;
		for (let index = 0; index < data.length; index += 4) {
			if (data[index]! > 180 && data[index + 1]! < 130 && data[index + 2]! < 130) count++;
		}
		return count;
	}, bytes.toString('base64'));
}

async function draftData(page: Page): Promise<string> {
	return page.evaluate(
		() =>
			new Promise<string>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const rows = request.result.transaction('drafts').objectStore('drafts').getAll();
					rows.onerror = () => reject(rows.error);
					rows.onsuccess = () => {
						request.result.close();
						resolve(rows.result.find((row) => row.name === 'plan.png')?.data ?? '');
					};
				};
			})
	);
}

test('discards a cancelled image stroke without losing redo', async ({ page, browser }, info) => {
	await resetAppState(page);
	await importImage(page);
	await page.getByTestId('image-pen').click();
	await page.getByTestId('image-document').getByRole('button', { name: '#ff6b6b' }).click();
	await draw(page);
	await page.getByTitle('Annuler le trait').click();
	const redo = page.getByTitle('Rétablir le trait');
	await expect(redo).toBeEnabled();
	const canvas = page.getByTestId('image-canvas');
	const box = await canvas.boundingBox();
	if (!box) throw new Error('Image canvas has no box');
	await canvas.evaluate((element) => {
		element.addEventListener(
			'pointerdown',
			(event) =>
				element.setAttribute('data-test-pointer', String((event as PointerEvent).pointerId)),
			{ once: true }
		);
	});
	await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.55, { steps: 10 });
	const pointerId = Number(await canvas.getAttribute('data-test-pointer'));
	expect(pointerId).toBeGreaterThan(0);
	await canvas.dispatchEvent('pointercancel', { pointerId, pointerType: 'mouse', bubbles: true });
	await page.mouse.up();
	const redoEnabled = await redo.isEnabled();
	const download = page.waitForEvent('download');
	await page.getByTestId('image-export').click();
	const exported = await readFile((await (await download).path())!);
	const red = await redPixels(page, exported);
	await info.attach('image-ink-cancellation.json', {
		body: JSON.stringify({ browser: browser.version(), pointerId, redoEnabled, redPixels: red }),
		contentType: 'application/json'
	});
	expect(redoEnabled).toBe(true);
	expect(red).toBe(0);
});

test('annotates an image, exports a flattened copy and keeps the original', async ({
	page
}, info: TestInfo) => {
	await resetAppState(page);
	await importImage(page);
	await expect.poll(() => draftData(page)).not.toBe('');
	const original = await draftData(page);
	await expect(page.getByTestId('image-zoom')).toHaveText('100%');
	await page.getByTitle('Zoom avant').click();
	await expect(page.getByTestId('image-zoom')).toHaveText('110%');

	await page.getByTestId('image-pen').click();
	await page.getByTestId('image-document').getByRole('button', { name: '#ff6b6b' }).click();
	await draw(page);

	const first = page.waitForEvent('download');
	await page.getByTestId('image-export').click();
	const firstDownload = await first;
	expect(firstDownload.suggestedFilename()).toBe('plan-annotated.png');
	const annotated = await readFile((await firstDownload.path())!);
	expect(await redPixels(page, annotated)).toBeGreaterThan(20);

	const undo = page.getByTitle('Annuler le trait');
	await expect(undo).toBeEnabled();
	await undo.click();
	const cleared = page.waitForEvent('download');
	await page.getByTestId('image-export').click();
	const clearedDownload = await cleared;
	const clearedBytes = await readFile((await clearedDownload.path())!);
	expect(await redPixels(page, clearedBytes)).toBe(0);

	await page.getByTitle('Rétablir le trait').click();
	const again = page.waitForEvent('download');
	await page.getByTestId('image-export').click();
	const againBytes = await readFile((await (await again).path())!);
	expect(await redPixels(page, againBytes)).toBeGreaterThan(20);

	await page.getByTestId('image-clear').click();
	expect(await draftData(page)).toBe(original);
	await info.attach('image-annotation.json', {
		body: JSON.stringify({
			originalUnchanged: true,
			annotatedBytes: annotated.length,
			clearedRedPixels: 0,
			exportName: firstDownload.suggestedFilename()
		}),
		contentType: 'application/json'
	});
	await info.attach('image-annotation.png', { body: await page.screenshot() });
});

test('offers pan and tool controls on a narrow viewport', async ({ page }) => {
	await resetAppState(page);
	await page.setViewportSize({ width: 390, height: 700 });
	await importImage(page);
	await expect(page.getByTestId('image-pen')).toBeVisible();
	await expect(page.getByTestId('image-highlighter')).toBeVisible();
	await expect(page.getByTestId('image-eraser')).toBeVisible();
	await page.getByTestId('image-highlighter').click();
	await expect(page.getByTestId('image-highlighter')).toHaveAttribute('aria-pressed', 'true');
	await draw(page);
	await expect(page.getByTestId('image-clear')).toBeVisible();
});

test('keeps read-view ink out of image exports', async ({ page }, info) => {
	await resetAppState(page);
	await importImage(page);
	await expect.poll(() => draftData(page)).not.toBe('');
	const original = await draftData(page);
	await importSource(page, '# Read ink\n\nSeparate annotation surface.', 'read-ink');
	await page.locator('[data-mode="read"]').click();
	await expect(page.locator('.mdsh-preview')).toBeVisible();
	await page.getByTestId('annotation-toggle').click();
	await page.getByTestId('annotation-color-1').click();
	const box = await page.getByTestId('annotation-canvas').boundingBox();
	if (!box) throw new Error('Read canvas has no box');
	await page.mouse.move(box.x + 100, box.y + 160);
	await page.mouse.down();
	await page.mouse.move(box.x + 280, box.y + 160, { steps: 12 });
	await page.mouse.up();
	await page.locator('aside button[data-file-id]').filter({ hasText: 'plan.png' }).click();
	await expect(page.getByTestId('image-document')).toBeVisible();
	await expect(page.getByTestId('annotation-canvas')).toHaveCount(0);
	const download = page.waitForEvent('download');
	await page.getByTestId('image-export').click();
	const exported = await readFile((await (await download).path())!);
	expect(await redPixels(page, exported)).toBe(0);
	expect(await draftData(page)).toBe(original);
	await info.attach('read-image-isolation.png', { body: await page.screenshot() });
	await info.attach('image-export.png', { body: exported, contentType: 'image/png' });
});

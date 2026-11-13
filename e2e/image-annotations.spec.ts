import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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

interface BitmapSize {
	width: number;
	height: number;
}

async function bitmapSize(page: Page): Promise<BitmapSize> {
	return page.getByTestId('image-canvas').evaluate((element) => {
		const canvas = element as HTMLCanvasElement;
		return { width: canvas.width, height: canvas.height };
	});
}

async function watchImagePointer(page: Page) {
	await page.getByTestId('image-canvas').evaluate((element) => {
		const state = window as Window & { __imagePointer?: number };
		element.addEventListener(
			'pointerdown',
			(event) => {
				state.__imagePointer = event.pointerId;
			},
			true
		);
	});
}

async function bitmapPoint(page: Page, size: BitmapSize, point: { x: number; y: number }) {
	const box = await page.getByTestId('image-canvas').boundingBox();
	if (!box) throw new Error('Image canvas has no box');
	return {
		x: box.x + (point.x / size.width) * box.width,
		y: box.y + (point.y / size.height) * box.height
	};
}

async function startImageLine(
	page: Page,
	size: BitmapSize,
	from: { x: number; y: number },
	to: { x: number; y: number }
) {
	const start = await bitmapPoint(page, size, from);
	const end = await bitmapPoint(page, size, to);
	await page.mouse.move(start.x, start.y);
	await page.mouse.down();
	await page.mouse.move(end.x, end.y, { steps: 8 });
}

async function drawImageLine(
	page: Page,
	size: BitmapSize,
	from: { x: number; y: number },
	to: { x: number; y: number }
) {
	await startImageLine(page, size, from, to);
	await page.mouse.up();
}

async function dispatchImagePointer(
	page: Page,
	type: 'pointercancel' | 'lostpointercapture',
	offset = 0
) {
	const pointerId = await page.evaluate(
		() => (window as Window & { __imagePointer?: number }).__imagePointer
	);
	if (pointerId === undefined) throw new Error('No image pointer id was recorded');
	await page.getByTestId('image-canvas').evaluate(
		(element, event) => {
			element.dispatchEvent(
				new PointerEvent(event.type, {
					bubbles: true,
					cancelable: true,
					composed: true,
					pointerId: event.pointerId,
					pointerType: 'mouse',
					isPrimary: true,
					button: 0,
					buttons: 0
				})
			);
		},
		{ type, pointerId: pointerId + offset }
	);
}

async function imagePixel(page: Page, x: number, y: number) {
	return page.getByTestId('image-canvas').evaluate(
		(element, point) => {
			const canvas = element as HTMLCanvasElement;
			const data = canvas
				.getContext('2d')!
				.getImageData(Math.round(point.x), Math.round(point.y), 1, 1).data;
			return { r: data[0]!, g: data[1]!, b: data[2]!, a: data[3]! };
		},
		{ x, y }
	);
}

async function exportedPixel(page: Page, bytes: Buffer, x: number, y: number) {
	return page.evaluate(
		async ({ base64, point }) => {
			const image = new Image();
			image.src = `data:image/png;base64,${base64}`;
			await image.decode();
			const canvas = document.createElement('canvas');
			canvas.width = image.naturalWidth;
			canvas.height = image.naturalHeight;
			const context = canvas.getContext('2d')!;
			context.drawImage(image, 0, 0);
			const data = context.getImageData(point.x, point.y, 1, 1).data;
			return { r: data[0]!, g: data[1]!, b: data[2]!, a: data[3]! };
		},
		{ base64: bytes.toString('base64'), point: { x, y } }
	);
}

function isRed(pixel: { r: number; g: number; b: number }) {
	return pixel.r > 180 && pixel.g < 130 && pixel.b < 130;
}

function isBlue(pixel: { r: number; g: number; b: number }) {
	return pixel.b > 180 && pixel.r < 130;
}

async function inkFrame(page: Page) {
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			)
	);
}

test('discards a cancelled image pen stroke and keeps redo history and export clean', async ({
	page
}, info: TestInfo) => {
	await resetAppState(page);
	await importImage(page);
	await expect.poll(() => draftData(page)).not.toBe('');
	const original = await draftData(page);
	const size = await bitmapSize(page);
	await watchImagePointer(page);
	const samples: {
		phase: string;
		x: number;
		y: number;
		pixel: { r: number; g: number; b: number; a: number };
	}[] = [];
	const pixelAt = async (phase: string, x: number, y: number) => {
		const pixel = await imagePixel(page, x, y);
		samples.push({ phase, x, y, pixel });
		return pixel;
	};

	await page.getByTestId('image-pen').click();
	await page.getByTestId('image-document').getByRole('button', { name: '#ff6b6b' }).click();
	await drawImageLine(page, size, { x: 40, y: 60 }, { x: 80, y: 60 });
	expect(isRed(await pixelAt('committed-pen', 60, 60))).toBe(true);

	await page.getByTestId('image-document').getByRole('button', { name: '#4dabf7' }).click();
	await drawImageLine(page, size, { x: 40, y: 110 }, { x: 80, y: 110 });
	expect(isBlue(await pixelAt('committed-blue', 60, 110))).toBe(true);
	await page.getByTitle('Annuler le trait').click();
	expect(isBlue(await pixelAt('blue-after-undo', 60, 110))).toBe(false);
	await expect(page.getByTitle('Rétablir le trait')).toBeEnabled();

	await page.getByTestId('image-document').getByRole('button', { name: '#ff6b6b' }).click();
	await startImageLine(page, size, { x: 100, y: 150 }, { x: 160, y: 150 });
	await inkFrame(page);
	expect(isRed(await pixelAt('pen-partial-before-cancel', 130, 150))).toBe(true);
	await dispatchImagePointer(page, 'pointercancel');
	await page.mouse.up();
	await inkFrame(page);
	expect(isRed(await pixelAt('pen-after-cancel', 130, 150))).toBe(false);
	await expect(page.getByTitle('Rétablir le trait')).toBeEnabled();

	const download = page.waitForEvent('download');
	await page.getByTestId('image-export').click();
	const exported = await readFile((await (await download).path())!);
	const exportedCommitted = await exportedPixel(page, exported, 60, 60);
	const exportedCancelled = await exportedPixel(page, exported, 130, 150);
	samples.push({
		phase: 'export-committed-pen',
		x: 60,
		y: 60,
		pixel: exportedCommitted
	});
	samples.push({
		phase: 'export-cancelled-pen',
		x: 130,
		y: 150,
		pixel: exportedCancelled
	});
	expect(isRed(exportedCommitted)).toBe(true);
	expect(isRed(exportedCancelled)).toBe(false);

	await page.getByTitle('Rétablir le trait').click();
	expect(isBlue(await pixelAt('blue-after-redo', 60, 110))).toBe(true);

	await page.getByTestId('image-pen').click();
	await page.getByTestId('image-document').getByRole('button', { name: '#ff6b6b' }).click();
	await drawImageLine(page, size, { x: 40, y: 175 }, { x: 80, y: 175 });
	expect(isRed(await pixelAt('later-pen-stroke', 60, 175))).toBe(true);
	await page.getByTitle('Annuler le trait').click();
	expect(isRed(await pixelAt('later-pen-after-undo', 60, 175))).toBe(false);

	await page.getByTestId('image-clear').click();
	expect(await draftData(page)).toBe(original);
	await info.attach('image-cancelled-pen.json', {
		body: JSON.stringify({
			samples,
			exportedBytes: exported.length,
			exportedSha256: createHash('sha256').update(exported).digest('hex'),
			sampleCoordinates: 'bitmap pixels of the 192 by 192 canvas'
		}),
		contentType: 'application/json'
	});
	await info.attach('image-cancelled-pen-export.png', {
		body: exported,
		contentType: 'image/png'
	});
	await info.attach('image-cancelled-pen.png', { body: await page.screenshot() });
});

test('rolls back cancelled highlighter and eraser gestures and matches pointer ids', async ({
	page
}, info: TestInfo) => {
	await resetAppState(page);
	await importImage(page);
	const size = await bitmapSize(page);
	await watchImagePointer(page);
	const samples: {
		phase: string;
		x: number;
		y: number;
		pixel: { r: number; g: number; b: number; a: number };
	}[] = [];
	const pixelAt = async (phase: string, x: number, y: number) => {
		const pixel = await imagePixel(page, x, y);
		samples.push({ phase, x, y, pixel });
		return pixel;
	};
	await page.getByTestId('image-pen').click();
	await page.getByTestId('image-document').getByRole('button', { name: '#ff6b6b' }).click();
	await drawImageLine(page, size, { x: 30, y: 100 }, { x: 160, y: 100 });
	expect(isRed(await pixelAt('committed-pen', 100, 100))).toBe(true);

	const highlighterBaseline = await pixelAt('highlighter-baseline', 100, 20);
	await page.getByTestId('image-highlighter').click();
	await startImageLine(page, size, { x: 30, y: 20 }, { x: 160, y: 20 });
	await inkFrame(page);
	expect(await pixelAt('highlighter-partial-before-cancel', 100, 20)).not.toEqual(
		highlighterBaseline
	);
	await dispatchImagePointer(page, 'pointercancel');
	await page.mouse.up();
	await inkFrame(page);
	expect(await pixelAt('highlighter-after-cancel', 100, 20)).toEqual(highlighterBaseline);

	await page.getByTestId('image-eraser').click();
	await startImageLine(page, size, { x: 80, y: 100 }, { x: 120, y: 100 });
	await inkFrame(page);
	expect(isRed(await pixelAt('eraser-hole-before-cancel', 100, 100))).toBe(false);
	await dispatchImagePointer(page, 'pointercancel');
	await page.mouse.up();
	await inkFrame(page);
	expect(isRed(await pixelAt('eraser-after-cancel', 100, 100))).toBe(true);

	await page.getByTestId('image-pen').click();
	await page.getByTestId('image-document').getByRole('button', { name: '#ff6b6b' }).click();
	await startImageLine(page, size, { x: 60, y: 40 }, { x: 120, y: 40 });
	await inkFrame(page);
	expect(isRed(await pixelAt('capture-partial-before-loss', 90, 40))).toBe(true);
	await dispatchImagePointer(page, 'lostpointercapture');
	await page.mouse.up();
	await inkFrame(page);
	expect(isRed(await pixelAt('capture-partial-after-loss', 90, 40))).toBe(false);

	await startImageLine(page, size, { x: 40, y: 140 }, { x: 70, y: 140 });
	await dispatchImagePointer(page, 'pointercancel', 1);
	const extended = await bitmapPoint(page, size, { x: 160, y: 140 });
	await page.mouse.move(extended.x, extended.y, { steps: 8 });
	await inkFrame(page);
	expect(isRed(await pixelAt('mismatched-pointer-cancel-extended', 130, 140))).toBe(true);
	await page.mouse.up();
	await inkFrame(page);
	expect(isRed(await pixelAt('mismatched-pointer-after-release', 130, 140))).toBe(true);
	await page.getByTitle('Annuler le trait').click();
	expect(isRed(await pixelAt('mismatched-pointer-after-undo', 130, 140))).toBe(false);
	expect(isRed(await pixelAt('committed-pen-after-undo', 100, 100))).toBe(true);

	await info.attach('image-cancelled-tools.json', {
		body: JSON.stringify({ samples }),
		contentType: 'application/json'
	});
});

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import { createFirstFile, resetAppState, writeSourceContent } from './helpers';

// Bounded visual previews and import preflight for issue 570.
test.use({ locale: 'en-US', reducedMotion: 'reduce', trace: 'off' });

function crc32(buffer: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of buffer) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
	const checksum = Buffer.alloc(4);
	checksum.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, checksum]);
}

/** A valid, highly compressible grayscale PNG that is above the upload pixel cap. */
function oversizedPng(width: number, height: number): Buffer {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 0;
	const row = Buffer.alloc(1 + width);
	row.fill(0x55, 1);
	const raw = Buffer.concat(Array.from({ length: height }, () => row));
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		pngChunk('IHDR', header),
		pngChunk('IDAT', deflateSync(raw, { level: 9 })),
		pngChunk('IEND', Buffer.alloc(0))
	]);
}

const counterKey = 'deckmark:preview-counters';
const PIXEL_BUDGET = 2_000_000;
const DIMENSION_BUDGET = 2048;

async function installCounters(page: Page) {
	await page.addInitScript((key) => {
		window.addEventListener('deckmark:editor-perf', (event) => {
			const detail = (event as CustomEvent<{ kind: string; name: string }>).detail;
			if (detail.kind !== 'counter') return;
			const counts = JSON.parse(sessionStorage.getItem(key) ?? '{}') as Record<string, number>;
			counts[detail.name] = (counts[detail.name] ?? 0) + 1;
			sessionStorage.setItem(key, JSON.stringify(counts));
		});
	}, counterKey);
}

async function readCounters(page: Page): Promise<Record<string, number>> {
	return page.evaluate((key) => {
		const counts = JSON.parse(sessionStorage.getItem(key) ?? '{}') as Record<string, number>;
		const previews = (
			window as unknown as { __MDSH_VISUAL_PREVIEWS__?: { stats: () => Record<string, number> } }
		).__MDSH_VISUAL_PREVIEWS__;
		if (previews) {
			for (const [name, value] of Object.entries(previews.stats()))
				counts[`preview.${name}`] = value;
		}
		return counts;
	}, counterKey);
}

async function heap(page: Page): Promise<Record<string, number | boolean>> {
	return page.evaluate(() => {
		const memory = (performance as unknown as { memory?: Record<string, number> }).memory;
		if (!memory) return { supported: false };
		return {
			supported: true,
			usedJSHeapSize: memory.usedJSHeapSize ?? 0,
			totalJSHeapSize: memory.totalJSHeapSize ?? 0
		};
	});
}

async function generateImage(
	page: Page,
	id: string,
	width: number,
	height: number,
	color: string,
	project = false
): Promise<{ content: string; uri: string }> {
	return page.evaluate(
		async ({ rowId, width, height, fill, withProject }) => {
			const canvas = document.createElement('canvas');
			canvas.width = width;
			canvas.height = height;
			const context = canvas.getContext('2d')!;
			context.fillStyle = fill;
			context.fillRect(0, 0, width, height);
			const uri = canvas.toDataURL('image/png');
			const content = `# Preview ${rowId}\n\nBefore image.\n\n![Huge ${rowId}](${uri})\n\nAfter image.\n`;
			await new Promise<void>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const transaction = database.transaction(['projects', 'drafts'], 'readwrite');
					if (withProject) {
						transaction.objectStore('projects').put({
							id: 'preview-project',
							name: 'Preview project',
							createdAt: 1,
							updatedAt: 1
						});
					}
					transaction.objectStore('drafts').put({
						id: rowId,
						name: `${rowId}.md`,
						content,
						createdAt: 1_700_000_000_000,
						updatedAt: 1_700_000_000_000,
						order: 0
					});
					transaction.oncomplete = () => {
						database.close();
						resolve();
					};
					transaction.onerror = () => reject(transaction.error);
				};
			});
			localStorage.setItem('mdsh:activeId', rowId);
			localStorage.setItem('mdsh:locale', 'en');
			return { content, uri };
		},
		{ rowId: id, width, height, fill: color, withProject: project }
	);
}

async function storedContent(page: Page, id: string): Promise<string> {
	return page.evaluate(
		(rowId) =>
			new Promise<string>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const get = database.transaction('drafts').objectStore('drafts').get(rowId);
					get.onsuccess = () => {
						database.close();
						resolve((get.result as { content?: string } | undefined)?.content ?? '');
					};
					get.onerror = () => reject(get.error);
				};
			}),
		id
	);
}

async function confirmLargeRender(page: Page) {
	const dialog = page.getByRole('dialog', { name: /Render this large document/ });
	await dialog.waitFor({ state: 'visible', timeout: 2_000 }).catch(() => {});
	if (await dialog.isVisible().catch(() => false)) {
		await dialog.getByRole('button', { name: /Render document/ }).click();
	}
}

async function openVisualEditor(page: Page) {
	await page.locator('[data-mode=wysiwyg]').click();
	await confirmLargeRender(page);
	await expect(page.locator('.ProseMirror')).toHaveAttribute('contenteditable', 'true', {
		timeout: 60_000
	});
}

async function previewMetrics(page: Page) {
	const image = page.locator('.milkdown-image-block img').first();
	await expect(image).toBeVisible({ timeout: 30_000 });
	await expect
		.poll(() =>
			image.evaluate((element) => {
				const target = element as HTMLImageElement;
				return target.complete && target.naturalWidth > 0;
			})
		)
		.toBe(true);
	return image.evaluate((element) => {
		const target = element as HTMLImageElement;
		return {
			src: target.currentSrc || target.src,
			width: target.naturalWidth,
			height: target.naturalHeight,
			pixels: target.naturalWidth * target.naturalHeight,
			alt: target.alt
		};
	});
}

test('bounds an oversized inline raster and keeps the exact source bytes', async ({
	page
}, info) => {
	test.setTimeout(180_000);
	await installCounters(page);
	await resetAppState(page, { mode: 'source' });
	const fixture = await generateImage(page, 'preview-a', 4000, 4000, '#1d5f3a');
	await page.reload();
	await openVisualEditor(page);
	const metrics = await previewMetrics(page);
	const counters = await readCounters(page);
	const heapAfterPreview = await heap(page);
	expect(metrics.pixels).toBeLessThanOrEqual(PIXEL_BUDGET);
	expect(Math.max(metrics.width, metrics.height)).toBeLessThanOrEqual(DIMENSION_BUDGET);
	expect(metrics.src.startsWith('blob:')).toBe(true);
	expect(metrics.alt).toBe('Huge preview-a');
	expect(counters.imagePreviewGenerated ?? 0).toBeGreaterThanOrEqual(1);
	expect(counters['preview.entries'] ?? 0).toBeGreaterThanOrEqual(1);
	await expect
		.poll(async () => (await readCounters(page))['preview.pending'] ?? 0, { timeout: 10_000 })
		.toBe(0);

	// A text edit, undo and redo must keep the image and its preview identity.
	const paragraph = page.locator('.ProseMirror p').last();
	await paragraph.click();
	await page.keyboard.press('End');
	await page.keyboard.insertText(' Changed.');
	await expect(page.locator('.ProseMirror')).toContainText('Changed.');
	await page.keyboard.press('ControlOrMeta+z');
	await expect(page.locator('.ProseMirror')).not.toContainText('Changed.');
	await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+Shift+z');
	await expect(page.locator('.ProseMirror')).toContainText('Changed.');
	expect((await previewMetrics(page)).width).toBeLessThanOrEqual(DIMENSION_BUDGET);

	await page.locator('[data-mode=source]').click();
	await expect(page.locator('.cm-content').first()).toBeVisible({ timeout: 30_000 });
	const releaseCounters = await readCounters(page);
	const heapAfterRelease = await heap(page);
	expect(releaseCounters['preview.entries'] ?? 0).toBe(0);
	expect(releaseCounters['preview.revoked'] ?? 0).toBeGreaterThanOrEqual(1);
	await expect
		.poll(async () => (await storedContent(page, 'preview-a')).includes(fixture.uri), {
			timeout: 20_000
		})
		.toBe(true);
	expect(await storedContent(page, 'preview-a')).toContain('![Huge preview-a]');

	await page.locator('[data-mode=read]').click();
	const readImage = page.locator('.mdsh-preview img').first();
	await expect(readImage).toBeVisible({ timeout: 30_000 });
	expect(await readImage.getAttribute('src')).toBe(fixture.uri);

	await page.locator('[data-mode=source]').click();
	const download = page.waitForEvent('download');
	await page.keyboard.press('ControlOrMeta+s');
	const path = info.outputPath('preview-source.md');
	await (await download).saveAs(path);
	expect(await readFile(path, 'utf8')).toContain(fixture.uri);
	await info.attach('preview-metrics.json', {
		body: JSON.stringify(
			{
				fixture: {
					sha256: createHash('sha256').update(fixture.content).digest('hex'),
					bytes: Buffer.byteLength(fixture.content),
					sourcePixels: 4000 * 4000
				},
				preview: metrics,
				counters,
				releaseCounters,
				heap: { afterPreview: heapAfterPreview, afterRelease: heapAfterRelease },
				budget: { pixels: PIXEL_BUDGET, dimension: DIMENSION_BUDGET },
				browser: page.context().browser()?.version()
			},
			null,
			2
		),
		contentType: 'application/json'
	});
});

test('rejects an oversized import before a bitmap decode', async ({ page }, info) => {
	test.setTimeout(120_000);
	await installCounters(page);
	await resetAppState(page);
	await createFirstFile(page);
	await writeSourceContent(page, '# Import\n\nText before.\n');
	const fixture = oversizedPng(9000, 4000);
	const outcome = await page.evaluate((base64) => {
		const binary = atob(base64);
		const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
		const file = new File([bytes], 'oversized.png', { type: 'image/png' });
		const transfer = new DataTransfer();
		transfer.items.add(file);
		window.dispatchEvent(
			new DragEvent('drop', {
				bubbles: true,
				cancelable: true,
				dataTransfer: transfer
			})
		);
		return { dropped: true, bytes: bytes.length };
	}, fixture.toString('base64'));
	expect(outcome.dropped).toBe(true);
	await expect(page.getByText(/image.*(illisible|unreadable)/i)).toBeVisible({
		timeout: 10_000
	});
	const counters = await readCounters(page);
	expect(counters.imagePreflightReject ?? 0).toBeGreaterThanOrEqual(1);
	expect(counters.imageBitmapDecode ?? 0).toBe(0);
	expect(counters.imageElementDecode ?? 0).toBe(0);
	await expect(page.locator('.cm-content').first()).not.toContainText('data:image/png');
	await info.attach('oversized-import.json', {
		body: JSON.stringify(
			{
				fixture: { width: 9000, height: 4000, pixels: 36_000_000, bytes: outcome.bytes },
				counters,
				browser: page.context().browser()?.version()
			},
			null,
			2
		),
		contentType: 'application/json'
	});
});

test('a fast file switch never shows the previous preview or leaks its URL', async ({
	page
}, info) => {
	test.setTimeout(180_000);
	await installCounters(page);
	await resetAppState(page, { mode: 'source' });
	const first = await generateImage(page, 'switch-a', 4000, 4000, '#7a1f1f');
	const second = await generateImage(page, 'switch-b', 3500, 2500, '#1f3f7a');
	await page.reload();
	await openVisualEditor(page);
	const firstMetrics = await previewMetrics(page);
	expect(firstMetrics.src.startsWith('blob:')).toBe(true);

	await page.locator('aside button[data-file-id="switch-b"]').click();
	await openVisualEditor(page);
	await expect
		.poll(async () => (await previewMetrics(page)).alt, { timeout: 30_000 })
		.toBe('Huge switch-b');
	const secondMetrics = await previewMetrics(page);
	expect(secondMetrics.src.startsWith('blob:')).toBe(true);
	expect(secondMetrics.width).toBeLessThanOrEqual(DIMENSION_BUDGET);

	await page.locator('aside button[data-file-id="switch-a"]').click();
	await openVisualEditor(page);
	await expect
		.poll(async () => (await previewMetrics(page)).alt, { timeout: 30_000 })
		.toBe('Huge switch-a');
	const backMetrics = await previewMetrics(page);
	expect(backMetrics.alt).toBe('Huge switch-a');
	expect(backMetrics.width).toBeLessThanOrEqual(DIMENSION_BUDGET);
	const counters = await readCounters(page);
	expect(counters['preview.revoked'] ?? 0).toBeGreaterThanOrEqual(1);
	expect(await storedContent(page, 'switch-a').then((content) => content.includes(first.uri))).toBe(
		true
	);
	expect(
		await storedContent(page, 'switch-b').then((content) => content.includes(second.uri))
	).toBe(true);
	await info.attach('switch-preview.json', {
		body: JSON.stringify(
			{ first: firstMetrics, second: secondMetrics, back: backMetrics, counters },
			null,
			2
		),
		contentType: 'application/json'
	});
});

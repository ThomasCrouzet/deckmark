import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { DraftRow } from '../src/lib/db';
import { resetAppState } from './helpers';

// A binary viewer must restart its decode when another tab replaces the bytes of
// the same file ID. These cases seed a real IndexedDB row, then let a second
// BroadcastChannel sender commit a newer row with the same ID.

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

interface ObjectUrlRecord {
	url: string;
	size: number;
	type: string;
	text: string;
}

declare global {
	interface Window {
		__binaryImageSources?: string[];
		__binaryObjectUrls?: { created: ObjectUrlRecord[]; revoked: string[] };
	}
}

const command =
	'npx playwright test e2e/binary-view-refresh.spec.ts --project=chromium --workers=1 --retries=0';

test.beforeEach(async ({ page }) => {
	await page.addInitScript(() => {
		const nativeImage = window.Image;
		const sources: string[] = [];
		window.__binaryImageSources = sources;
		class TrackedImage extends nativeImage {
			get src(): string {
				return super.src;
			}
			set src(value: string) {
				sources.push(value);
				super.src = value;
			}
		}
		window.Image = TrackedImage as unknown as typeof Image;

		const created: ObjectUrlRecord[] = [];
		const revoked: string[] = [];
		window.__binaryObjectUrls = { created, revoked };
		const create = URL.createObjectURL.bind(URL);
		const revoke = URL.revokeObjectURL.bind(URL);
		URL.createObjectURL = (blob: Blob) => {
			const url = create(blob);
			const record: ObjectUrlRecord = { url, size: blob.size, type: blob.type, text: '' };
			created.push(record);
			void blob.text().then((text) => (record.text = text));
			return url;
		};
		URL.revokeObjectURL = (url: string) => {
			revoked.push(url);
			revoke(url);
		};
	});
	await resetAppState(page);
});

test.afterEach(async ({ page, browser }, info: TestInfo) => {
	await info.attach('binary-view-refresh.json', {
		body: JSON.stringify(
			{
				command,
				source: info.config.metadata,
				browser: browser.version(),
				platform: process.platform,
				title: info.title,
				status: info.status,
				imageSources: await page.evaluate(() => window.__binaryImageSources?.length ?? 0),
				objectUrls: await page.evaluate(() => ({
					created: window.__binaryObjectUrls?.created.length ?? 0,
					revoked: window.__binaryObjectUrls?.revoked.length ?? 0
				}))
			},
			null,
			2
		),
		contentType: 'application/json'
	});
	await info.attach('binary-view-refresh.png', { body: await page.screenshot() });
});

async function commitRemote(page: Page, row: DraftRow): Promise<void> {
	await page.evaluate(async (remote) => {
		await new Promise<void>((resolve, reject) => {
			const request = indexedDB.open('mdsh');
			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				const database = request.result;
				const transaction = database.transaction('drafts', 'readwrite');
				transaction.objectStore('drafts').put(remote);
				transaction.oncomplete = () => {
					database.close();
					resolve();
				};
				transaction.onerror = () => reject(transaction.error);
			};
		});
		const channel = new BroadcastChannel('mdsh');
		channel.postMessage({ type: 'draft-written', id: remote.id, updatedAt: remote.updatedAt });
		channel.close();
	}, row);
}

async function seedDraft(page: Page, row: DraftRow, extra: DraftRow[] = []): Promise<void> {
	await page.evaluate(
		async ({ seed, extraRows }) => {
			await new Promise<void>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const transaction = database.transaction('drafts', 'readwrite');
					const drafts = transaction.objectStore('drafts');
					drafts.put(seed);
					for (const entry of extraRows) drafts.put(entry);
					transaction.oncomplete = () => {
						database.close();
						resolve();
					};
					transaction.onerror = () => reject(transaction.error);
				};
			});
			localStorage.setItem('mdsh:activeId', seed.id);
		},
		{ seed: row, extraRows: extra }
	);
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
}

async function solidPng(page: Page, color: string): Promise<string> {
	return page.evaluate((fill) => {
		const canvas = document.createElement('canvas');
		canvas.width = 64;
		canvas.height = 64;
		const context = canvas.getContext('2d');
		if (!context) throw new Error('No 2D context');
		context.fillStyle = fill;
		context.fillRect(0, 0, canvas.width, canvas.height);
		return canvas.toDataURL('image/png');
	}, color);
}

async function canvasColor(page: Page): Promise<{ red: number; green: number; blue: number }> {
	return page.getByTestId('image-canvas').evaluate((canvas: HTMLCanvasElement) => {
		const context = canvas.getContext('2d');
		if (!context) throw new Error('No 2D context');
		const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
		let red = 0;
		let green = 0;
		let blue = 0;
		for (let index = 0; index < data.length; index += 4) {
			if (data[index + 3] === 0) continue;
			red += data[index]!;
			green += data[index + 1]!;
			blue += data[index + 2]!;
		}
		return { red, green, blue };
	});
}

async function draw(page: Page): Promise<void> {
	const box = await page.getByTestId('image-canvas').boundingBox();
	if (!box) throw new Error('Image canvas has no box');
	await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.55, { steps: 6 });
	await page.mouse.up();
}

async function downloadBytes(page: Page, info: TestInfo, name: string) {
	const pending = page.waitForEvent('download');
	await page.getByTestId('image-export').click();
	const download = await pending;
	const path = info.outputPath(name);
	await download.saveAs(path);
	await info.attach(name, { path });
	return { name: download.suggestedFilename(), bytes: await readFile(path) };
}

function imageRow(id: string, data: string, name = 'binary-refresh.png'): DraftRow {
	return {
		id,
		name,
		content: '',
		kind: 'image',
		mime: 'image/png',
		data,
		createdAt: 1_700_000_000_000,
		updatedAt: 1_700_000_000_000,
		order: 0,
		open: true
	};
}

function pdfRow(id: string, data: string, name = 'binary-refresh.pdf'): DraftRow {
	return {
		id,
		name,
		content: '',
		kind: 'pdf',
		mime: 'application/pdf',
		data,
		createdAt: 1_700_000_000_000,
		updatedAt: 1_700_000_000_000,
		order: 0,
		open: true
	};
}

function pdfBytes(marker: string): Buffer {
	return Buffer.from(`%PDF-1.4\n% Binary view ${marker}\n%%EOF\n`);
}

function dataUrl(bytes: Buffer): string {
	return `data:application/pdf;base64,${bytes.toString('base64')}`;
}

async function waitForImage(page: Page): Promise<void> {
	await expect(page.getByTestId('image-document')).toBeVisible();
	await expect
		.poll(() =>
			page.getByTestId('image-canvas').evaluate((element) => (element as HTMLCanvasElement).width)
		)
		.toBeGreaterThan(0);
}

test('replaces a same-ID image payload, clears stale annotations and exports the new bytes', async ({
	page
}, info) => {
	const red = await solidPng(page, '#ff0000');
	const blue = await solidPng(page, '#0000ff');
	await seedDraft(page, imageRow('binary-image-refresh', red));
	await waitForImage(page);

	await expect
		.poll(async () => {
			const color = await canvasColor(page);
			return color.red > 0 && color.blue === 0;
		})
		.toBe(true);
	await draw(page);
	await expect(page.getByTitle(/Annuler le trait|Undo stroke/)).toBeEnabled();

	await commitRemote(page, {
		...imageRow('binary-image-refresh', blue, 'binary-refresh-blue.png'),
		updatedAt: 1_700_000_000_010
	});

	await expect
		.poll(async () => {
			const color = await canvasColor(page);
			return color.blue > 0 && color.red === 0;
		})
		.toBe(true);
	await expect(page.getByTitle(/Annuler le trait|Undo stroke/)).toBeDisabled();
	await expect(page.getByTestId('image-replaced-notice')).toBeVisible();
	await expect(page.getByTestId('image-meta')).toContainText('binary-refresh-blue.png');

	await draw(page);
	const exported = await downloadBytes(page, info, 'refreshed-image.png');
	expect(exported.name).toBe('binary-refresh-blue-annotated.png');
	const pixels = await page.evaluate(async (base64) => {
		const image = new Image();
		image.src = `data:image/png;base64,${base64}`;
		await image.decode();
		const canvas = document.createElement('canvas');
		canvas.width = image.naturalWidth;
		canvas.height = image.naturalHeight;
		const context = canvas.getContext('2d')!;
		context.drawImage(image, 0, 0);
		const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
		let red = 0;
		let blue = 0;
		for (let index = 0; index < data.length; index += 4) {
			if (data[index + 3] === 0) continue;
			if (data[index]! > 200 && data[index + 1]! < 60 && data[index + 2]! < 60) red++;
			if (data[index + 2]! > 200 && data[index]! < 60 && data[index + 1]! < 60) blue++;
		}
		return { red, blue };
	}, exported.bytes.toString('base64'));
	expect(pixels.blue).toBeGreaterThan(0);
	expect(pixels.red).toBe(0);
	expect(
		await page.evaluate(() => window.__binaryImageSources?.length ?? 0)
	).toBeGreaterThanOrEqual(2);
});

test('keeps the decoded image and its annotations when another tab changes metadata only', async ({
	page
}) => {
	const red = await solidPng(page, '#ff0000');
	await seedDraft(page, imageRow('binary-image-metadata', red));
	await waitForImage(page);
	await draw(page);
	await expect(page.getByTitle(/Annuler le trait|Undo stroke/)).toBeEnabled();
	const decodes = await page.evaluate(() => window.__binaryImageSources?.length ?? 0);

	await commitRemote(page, {
		...imageRow('binary-image-metadata', red, 'renamed-binary-refresh.png'),
		updatedAt: 1_700_000_000_010
	});

	await expect(page.getByTestId('image-meta')).toContainText('renamed-binary-refresh.png');
	await expect(page.getByTitle(/Annuler le trait|Undo stroke/)).toBeEnabled();
	await expect(page.getByTestId('image-replaced-notice')).toHaveCount(0);
	await expect
		.poll(() => page.evaluate(() => window.__binaryImageSources?.length ?? 0))
		.toBe(decodes);
});

test('ends on the newest image after rapid same-ID replacements and clears an invalid payload', async ({
	page
}, info) => {
	const red = await solidPng(page, '#ff0000');
	const blue = await solidPng(page, '#0000ff');
	const green = await solidPng(page, '#00ff00');
	await seedDraft(page, imageRow('binary-image-rapid', red));
	await waitForImage(page);

	await commitRemote(page, {
		...imageRow('binary-image-rapid', blue, 'binary-refresh-blue.png'),
		updatedAt: 1_700_000_000_010
	});
	await commitRemote(page, {
		...imageRow('binary-image-rapid', green, 'binary-refresh-green.png'),
		updatedAt: 1_700_000_000_020
	});
	await expect
		.poll(async () => {
			const color = await canvasColor(page);
			return color.green > 0 && color.red === 0 && color.blue === 0;
		})
		.toBe(true);
	await expect(page.getByTestId('image-meta')).toContainText('binary-refresh-green.png');

	await draw(page);
	const exported = await downloadBytes(page, info, 'rapid-image.png');
	expect(exported.name).toBe('binary-refresh-green-annotated.png');
	expect(exported.bytes.length).toBeGreaterThan(0);

	await commitRemote(page, {
		...imageRow('binary-image-rapid', 'data:image/png;base64,AAAA', 'binary-refresh-broken.png'),
		updatedAt: 1_700_000_000_030
	});
	await expect(page.getByTestId('image-document').getByRole('alert')).toBeVisible();
	await expect(page.getByTestId('image-canvas')).toHaveCount(0);
});

async function waitForPdf(page: Page): Promise<string> {
	await expect(page.getByTestId('pdf-document')).toBeVisible();
	await expect(page.getByTestId('pdf-frame')).toHaveAttribute('src', /^blob:/);
	return (await page.getByTestId('pdf-frame').getAttribute('src'))!;
}

async function createdUrls(page: Page): Promise<ObjectUrlRecord[]> {
	return page.evaluate(() => window.__binaryObjectUrls?.created ?? []);
}

async function revokedUrls(page: Page): Promise<string[]> {
	return page.evaluate(() => window.__binaryObjectUrls?.revoked ?? []);
}

test('replaces a same-ID PDF payload, revokes the old object URL and rejects an invalid payload', async ({
	page
}, info) => {
	const first = pdfBytes('first payload');
	const second = pdfBytes('second payload');
	const other = pdfRow('binary-pdf-other', dataUrl(pdfBytes('other payload')), 'other.pdf');
	other.order = 1;
	await seedDraft(page, pdfRow('binary-pdf-refresh', dataUrl(first)), [other]);
	const firstUrl = await waitForPdf(page);
	await expect
		.poll(async () => (await createdUrls(page)).find((entry) => entry.url === firstUrl)?.text)
		.toContain('first payload');

	await commitRemote(page, {
		...pdfRow('binary-pdf-refresh', dataUrl(second), 'binary-refresh-second.pdf'),
		updatedAt: 1_700_000_000_010
	});
	await expect.poll(() => page.getByTestId('pdf-frame').getAttribute('src')).not.toBe(firstUrl);
	const secondUrl = await waitForPdf(page);
	await expect
		.poll(async () => (await createdUrls(page)).find((entry) => entry.url === secondUrl)?.text)
		.toContain('second payload');
	await expect.poll(() => revokedUrls(page)).toContain(firstUrl);
	await expect(page.getByTestId('pdf-document')).toContainText('binary-refresh-second.pdf');

	// A metadata-only row must keep the object URL.
	const beforeRename = await createdUrls(page);
	await commitRemote(page, {
		...pdfRow('binary-pdf-refresh', dataUrl(second), 'renamed-binary-refresh.pdf'),
		updatedAt: 1_700_000_000_020
	});
	await expect(page.getByTestId('pdf-document')).toContainText('renamed-binary-refresh.pdf');
	await expect(page.getByTestId('pdf-frame')).toHaveAttribute('src', secondUrl);
	expect((await createdUrls(page)).length).toBe(beforeRename.length);

	// Leaving the document must revoke the object URL that it displayed.
	await page.locator('aside button[data-file-id="binary-pdf-other"]').click();
	await expect(page.getByTestId('pdf-document')).toContainText('other.pdf');
	await expect.poll(() => revokedUrls(page)).toContain(secondUrl);
	const otherUrl = await waitForPdf(page);
	expect(otherUrl).not.toBe(secondUrl);
	await page.locator('aside button[data-file-id="binary-pdf-refresh"]').click();
	await expect(page.getByTestId('pdf-document')).toContainText('renamed-binary-refresh.pdf');
	const reopenedUrl = await waitForPdf(page);
	await expect(page.getByTestId('pdf-frame')).toHaveAttribute('src', reopenedUrl);
	expect((await createdUrls(page)).length - (await revokedUrls(page)).length).toBe(1);

	// Rapid replacements must end on the newest payload and release the superseded URL.
	const third = pdfBytes('third payload');
	const fourth = pdfBytes('fourth payload');
	await commitRemote(page, {
		...pdfRow('binary-pdf-refresh', dataUrl(third), 'binary-refresh-third.pdf'),
		updatedAt: 1_700_000_000_030
	});
	await commitRemote(page, {
		...pdfRow('binary-pdf-refresh', dataUrl(fourth), 'binary-refresh-fourth.pdf'),
		updatedAt: 1_700_000_000_040
	});
	await expect.poll(() => page.getByTestId('pdf-frame').getAttribute('src')).not.toBe(secondUrl);
	const fourthUrl = await waitForPdf(page);
	const created = await createdUrls(page);
	expect(created.find((entry) => entry.url === fourthUrl)?.text).toBeDefined();
	await expect
		.poll(async () => (await createdUrls(page)).find((entry) => entry.url === fourthUrl)?.text)
		.toContain('fourth payload');
	expect(created.length - (await revokedUrls(page)).length).toBe(1);

	// An invalid replacement must not keep the previous PDF on screen.
	await commitRemote(page, {
		...pdfRow('binary-pdf-refresh', 'data:application/pdf;base64,not-base64', 'broken.pdf'),
		updatedAt: 1_700_000_000_050
	});
	await expect(page.getByTestId('pdf-document').getByRole('alert')).toBeVisible();
	await expect(page.getByTestId('pdf-frame')).toHaveCount(0);
	expect((await createdUrls(page)).length).toBe((await revokedUrls(page)).length);

	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	await expect(page.getByTestId('pdf-document')).toBeVisible();
	await expect(page.getByTestId('pdf-document').getByRole('alert')).toBeVisible();
	await info.attach('pdf-refresh.json', {
		body: JSON.stringify(
			{ firstUrl, secondUrl, fourthUrl, created: created.length, revoked: await revokedUrls(page) },
			null,
			2
		),
		contentType: 'application/json'
	});
});

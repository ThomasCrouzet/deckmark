import { deflateSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import { resetAppState } from './helpers';

// Project media cache epochs for issue 571.
test.use({ locale: 'en-US', reducedMotion: 'reduce', trace: 'off' });

const counterKey = 'deckmark:media-counters';

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

/** Valid grayscale PNG with a constant value. Equal inputs have equal length. */
function solidPng(value: number): string {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(64, 0);
	header.writeUInt32BE(64, 4);
	header[8] = 8;
	header[9] = 0;
	const row = Buffer.alloc(65);
	row.fill(value, 1);
	const raw = Buffer.concat(Array.from({ length: 64 }, () => row));
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		pngChunk('IHDR', header),
		pngChunk('IDAT', deflateSync(raw, { level: 9 })),
		pngChunk('IEND', Buffer.alloc(0))
	]).toString('base64');
}

interface MediaStats {
	contextReads: number;
	assetReads: number;
	assetIndexBuilds: number;
	assetKeysVisited: number;
	decodeCalls: number;
	imageCacheHits: number;
	imageCacheMisses: number;
	resolvedHits: number;
	resolvedMisses: number;
	fingerprintCalls: number;
	fingerprintBytes: number;
	epoch: number;
}

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

async function mediaStats(page: Page): Promise<MediaStats> {
	return page.evaluate(() =>
		(
			window as unknown as {
				__MDSH_PROJECT_MEDIA__?: { stats: () => MediaStats };
			}
		).__MDSH_PROJECT_MEDIA__!.stats()
	);
}

async function resetMediaStats(page: Page): Promise<void> {
	await page.evaluate(() => {
		(
			window as unknown as { __MDSH_PROJECT_MEDIA__?: { reset: () => void } }
		).__MDSH_PROJECT_MEDIA__!.reset();
	});
}

async function openVisualEditor(page: Page) {
	await page.locator('[data-mode=wysiwyg]').click();
	const dialog = page.getByRole('dialog', { name: /Render this large document/ });
	await dialog.waitFor({ state: 'visible', timeout: 3_000 }).catch(() => {});
	if (await dialog.isVisible().catch(() => false)) {
		await dialog.getByRole('button', { name: /Render document/ }).click();
	}
	await expect(page.locator('.ProseMirror')).toHaveAttribute('contenteditable', 'true', {
		timeout: 60_000
	});
}

async function seedProject(page: Page, redBase64: string) {
	await page.evaluate(
		async ({ red }) => {
			const bytes = (base64: string) =>
				Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
			await new Promise<void>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const transaction = database.transaction(
						['projects', 'drafts', 'projectAssets'],
						'readwrite'
					);
					transaction.objectStore('projects').put({
						id: 'media-project',
						name: 'Media project',
						createdAt: 1,
						updatedAt: 1
					});
					transaction.objectStore('projectAssets').put({
						id: 'asset-a',
						projectId: 'media-project',
						path: 'assets/a.png',
						mime: 'image/png',
						data: bytes(red)
					});
					transaction.objectStore('drafts').put({
						id: 'note-a',
						name: 'note-a.md',
						content:
							'# With media\n\n![Red one](../assets/a.png)\n\nBetween.\n\n![Red two](../assets/a.png)\n\nTail.\n',
						projectId: 'media-project',
						relativePath: 'notes/note-a.md',
						createdAt: 1,
						updatedAt: 1,
						order: 0
					});
					transaction.objectStore('drafts').put({
						id: 'note-b',
						name: 'note-b.md',
						content: '# Unrelated\n\nPlain text.\n',
						projectId: 'media-project',
						relativePath: 'notes/note-b.md',
						createdAt: 1,
						updatedAt: 1,
						order: 1
					});
					transaction.oncomplete = () => {
						database.close();
						resolve();
					};
					transaction.onerror = () => reject(transaction.error);
				};
			});
			localStorage.setItem('mdsh:activeId', 'note-a');
			localStorage.setItem('mdsh:locale', 'en');
		},
		{ red: redBase64 }
	);
}

async function imagePixels(page: Page): Promise<number[]> {
	return page
		.locator('.milkdown-image-block img')
		.first()
		.evaluate((element) => {
			const image = element as HTMLImageElement;
			const canvas = document.createElement('canvas');
			canvas.width = 1;
			canvas.height = 1;
			const context = canvas.getContext('2d')!;
			context.drawImage(image, 0, 0, 1, 1);
			return [...context.getImageData(0, 0, 1, 1).data];
		});
}

test('repeated project image resolution does not reread or rehash the asset', async ({
	page
}, info) => {
	test.setTimeout(120_000);
	await installCounters(page);
	await resetAppState(page, { mode: 'source' });
	await seedProject(page, solidPng(40));
	await page.reload();
	await openVisualEditor(page);
	await expect(page.locator('.milkdown-image-block img')).toHaveCount(2);
	await expect
		.poll(() =>
			page
				.locator('.milkdown-image-block img')
				.evaluateAll((images) => images.every((image) => image.complete))
		)
		.toBe(true);
	await page.locator('[data-mode=source]').click();
	await resetMediaStats(page);
	await openVisualEditor(page);
	await expect(page.locator('.milkdown-image-block img')).toHaveCount(2);
	await expect
		.poll(() =>
			page
				.locator('.milkdown-image-block img')
				.evaluateAll((images) => images.every((image) => image.complete))
		)
		.toBe(true);
	const stats = await mediaStats(page);
	expect(stats.assetReads).toBe(0);
	expect(stats.fingerprintCalls).toBe(0);
	expect(stats.fingerprintBytes).toBe(0);
	expect(stats.decodeCalls).toBe(0);
	expect(stats.resolvedHits).toBeGreaterThanOrEqual(2);
	await info.attach('project-media-cache.json', {
		body: JSON.stringify(
			{ stats, browser: page.context().browser()?.version(), method: 'mode remount' },
			null,
			2
		),
		contentType: 'application/json'
	});
});

test('an unrelated cross-tab save keeps project image work valid', async ({
	page,
	context
}, info) => {
	test.setTimeout(150_000);
	await installCounters(page);
	await resetAppState(page, { mode: 'source' });
	await seedProject(page, solidPng(40));
	await page.reload();
	await openVisualEditor(page);
	await expect(page.locator('.milkdown-image-block img')).toHaveCount(2);
	const before = await mediaStats(page);

	const other = await context.newPage();
	await other.goto('/');
	await other.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	await other.locator('aside button[data-file-id="note-b"]').click();
	await other.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	await other.locator('[data-mode=source]').click();
	const source = other.locator('.cm-content').first();
	await expect(source).toBeVisible({ timeout: 20_000 });
	await source.click();
	await other.keyboard.press('ControlOrMeta+End');
	await other.keyboard.insertText(' Cross-tab edit.');
	await expect
		.poll(() =>
			other.evaluate(
				() =>
					new Promise<boolean>((resolve, reject) => {
						const request = indexedDB.open('mdsh');
						request.onerror = () => reject(request.error);
						request.onsuccess = () => {
							const database = request.result;
							const get = database.transaction('drafts').objectStore('drafts').get('note-b');
							get.onsuccess = () => {
								database.close();
								resolve(
									((get.result as { content?: string } | undefined)?.content ?? '').includes(
										'Cross-tab edit.'
									)
								);
							};
							get.onerror = () => reject(get.error);
						};
					})
			)
		)
		.toBe(true);
	await page.waitForTimeout(500);
	const after = await mediaStats(page);
	expect(after.epoch).toBe(before.epoch);

	await page.locator('[data-mode=source]').click();
	await resetMediaStats(page);
	await openVisualEditor(page);
	await expect(page.locator('.milkdown-image-block img')).toHaveCount(2);
	await expect
		.poll(async () => (await mediaStats(page)).resolvedHits, { timeout: 10_000 })
		.toBeGreaterThanOrEqual(2);
	const resolved = await mediaStats(page);
	expect(resolved.assetReads).toBe(0);
	expect(resolved.decodeCalls).toBe(0);
	expect(resolved.fingerprintCalls).toBe(0);
	expect(await imagePixels(page)).toEqual([40, 40, 40, 255]);
	await other.close();
	await info.attach('project-media-cross-tab.json', {
		body: JSON.stringify({ before, after, resolved }, null, 2),
		contentType: 'application/json'
	});
});

test('an equal-length asset replacement returns the new bytes', async ({ page }, info) => {
	test.setTimeout(120_000);
	await installCounters(page);
	await resetAppState(page, { mode: 'source' });
	const red = solidPng(40);
	const blue = solidPng(200);
	expect(Buffer.from(red, 'base64').length).toBe(Buffer.from(blue, 'base64').length);
	await seedProject(page, red);
	await page.reload();
	await openVisualEditor(page);
	await expect(page.locator('.milkdown-image-block img')).toHaveCount(2);
	expect(await imagePixels(page)).toEqual([40, 40, 40, 255]);

	// A native external refresh writes the row and then signals the media
	// generation. The same notification path covers a cross-tab asset change.
	await page.evaluate(async (base64) => {
		const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
		await new Promise<void>((resolve, reject) => {
			const request = indexedDB.open('mdsh');
			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				const database = request.result;
				const transaction = database.transaction('projectAssets', 'readwrite');
				transaction.objectStore('projectAssets').put({
					id: 'asset-a',
					projectId: 'media-project',
					path: 'assets/a.png',
					mime: 'image/png',
					data: bytes
				});
				transaction.oncomplete = () => {
					database.close();
					resolve();
				};
				transaction.onerror = () => reject(transaction.error);
			};
		});
		new BroadcastChannel('mdsh').postMessage({ type: 'project-assets-changed' });
	}, blue);
	await page.waitForTimeout(300);
	await page.locator('[data-mode=source]').click();
	await resetMediaStats(page);
	await openVisualEditor(page);
	await expect(page.locator('.milkdown-image-block img')).toHaveCount(2);
	await expect
		.poll(async () => imagePixels(page), { timeout: 20_000 })
		.toEqual([200, 200, 200, 255]);
	const stats = await mediaStats(page);
	expect(stats.decodeCalls).toBeGreaterThanOrEqual(1);
	await expect
		.poll(() =>
			page
				.locator('.milkdown-image-block img')
				.evaluateAll((images) =>
					images.every((image) => (image as HTMLImageElement).alt.startsWith('Red'))
				)
		)
		.toBe(true);
	await info.attach('project-media-replacement.json', {
		body: JSON.stringify({ redBytes: Buffer.from(red, 'base64').length, stats }, null, 2),
		contentType: 'application/json'
	});
});

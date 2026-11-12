import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { openPalette, resetAppState } from './helpers';

test.use({ locale: 'fr-FR', reducedMotion: 'reduce' });

const fixtures = [
	{
		name: 'review.png',
		mimeType: 'image/png',
		buffer: Buffer.from(
			'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
			'base64'
		)
	},
	{
		name: 'review.pdf',
		mimeType: 'application/pdf',
		buffer: Buffer.from('%PDF-1.4\n% Binary export fixture\n%%EOF\n')
	}
];

const command =
	'E2E_PORT=4185 npx playwright test e2e/binary-review.spec.ts e2e/pdf-viewer.spec.ts --project=chromium --workers=1 --retries=0';

test.beforeEach(async ({ page }) => resetAppState(page));

test.afterEach(async ({ page, browser }, info) => {
	await info.attach('binary-review.json', {
		body: JSON.stringify(
			{
				command,
				source: info.config.metadata,
				browser: browser.version(),
				platform: process.platform,
				status: info.status,
				title: info.title,
				fixtures: fixtures.map((fixture) => ({
					name: fixture.name,
					bytes: fixture.buffer.length,
					sha256: createHash('sha256').update(fixture.buffer).digest('hex')
				}))
			},
			null,
			2
		),
		contentType: 'application/json'
	});
	await info.attach('binary-review.png', {
		body: await page.screenshot(),
		contentType: 'image/png'
	});
});

async function importBinary(page: Page, fixture: (typeof fixtures)[number]) {
	await page.locator('input[type="file"][accept*="text/markdown"]').setInputFiles(fixture);
	await expect(page.getByTestId('document-kind')).toHaveText(
		fixture.mimeType === 'application/pdf' ? 'PDF' : 'Image'
	);
}

async function downloadBytes(
	page: Page,
	info: TestInfo,
	name: string,
	action: () => Promise<void>
) {
	const pending = page.waitForEvent('download');
	await action();
	const download = await pending;
	const path = info.outputPath(name);
	await download.saveAs(path);
	await info.attach(name, { path });
	return { name: download.suggestedFilename(), bytes: await readFile(path) };
}

const ZIP_LOCAL_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const ZIP_EOCD = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const EXPECTED_LIBRARY_ZIP = /^deckmark-export-\d{4}-\d{2}-\d{2}\.zip$/;

/** Bounded metadata for a failed library ZIP parse. Never includes raw bytes. */
function zipBoundary(bytes: Buffer, suggestedFilename: string) {
	const eocdOffset = bytes.lastIndexOf(ZIP_EOCD);
	const eocdCommentLength =
		eocdOffset >= 0 && eocdOffset + 22 <= bytes.length ? bytes.readUInt16LE(eocdOffset + 20) : null;
	return {
		triggerCommand: 'Exporter tous les fichiers',
		suggestedFilename,
		expectedFilenamePattern: EXPECTED_LIBRARY_ZIP.source,
		filenameMatchesExpected: EXPECTED_LIBRARY_ZIP.test(suggestedFilename),
		byteLength: bytes.length,
		first8Hex: bytes.length >= 8 ? bytes.subarray(0, 8).toString('hex') : null,
		last32Hex: bytes.length >= 32 ? bytes.subarray(-32).toString('hex') : null,
		localHeader: bytes.length >= 4 ? bytes.subarray(0, 4).equals(ZIP_LOCAL_HEADER) : null,
		eocdOffset: eocdOffset >= 0 ? eocdOffset : null,
		eocdFromEnd: eocdOffset >= 0 ? bytes.length - eocdOffset : null,
		eocdEndsAtLength:
			eocdOffset >= 0 &&
			eocdCommentLength !== null &&
			eocdOffset + 22 + eocdCommentLength === bytes.length
	};
}

async function loadLibraryZip(info: TestInfo, download: { name: string; bytes: Buffer }) {
	try {
		return await (await import('jszip')).default.loadAsync(download.bytes);
	} catch (error) {
		try {
			const boundary = zipBoundary(download.bytes, download.name);
			const payload = JSON.stringify(boundary);
			console.error(`[library-zip-boundary] ${payload}`);
			await info.attach('binary-library-zip-boundary.json', {
				body: payload,
				contentType: 'application/json'
			});
		} catch (diagnosticError) {
			console.error('[library-zip-boundary] diagnostic capture failed', diagnosticError);
		}
		throw error;
	}
}

async function exportLibrary(page: Page) {
	await openPalette(page);
	await page.keyboard.insertText('Exporter tous les fichiers');
	// Enter runs the option that is selected when the key arrives, not the
	// option that matches the text. Wait for the filtered command to become
	// the selected option, or the palette can run its first command instead.
	const dialog = page.getByRole('dialog', { name: 'Palette de commandes' });
	const option = dialog.getByRole('option', { name: 'Exporter tous les fichiers' });
	await expect(option).toBeVisible();
	await expect(option).toHaveAttribute('aria-selected', 'true');
	await page.keyboard.press('Enter');
}

for (const fixture of fixtures) {
	for (const action of ['save-as', 'save-to-disk']) {
		test(`${action} preserves ${fixture.name} bytes without a disk link`, async ({
			page
		}, info) => {
			await importBinary(page, fixture);
			// Keep a broken text save from opening a native dialog or overwriting a real file.
			await page.evaluate(() => {
				Object.defineProperty(window, 'showSaveFilePicker', {
					configurable: true,
					value: async () => {
						throw new DOMException('Binary export must use a download', 'AbortError');
					}
				});
			});
			const result = await downloadBytes(page, info, `${action}-${fixture.name}`, () =>
				page.getByTestId(action).click()
			);
			expect(result.name).toBe(fixture.name);
			expect(result.bytes.equals(fixture.buffer)).toBe(true);
			await expect(
				page.locator('#app-toolbar [data-testid^="storage-status-"]')
			).not.toHaveAttribute('data-origin', 'disk');
			await expect(page.getByTestId('disk-edit-mode')).not.toHaveAttribute('data-mode', 'in-place');
		});
	}
}

test('library ZIP preserves image and PDF bytes', async ({ page }, info) => {
	for (const fixture of fixtures) await importBinary(page, fixture);
	const download = await downloadBytes(page, info, 'binary-library.zip', () => exportLibrary(page));
	const zip = await loadLibraryZip(info, download);
	for (const fixture of fixtures) {
		const entry = zip.file(fixture.name);
		expect(entry).not.toBeNull();
		expect((await entry!.async('nodebuffer')).equals(fixture.buffer)).toBe(true);
	}
});

test('project ZIP and nested library ZIP preserve binary document bytes', async ({
	page
}, info) => {
	const { default: JSZip } = await import('jszip');
	const seed = new JSZip();
	seed.file('README.md', '# Binary project\n');
	await page.getByTestId('projects-open').click();
	const panel = page.getByRole('dialog', { name: 'Projets Markdown' });
	await panel.locator('input[type=file][accept=".zip"]').setInputFiles({
		name: 'Binary.zip',
		mimeType: 'application/zip',
		buffer: await seed.generateAsync({ type: 'nodebuffer' })
	});
	await expect(
		panel.getByRole('button', { name: 'Exporter le projet', exact: true })
	).toBeEnabled();
	await panel.getByRole('button', { name: 'Fermer les projets' }).click();
	const root = page.locator('[data-project-root-name="Binary"]');
	await expect(root).toBeVisible();
	if ((await root.locator('details').first().getAttribute('open')) === null)
		await root.locator('summary').first().click();
	for (const fixture of fixtures) {
		await importBinary(page, fixture);
		const row = page
			.locator('aside .mdsh-file-row:not([data-project-document])')
			.filter({ hasText: fixture.name.replace(/\.[^.]+$/, '') })
			.locator('button[data-file-id]');
		await row.dragTo(root.locator('summary').first());
		await expect(root.locator(`[data-project-document="${fixture.name}"]`)).toBeVisible();
	}
	await page.getByTestId('projects-open').click();
	const projectDownload = await downloadBytes(page, info, 'binary-project.zip', () =>
		panel.getByRole('button', { name: 'Exporter le projet', exact: true }).click()
	);
	await panel.getByRole('button', { name: 'Fermer les projets' }).click();
	const libraryDownload = await downloadBytes(page, info, 'nested-binary-library.zip', () =>
		exportLibrary(page)
	);
	const library = await JSZip.loadAsync(libraryDownload.bytes);
	const nested = library.file('Binary.zip');
	expect(nested).not.toBeNull();
	for (const bytes of [projectDownload.bytes, await nested!.async('nodebuffer')]) {
		const archive = await JSZip.loadAsync(bytes);
		for (const fixture of fixtures) {
			const entry = archive.file(fixture.name);
			expect(entry).not.toBeNull();
			expect((await entry!.async('nodebuffer')).equals(fixture.buffer)).toBe(true);
		}
	}
});

test('library ZIP rejects an oversized restored PDF instead of exporting empty text', async ({
	page
}, info) => {
	await importBinary(page, fixtures[1]!);
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					new Promise<boolean>((resolve, reject) => {
						const opening = indexedDB.open('mdsh');
						opening.onerror = () => reject(opening.error);
						opening.onsuccess = () => {
							const database = opening.result;
							const request = database.transaction('drafts').objectStore('drafts').getAll();
							request.onsuccess = () => {
								database.close();
								resolve(request.result.some((row) => row.name === 'review.pdf' && row.data));
							};
							request.onerror = () => reject(request.error);
						};
					})
			)
		)
		.toBe(true);
	await page.evaluate(async () => {
		const bytes = new Uint8Array(16 * 1024 * 1024 + 1);
		bytes.set(new TextEncoder().encode('%PDF-1.4\n'));
		const data = await new Promise<string>((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () =>
				typeof reader.result === 'string'
					? resolve(reader.result)
					: reject(new Error('No data URL'));
			reader.onerror = () => reject(reader.error);
			reader.readAsDataURL(new Blob([bytes], { type: 'application/pdf' }));
		});
		await new Promise<void>((resolve, reject) => {
			const opening = indexedDB.open('mdsh');
			opening.onerror = () => reject(opening.error);
			opening.onsuccess = () => {
				const database = opening.result;
				const transaction = database.transaction('drafts', 'readwrite');
				const store = transaction.objectStore('drafts');
				const request = store.getAll();
				request.onsuccess = () => {
					for (const row of request.result) {
						if (row.name === 'review.pdf') store.put({ ...row, data });
					}
				};
				transaction.oncomplete = () => {
					database.close();
					resolve();
				};
				transaction.onabort = () => reject(transaction.error);
			};
		});
	});
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	// Headless Chromium turns the PDF preview iframe blob into a browser
	// download. It is the preview, not an export, so exclude that exact blob
	// URL and require every other download to be absent.
	const preview = page.getByTestId('pdf-frame');
	await expect(preview).toBeVisible();
	const previewUrl = await preview.getAttribute('src');
	expect(previewUrl).toMatch(/^blob:/);
	const downloads: { url: string; name: string }[] = [];
	page.on('download', (download) =>
		downloads.push({ url: download.url(), name: download.suggestedFilename() })
	);
	await exportLibrary(page);
	await expect(page.getByText('La création du ZIP a échoué.', { exact: true })).toBeVisible();
	expect(downloads.filter((download) => download.url !== previewUrl)).toEqual([]);
	await info.attach('oversized-pdf.json', {
		body: JSON.stringify({ restoredBytes: 16 * 1024 * 1024 + 1, previewUrl, downloads }),
		contentType: 'application/json'
	});
});

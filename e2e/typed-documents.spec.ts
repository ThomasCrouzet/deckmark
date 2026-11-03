import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { resetAppState } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

const png = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lYQ7WQAAAABJRU5ErkJggg==',
	'base64'
);

async function setFiles(page: Page) {
	await page.locator('input[type="file"][accept*="text/markdown"]').setInputFiles([
		{ name: 'script.py', mimeType: 'text/x-python', buffer: Buffer.from('print("hello")\n') },
		{
			name: 'deck.md',
			mimeType: 'text/markdown',
			buffer: Buffer.from(
				'# Deck\n\n<!-- mdsh-presentation\n{"version":1,"width":1280,"height":720,"theme":"midnight","slides":[{"id":"s1","elements":[]}]}\n-->\n'
			)
		},
		{
			name: 'fake.py',
			mimeType: 'text/x-python',
			buffer: Buffer.from('<!-- mdsh-presentation\n{}\n-->\n')
		},
		{ name: 'pixel.png', mimeType: 'image/png', buffer: png }
	]);
}

async function openFile(page: Page, name: string) {
	await page
		.locator('aside')
		.getByRole('button', { name: new RegExp(`^${name}`) })
		.first()
		.click();
}

test('imports typed files and preserves their type and bytes', async ({ page }, info: TestInfo) => {
	await resetAppState(page);
	await setFiles(page);
	await expect(page.getByTestId('document-kind')).toHaveText('Image');
	await expect(page.getByTestId('image-document')).toBeVisible();
	// The image document renders through a canvas so it can be annotated.
	await expect(page.getByTestId('image-canvas')).toBeVisible();
	await expect
		.poll(() =>
			page.getByTestId('image-canvas').evaluate((element) => (element as HTMLCanvasElement).width)
		)
		.toBeGreaterThan(0);

	const downloadPromise = page.waitForEvent('download');
	await page
		.getByTestId('image-document')
		.getByRole('button', { name: 'Exporter', exact: true })
		.click();
	const download = await downloadPromise;
	expect(download.suggestedFilename()).toBe('pixel.png');
	const exported = await readFile((await download.path())!);
	expect(exported.equals(png)).toBe(true);

	await openFile(page, 'script\\.py');
	await expect(page.getByTestId('document-kind')).toHaveText('Code');
	await expect(page.locator('.cm-content')).toContainText('print("hello")');
	await expect(page.locator('[data-mode="wysiwyg"]')).toHaveCount(0);

	await openFile(page, 'fake\\.py');
	await expect(page.getByTestId('document-kind')).toHaveText('Code');
	await expect(page.locator('.cm-content')).toContainText('mdsh-presentation');

	await openFile(page, 'deck');
	await expect(page.getByTestId('document-kind')).toHaveText('Présentation');

	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	await openFile(page, 'script\\.py');
	await expect(page.getByTestId('document-kind')).toHaveText('Code');
	await openFile(page, 'pixel\\.png');
	await expect(page.getByTestId('document-kind')).toHaveText('Image');

	const kinds = await page.evaluate(
		() =>
			new Promise<Array<{ name: string; kind?: string }>>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const rows = request.result.transaction('drafts').objectStore('drafts').getAll();
					rows.onerror = () => reject(rows.error);
					rows.onsuccess = () => {
						request.result.close();
						resolve(rows.result.map((row) => ({ name: row.name, kind: row.kind })));
					};
				};
			})
	);
	expect(kinds).toEqual(
		expect.arrayContaining([
			{ name: 'script.py', kind: 'code' },
			{ name: 'fake.py', kind: 'code' },
			{ name: 'deck.md', kind: 'presentation' },
			{ name: 'pixel.png', kind: 'image' }
		])
	);

	await info.attach('typed-documents.json', {
		body: JSON.stringify({ kinds, pngBytes: png.length }, null, 2),
		contentType: 'application/json'
	});
	await info.attach('typed-documents.png', { body: await page.screenshot() });
});

test('edits a code file and keeps its extension on export', async ({ page }, info: TestInfo) => {
	await resetAppState(page);
	await page.locator('input[type="file"][accept*="text/markdown"]').setInputFiles({
		name: 'main.rs',
		mimeType: 'text/rust',
		buffer: Buffer.from('fn main() {}\n')
	});
	const editor = page.locator('.cm-content').first();
	await expect(editor).toContainText('fn main');
	await editor.click();
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.insertText('fn main() {\n    println!("ok");\n}\n');
	await page.waitForTimeout(600);
	const downloadPromise = page.waitForEvent('download');
	await page.getByRole('button', { name: 'Exporter', exact: true }).click();
	const download = await downloadPromise;
	expect(download.suggestedFilename()).toBe('main.rs');
	const text = await readFile((await download.path())!, 'utf8');
	expect(text).toBe('fn main() {\n    println!("ok");\n}\n');

	await info.attach('code-export.rs', { body: text, contentType: 'text/plain' });
});

test('skips unsupported binary documents with an import report', async ({
	page
}, info: TestInfo) => {
	await resetAppState(page);
	await page.locator('input[type="file"][accept*="text/markdown"]').setInputFiles([
		{ name: 'valid.md', mimeType: 'text/markdown', buffer: Buffer.from('# Valid') },
		{ name: 'unknown.xyz', mimeType: 'application/octet-stream', buffer: Buffer.from([0, 1, 2]) }
	]);
	await expect(page.locator('.cm-content').first()).toContainText('Valid');
	await expect(page.locator('aside button[data-file-id]')).toHaveCount(1);
	await info.attach('unsupported-import.json', {
		body: JSON.stringify({ imported: 1, skipped: 1 }),
		contentType: 'application/json'
	});
});

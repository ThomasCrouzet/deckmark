import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { resetAppState } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

async function importJson(page: Page, name: string, content: string) {
	await page.locator('input[type="file"][accept*="text/markdown"]').setInputFiles({
		name,
		mimeType: 'application/json',
		buffer: Buffer.from(content)
	});
	await expect(page.getByTestId('code-editor')).toBeVisible({ timeout: 20_000 });
	await expect(page.getByTestId('json-status')).toBeVisible();
}

async function savedContent(page: Page): Promise<string> {
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
						const latest = rows.result
							.filter((row) => row.open !== false)
							.sort((a, b) => b.updatedAt - a.updatedAt)[0];
						resolve(latest?.content ?? '');
					};
				};
			})
	);
}

async function fillJson(page: Page, content: string) {
	const editor = page.locator('.cm-content').first();
	await editor.click();
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.insertText(content);
}

test('validates, formats and minifies JSON without losing data', async ({
	page
}, info: TestInfo) => {
	await resetAppState(page);
	const source = '{"big":12345678901234567890,"text":"cœur 🎉","nested":{"a":1},"list":[1,2]}';
	await importJson(page, 'data.json', source);
	await expect(page.getByTestId('json-status')).toHaveText('JSON valide');

	await page.getByTestId('json-format').click();
	await expect
		.poll(() => savedContent(page))
		.toBe(
			'{\n  "big": 12345678901234567890,\n  "text": "cœur 🎉",\n  "nested": {\n    "a": 1\n  },\n  "list": [\n    1,\n    2\n  ]\n}'
		);
	await page.keyboard.press('ControlOrMeta+z');
	await expect.poll(() => savedContent(page)).toBe(source);

	await page.getByTestId('json-minify').click();
	await expect.poll(() => savedContent(page)).toBe(source);

	await fillJson(page, '{"a": }');
	await expect(page.getByTestId('json-status')).toContainText('JSON invalide');
	await expect(page.getByTestId('json-format')).toBeDisabled();
	await expect
		.poll(() => page.getByTestId('json-status').innerText())
		.toMatch(/ligne \d+, colonne \d+/);

	await info.attach('json-tools.json', {
		body: JSON.stringify({
			source,
			formatted: true,
			minified: await savedContent(page),
			invalidLocated: true
		}),
		contentType: 'application/json'
	});
});

test('preserves duplicate keys and CRLF output', async ({ page }, info: TestInfo) => {
	await resetAppState(page);
	const duplicate = '{"a":1,"a":2}';
	await importJson(page, 'duplicates.json', duplicate);
	await expect(page.getByTestId('json-duplicates')).toContainText('"a"');
	await page.getByTestId('json-format').click();
	await expect
		.poll(() => savedContent(page))
		.toBe('{\r\n  "a": 1,\r\n  "a": 2\r\n}'.replace(/\r\n/g, '\n'));

	await page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		const handle = await root.getFileHandle('unused.json', { create: true });
		void handle;
	});
	await importJson(page, 'crlf.json', '{"a":1,"b":2}\r\n');
	await expect(page.getByTestId('code-eol')).toHaveText('CRLF');
	await page.getByTestId('json-format').click();
	await expect.poll(() => savedContent(page)).toBe('{\r\n  "a": 1,\r\n  "b": 2\r\n}');

	const downloadPromise = page.waitForEvent('download');
	await page.getByRole('button', { name: 'Exporter', exact: true }).click();
	const download = await downloadPromise;
	expect(download.suggestedFilename()).toBe('crlf.json');
	const exported = await readFile((await download.path())!, 'utf8');
	expect(exported).toBe('{\r\n  "a": 1,\r\n  "b": 2\r\n}');

	await info.attach('json-duplicates.txt', {
		body: JSON.stringify({ duplicate, exported }),
		contentType: 'application/json'
	});
});

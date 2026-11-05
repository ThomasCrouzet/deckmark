import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { resetAppState } from './helpers';
import { waitForPresentation } from './presentation-helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

const fixturePath = (name: string) => new URL(`./fixtures/compat/${name}`, import.meta.url);

async function openEnglish(page: Page): Promise<void> {
	await resetAppState(page);
	await page.evaluate(() => localStorage.setItem('mdsh:locale', 'en'));
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
}

async function importFile(page: Page, name: string, bytes: Buffer): Promise<void> {
	await page.locator('input[type="file"][accept*="text/markdown"]').setInputFiles({
		name,
		mimeType: 'text/markdown',
		buffer: bytes
	});
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
						const active = rows.result.find((row) => row.open !== false);
						request.result.close();
						resolve(active?.content ?? '');
					};
				};
			})
	);
}

async function expectBytesAfterReload(page: Page, text: string): Promise<void> {
	await expect.poll(() => savedContent(page)).toBe(text);
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	await expect.poll(() => savedContent(page)).toBe(text);
}

test('round-trips the released v2.4.0 minimal presentation', async ({ page }, info: TestInfo) => {
	await openEnglish(page);
	const fixture = (await readFile(fixturePath('presentation-v1-minimal.md'))).toString('utf8');
	await importFile(page, 'released-minimal.md', Buffer.from(fixture));
	await waitForPresentation(page);
	await expectBytesAfterReload(page, fixture);
	await info.attach('released-minimal.md', { body: fixture, contentType: 'text/markdown' });
});

test('round-trips the released v2.4.0 framed presentation', async ({ page }, info: TestInfo) => {
	await openEnglish(page);
	const fixture = (await readFile(fixturePath('presentation-v1-framed.md'))).toString('utf8');
	await importFile(page, 'released-framed.md', Buffer.from(fixture));
	const editor = await waitForPresentation(page);
	await expect(editor.getByTestId('slide-thumbnail')).toHaveCount(2);
	await expectBytesAfterReload(page, fixture);
	await info.attach('released-framed.md', { body: fixture, contentType: 'text/markdown' });
});

test('refuses the released future-version fixture without changing its bytes', async ({
	page
}, info: TestInfo) => {
	await openEnglish(page);
	const fixture = (await readFile(fixturePath('presentation-future-version.md'))).toString('utf8');
	await importFile(page, 'released-future.md', Buffer.from(fixture));
	const editor = await waitForPresentation(page);
	await expect(editor.getByTestId('slide-source-error')).toBeVisible();
	await expect(editor.getByTestId('slide-source-editor')).toHaveValue(fixture);
	await expect.poll(() => savedContent(page)).toBe(fixture);
	await info.attach('future-version-refusal.json', {
		body: JSON.stringify({ fixture: 'presentation-future-version.md', bytes: fixture.length }),
		contentType: 'application/json'
	});
});

test('keeps a BOM and CRLF note byte-identical', async ({ page }, info: TestInfo) => {
	await openEnglish(page);
	const bytes = await readFile(fixturePath('note-bom-crlf.md'));
	await importFile(page, 'bom-crlf.md', bytes);
	await expect(page.locator('.cm-content').first()).toBeVisible({ timeout: 20_000 });
	const text = bytes.toString('utf8');
	await expectBytesAfterReload(page, text);
	await info.attach('bom-crlf.md', { body: bytes, contentType: 'text/markdown' });
});

test('classifies literal presentation markers as an ordinary note', async ({ page }) => {
	await openEnglish(page);
	const fixture = (await readFile(fixturePath('note-literal-markers.md'))).toString('utf8');
	await importFile(page, 'literal-markers.md', Buffer.from(fixture));
	await expect(page.getByTestId('presentation-editor')).toHaveCount(0);
	await expect(page.locator('.cm-content')).toBeVisible();
	await expect.poll(() => savedContent(page)).toBe(fixture);
});

test('keeps metadata that is not at the end as a presentation for safe refusal', async ({
	page
}) => {
	await openEnglish(page);
	const fixture = (await readFile(fixturePath('presentation-metadata-not-at-end.md'))).toString(
		'utf8'
	);
	await importFile(page, 'metadata-not-at-end.md', Buffer.from(fixture));
	await expect(page.getByTestId('presentation-editor')).toBeVisible({ timeout: 20_000 });
	await expect(page.getByTestId('slide-source-error')).toBeVisible();
});

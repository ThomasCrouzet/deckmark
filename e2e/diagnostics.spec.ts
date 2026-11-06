import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { resetAppState } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

const sentinelBody = 'SENTINEL_DOCUMENT_BODY_4c1f';
const sentinelName = 'SENTINEL_FILE_NAME_77a2.md';
const sessionValue = 'sentinel_session_value_5b8d';

async function openEnglish(page: Page): Promise<void> {
	await resetAppState(page);
	await page.evaluate(() => localStorage.setItem('mdsh:locale', 'en'));
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
}

async function openDiagnostics(page: Page): Promise<void> {
	await page.keyboard.press('ControlOrMeta+Shift+p');
	await page.getByRole('combobox').fill('Report a problem');
	await page.keyboard.press('Enter');
	await expect(page.getByTestId('diagnostics-section')).toBeVisible();
	await expect(page.getByTestId('diagnostics-description')).toBeVisible();
}

test('builds, previews and downloads an identical secret-safe report', async ({ page }, info) => {
	await openEnglish(page);
	await page.locator('input[type="file"][accept*="text/markdown"]').setInputFiles({
		name: sentinelName,
		mimeType: 'text/markdown',
		buffer: Buffer.from(`# ${sentinelBody}\n\n${sentinelBody}\n`)
	});
	await expect(page.locator('.cm-content')).toContainText(sentinelBody);
	await page.evaluate((key) => sessionStorage.setItem('mdsh:ai-key', key), sessionValue);
	await openDiagnostics(page);
	await page.getByTestId('diagnostics-description').fill('The export button did nothing.');
	await page.getByTestId('diagnostics-include-stats').check();

	const requests: string[] = [];
	page.on('request', (request) => requests.push(request.url()));
	await page.getByTestId('diagnostics-build').click();
	const preview = page.getByTestId('diagnostics-preview');
	await expect(preview).toBeVisible({ timeout: 10_000 });
	const text = (await preview.textContent()) ?? '';
	expect(text).toContain('deckmark-diagnostics');
	expect(text).toContain('"documents": 1');
	expect(text).not.toContain(sentinelBody);
	expect(text).not.toContain(sentinelName);
	expect(text).not.toContain('SENTINEL_FILE_NAME_77a2');
	expect(text).not.toContain(sessionValue);
	expect(requests).toEqual([]);

	const [download] = await Promise.all([
		page.waitForEvent('download'),
		page.getByTestId('diagnostics-download').click()
	]);
	const path = await download.path();
	expect(path).toBeTruthy();
	const downloaded = await readFile(path!, 'utf8');
	expect(downloaded).toBe(text);
	expect(downloaded).not.toContain(sessionValue);

	await info.attach('diagnostics-preview.json', { body: text, contentType: 'application/json' });
	await info.attach('diagnostics-downloaded.json', {
		body: downloaded,
		contentType: 'application/json'
	});
});

test('cancel leaves no report and no download', async ({ page }) => {
	await openEnglish(page);
	await openDiagnostics(page);
	await page.getByTestId('diagnostics-description').fill('Temporary description');
	await page.getByTestId('diagnostics-build').click();
	await expect(page.getByTestId('diagnostics-preview')).toBeVisible();
	await page.getByTestId('diagnostics-cancel').click();
	await expect(page.getByTestId('diagnostics-preview')).toHaveCount(0);
	await expect(page.getByTestId('diagnostics-open')).toBeVisible();
});

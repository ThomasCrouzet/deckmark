import { readFile } from 'node:fs/promises';
import { expect, test, type TestInfo } from '@playwright/test';
import { resetAppState } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

const pdf = Buffer.from(
	'%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n'
);

test('opens a PDF document without modifying or uploading it', async ({ page }, info: TestInfo) => {
	await resetAppState(page);
	await page.locator('input[type="file"][accept*="text/markdown"]').setInputFiles({
		name: 'plan.pdf',
		mimeType: 'application/pdf',
		buffer: pdf
	});
	await expect(page.getByTestId('pdf-document')).toBeVisible();
	await expect(page.getByTestId('document-kind')).toHaveText('PDF');
	await expect(page.getByTestId('pdf-frame')).toHaveAttribute('src', /^blob:/);
	await expect(page.getByRole('button', { name: 'Ouvrir le PDF' })).toBeEnabled();

	const downloadPromise = page.waitForEvent('download');
	await page.getByTestId('pdf-document').getByRole('button', { name: 'Exporter' }).click();
	const download = await downloadPromise;
	expect(download.suggestedFilename()).toBe('plan.pdf');
	expect((await readFile((await download.path())!)).equals(pdf)).toBe(true);

	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	await expect(page.getByTestId('pdf-document')).toBeVisible();
	await expect(page.getByTestId('document-kind')).toHaveText('PDF');
	await info.attach('pdf-viewer.json', {
		body: JSON.stringify({ kind: 'pdf', originalBytes: pdf.length, uploads: 0 }),
		contentType: 'application/json'
	});
});

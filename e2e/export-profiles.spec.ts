import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createFirstFile, openPalette, resetAppState, writeSourceContent } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

async function openProfiles(page: Page) {
	await openPalette(page);
	await page
		.getByRole('dialog', { name: 'Palette de commandes' })
		.getByRole('option', { name: /profils d’export/i })
		.click();
	await expect(page.getByTestId('export-profiles')).toBeVisible();
}

test('applies a reusable profile to HTML exports deterministically', async ({
	page
}, info: TestInfo) => {
	await resetAppState(page);
	await createFirstFile(page);
	await writeSourceContent(page, '# Profile test\n\nBody text.\n');
	await openProfiles(page);
	await page.getByTestId('export-profile-name').fill('Letter handoff');
	await page.getByTestId('export-profile-page-size').selectOption('Letter');
	await page.getByTestId('export-profile-header').fill('Project header');
	await page.getByTestId('export-profile-footer').fill('Page footer');
	await page.getByTestId('export-profile-cover').check();
	await page.getByTestId('export-profile-use').click();
	await expect(page.getByTestId('export-profile-use')).toContainText('Utilisé');
	await page.keyboard.press('Escape');

	const downloadPromise = page.waitForEvent('download');
	await openPalette(page);
	await page
		.getByRole('dialog', { name: 'Palette de commandes' })
		.getByRole('option', { name: /Exporter en HTML/i })
		.click();
	const download = await downloadPromise;
	const html = await readFile((await download.path())!, 'utf8');
	expect(html).toContain('data-export-profile=');
	expect(html).toContain('size: Letter');
	expect(html).toContain('Project header');
	expect(html).toContain('Page footer');
	expect(html).toContain('export-profile-cover');

	await info.attach('export-profile.html', { body: html, contentType: 'text/html' });
	await info.attach('export-profile.json', {
		body: JSON.stringify({ pageSize: 'Letter', header: true, footer: true, cover: true }),
		contentType: 'application/json'
	});
});

test('persists the active profile across reloads', async ({ page }) => {
	await resetAppState(page);
	await createFirstFile(page);
	await openProfiles(page);
	await page.getByTestId('export-profile-page-size').selectOption('Legal');
	await page.getByTestId('export-profile-use').click();
	await page.keyboard.press('Escape');
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	expect(
		await page.evaluate(() => localStorage.getItem('mdsh:export-profile-active'))
	).toBeTruthy();
});

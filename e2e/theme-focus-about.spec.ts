import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createFirstFile, openPalette, resetAppState } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

test.beforeEach(async ({ page }) => {
	await resetAppState(page);
	await createFirstFile(page);
});

async function openSettings(page: Page) {
	await openPalette(page);
	const palette = page.getByRole('dialog', { name: 'Palette de commandes' });
	await palette.getByRole('option', { name: /Réglages/i }).click();
	await expect(page.getByRole('dialog', { name: 'Réglages' })).toBeVisible();
}

test('switches light and dark from the toolbar and keeps System in Settings', async ({
	page
}, info: TestInfo) => {
	const root = page.locator('html');
	const toggle = page.getByTestId('theme-toggle');
	await expect(root).toHaveAttribute('data-theme', 'dark');
	await expect(toggle).toHaveAttribute('aria-label', 'Passer au thème clair');

	await toggle.click();
	await expect(root).toHaveAttribute('data-theme', 'light');
	await expect(toggle).toHaveAttribute('aria-label', 'Passer au thème sombre');
	await expect.poll(() => page.evaluate(() => localStorage.getItem('mdsh:theme'))).toBe('light');
	const lightBackground = await page.evaluate(() =>
		getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim()
	);

	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	await expect(root).toHaveAttribute('data-theme', 'light');

	await toggle.click();
	await expect(root).toHaveAttribute('data-theme', 'dark');
	await expect.poll(() => page.evaluate(() => localStorage.getItem('mdsh:theme'))).toBe('dark');

	await openSettings(page);
	const settings = page.getByRole('dialog', { name: 'Réglages' });
	const group = settings.getByRole('group', { name: 'Choix du thème' });
	await group.getByRole('button', { name: 'Système', exact: true }).click();
	await expect.poll(() => page.evaluate(() => localStorage.getItem('mdsh:theme'))).toBe('system');

	await info.attach('theme-toggle.json', {
		body: JSON.stringify({
			lightBackground,
			storageAfterReload: 'light',
			settingsOption: 'system'
		}),
		contentType: 'application/json'
	});
	await info.attach('theme-toggle.png', { body: await page.screenshot() });
});

test('offers Focus only in Read and exits it with the mode', async ({ page }, info: TestInfo) => {
	const focusToggle = page.getByTestId('focus-toggle');
	await expect(focusToggle).toHaveCount(0);
	await page.locator('[data-mode="source"]').click();
	await expect(focusToggle).toHaveCount(0);
	await page.locator('[data-mode="read"]').click();
	await expect(focusToggle).toBeVisible();
	await expect(focusToggle).toHaveAttribute('aria-pressed', 'false');

	await focusToggle.click();
	await expect(page.locator('body')).toHaveClass(/focus-mode/);
	await expect(focusToggle).toHaveAttribute('aria-pressed', 'true');
	const exit = page.getByRole('button', { name: 'Quitter le mode focus' });
	await expect(exit).toBeVisible();
	await exit.click();
	await expect(page.locator('body')).not.toHaveClass(/focus-mode/);

	await focusToggle.click();
	await expect(page.locator('body')).toHaveClass(/focus-mode/);
	await page.keyboard.press('Control+e');
	await expect(page.locator('[data-mode="wysiwyg"]')).toHaveAttribute('aria-checked', 'true');
	await expect(page.locator('body')).not.toHaveClass(/focus-mode/);
	await expect(focusToggle).toHaveCount(0);

	await page.locator('[data-mode="read"]').click();
	await page.getByTestId('focus-toggle').click();
	await expect(page.locator('body')).toHaveClass(/focus-mode/);
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	await expect(page.locator('body')).not.toHaveClass(/focus-mode/);

	await info.attach('focus-read-only.json', {
		body: JSON.stringify({ visibleBefore: false, exitsOnModeChange: true, persisted: false }),
		contentType: 'application/json'
	});
	await info.attach('focus-read-only.png', { body: await page.screenshot() });
});

test('shows the author and GitHub profile in About', async ({ page }, info: TestInfo) => {
	await openSettings(page);
	const settings = page.getByRole('dialog', { name: 'Réglages' });
	await expect(settings.getByTestId('about-author')).toHaveText('Créé par Thomas CROUZET');
	const link = settings.getByTestId('about-github');
	await expect(link).toHaveText('Profil GitHub');
	await expect(link).toHaveAttribute('href', 'https://github.com/ThomasCrouzet');
	await expect(link).toHaveAttribute('target', '_blank');
	await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
	await link.focus();
	await expect(link).toBeFocused();

	await info.attach('about-credits.json', {
		body: JSON.stringify({
			author: await settings.getByTestId('about-author').innerText(),
			href: await link.getAttribute('href'),
			rel: await link.getAttribute('rel')
		}),
		contentType: 'application/json'
	});
	await info.attach('about-credits.png', { body: await page.screenshot() });
});

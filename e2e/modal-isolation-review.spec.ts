import { expect, test, type Page } from '@playwright/test';
import { resetAppState } from './helpers';
import { importMarkdown, presentationFixture } from './presentation-helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

test.beforeEach(async ({ page }) => {
	await resetAppState(page);
	await page.evaluate(() => localStorage.setItem('mdsh:locale', 'en'));
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	await importMarkdown(page, presentationFixture(['# Protected deck']), 'Protected deck.md');
	await expect(page.locator('.save-state')).toHaveText('saved');
});

async function dropFile(page: Page): Promise<void> {
	await page.evaluate(() => {
		const dataTransfer = new DataTransfer();
		dataTransfer.items.add(
			new File(['# Unwanted import'], 'Unwanted.md', { type: 'text/markdown' })
		);
		window.dispatchEvent(new DragEvent('dragover', { dataTransfer, cancelable: true }));
		window.dispatchEvent(new DragEvent('drop', { dataTransfer, cancelable: true }));
	});
}

for (const modal of ['creation', 'settings', 'projects', 'palette', 'prompt'] as const) {
	test(`keeps a file drop outside the ${modal} dialog`, async ({ page }, info) => {
		if (modal === 'prompt') {
			await page.keyboard.press('ControlOrMeta+,');
			await page.getByRole('button', { name: 'Export (encrypted)...', exact: true }).click();
		} else if (modal === 'projects') await page.getByTestId('projects-open').click();
		else
			await page.keyboard.press(
				modal === 'creation'
					? 'ControlOrMeta+n'
					: modal === 'settings'
						? 'ControlOrMeta+,'
						: 'ControlOrMeta+Shift+p'
			);
		await expect(page.getByRole('dialog').last()).toBeVisible();
		await dropFile(page);
		await page.keyboard.press('Escape');
		await expect(page.getByTestId('document-kind')).toHaveText('Presentation');
		await expect(page.getByTestId('slide-canvas')).toContainText('Protected deck');
		await page.reload();
		await expect(page.getByTestId('slide-canvas')).toContainText('Protected deck');
		await expect(page.getByRole('button', { name: /Unwanted/ })).toHaveCount(0);
		await info.attach('protected-deck.png', {
			body: await page.screenshot(),
			contentType: 'image/png'
		});
	});
}

test('announces a backup error above a dialog on a presentation', async ({ page }, info) => {
	await page.keyboard.press('ControlOrMeta+,');
	await expect(page.getByRole('dialog')).toBeVisible();
	await page.locator('input[type=file][accept*="json"]').setInputFiles({
		name: 'broken-backup.json',
		mimeType: 'application/json',
		buffer: Buffer.from('{invalid')
	});
	const error = page.getByRole('alert');
	await expect(error).toHaveCount(1);
	await expect(error).toBeVisible();
	await expect(error).not.toHaveText('');
	await expect(error.locator('xpath=ancestor::*[@inert]')).toHaveCount(0);
	await info.attach('accessible-error.png', {
		body: await page.screenshot(),
		contentType: 'image/png'
	});
	await page.keyboard.press('Escape');
	await expect(page.getByRole('alert')).toHaveCount(1);
	await page.getByTestId('slide-present').click();
	await expect(page.getByRole('alert')).toHaveCount(1);
	await expect(page.getByRole('alert').locator('xpath=ancestor::*[@inert]')).toHaveCount(0);
});

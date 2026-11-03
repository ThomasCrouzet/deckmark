import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createFirstFile, resetAppState } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

const caret = (page: Page) =>
	page.locator('.ProseMirror').evaluate((root) => {
		const selection = window.getSelection();
		return {
			focused: document.activeElement === root,
			collapsed: selection?.isCollapsed ?? false,
			text: root.textContent ?? ''
		};
	});

async function createNote(page: Page) {
	await page.locator('aside button[aria-label^="Nouveau fichier"]').first().click();
	await page.getByTestId('create-note').click();
	await expect(page.locator('[data-mode="wysiwyg"]')).toHaveAttribute('aria-checked', 'true');
	await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 20_000 });
}

test.describe('New note opens in Edit', () => {
	test.beforeEach(async ({ page }) => {
		await resetAppState(page);
		await createFirstFile(page);
	});

	for (const previous of ['wysiwyg', 'source', 'read'] as const) {
		test(`takes the caret after creation from ${previous}`, async ({ page }, info: TestInfo) => {
			await page.locator(`[data-mode="${previous}"]`).click();
			await expect(page.locator(`[data-mode="${previous}"]`)).toHaveAttribute(
				'aria-checked',
				'true'
			);
			if (previous === 'wysiwyg') await expect(page.locator('.ProseMirror').first()).toBeVisible();
			if (previous === 'source') await expect(page.locator('.cm-content').first()).toBeVisible();

			await createNote(page);
			await expect(page.getByRole('dialog')).toHaveCount(0);
			await expect
				.poll(() => caret(page))
				.toEqual({
					focused: true,
					collapsed: true,
					text: ''
				});
			await page.keyboard.type('Saisie immédiate');
			await expect(page.locator('.ProseMirror')).toContainText('Saisie immédiate');
			await expect
				.poll(() => caret(page))
				.toMatchObject({ focused: true, text: 'Saisie immédiate' });

			await info.attach(`new-note-from-${previous}.json`, {
				body: JSON.stringify({
					command: 'npx playwright test e2e/new-note-mode.spec.ts',
					previous,
					mode: await page.locator('[data-mode][aria-checked="true"]').getAttribute('data-mode'),
					caret: await caret(page),
					saved: await page.locator('.title-save').innerText()
				}),
				contentType: 'application/json'
			});
			await info.attach(`new-note-from-${previous}.png`, {
				body: await page.screenshot(),
				contentType: 'image/png'
			});
		});
	}

	test('keeps the render guard for imported large content', async ({ page }, info: TestInfo) => {
		const content = '# Long imported\n\n' + 'Texte de contrôle. '.repeat(15000);
		await page
			.locator('input[type="file"][accept*="text/markdown"]')
			.setInputFiles({ name: 'long.md', mimeType: 'text/markdown', buffer: Buffer.from(content) });
		await expect(page.locator('.cm-content').first()).toBeVisible();
		await expect(page.locator('[data-mode="source"]')).toHaveAttribute('aria-checked', 'true');
		await page.getByRole('button', { name: 'Fermer le bilan d’import', exact: true }).click();

		await createNote(page);
		await page.keyboard.type('Nouvelle note');

		await page.locator('aside').getByRole('button', { name: /long/i }).first().click();
		await expect(page.locator('[data-mode="source"]')).toHaveAttribute('aria-checked', 'true');
		await expect(page.locator('.cm-content').first()).toContainText('Long imported');

		await info.attach('render-guard.json', {
			body: JSON.stringify({
				command: 'npx playwright test e2e/new-note-mode.spec.ts',
				importedMode: 'source',
				newNoteMode: 'wysiwyg',
				returnedMode: 'source'
			}),
			contentType: 'application/json'
		});
		await info.attach('render-guard.png', { body: await page.screenshot() });
	});
});

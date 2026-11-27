import { test, expect } from '@playwright/test';
import { resetAppState } from './helpers';

test.describe('Welcome demo document', () => {
	test.beforeEach(async ({ page }) => {
		await resetAppState(page);
	});

	test('creates three linked demo files and opens the sidebar', async ({ page }) => {
		const demoBtn = page.locator('main').getByRole('button', { name: /document de démo/ });
		await demoBtn.click();

		// loadDemo creates and activates the welcome file first. The interface is French.
		const nameInput = page.locator('input[aria-label^="Nom du fichier"]');
		await expect(nameInput).toHaveValue('Bienvenue dans la démo DeckMark', { timeout: 10_000 });

		// The sidebar opens and lists the three demo files.
		const sidebar = page.locator('aside');
		await expect(sidebar.getByText('Maths et diagrammes').first()).toBeVisible({ timeout: 5000 });
		await expect(sidebar.getByText('Liste de tâches').first()).toBeVisible();

		// The two other files link to this file, so its backlinks are visible.
		const backlinksSection = sidebar.locator('[aria-label="Rétroliens"]');
		await expect(backlinksSection).toBeVisible({ timeout: 5000 });
		await expect(backlinksSection.getByText('Maths et diagrammes')).toBeVisible();
		await expect(backlinksSection.getByText('Liste de tâches')).toBeVisible();
	});

	test('the French demo link instruction works in Edit mode', async ({ page }) => {
		await page
			.locator('main')
			.getByRole('button', { name: /document de démo/ })
			.click();
		const nameInput = page.locator('input[aria-label^="Nom du fichier"]');
		await expect(nameInput).toHaveValue('Bienvenue dans la démo DeckMark', { timeout: 10_000 });
		await page.locator('button[data-mode="wysiwyg"]').click();
		const editor = page.locator('.ProseMirror');
		// The instruction names the keys of this platform, not the macOS glyphs.
		await expect(editor).toContainText('Ctrl+clic');
		await expect(editor).not.toContainText('⌘');
		await editor
			.locator('span[data-mdsh-wiki-link]')
			.first()
			.click({ position: { x: 20, y: 5 }, modifiers: ['ControlOrMeta'] });
		await expect(nameInput).toHaveValue('Maths et diagrammes');
	});

	test('the English demo link instruction works in Edit mode', async ({ page }) => {
		await page.evaluate(() => localStorage.setItem('mdsh:locale', 'en'));
		await page.reload();
		await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
		await page.locator('main').getByRole('button', { name: 'Open a demo document' }).click();
		const nameInput = page.locator('input[aria-label^="File name"]');
		await expect(nameInput).toHaveValue('Welcome to the DeckMark demo', { timeout: 10_000 });
		await page.locator('button[data-mode="wysiwyg"]').click();
		const editor = page.locator('.ProseMirror');
		await expect(editor).toContainText('Ctrl+click');
		await expect(editor).toContainText('Alt+Enter');
		await expect(editor).not.toContainText('⌘');
		await editor
			.locator('span[data-mdsh-wiki-link]')
			.first()
			.click({ position: { x: 20, y: 5 }, modifiers: ['ControlOrMeta'] });
		await expect(nameInput).toHaveValue('Math and diagrams');
	});
});

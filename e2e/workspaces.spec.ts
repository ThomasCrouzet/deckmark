import { test, expect } from '@playwright/test';
import { resetAppState, seedFiles, openPalette, renameActiveFile } from './helpers';

test.describe('Workspaces - save and restore sessions', () => {
	test.beforeEach(async ({ page }) => {
		await resetAppState(page);
	});

	test('restores saved tabs, their order, and the active document', async ({ page }) => {
		await seedFiles(page, [
			{ name: 'doc-a', content: '# A\n' },
			{ name: 'doc-b', content: '# B\n' }
		]);
		const fileButtons = page.locator('aside button[data-file-id]');
		await fileButtons.nth(0).click();
		const fileName = page.locator('input[aria-label^="Nom du fichier"]');
		await expect(fileName).toHaveValue('doc-a');

		// Save the workspace from the palette, enter its name, and press Enter.
		await openPalette(page);
		await page.keyboard.type('Sauvegarder le workspace courant');
		await expect(
			page.getByRole('option', { name: 'Sauvegarder le workspace courant', exact: true })
		).toBeVisible();
		await page.keyboard.press('Enter');
		const promptDialog = page.getByRole('dialog', { name: 'Nom du workspace ?' });
		await expect(promptDialog).toBeVisible({ timeout: 5000 });
		const promptInput = promptDialog.locator('input[type="text"]');
		await promptInput.fill('Mon workspace');
		await promptInput.press('Enter');
		// Wait for the prompt to close before changing the session.
		await expect(promptDialog).toBeHidden({ timeout: 5000 });

		// Change the open tabs and active document before loading the saved workspace.
		await page.locator('aside').getByRole('button', { name: 'Fermer doc-a', exact: true }).click();
		await page
			.locator('aside')
			.getByRole('button', { name: /Nouveau fichier/ })
			.click();
		await page.getByTestId('create-note').click();
		await renameActiveFile(page, 'doc-c');
		await expect(fileButtons.locator('.truncate')).toHaveText(['doc-b', 'doc-c']);
		await page.reload();
		await expect(fileName).toHaveValue('doc-c');

		// Open the Workspaces panel with the "Charger un workspace..." command.
		await openPalette(page);
		await page.keyboard.type('Charger un workspace');
		await page.keyboard.press('Enter');
		const wsDialog = page.getByRole('dialog', { name: 'Workspaces' });
		await expect(wsDialog).toBeVisible({ timeout: 5000 });
		await expect(wsDialog.getByText('Mon workspace')).toBeVisible();
		await wsDialog
			.getByRole('button', { name: 'Charger le workspace Mon workspace', exact: true })
			.click();
		await expect(wsDialog).toBeHidden();
		await expect(fileButtons.locator('.truncate')).toHaveText(['doc-a', 'doc-b']);
		await expect(fileButtons.nth(0)).toHaveAttribute('aria-current', 'true');
		await expect(fileName).toHaveValue('doc-a');
		await expect(page.locator('.cm-content')).toHaveText('# A');
		await fileButtons.nth(1).click();
		await expect(page.locator('.cm-content')).toHaveText('# B');
	});
});

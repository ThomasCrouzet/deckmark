import { test, expect, type Page } from '@playwright/test';
import { resetAppState, seedFiles } from './helpers';

// §6.5 - Sidebar multi-selection: Cmd+click toggle, Shift+click range,
// and grouped actions for ZIP export, close, and deselect.
//
// Create three files from the sidebar to test selection ranges.
// This local helper creates N files named "Sans titre*.md" from the sidebar.

async function createFiles(page: Page, count: number) {
	// Open the sidebar. It is already visible on desktop, but CI can use the mobile
	// button. The toggle is idempotent.
	const welcomeBtn = page.locator('main').getByRole('button', { name: /Nouveau fichier/ });
	await welcomeBtn.click();
	await page.getByTestId('create-note').click();
	await expect(page.locator('input[aria-label^="Nom du fichier"]')).toBeVisible({
		timeout: 10_000
	});
	// Create later files from the "Nouveau fichier" sidebar button.
	const sidebarNewBtn = page.locator('aside').getByRole('button', { name: /Nouveau fichier/ });
	for (let i = 1; i < count; i++) {
		await sidebarNewBtn.click();
		await page.getByTestId('create-note').click();
		// Wait one tick for the store to create the file.
		await page.waitForTimeout(50);
	}
	// Wait for N items in the sidebar list.
	await expect(page.locator('aside ul[aria-label*="Fichiers ouverts"] > li')).toHaveCount(count, {
		timeout: 5000
	});
}

test.describe('§6.5 - Sidebar multi-selection', () => {
	test.beforeEach(async ({ page }) => {
		await resetAppState(page);
	});

	test('shows grouped actions after Cmd+click and Shift+click', async ({ page }) => {
		await createFiles(page, 3);

		// Select file buttons by `data-file-id`. This attribute is not on Close buttons
		// and is more stable than the "Sans titre" label.
		const fileButtons = page.locator('aside button[data-file-id]');
		await expect(fileButtons).toHaveCount(3);

		const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
		await fileButtons.nth(0).click({ modifiers: [mod] });
		await fileButtons.nth(2).click({ modifiers: [mod] });

		// The grouped action bar must appear after two selections.
		const actionsBar = page.locator('aside [aria-label="Actions sur la sélection"]');
		await expect(actionsBar).toBeVisible();
		await expect(actionsBar).toContainText('2 sélectionnés');

		// Shift+click the second file to extend the selection from the last anchor.
		// All three files must be selected.
		await fileButtons.nth(1).click({ modifiers: ['Shift'] });
		await expect(actionsBar).toContainText('3 sélectionnés');
	});

	test('preserves closed selected files and restores one from trash', async ({ page }) => {
		await seedFiles(page, [
			{ name: 'doc-a', content: '# A' },
			{ name: 'doc-b', content: '# B' },
			{ name: 'doc-c', content: '# C' }
		]);
		const fileButtons = page.locator('aside button[data-file-id]');
		const restoredId = await fileButtons.nth(2).getAttribute('data-file-id');

		const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
		// Select all three files with a full Shift+click range.
		await fileButtons.nth(0).click({ modifiers: [mod] });
		await fileButtons.nth(2).click({ modifiers: ['Shift'] });

		const actionsBar = page.locator('aside [aria-label="Actions sur la sélection"]');
		await expect(actionsBar).toContainText('3 sélectionnés');

		// Click "Fermer la sélection" to close all selected files.
		await actionsBar.getByRole('button', { name: 'Fermer la sélection' }).click();

		await expect(actionsBar).not.toBeVisible({ timeout: 5000 });
		await expect(fileButtons).toHaveCount(0, { timeout: 5000 });

		const retained = page
			.locator('aside details')
			.filter({ has: page.locator('summary', { hasText: /^Documents conservés/ }) });
		await expect(retained.locator('summary')).toHaveText('Documents conservés (3)');
		await retained.locator('summary').click();
		await expect(retained.getByRole('button')).toHaveText(['doc-a.md', 'doc-b.md', 'doc-c.md']);
		await retained.getByRole('button', { name: 'doc-c.md', exact: true }).click();
		await expect(fileButtons).toHaveAttribute('data-file-id', restoredId!);
		await expect(page.locator('.cm-content')).toHaveText('# C');

		await page.locator('aside summary').filter({ hasText: 'Actions du document' }).click();
		await page
			.locator('aside')
			.getByRole('button', { name: 'Déplacer le document dans la corbeille', exact: true })
			.click();
		await page
			.getByRole('dialog', { name: 'Déplacer ce document dans la corbeille ?', exact: true })
			.getByRole('button', { name: 'Confirmer', exact: true })
			.click();
		await expect(fileButtons).toHaveCount(0);
		const trash = page
			.locator('aside details')
			.filter({ has: page.locator('summary', { hasText: /^Corbeille/ }) });
		await expect(trash.locator('summary')).toHaveText('Corbeille (1)');
		await trash.locator('summary').click();
		await trash.getByRole('button', { name: 'Restaurer doc-c.md', exact: true }).click();
		await expect(trash).toHaveCount(0);
		await expect(fileButtons).toHaveCount(1);
		await expect(fileButtons).toHaveAttribute('data-file-id', restoredId!);
		await expect(page.locator('input[aria-label^="Nom du fichier"]')).toHaveValue('doc-c');
		await expect(page.locator('.cm-content')).toHaveText('# C');
		await expect(retained.getByRole('button')).toHaveText(['doc-a.md', 'doc-b.md']);
	});
});

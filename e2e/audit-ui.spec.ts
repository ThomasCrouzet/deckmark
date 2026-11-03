import { expect, test } from '@playwright/test';
import { createFirstFile, openPalette, resetAppState, writeSourceContent } from './helpers';

test.beforeEach(async ({ page }) => {
	await resetAppState(page);
});

test('shows the menu and scrolls to an accent-insensitive search result', async ({ page }) => {
	await createFirstFile(page);
	await openPalette(page);
	const query = page.getByRole('combobox');
	await query.fill('parametres');
	await expect(page.getByRole('option', { name: /réglages/i })).toBeVisible();
	await query.fill('');
	for (let i = 0; i < 25; i++) await query.press('ArrowDown');
	const current = page.locator('[role="option"][aria-selected="true"]');
	await expect(current).toBeInViewport();
	await expect
		.poll(async () =>
			current.evaluate((element) => {
				const list = element.closest('[role="listbox"]')!;
				const row = element.getBoundingClientRect();
				const bounds = list.getBoundingClientRect();
				return row.top >= bounds.top && row.bottom <= bounds.bottom;
			})
		)
		.toBe(true);
});

test('keeps the Tab loop when search has results', async ({ page }) => {
	await createFirstFile(page);
	await writeSourceContent(page, 'Une phrase pour rechercher.');
	await openPalette(page);
	await page.getByRole('combobox').fill('cross-fichiers');
	await page.getByRole('option').first().click();
	const dialog = page.getByRole('dialog');
	await dialog.getByRole('combobox').fill('phrase');
	await expect(dialog.getByRole('option').first()).toBeVisible();
	await dialog.getByRole('button', { name: /^fermer/i }).focus();
	await page.keyboard.press('Tab');
	await expect
		.poll(() => dialog.evaluate((element) => element.contains(document.activeElement)))
		.toBe(true);
});

test('keeps the small-screen drawer inert and restores touch focus', async ({ page }) => {
	await page.setViewportSize({ width: 320, height: 568 });
	await createFirstFile(page);
	await expect(page.locator('#files-panel')).toHaveAttribute('inert', '');
	await expect(page.getByRole('button', { name: 'Palette de commandes' })).toBeInViewport();
	await expect(page.locator('input[aria-label^="Nom du fichier"]')).toBeInViewport();
	const menu = page.getByRole('button', { name: 'Menu', exact: true });
	await menu.focus();
	await page.keyboard.press('Enter');
	await expect(page.locator('#files-panel button[aria-label="Fermer le panneau"]')).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(menu).toBeFocused();
	// Focus mode is offered only while Read is selected.
	await page.locator('button[data-mode="read"]').click();
	await openPalette(page);
	await page.getByRole('combobox').fill('focus');
	await page.getByRole('option').first().click();
	const exit = page.getByRole('button', { name: 'Quitter le mode focus' });
	await expect(exit).toBeInViewport();
	await exit.click();
	await expect(page.getByRole('button', { name: 'Palette de commandes' })).toBeVisible();
});

test('customizes the command palette shortcut locally', async ({ page }) => {
	await openPalette(page);
	await page.getByRole('combobox').fill('parametres');
	await page.getByRole('option').first().click();
	await page.getByText('Raccourcis clavier', { exact: true }).click();
	const binding = page.getByRole('textbox', { name: 'Raccourci pour Commandes', exact: true });
	await binding.focus();
	await page.keyboard.press('ControlOrMeta+;');
	const expectedShortcut = await page.evaluate(() =>
		/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘;' : 'Ctrl+;'
	);
	await expect(binding).toHaveValue(expectedShortcut);
	await page.keyboard.press('Escape');
	await page.reload();
	await page.locator('body').click({ position: { x: 310, y: 500 } });
	await page.keyboard.press('ControlOrMeta+;');
	await expect(page.getByRole('dialog', { name: 'Palette de commandes' })).toBeVisible();
});

async function draftContents(page: import('@playwright/test').Page): Promise<string[]> {
	return page.evaluate(
		() =>
			new Promise<string[]>((resolve, reject) => {
				const opening = indexedDB.open('mdsh');
				opening.onerror = () => reject(opening.error);
				opening.onsuccess = () => {
					const database = opening.result;
					const reading = database.transaction('drafts').objectStore('drafts').getAll();
					reading.onsuccess = () => {
						database.close();
						resolve(reading.result.map((row) => row.content));
					};
					reading.onerror = () => {
						database.close();
						reject(reading.error);
					};
				};
			})
	);
}

async function openSettings(page: import('@playwright/test').Page) {
	await openPalette(page);
	await page.getByRole('combobox').fill('parametres');
	await page.getByRole('option').first().click();
	await expect(page.getByRole('dialog', { name: 'Réglages' })).toBeVisible();
}

test('Escape cancels restore without a merge or replacement', async ({ page }) => {
	await createFirstFile(page);
	await writeSourceContent(page, 'Contenu conservé après annulation');
	const before = await draftContents(page);
	await openSettings(page);
	const backup = {
		format: 'mdsh-backup',
		schemaVersion: 1,
		exportedAt: Date.now(),
		drafts: [
			{
				id: 'restore-test',
				name: 'restauration.md',
				content: 'NE PAS IMPORTER',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				order: 0
			}
		],
		workspaces: [],
		templates: []
	};
	await page.locator('input[type="file"][accept*="json"]').setInputFiles({
		name: 'backup.json',
		mimeType: 'application/json',
		buffer: Buffer.from(JSON.stringify(backup))
	});
	const choice = page.getByRole('dialog', { name: 'Restaurer la sauvegarde' });
	await expect(choice.getByRole('button', { name: 'Fusionner', exact: true })).toBeVisible();
	await expect(choice.getByRole('button', { name: 'Remplacer', exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(choice).toBeHidden();
	await expect(page.getByRole('dialog', { name: 'Réglages' })).toBeVisible();
	expect(await draftContents(page)).toEqual(before);
	await page.keyboard.press('Escape');
	await page.reload();
	expect(await draftContents(page)).toEqual(before);
});

test('keeps the passphrase dialog visible and traps focus until cancellation', async ({ page }) => {
	await createFirstFile(page);
	await openSettings(page);
	const trigger = page.getByRole('button', { name: /exporter.*chiffré/i });
	await trigger.click();
	const prompt = page.getByRole('dialog', { name: 'Chiffrer la sauvegarde' });
	const password = prompt.locator('input[type="password"]');
	await expect(password).toBeFocused();
	expect(
		await password.evaluate((element) => {
			const rect = element.getBoundingClientRect();
			return (
				document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === element
			);
		})
	).toBe(true);
	for (let i = 0; i < 8; i++) {
		await page.keyboard.press('Tab');
		expect(await prompt.evaluate((element) => element.contains(document.activeElement))).toBe(true);
	}
	const before = await draftContents(page);
	await page.keyboard.press('Control+n');
	expect(await draftContents(page)).toEqual(before);
	await page.keyboard.press('Escape');
	await expect(prompt).toBeHidden();
	await expect(trigger).toBeFocused();
});

test('opens a large document in source mode and asks before rendering', async ({ page }) => {
	const content = '# Long document\n\n' + 'Texte de contrôle. '.repeat(15000);
	await page
		.locator('input[type="file"][accept*="text/markdown"]')
		.setInputFiles({ name: 'long.md', mimeType: 'text/markdown', buffer: Buffer.from(content) });
	await expect(page.locator('.cm-content')).toBeVisible();
	await expect(page.locator('button[data-mode="source"]')).toHaveAttribute('aria-checked', 'true');
	await page.getByRole('button', { name: 'Fermer le bilan d’import', exact: true }).click();
	await page.locator('button[data-mode="read"]').click();
	const prompt = page.getByRole('dialog', { name: 'Afficher ce document volumineux ?' });
	await expect(prompt).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page.locator('button[data-mode="source"]')).toHaveAttribute('aria-checked', 'true');
	await expect.poll(() => draftContents(page)).toEqual([content]);
	await page.locator('button[data-mode="read"]').click();
	await prompt.getByRole('button', { name: 'Afficher le document', exact: true }).click();
	await expect(page.locator('.mdsh-preview')).toBeVisible();
	await expect(page.locator('.mdsh-preview')).toContainText('Long document');
});

test('reports an ignored binary file in the import summary', async ({ page }) => {
	await page.locator('input[type="file"][accept*="text/markdown"]').setInputFiles([
		{ name: 'valide.md', mimeType: 'text/markdown', buffer: Buffer.from('# Import valide') },
		{ name: 'binaire.md', mimeType: 'text/markdown', buffer: Buffer.from([0, 1, 0, 255, 0, 3]) }
	]);
	const report = page.getByRole('region', { name: 'Bilan d’import' });
	await expect(report).toContainText('1 importé(s)');
	await report.getByText('Détails par fichier', { exact: true }).click();
	await expect(report).toContainText('binaire.md');
	await expect(report).toContainText(/binaire|Encodage/);
	await expect.poll(() => draftContents(page)).toEqual(['# Import valide']);
});

test('keeps completed documents and stops the batch after import cancellation', async ({
	page
}) => {
	// Verify the imported bytes without intermediate WYSIWYG serialization.
	const sourceMode = page.locator('button[data-mode="source"]');
	await sourceMode.click();
	await expect(sourceMode).toHaveAttribute('aria-checked', 'true');
	await page.evaluate(() => {
		const read = File.prototype.arrayBuffer;
		File.prototype.arrayBuffer = async function () {
			await new Promise((resolve) => setTimeout(resolve, 40));
			return read.call(this);
		};
	});
	await page.locator('input[type="file"][accept*="text/markdown"]').setInputFiles(
		Array.from({ length: 30 }, (_, index) => ({
			name: `note-${index}.md`,
			mimeType: 'text/markdown',
			buffer: Buffer.from(`# Note ${index}`)
		}))
	);
	const cancel = page.getByRole('button', { name: 'Annuler l’import', exact: true });
	await expect(cancel).toBeVisible();
	await expect.poll(async () => (await draftContents(page)).length).toBeGreaterThan(0);
	await cancel.click();
	const report = page.getByRole('region', { name: 'Bilan d’import' });
	await expect(report).toContainText('Import annulé');
	const completedCount = Number((await report.innerText()).match(/(\d+) importé\(s\)/)?.[1]);
	expect(completedCount).toBeGreaterThan(0);
	await expect.poll(async () => (await draftContents(page)).length).toBe(completedCount);
	const imported = await draftContents(page);
	expect(imported.length).toBeLessThan(30);
	await page.reload();
	await expect(sourceMode).toHaveAttribute('aria-checked', 'true');
	expect(await draftContents(page)).toEqual(imported);
});

test('rejects an oversized backup before it reads the file', async ({ page }) => {
	await openSettings(page);
	await page.evaluate(() => {
		const size = Object.getOwnPropertyDescriptor(Blob.prototype, 'size')!.get!;
		const read = File.prototype.arrayBuffer;
		Object.defineProperty(File.prototype, 'size', {
			configurable: true,
			get() {
				return this.name === 'oversized.json' ? 65 * 1024 * 1024 : size.call(this);
			}
		});
		File.prototype.arrayBuffer = function () {
			if (this.name === 'oversized.json') throw new Error('Une lecture interdite a été tentée');
			return read.call(this);
		};
	});
	await page.locator('input[type="file"][accept*="json"]').setInputFiles({
		name: 'oversized.json',
		mimeType: 'application/json',
		buffer: Buffer.from('{}')
	});
	await expect(page.getByRole('alert')).toContainText('La sauvegarde dépasse les limites');
	await expect(page.getByRole('dialog', { name: 'Restaurer la sauvegarde' })).toHaveCount(0);
});

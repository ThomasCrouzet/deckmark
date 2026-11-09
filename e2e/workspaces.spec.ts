import { readFile } from 'node:fs/promises';
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
		await page.locator('button[data-mode="source"]').click();
		await expect(page.locator('.cm-content')).toHaveText('# A');
		await fileButtons.nth(1).click();
		await expect(page.locator('.cm-content')).toHaveText('# B');
	});

	test('exports deferred restored tabs with durable content', async ({ page }, info) => {
		await seedFiles(page, [
			{ name: 'doc-a', content: '# Alpha unique\n' },
			{ name: 'doc-b', content: '# Bravo unique\n' }
		]);
		const fileButtons = page.locator('aside button[data-file-id]');
		await fileButtons.nth(1).click();
		await openPalette(page);
		await page.keyboard.type('Sauvegarder le workspace courant');
		await page.keyboard.press('Enter');
		const promptDialog = page.getByRole('dialog', { name: 'Nom du workspace ?' });
		const promptInput = promptDialog.locator('input[type="text"]');
		await promptInput.fill('Export workspace');
		await promptInput.press('Enter');
		await expect(promptDialog).toBeHidden({ timeout: 5000 });

		// Close doc-a, then make it larger than the startup inline limit. The
		// reloaded session keeps only its metadata so the restore stays deferred.
		const alphaId = await fileButtons.nth(0).getAttribute('data-file-id');
		await page.locator('aside').getByRole('button', { name: 'Fermer doc-a', exact: true }).click();
		await expect(fileButtons.locator('.truncate')).toHaveText(['doc-b']);
		await page.waitForTimeout(600);
		await page.evaluate(
			(id) =>
				new Promise<void>((resolve, reject) => {
					const request = indexedDB.open('mdsh');
					request.onerror = () => reject(request.error);
					request.onsuccess = () => {
						const database = request.result;
						const transaction = database.transaction('drafts', 'readwrite');
						const store = transaction.objectStore('drafts');
						const read = store.get(id!);
						read.onsuccess = () => {
							const content = `# Alpha unique\n${'A'.repeat(300 * 1024)}`;
							const row = {
								...read.result,
								content,
								open: false,
								updatedAt: Date.now()
							};
							// Keep the metadata index consistent without Dexie hooks.
							row.manifest = JSON.stringify([
								1,
								row.id,
								row.name,
								row.projectId ?? '',
								row.relativePath ?? '',
								row.createdAt,
								row.updatedAt,
								row.order,
								row.kind ?? '',
								row.mime ?? '',
								row.origin ?? '',
								row.sourceFileId ?? '',
								0,
								content.length,
								row.data ? 1 : 0
							]);
							store.put(row);
						};
						transaction.oncomplete = () => {
							database.close();
							resolve();
						};
						transaction.onerror = () => reject(transaction.error);
					};
				}),
			alphaId
		);
		await page.reload();
		const stored = await page.evaluate(
			(id) =>
				new Promise<{ length: number; open: boolean | undefined }>((resolve, reject) => {
					const request = indexedDB.open('mdsh');
					request.onerror = () => reject(request.error);
					request.onsuccess = () => {
						const database = request.result;
						const read = database.transaction('drafts').objectStore('drafts').get(id!);
						read.onsuccess = () => {
							database.close();
							resolve({ length: read.result.content.length, open: read.result.open });
						};
						read.onerror = () => reject(read.error);
					};
				}),
			alphaId
		);
		expect(stored.length).toBeGreaterThan(262_144);
		expect(stored.open).toBe(false);
		const manifest = await page.evaluate(
			(id) =>
				new Promise<unknown[]>((resolve, reject) => {
					const request = indexedDB.open('mdsh');
					request.onerror = () => reject(request.error);
					request.onsuccess = () => {
						const database = request.result;
						const cursor = database
							.transaction('drafts')
							.objectStore('drafts')
							.index('manifest')
							.openKeyCursor();
						cursor.onsuccess = () => {
							const value = cursor.result;
							if (!value) {
								database.close();
								reject(new Error('No manifest key'));
								return;
							}
							const decoded = JSON.parse(String(value.key)) as unknown[];
							if (decoded[1] === id) {
								database.close();
								resolve(decoded);
								return;
							}
							value.continue();
						};
						cursor.onerror = () => reject(cursor.error);
					};
				}),
			alphaId
		);
		expect(manifest[12]).toBe(0);
		expect(manifest[13]).toBeGreaterThan(262_144);
		await openPalette(page);
		await page.keyboard.type('Charger un workspace');
		await page.keyboard.press('Enter');
		const wsDialog = page.getByRole('dialog', { name: 'Workspaces' });
		await wsDialog
			.getByRole('button', { name: 'Charger le workspace Export workspace', exact: true })
			.click();
		await expect(wsDialog).toBeHidden();
		await expect(fileButtons.locator('.truncate')).toHaveText(['doc-a', 'doc-b']);
		const fileName = page.locator('input[aria-label^="Nom du fichier"]');
		await expect(fileName).toHaveValue('doc-b');

		// Do not activate doc-a: Export Open must hydrate the deferred body.
		await openPalette(page);
		await page.keyboard.type('Exporter les onglets ouverts');
		await expect(
			page.getByRole('option', { name: 'Exporter les onglets ouverts en ZIP', exact: true })
		).toBeVisible();
		const downloadPromise = page.waitForEvent('download');
		await page.keyboard.press('Enter');
		const download = await downloadPromise;
		const path = await download.path();
		if (!path) throw new Error('Export ZIP introuvable');
		const { default: JSZip } = await import('jszip');
		const zip = await JSZip.loadAsync(await readFile(path));
		const names = Object.keys(zip.files).filter((name) => !zip.files[name]!.dir);
		const contents = await Promise.all(
			names.map(async (name) => [name, await zip.files[name]!.async('string')] as const)
		);
		const alpha = contents.find(([name]) => name.includes('doc-a'))?.[1];
		const bravo = contents.find(([name]) => name.includes('doc-b'))?.[1];
		expect(alpha).toContain('# Alpha unique');
		expect(bravo).toContain('# Bravo unique');
		await info.attach('workspace-export-open.json', {
			body: JSON.stringify({ names, contents }, null, 2),
			contentType: 'application/json'
		});
	});
});

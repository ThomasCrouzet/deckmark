import { test, expect } from '@playwright/test';
import { resetAppState, createFirstFile } from './helpers';

test('registers the Window file launch queue and applies import limits', async ({ page }) => {
	await page.addInitScript(() => {
		localStorage.setItem('mdsh:mode', 'source');
		Object.defineProperty(window, 'launchQueue', {
			configurable: true,
			value: {
				setConsumer: (
					consume: (params: { files: Array<{ getFile: () => Promise<File> }> }) => Promise<void>
				) => {
					void consume({
						files: [
							{
								getFile: async () =>
									new File(['# Received launch'], 'received.md', { type: 'text/markdown' })
							},
							{
								getFile: async () =>
									new File([new Uint8Array(16 * 1024 * 1024 + 1)], 'large.md', {
										type: 'text/markdown'
									})
							}
						]
					});
				}
			}
		});
	});
	await page.goto('/');
	await expect(page.locator('.cm-content')).toHaveText('# Received launch');
	await page.getByText('Détails par fichier', { exact: true }).click();
	await expect(
		page.getByText('Taille maximale du fichier dépassée', { exact: false })
	).toBeVisible();
	await expect(page.locator('aside button[data-file-id]')).toHaveCount(1);
});

test('selects drafts with the keyboard and exposes selection state', async ({ page }) => {
	await resetAppState(page);
	await createFirstFile(page);
	await page.locator('aside button[aria-label^="Nouveau fichier"]').click();
	await page.getByTestId('create-note').click();
	const drafts = page.locator('aside button[data-file-id]');
	await expect(drafts).toHaveCount(2);
	await drafts.nth(0).focus();
	await page.keyboard.press('Space');
	await expect(drafts.nth(0)).toHaveAttribute('aria-pressed', 'true');
	await drafts.nth(1).focus();
	await page.keyboard.press('Shift+Space');
	await expect(drafts.nth(1)).toHaveAttribute('aria-pressed', 'true');
	await page.keyboard.press('Space');
	await expect(drafts.nth(1)).toHaveAttribute('aria-pressed', 'false');
});

test('preserves the disk revision across reload and refuses an unconfirmed overwrite', async ({
	page
}) => {
	await resetAppState(page);
	await page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		const handle = await root.getFileHandle('revision-check.md', { create: true });
		const writer = await handle.createWritable();
		await writer.write('ORIGINAL_VERSION');
		await writer.close();
		Object.defineProperty(window, 'showOpenFilePicker', {
			configurable: true,
			value: async () => [handle]
		});
	});
	await page
		.locator('aside')
		.getByRole('button', { name: /^Importer un fichier markdown/ })
		.click();
	const editor = page.locator('.cm-content');
	await expect(editor).toHaveText('ORIGINAL_VERSION');
	await editor.fill('LOCAL_VERSION');
	await expect
		.poll(() =>
			page.evaluate(async () => {
				const database = await new Promise<IDBDatabase>((resolve, reject) => {
					const request = indexedDB.open('mdsh');
					request.onsuccess = () => resolve(request.result);
					request.onerror = () => reject(request.error);
				});
				try {
					return await new Promise<string>((resolve, reject) => {
						const request = database.transaction('drafts').objectStore('drafts').getAll();
						request.onsuccess = () => resolve(request.result[0]?.content ?? '');
						request.onerror = () => reject(request.error);
					});
				} finally {
					database.close();
				}
			})
		)
		.toBe('LOCAL_VERSION');
	await page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		const handle = await root.getFileHandle('revision-check.md');
		const writer = await handle.createWritable();
		await writer.write('EXTERNAL_VERSION');
		await writer.close();
	});
	await page.reload();
	await expect(editor).toHaveText('LOCAL_VERSION');
	await page.getByRole('button', { name: 'Enregistrer sur le disque', exact: true }).click();
	const prompt = page.getByRole('dialog', {
		name: 'Résoudre le conflit disque pour revision-check.md'
	});
	await expect(prompt).toBeVisible();
	await prompt.getByRole('button', { name: 'Annuler', exact: true }).last().click();
	await expect
		.poll(() =>
			page.evaluate(async () => {
				const root = await navigator.storage.getDirectory();
				return (await (await root.getFileHandle('revision-check.md')).getFile()).text();
			})
		)
		.toBe('EXTERNAL_VERSION');
});

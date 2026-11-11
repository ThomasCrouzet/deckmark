import { test, expect } from '@playwright/test';
import { resetAppState, seedFiles, openPalette, writeSourceContent } from './helpers';

test.beforeEach(async ({ page }) => {
	await resetAppState(page);
});

test('drafts remain usable when preference storage is denied', async ({ page }) => {
	await page.addInitScript(() => {
		Object.defineProperty(window, 'localStorage', {
			get() {
				throw new DOMException('Denied', 'SecurityError');
			}
		});
	});
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await page.reload();
	await page.getByTestId('welcome-new').click();
	await page.getByTestId('create-note').click();
	await writeSourceContent(page, 'Durable without preferences');
	await page.reload();
	await page.locator('button[data-mode="source"]').click();
	await expect(page.locator('.cm-content')).toContainText('Durable without preferences');
	expect(errors).toEqual([]);
});

test('closed documents remain searchable and wiki links reopen the same document', async ({
	page
}) => {
	await seedFiles(page, [
		{ name: 'alpha', content: '# Alpha\n\nunique-closed-marker' },
		{ name: 'beta', content: '# Beta\n\n[[alpha]]' }
	]);
	const closeAlpha = () =>
		page.locator('.mdsh-file-row').filter({ hasText: 'alpha' }).locator('button').last().click();
	await closeAlpha();
	await page.keyboard.press('ControlOrMeta+Shift+f');
	await page.getByRole('combobox').fill('unique-closed-marker');
	await page.locator('#search-listbox [role="option"]').first().click();
	await expect(page.locator('#app-toolbar input')).toHaveValue('alpha');
	await expect(page.locator('.cm-content')).toContainText('unique-closed-marker');
	await closeAlpha();
	await page.locator('button[data-mode="read"]').click();
	await page.locator('.wiki-link').click();
	await expect(page.locator('#app-toolbar input')).toHaveValue('alpha');
	await expect(page.locator('.mdsh-preview')).toContainText('unique-closed-marker');
	await expect(page.locator('.mdsh-file-row')).toHaveCount(2);
	await page.locator('.mdsh-file-row').first().locator('button').last().click();
	await page.locator('.mdsh-file-row').first().locator('button').last().click();
	await page.getByRole('button', { name: 'Retrouver vos documents (2)' }).click();
	await expect(page.getByRole('dialog', { name: 'Bibliothèque de documents' })).toBeVisible();
});

test('library ZIP contains open and closed documents', async ({ page }) => {
	await seedFiles(page, [
		{ name: 'alpha', content: 'first' },
		{ name: 'beta', content: 'second' }
	]);
	await page
		.locator('.mdsh-file-row')
		.filter({ hasText: 'alpha' })
		.locator('button')
		.last()
		.click();
	await openPalette(page);
	await page.getByRole('combobox').fill('Exporter tous');
	const downloadPromise = page.waitForEvent('download');
	await page.keyboard.press('Enter');
	const stream = await (await downloadPromise).createReadStream();
	const parts: Buffer[] = [];
	for await (const part of stream!) parts.push(part);
	const { default: JSZip } = await import('jszip');
	const zip = await JSZip.loadAsync(Buffer.concat(parts));
	expect(Object.keys(zip.files).sort()).toEqual(['alpha.md', 'beta.md']);
	expect(await zip.file('alpha.md')!.async('string')).toBe('first');
});

test('a large closed document hydrates on demand for search and export', async ({ page }) => {
	test.setTimeout(90_000);
	const marker = 'deferred-marker-315';
	const paragraph = 'Deferred body line for issue 315.\n';
	const content = `# Large document\n\n${paragraph.repeat(9_500)}${marker}\n`;
	expect(content.length).toBeGreaterThan(256 * 1024);
	await page.locator('input[type="file"][accept*="text/markdown"]').setInputFiles({
		name: 'large315.md',
		mimeType: 'text/markdown',
		buffer: Buffer.from(content)
	});
	await expect(page.locator('#app-toolbar input')).toHaveValue('large315', {
		timeout: 20_000
	});
	await page.waitForTimeout(600);
	const closeLarge = () =>
		page.locator('.mdsh-file-row').filter({ hasText: 'large315' }).locator('button').last().click();

	// A reload reads the metadata projection and leaves the large closed body in Dexie.
	await closeLarge();
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor({
		state: 'visible',
		timeout: 15_000
	});
	await expect(page.getByText('Documents conservés')).toBeVisible();

	// Search must read the exact body from Dexie without keeping it in the store.
	await page.keyboard.press('ControlOrMeta+Shift+f');
	await page.getByRole('combobox').fill(marker);
	await page.locator('#search-listbox [role="option"]').first().click();
	await expect(page.locator('#app-toolbar input')).toHaveValue('large315');
	// The hit in the search listbox proves the exact closed body was hydrated.
	// The editor viewport only renders nearby lines, so the export below is the
	// byte-level check for the same body.

	// Reload again so the closed body is deferred before the export.
	await closeLarge();
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor({
		state: 'visible',
		timeout: 15_000
	});
	await openPalette(page);
	await page.getByRole('combobox').fill('Exporter tous');
	const downloadPromise = page.waitForEvent('download');
	await page.keyboard.press('Enter');
	const stream = await (await downloadPromise).createReadStream();
	const parts: Buffer[] = [];
	for await (const part of stream!) parts.push(part);
	const { default: JSZip } = await import('jszip');
	const zip = await JSZip.loadAsync(Buffer.concat(parts));
	expect(await zip.file('large315.md')!.async('string')).toBe(content);
});

test('library Replace All previews and applies a deferred closed note', async ({ page }, info) => {
	test.setTimeout(90_000);
	const largeAlpha = `# Alpha\n\n${'Deferred body line for the closed note.\n'.repeat(8_000)}needle in closed alpha\n`;
	expect(largeAlpha.length).toBeGreaterThan(256 * 1024);
	await page.locator('input[type="file"][accept*="text/markdown"]').setInputFiles({
		name: 'alpha.md',
		mimeType: 'text/markdown',
		buffer: Buffer.from(largeAlpha)
	});
	await expect(page.locator('#app-toolbar input')).toHaveValue('alpha', { timeout: 20_000 });
	await page.locator('input[type="file"][accept*="text/markdown"]').setInputFiles({
		name: 'beta.md',
		mimeType: 'text/markdown',
		buffer: Buffer.from('# Beta\n\nneedle in open beta')
	});
	await expect(page.locator('#app-toolbar input')).toHaveValue('beta', { timeout: 20_000 });
	await page
		.locator('.mdsh-file-row')
		.filter({ hasText: 'alpha' })
		.locator('button')
		.last()
		.click();
	// The reload reads the metadata projection. The closed alpha body stays in Dexie.
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor({
		state: 'visible',
		timeout: 15_000
	});
	await expect(page.getByText('Documents conservés')).toBeVisible();

	await page.keyboard.press('ControlOrMeta+Shift+f');
	await page.getByRole('combobox').fill('needle');
	await expect(page.locator('#search-listbox [role="option"]').first()).toBeVisible({
		timeout: 10_000
	});
	await page.getByTitle('Remplacer dans tous les fichiers').click();
	await page.getByLabel('Texte de remplacement').fill('replacement');
	await page.getByRole('button', { name: 'Remplacer tout' }).click();

	// Both notes must enter the preview, including the deferred closed body.
	await expect(page.getByText('2 fichier(s), 2 remplacement(s)')).toBeVisible({
		timeout: 15_000
	});
	await page.getByRole('button', { name: 'Confirmer le remplacement' }).click();
	await expect(page.getByRole('dialog', { name: 'Recherche cross-fichiers' })).toHaveCount(0, {
		timeout: 10_000
	});

	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor({
		state: 'visible',
		timeout: 15_000
	});
	await page.keyboard.press('ControlOrMeta+Shift+f');
	await page.getByRole('combobox').fill('replacement');
	const hits = page.locator('#search-listbox [role="option"]');
	await expect(hits).toHaveCount(2, { timeout: 10_000 });
	await hits.first().click();
	await expect(page.locator('.cm-content')).toContainText('replacement');
	const rows = await page.evaluate(
		() =>
			new Promise<Array<{ name: string; content: string }>>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const all = request.result.transaction('drafts').objectStore('drafts').getAll();
					all.onerror = () => reject(all.error);
					all.onsuccess = () => {
						request.result.close();
						resolve(all.result.map((row) => ({ name: row.name, content: row.content })));
					};
				};
			})
	);
	const rowFor = (name: string) => rows.find((row) => row.name.startsWith(name));
	expect(rowFor('alpha')?.content).toBe(
		largeAlpha.replace('needle in closed alpha', 'replacement in closed alpha')
	);
	expect(rowFor('beta')?.content).toBe('# Beta\n\nreplacement in open beta');
	await info.attach('deferred-replace.json', {
		body: JSON.stringify({ rows }),
		contentType: 'application/json'
	});
});

test('Replace All reports a failed deferred body read', async ({ page }, info) => {
	test.setTimeout(90_000);
	const largeAlpha = `# Alpha\n\n${'Deferred body line for the closed note.\n'.repeat(8_000)}needle in closed alpha\n`;
	await page.locator('input[type="file"][accept*="text/markdown"]').setInputFiles({
		name: 'alpha.md',
		mimeType: 'text/markdown',
		buffer: Buffer.from(largeAlpha)
	});
	await expect(page.locator('#app-toolbar input')).toHaveValue('alpha', { timeout: 20_000 });
	await page.locator('input[type="file"][accept*="text/markdown"]').setInputFiles({
		name: 'beta.md',
		mimeType: 'text/markdown',
		buffer: Buffer.from('# Beta\n\nneedle in open beta')
	});
	await expect(page.locator('#app-toolbar input')).toHaveValue('beta', { timeout: 20_000 });
	await page
		.locator('.mdsh-file-row')
		.filter({ hasText: 'alpha' })
		.locator('button')
		.last()
		.click();
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor({
		state: 'visible',
		timeout: 15_000
	});
	await expect(page.getByText('Documents conservés')).toBeVisible();

	// Simulate a body that vanished from IndexedDB after the metadata load.
	const removed = await page.evaluate(
		() =>
			new Promise<number>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const all = request.result.transaction('drafts', 'readwrite').objectStore('drafts');
					const keys = all.getAllKeys();
					keys.onerror = () => reject(keys.error);
					keys.onsuccess = () => {
						const transaction = all.transaction;
						for (const key of keys.result) all.delete(key);
						transaction.oncomplete = () => {
							request.result.close();
							resolve(keys.result.length);
						};
						transaction.onerror = () => reject(transaction.error);
					};
				};
			})
	);
	expect(removed).toBeGreaterThan(0);

	await page.keyboard.press('ControlOrMeta+Shift+f');
	await page.getByRole('combobox').fill('needle');
	await page.getByTitle('Remplacer dans tous les fichiers').click();
	await page.getByLabel('Texte de remplacement').fill('replacement');
	await page.getByRole('button', { name: 'Remplacer tout' }).click();
	await expect(
		page.getByRole('dialog', { name: 'Recherche cross-fichiers' }).getByRole('alert')
	).toContainText('Le remplacement a échoué', {
		timeout: 15_000
	});
	await expect(page.getByRole('region', { name: 'Aperçu du remplacement' })).toHaveCount(0);
	await info.attach('deferred-replace-failure.json', {
		body: JSON.stringify({ removedRows: removed }),
		contentType: 'application/json'
	});
});

test('actions expose the library and renaming repairs incoming links', async ({ page }) => {
	await seedFiles(page, [
		{ name: 'alpha', content: 'Target' },
		{ name: 'beta', content: '[[alpha|Label]]' }
	]);
	await page.getByRole('button', { name: 'Actions', exact: true }).click();
	await page.getByRole('button', { name: 'Bibliothèque de documents', exact: true }).click();
	const library = page.getByRole('dialog', { name: 'Bibliothèque de documents' });
	await expect(library.getByRole('textbox')).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('button', { name: 'Actions', exact: true })).toBeFocused();
	await page.getByRole('button', { name: 'Actions', exact: true }).click();
	await page.getByRole('button', { name: 'Bibliothèque de documents', exact: true }).click();
	await library.getByRole('textbox').fill('alpha');
	await library.getByRole('button', { name: 'Ouvrir alpha.md', exact: true }).click();
	await page.locator('#app-toolbar input').fill('gamma');
	await page.locator('#app-toolbar input').press('Enter');
	await expect(page.locator('#app-toolbar input')).toHaveValue('gamma');
	await page
		.locator('.mdsh-file-row')
		.filter({ hasText: 'beta' })
		.locator('button[data-file-id]')
		.click();
	await expect(page.locator('.cm-content')).toContainText('[[gamma|Label]]');
});

test('outline navigation and reading search keep the selected mode', async ({ page }) => {
	await seedFiles(page, [
		{
			name: 'long',
			content: '# First\n\nneedle one\n\n```md\n# Example\n```\n\n## Second\n\nneedle two'
		}
	]);
	await page.getByRole('button', { name: 'Actions', exact: true }).click();
	await page.getByRole('button', { name: 'Plan du document', exact: true }).click();
	const outline = page.getByRole('navigation', { name: 'Plan du document' });
	await expect(outline.getByRole('button')).toHaveCount(2);
	await outline.getByRole('button', { name: 'Second' }).click();
	await expect(page.locator('.cm-content')).toBeFocused();
	await page.locator('button[data-mode="read"]').click();
	await expect(page.locator('.mdsh-preview h2')).toBeVisible();
	await page.keyboard.press('ControlOrMeta+f');
	await page.getByRole('searchbox').fill('needle');
	await expect(page.locator('[data-document-navigation] [role="status"]')).toHaveText('1/2');
	await page.getByRole('button', { name: 'Résultat suivant' }).click();
	await expect(page.locator('[data-document-navigation] [role="status"]')).toHaveText('2/2');
	await expect(page.locator('button[data-mode="read"]')).toHaveAttribute('aria-checked', 'true');
	await page.locator('button[data-mode="wysiwyg"]').click();
	await expect(page.locator('.ProseMirror')).toBeVisible();
	await page.keyboard.press('ControlOrMeta+f');
	await page.getByRole('searchbox').fill('needle');
	await expect(page.locator('[data-document-navigation] [role="status"]')).toHaveText('1/2');
	await page.getByRole('button', { name: 'Résultat suivant' }).click();
	await page.getByRole('button', { name: 'Fermer la navigation du document' }).click();
	await page.keyboard.insertText('edited');
	await page.locator('button[data-mode="source"]').click();
	await expect(page.locator('.cm-content')).toContainText('needle one');
	await expect(page.locator('.cm-content')).toContainText('edited two');
});

test('backup verification reports its contents without changing the library', async ({ page }) => {
	await seedFiles(page, [{ name: 'keep', content: 'Keep my work' }]);
	await page.keyboard.press('ControlOrMeta+,');
	const settings = page.getByRole('dialog', { name: 'Réglages', exact: true });
	const chooser = page.waitForEvent('filechooser');
	await settings.getByRole('button', { name: 'Vérifier une sauvegarde...' }).click();
	await (
		await chooser
	).setFiles({
		name: 'check.json',
		mimeType: 'application/json',
		buffer: Buffer.from(
			JSON.stringify({
				format: 'mdsh-backup',
				schemaVersion: 1,
				exportedAt: 1,
				drafts: [],
				workspaces: [],
				templates: []
			})
		)
	});
	const summary = page.getByRole('dialog', {
		name: 'Sauvegarde vérifiée. Votre bibliothèque est inchangée.'
	});
	await expect(summary).toContainText('0 fichier(s)');
	await expect(summary).toContainText('0 projet(s)');
	await expect(summary).toContainText('0 ressource(s) de projet');
	await page.keyboard.press('Escape');
	await page.keyboard.press('Escape');
	await expect(page.locator('.cm-content')).toContainText('Keep my work');
	await expect(page.locator('.mdsh-file-row')).toHaveCount(1);
});

test('custom templates can be edited and reused from Settings', async ({ page }) => {
	await seedFiles(page, [{ name: 'template-source', content: '# Initial template' }]);
	await openPalette(page);
	await page.getByRole('combobox').fill('Enregistrer le fichier comme modèle');
	await page.keyboard.press('Enter');
	const prompt = page.getByRole('dialog', { name: 'Nom du modèle ?' });
	await prompt.getByRole('textbox').fill('Reusable');
	await prompt.getByRole('button', { name: 'Enregistrer le modèle', exact: true }).click();
	await expect(prompt).toHaveCount(0);
	await page.keyboard.press('ControlOrMeta+,');
	const settings = page.getByRole('dialog', { name: 'Réglages', exact: true });
	await settings.getByText('Gérer les modèles', { exact: true }).click();
	await settings.getByRole('button', { name: 'Modifier', exact: true }).click();
	await settings.getByRole('textbox', { name: 'Nom du modèle' }).fill('Revised');
	await settings
		.getByRole('textbox', { name: 'Contenu Markdown' })
		.fill('# Updated template\n\n{{date}}');
	await settings.getByRole('button', { name: 'Enregistrer le modèle', exact: true }).click();
	await expect(settings.getByText('Revised', { exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
	await openPalette(page);
	await page.getByRole('combobox').fill('Revised');
	await page.keyboard.press('Enter');
	await expect(page.locator('.ProseMirror')).toContainText('Updated template', {
		timeout: 20_000
	});
	await expect(page.locator('.ProseMirror')).not.toContainText('{{date}}');
});

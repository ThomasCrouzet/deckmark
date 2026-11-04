import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createFirstFile, openPalette, resetAppState, writeSourceContent } from './helpers';
import { databaseState } from './storage-evidence';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

const toolbarStatus = (page: Page) => page.locator('#app-toolbar [data-testid^="storage-status-"]');

test('labels a created note as a local draft and marks pending changes', async ({
	page
}, info: TestInfo) => {
	await resetAppState(page);
	await createFirstFile(page);
	await expect(toolbarStatus(page)).toHaveAttribute('data-origin', 'draft');
	await expect(toolbarStatus(page)).toHaveAttribute('data-sync', 'saved');
	await expect(toolbarStatus(page)).toHaveAttribute('aria-label', /Brouillon local/);

	await writeSourceContent(page, 'Local content');
	await expect(toolbarStatus(page)).toHaveAttribute('data-sync', 'pending');
	await expect(toolbarStatus(page)).toHaveAttribute('aria-label', /Modifications en attente/);
	await expect(page.locator('aside [data-testid^="storage-status-"]')).toHaveAttribute(
		'data-origin',
		'draft'
	);

	await info.attach('draft-status.json', {
		body: JSON.stringify({
			origin: await toolbarStatus(page).getAttribute('data-origin'),
			sync: await toolbarStatus(page).getAttribute('data-sync'),
			label: await toolbarStatus(page).getAttribute('aria-label')
		}),
		contentType: 'application/json'
	});
});

test('labels an imported copy as temporary and persists that state', async ({
	page
}, info: TestInfo) => {
	await resetAppState(page);
	await page.locator('input[type="file"][accept*="text/markdown"]').setInputFiles({
		name: 'imported.md',
		mimeType: 'text/markdown',
		buffer: Buffer.from('# Imported')
	});
	await expect(page.locator('.cm-content').first()).toContainText('Imported');
	// The badge mounts with the active toolbar. Wait for the element itself so a
	// mount race does not fail the attribute check.
	await expect(toolbarStatus(page)).toHaveCount(1);
	await expect(toolbarStatus(page)).toHaveAttribute('data-origin', 'temporary');
	await expect(toolbarStatus(page)).toHaveAttribute('aria-label', /Copie temporaire/);
	await expect(
		page.locator('#app-statusbar').getByText('Brouillons locaux : enregistré', { exact: true })
	).toBeVisible();
	const draftId = await toolbarStatus(page).evaluate((element) =>
		(element.getAttribute('data-testid') ?? '').replace(/^storage-status-/, '')
	);
	expect(draftId).not.toBe('');
	const readDrafts = async () =>
		(await databaseState(page)).drafts.map(({ id, content, origin }) => ({ id, content, origin }));
	const expectedDrafts = [{ id: draftId, content: '# Imported', origin: 'imported' }];
	await expect.poll(readDrafts).toEqual(expectedDrafts);
	const beforeReload = await readDrafts();
	expect(beforeReload).toEqual(expectedDrafts);

	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	await expect(toolbarStatus(page)).toHaveAttribute('data-testid', `storage-status-${draftId}`);
	await expect(toolbarStatus(page)).toHaveAttribute('data-origin', 'temporary');
	await expect(page.locator('.cm-content').first()).toHaveText('# Imported');
	const afterReload = await readDrafts();
	expect(afterReload).toEqual(beforeReload);

	await info.attach('temporary-status.json', {
		body: JSON.stringify({
			origin: await toolbarStatus(page).getAttribute('data-origin'),
			beforeReload,
			afterReload
		}),
		contentType: 'application/json'
	});
});

test('follows link, save, conflict and unlink transitions', async ({ page }, info: TestInfo) => {
	await resetAppState(page);
	await createFirstFile(page);
	await writeSourceContent(page, 'Linked content');
	await page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		const handle = await root.getFileHandle('status.md', { create: true });
		const writer = await handle.createWritable();
		await writer.write('Linked content');
		await writer.close();
		Object.defineProperty(window, 'showSaveFilePicker', {
			configurable: true,
			value: async () => handle
		});
	});

	await page.getByRole('button', { name: 'Enregistrer sur le disque', exact: true }).click();
	await expect(toolbarStatus(page)).toHaveAttribute('data-origin', 'disk');
	await expect(toolbarStatus(page)).toHaveAttribute('data-sync', 'saved');
	await expect(toolbarStatus(page)).toHaveAttribute('aria-label', /Lié au disque/);

	await writeSourceContent(page, 'Local change');
	await expect(toolbarStatus(page)).toHaveAttribute('data-sync', 'pending');
	await page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		const writer = await (await root.getFileHandle('status.md')).createWritable();
		await writer.write('External content');
		await writer.close();
	});
	await page.getByRole('button', { name: 'Enregistrer sur le disque', exact: true }).click();
	const conflict = page.getByRole('dialog', { name: /Résoudre le conflit disque/ });
	await expect(conflict).toBeVisible();
	await expect(toolbarStatus(page)).toHaveAttribute('data-sync', 'conflict');
	await expect(toolbarStatus(page)).toHaveAttribute('aria-label', /Conflit disque/);
	await page.keyboard.press('Escape');
	await expect(conflict).toBeHidden();
	await expect(toolbarStatus(page)).toHaveAttribute('data-sync', 'pending');

	await openPalette(page);
	await page
		.getByRole('dialog', { name: 'Palette de commandes' })
		.getByRole('option', { name: /Gérer les liens disque/ })
		.click();
	const links = page.getByRole('dialog', { name: /Liens disque|Fichiers liés/ });
	await expect(links).toBeVisible();
	await links
		.getByRole('button', { name: /Dissocier/ })
		.first()
		.click();
	await expect(toolbarStatus(page)).toHaveAttribute('data-origin', 'draft');

	await info.attach('disk-status.json', {
		body: JSON.stringify({
			linked: 'disk',
			conflict: 'conflict',
			afterUnlink: 'draft',
			final: await toolbarStatus(page).getAttribute('aria-label')
		}),
		contentType: 'application/json'
	});
	await info.attach('disk-status.png', { body: await page.screenshot() });
});

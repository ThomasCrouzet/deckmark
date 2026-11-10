import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createFirstFile, openPalette, resetAppState, writeSourceContent } from './helpers';

test.use({ locale: 'fr-FR', reducedMotion: 'reduce' });

const toolbarStatus = (page: Page) => page.locator('#app-toolbar [data-testid^="storage-status-"]');

async function writeOpfsFile(page: Page, name: string, content: string) {
	await page.evaluate(
		async ({ name, content }) => {
			const root = await navigator.storage.getDirectory();
			const handle = await root.getFileHandle(name, { create: true });
			const writer = await handle.createWritable();
			await writer.write(content);
			await writer.close();
		},
		{ name, content }
	);
}

async function importLinkedFile(page: Page, name: string, content: string, drafts = 2) {
	await writeOpfsFile(page, name, content);
	await page.evaluate(async (name) => {
		const root = await navigator.storage.getDirectory();
		const handle = await root.getFileHandle(name, { create: true });
		Object.defineProperty(window, 'showOpenFilePicker', {
			configurable: true,
			value: async () => [handle]
		});
	}, name);
	await page
		.locator('aside')
		.getByRole('button', { name: /^Importer un fichier markdown/ })
		.click();
	await expect(toolbarStatus(page)).toHaveAttribute('data-origin', 'disk');
	await waitForDraftCount(page, drafts);
}

async function waitForDraftCount(page: Page, count: number) {
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					new Promise<number>((resolve, reject) => {
						const request = indexedDB.open('mdsh');
						request.onerror = () => reject(request.error);
						request.onsuccess = () => {
							const database = request.result;
							const read = database.transaction('drafts', 'readonly').objectStore('drafts').count();
							read.onerror = () => reject(read.error);
							read.onsuccess = () => {
								database.close();
								resolve(read.result);
							};
						};
					})
			)
		)
		.toBeGreaterThanOrEqual(count);
}

async function attachWorkflow(info: TestInfo, name: string, payload: unknown, page: Page) {
	await info.attach(`${name}.json`, {
		body: JSON.stringify(payload, null, 2),
		contentType: 'application/json'
	});
	await info.attach(`${name}.png`, { body: await page.screenshot() });
}

test('unlinking one draft keeps the other draft linked to the same handle', async ({
	page
}, info) => {
	await resetAppState(page);
	await createFirstFile(page);
	await importLinkedFile(page, 'shared-link.md', '# Shared\n\nOriginal');
	await importLinkedFile(page, 'shared-link.md', '# Shared\n\nOriginal', 3);

	await openPalette(page);
	await page.getByRole('option', { name: /Gérer les liens disque/ }).click();
	const dialog = page.getByRole('dialog', { name: 'Liens disque' });
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole('button', { name: /Dissocier/ })).toHaveCount(2);

	await dialog
		.getByRole('button', { name: /Dissocier/ })
		.first()
		.click();
	await expect(dialog.getByRole('button', { name: /Dissocier/ })).toHaveCount(1);
	await expect(dialog.getByText('1 lien(s)')).toBeVisible();
	await dialog.getByRole('button', { name: 'Fermer' }).click();
	await expect(dialog).toBeHidden();

	const openItems = page
		.locator('aside')
		.getByRole('list', { name: /Fichiers ouverts/ })
		.getByRole('listitem');
	const itemCount = await openItems.count();
	for (let index = 0; index < itemCount; index += 1) {
		await openItems.nth(index).getByRole('button').first().click();
		if ((await toolbarStatus(page).getAttribute('data-origin')) === 'disk') break;
	}
	await expect(toolbarStatus(page)).toHaveAttribute('data-origin', 'disk');
	await writeSourceContent(page, '# Shared\n\nStill linked');
	await page.keyboard.press('ControlOrMeta+s');
	await expect
		.poll(() =>
			page.evaluate(async () => {
				const root = await navigator.storage.getDirectory();
				const handle = await root.getFileHandle('shared-link.md');
				return (await handle.getFile()).text();
			})
		)
		.toBe('# Shared\n\nStill linked');
	await expect(toolbarStatus(page)).toHaveAttribute('data-sync', 'saved');

	await attachWorkflow(
		info,
		'shared-unlink',
		{
			linksBefore: 2,
			linksAfter: 1,
			remainingOrigin: await toolbarStatus(page).getAttribute('data-origin'),
			remainingSync: await toolbarStatus(page).getAttribute('data-sync'),
			diskContent: '# Shared\n\nStill linked'
		},
		page
	);
});

import { test, expect } from '@playwright/test';
import { resetAppState, runAction, writeSourceContent } from './helpers';

test('compares real browser filesystem revisions and keeps rejected branches', async ({
	page
}, info) => {
	await resetAppState(page);
	await page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		const handle = await root.getFileHandle('comparison.md', { create: true });
		const writer = await handle.createWritable();
		await writer.write('Original');
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
	await writeSourceContent(page, 'Local change');
	async function external(content: string) {
		await page.evaluate(async (text) => {
			const root = await navigator.storage.getDirectory();
			const writer = await (await root.getFileHandle('comparison.md')).createWritable();
			await writer.write(text);
			await writer.close();
		}, content);
	}
	async function diskText() {
		return page.evaluate(async () =>
			(
				await (
					await (await navigator.storage.getDirectory()).getFileHandle('comparison.md')
				).getFile()
			).text()
		);
	}
	await external('External change');
	await runAction(page, 'save-disk');
	const dialog = page.getByRole('dialog', {
		name: 'Résoudre le conflit disque pour comparison.md'
	});
	await expect(dialog).toContainText('Local change');
	await expect(dialog).toContainText('External change');
	await page.keyboard.press('Escape');
	expect(await diskText()).toBe('External change');
	await expect(page.locator('.cm-content')).toHaveText('Local change');
	await runAction(page, 'save-disk');
	await expect(dialog).toBeVisible();
	await external('Changed during comparison');
	await dialog.getByRole('button', { name: 'Écraser le disque' }).click();
	await expect(dialog).not.toBeVisible();
	expect(await diskText()).toBe('Changed during comparison');
	await runAction(page, 'save-disk');
	await expect(dialog).toContainText('Changed during comparison');
	await dialog.getByRole('button', { name: 'Utiliser la révision du disque' }).click();
	await expect(page.locator('.cm-content')).toHaveText('Changed during comparison');
	const history = await page.evaluate(
		() =>
			new Promise<unknown[]>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const db = request.result;
					const query = db.transaction('versions').objectStore('versions').getAll();
					query.onsuccess = () => {
						db.close();
						resolve(query.result);
					};
					query.onerror = () => {
						db.close();
						reject(query.error);
					};
				};
			})
	);
	expect(history).toEqual(
		expect.arrayContaining([expect.objectContaining({ content: 'Local change' })])
	);
	await info.attach('disk-comparison.json', {
		body: JSON.stringify({
			fixture: 'OPFS file with native browser writes; picker selection supplied by the fixture',
			disk: await diskText(),
			history
		}),
		contentType: 'application/json'
	});
	await info.attach('disk-comparison.png', {
		body: await page.screenshot(),
		contentType: 'image/png'
	});
});

import { expect, type Page } from '@playwright/test';

export async function loadHeadingFixture(page: Page, content: string): Promise<void> {
	await page.evaluate(
		(content) =>
			new Promise<void>((resolve, reject) => {
				const opening = indexedDB.open('mdsh');
				opening.onerror = () => reject(opening.error);
				opening.onsuccess = () => {
					const database = opening.result;
					const transaction = database.transaction('drafts', 'readwrite');
					const store = transaction.objectStore('drafts');
					const rows = store.getAll();
					rows.onsuccess = () => {
						const row = rows.result[0];
						if (!row) {
							transaction.abort();
							return;
						}
						store.put({ ...row, content, updatedAt: Date.now() });
					};
					transaction.oncomplete = () => {
						database.close();
						resolve();
					};
					transaction.onabort = () => {
						database.close();
						reject(transaction.error ?? new Error('Heading fixture transaction aborted'));
					};
				};
			}),
		content
	);
	await page.reload();
	await expect(page.locator('.cm-content')).toBeVisible();
}

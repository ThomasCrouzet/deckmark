import { expect, test, type Page } from '@playwright/test';
import { resetAppState } from './helpers';

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

async function seedTrashedDocument(page: Page, trashedAt: number): Promise<string> {
	const id = 'aged-trash';
	await page.evaluate(
		async ({ id, trashedAt }) => {
			const database = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			const now = Date.now();
			const file = {
				id,
				name: 'archived.md',
				content: '# Archived\n',
				createdAt: now,
				updatedAt: now,
				order: 0,
				open: false
			};
			await new Promise<void>((resolve, reject) => {
				const tx = database.transaction(['drafts', 'trashed'], 'readwrite');
				tx.objectStore('drafts').put({ ...file, id: 'live', name: 'live.md', open: true });
				tx.objectStore('trashed').put({ id, file, order: 1, trashedAt });
				tx.oncomplete = () => resolve();
				tx.onabort = () => reject(tx.error);
			});
			database.close();
			localStorage.setItem('mdsh:activeId', 'live');
		},
		{ id, trashedAt }
	);
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	return id;
}

test.beforeEach(async ({ page }) => {
	await resetAppState(page);
});

test('shows the automatic purge date of each trashed document', async ({ page }, testInfo) => {
	const trashedAt = Date.now() - 20 * 24 * 60 * 60 * 1000;
	const id = await seedTrashedDocument(page, trashedAt);

	const trash = page
		.locator('aside details')
		.filter({ has: page.locator('summary', { hasText: /^Corbeille/ }) });
	await expect(trash.locator('summary')).toContainText('Corbeille (1)');
	await trash.locator('summary').click();

	const purgeAt = trashedAt + RETENTION_MS;
	const expected = await page.evaluate(
		(timestamp) => new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium' }).format(timestamp),
		purgeAt
	);
	const hint = trash.getByTestId('trash-purge-hint');
	await expect(hint).toHaveCount(1);
	await expect(hint).toHaveText(`Suppression automatique le ${expected}`);

	// The retained document is still restorable: the hint only adds visibility.
	await expect(
		trash.getByRole('button', { name: 'Restaurer archived.md', exact: true })
	).toBeVisible();

	await testInfo.attach('trash-purge-deadline', {
		body: JSON.stringify({
			id,
			trashedAt,
			purgeAt,
			hint: `Suppression automatique le ${expected}`
		}),
		contentType: 'application/json'
	});
});

import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { openPalette, resetAppState, seedFiles, writeSourceContent } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

async function openSemantic(page: Page) {
	await openPalette(page);
	await page
		.getByRole('dialog', { name: 'Palette de commandes' })
		.getByRole('option', { name: /index de recherche local/i })
		.click();
	await expect(page.getByTestId('semantic-panel')).toBeVisible();
}

async function closeSemantic(page: Page) {
	await page.getByTestId('semantic-panel').getByRole('button', { name: 'Fermer' }).click();
	await expect(page.getByTestId('semantic-panel')).toHaveCount(0);
}

async function semanticRows(
	page: Page
): Promise<Array<{ id: string; projectId: string | null; path: string; modelId: string }>> {
	return page.evaluate(
		() =>
			new Promise<Array<{ id: string; projectId: string | null; path: string; modelId: string }>>(
				(resolve, reject) => {
					const request = indexedDB.open('mdsh');
					request.onerror = () => reject(request.error);
					request.onsuccess = () => {
						const database = request.result;
						if (!database.objectStoreNames.contains('semanticIndex')) {
							database.close();
							resolve([]);
							return;
						}
						const transaction = database.transaction(['semanticIndex']);
						const rows = transaction.objectStore('semanticIndex').getAll();
						transaction.oncomplete = () => {
							database.close();
							resolve(rows.result);
						};
						transaction.onerror = () => reject(transaction.error);
					};
				}
			)
	);
}

test('builds, searches and clears a local index without network access', async ({
	page
}, info: TestInfo) => {
	let external = 0;
	// The preview port changes between environments: compare host names only.
	page.on('request', (request) => {
		const url = new URL(request.url());
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
		if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) external++;
	});
	await resetAppState(page);
	await seedFiles(page, [
		{ name: 'Guide', content: '# Guide\n\nDocumentation for the editor.\n' },
		{ name: 'Recipe', content: '# Recipe\n\nCooking instructions.\n' }
	]);
	await openSemantic(page);
	await expect(page.getByTestId('semantic-enabled')).not.toBeChecked();
	await page.getByTestId('semantic-enabled').check();
	await page.getByTestId('semantic-model').selectOption('cooccurrence-v1');
	await expect(page.getByTestId('semantic-panel')).toContainText('co-occurrence');
	await page.getByTestId('semantic-index').click();
	await expect(page.getByTestId('semantic-panel')).toContainText('2 document');
	await page.getByTestId('semantic-query').fill('document');
	await expect(page.getByTestId('semantic-hit').first()).toContainText('Guide');
	await page.getByTestId('semantic-hit').first().click();
	await expect(page.getByTestId('semantic-panel')).toHaveCount(0);
	await expect(page.locator('.cm-content')).toContainText('Documentation');

	await openSemantic(page);
	await expect(page.getByTestId('semantic-enabled')).toBeChecked();
	await page.getByTestId('semantic-clear').click();
	await expect(page.getByTestId('semantic-panel')).toContainText('0 document');
	expect(external).toBe(0);

	await info.attach('semantic-search.json', {
		body: JSON.stringify({ indexed: 2, query: 'document', externalRequests: external }),
		contentType: 'application/json'
	});
});

test('drops changed source rows and another model until a rebuild', async ({
	page
}, info: TestInfo) => {
	test.setTimeout(180_000);
	await resetAppState(page);
	await seedFiles(page, [
		{ name: 'Guide', content: '# Guide\n\nDocumentation for the editor.\n' },
		{ name: 'Recipe', content: '# Recipe\n\nCooking instructions.\n' }
	]);
	await openSemantic(page);
	await page.getByTestId('semantic-enabled').check();
	await page.getByTestId('semantic-index').click();
	await expect(page.getByTestId('semantic-panel')).toContainText('2 document');
	await page.getByTestId('semantic-query').fill('documentation');
	await expect(page.getByTestId('semantic-hit').first()).toContainText('Guide');
	await closeSemantic(page);

	// Edit one indexed document. Its saved row still holds the old bytes.
	await page.locator('aside button[data-file-id]').filter({ hasText: 'Guide' }).click();
	await writeSourceContent(page, '# Guide\n\nDocumentation for the editor.\nA new line.\n');

	await openSemantic(page);
	await page.getByTestId('semantic-query').fill('documentation');
	await expect(page.getByTestId('semantic-panel')).toContainText(
		'Certains documents indexés ont changé'
	);
	// The edited document keeps its old bytes in the index, so it is counted as
	// stale and left out of the ranking.
	await expect(page.getByTestId('semantic-hit').filter({ hasText: 'Guide' })).toHaveCount(0);
	await expect(page.getByTestId('semantic-hit').first()).toContainText('Recipe.md');

	// The old feature vectors are not scored with the co-occurrence model.
	await page.getByTestId('semantic-model').selectOption('cooccurrence-v1');
	await expect(page.getByTestId('semantic-panel')).toContainText('autre modèle');
	await expect(page.getByTestId('semantic-hit')).toHaveCount(0);

	await page.getByTestId('semantic-index').click();
	await expect(page.getByTestId('semantic-hit').first()).toContainText('Guide.md');
	await expect(page.getByTestId('semantic-panel')).not.toContainText(
		'documents indexés ont changé'
	);
	const rows = await semanticRows(page);
	expect(rows.every((row) => row.modelId === 'cooccurrence-v1')).toBe(true);
	expect(rows.map((row) => row.path).sort()).toEqual(['Guide.md', 'Recipe.md']);

	await info.attach('semantic-stale-index.json', {
		body: JSON.stringify({ staleBeforeRebuild: 1, model: 'cooccurrence-v1', rows: rows.length }),
		contentType: 'application/json'
	});
});

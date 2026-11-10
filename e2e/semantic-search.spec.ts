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

async function importProject(page: Page, name: string, files: Record<string, string>) {
	const zip = new (await import('jszip')).default();
	for (const [path, content] of Object.entries(files)) zip.file(path, content);
	await page.getByTestId('projects-open').click();
	const panel = page.getByRole('dialog', { name: 'Projets Markdown' });
	await panel.locator('input[type=file][accept=".zip"]').setInputFiles({
		name: `${name}.zip`,
		mimeType: 'application/zip',
		buffer: await zip.generateAsync({ type: 'nodebuffer' })
	});
	await panel.getByRole('button', { name: 'Fermer les projets' }).click();
}

async function openProjectDocument(page: Page, project: string, path: string) {
	const root = page.locator(`[data-project-root-name="${project}"]`);
	const details = root.locator('details').first();
	if ((await details.getAttribute('open')) === null) await root.locator('summary').first().click();
	await expect(details).toHaveAttribute('open', '');
	await root.locator(`[data-project-document="${path}"] button[data-file-id]`).click();
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

test('clears only the selected library or project index', async ({ page }, info: TestInfo) => {
	test.setTimeout(180_000);
	await resetAppState(page);
	await seedFiles(page, [
		{ name: 'Library', content: '# Library\n\nDocumentation for the library.\n' }
	]);
	await importProject(page, 'Alpha', { 'alpha.md': '# Alpha\n\nDocumentation for alpha.\n' });
	await importProject(page, 'Beta', { 'beta.md': '# Beta\n\nDocumentation for beta.\n' });

	// Build the three scopes in turn. The panel takes the active project as its
	// initial scope on each open.
	await openSemantic(page);
	await page.getByTestId('semantic-enabled').check();
	await page.getByTestId('semantic-index').click();
	await expect(page.getByTestId('semantic-panel')).toContainText('1 document');
	await closeSemantic(page);

	await openProjectDocument(page, 'Alpha', 'alpha.md');
	await openSemantic(page);
	await page.getByTestId('semantic-index').click();
	await expect(page.getByTestId('semantic-panel')).toContainText('1 document');
	await closeSemantic(page);

	await openProjectDocument(page, 'Beta', 'beta.md');
	await openSemantic(page);
	await page.getByTestId('semantic-index').click();
	await expect(page.getByTestId('semantic-panel')).toContainText('1 document');
	await closeSemantic(page);

	// Clearing Project Alpha must keep the library and Project Beta rows.
	await openProjectDocument(page, 'Alpha', 'alpha.md');
	await openSemantic(page);
	await page.getByTestId('semantic-clear').click();
	await expect(page.getByTestId('semantic-panel')).toContainText('0 document');
	await page.getByTestId('semantic-query').fill('alpha');
	await expect(page.getByTestId('semantic-hit')).toHaveCount(0);
	let rows = await semanticRows(page);
	expect(rows.map((row) => row.path).sort()).toEqual(['Library.md', 'beta.md']);
	expect(rows.some((row) => row.projectId === null)).toBe(true);

	// The library scope still queries and clears on its own.
	await page.getByTestId('semantic-scope').selectOption({ label: 'Documents de la bibliothèque' });
	await expect(page.getByTestId('semantic-panel')).toContainText('1 document');
	await page.getByTestId('semantic-query').fill('library');
	await expect(page.getByTestId('semantic-hit').first()).toContainText('Library');
	await page.getByTestId('semantic-clear').click();
	await expect(page.getByTestId('semantic-panel')).toContainText('0 document');
	rows = await semanticRows(page);
	expect(rows.map((row) => row.path)).toEqual(['beta.md']);
	await closeSemantic(page);

	// Project Beta is still usable and clears without touching another scope.
	await openProjectDocument(page, 'Beta', 'beta.md');
	await openSemantic(page);
	await expect(page.getByTestId('semantic-panel')).toContainText('1 document');
	await page.getByTestId('semantic-query').fill('beta');
	await expect(page.getByTestId('semantic-hit').first()).toContainText('beta.md');
	await page.getByTestId('semantic-clear').click();
	await expect(page.getByTestId('semantic-panel')).toContainText('0 document');
	expect(await semanticRows(page)).toHaveLength(0);

	await info.attach('semantic-scoped-clear.json', {
		body: JSON.stringify({ selectedScope: 'project-alpha', remainingScopes: ['library', 'beta'] }),
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

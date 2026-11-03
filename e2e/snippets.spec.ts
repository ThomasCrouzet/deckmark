import { expect, test, type Download, type Page, type TestInfo } from '@playwright/test';
import { resetAppState } from './helpers';

const projectId = 'snippet-project';
const projectName = 'Snippet project';

interface SnippetFixture {
	id: string;
	title: string;
	code: string;
	language: string;
	tags: string[];
	folder?: string;
	projectId?: string;
	favorite: boolean;
	createdAt: number;
	updatedAt: number;
}

async function importCode(page: Page, name: string, content: string) {
	await page.locator('input[type="file"][accept*="text/markdown"]').setInputFiles({
		name,
		mimeType: 'text/plain',
		buffer: Buffer.from(content)
	});
	await expect(page.getByTestId('code-editor')).toBeVisible({ timeout: 20_000 });
}

async function openSnippets(page: Page) {
	await page.keyboard.press('ControlOrMeta+Shift+P');
	const palette = page.getByRole('dialog', { name: 'Palette de commandes' });
	await expect(palette).toBeVisible();
	await palette.locator('input[type="text"]').fill('extraits');
	await expect(palette.getByRole('option').first()).toContainText('Extraits de code');
	await page.keyboard.press('Enter');
	await expect(page.getByTestId('snippets-dialog')).toBeVisible({ timeout: 20_000 });
}

async function snippetRows(page: Page): Promise<SnippetFixture[]> {
	return page.evaluate(
		() =>
			new Promise<SnippetFixture[]>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					if (!database.objectStoreNames.contains('snippets')) {
						database.close();
						resolve([]);
						return;
					}
					const rows = database.transaction('snippets').objectStore('snippets').getAll();
					rows.onerror = () => {
						database.close();
						reject(rows.error);
					};
					rows.onsuccess = () => {
						database.close();
						resolve(rows.result as SnippetFixture[]);
					};
				};
			})
	);
}

async function seedSnippet(page: Page, row: SnippetFixture) {
	await page.evaluate(
		(value) =>
			new Promise<void>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const tx = database.transaction('snippets', 'readwrite');
					tx.objectStore('snippets').put(value);
					tx.oncomplete = () => {
						database.close();
						resolve();
					};
					tx.onerror = () => {
						database.close();
						reject(tx.error);
					};
				};
			}),
		row
	);
}

async function seedProject(page: Page) {
	await page.evaluate(
		(value) =>
			new Promise<void>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const tx = database.transaction('projects', 'readwrite');
					tx.objectStore('projects').put(value);
					tx.oncomplete = () => {
						database.close();
						resolve();
					};
					tx.onerror = () => {
						database.close();
						reject(tx.error);
					};
				};
			}),
		{ id: projectId, name: projectName, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 }
	);
}

async function attach(info: TestInfo, name: string, value: unknown) {
	await info.attach(name, {
		body: JSON.stringify(value, null, 2),
		contentType: 'application/json'
	});
}

async function downloadBytes(download: Download): Promise<Buffer> {
	const stream = await download.createReadStream();
	const chunks: Buffer[] = [];
	for await (const chunk of stream!) chunks.push(chunk);
	return Buffer.concat(chunks);
}

test('saves a selection and detects a duplicate', async ({ page }, info) => {
	await resetAppState(page);
	await importCode(page, 'helper.py', 'def greet(name):\n    return f"Hello {name}"\n');
	const editor = page.locator('.cm-content').first();
	await editor.click();
	await page.keyboard.press('ControlOrMeta+Home');
	await page.keyboard.press('Shift+End');

	await page.keyboard.press('ControlOrMeta+Shift+P');
	const palette = page.getByRole('dialog', { name: 'Palette de commandes' });
	await palette.locator('input[type="text"]').fill('selection');
	await page.keyboard.press('Enter');
	await expect(page.getByTestId('snippet-form')).toBeVisible({ timeout: 20_000 });
	await expect(page.getByTestId('snippet-title')).toHaveValue(/Sélection/);
	await expect(page.getByTestId('snippet-code').locator('.cm-content')).toContainText(
		'def greet(name):'
	);
	await page.getByTestId('snippet-title').fill('Greeting helper');
	await page.getByTestId('snippet-save').click();
	await expect(page.getByTestId('snippet-detail-title')).toHaveText('Greeting helper');

	const saved = await snippetRows(page);
	expect(saved).toHaveLength(1);
	expect(saved[0]!.code).toBe('def greet(name):');
	expect(saved[0]!.language).toBe('python');
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('snippets-dialog')).toBeHidden();

	await editor.click();
	await page.keyboard.press('ControlOrMeta+Home');
	await page.keyboard.press('Shift+End');
	await page.keyboard.press('ControlOrMeta+Shift+P');
	await palette.locator('input[type="text"]').fill('selection');
	await page.keyboard.press('Enter');
	await expect(page.getByTestId('snippet-form')).toBeVisible({ timeout: 20_000 });
	await page.getByTestId('snippet-title').fill('Greeting helper copy');
	await page.getByTestId('snippet-save').click();
	await expect(page.getByTestId('snippet-form-error')).toContainText('existe déjà');
	expect(await snippetRows(page)).toHaveLength(1);

	await attach(info, 'snippets-selection.json', {
		saved: saved[0],
		duplicateCount: (await snippetRows(page)).length
	});
	await info.attach('snippets-selection.png', { body: await page.screenshot() });
});

test('copies placeholders from the keyboard and keeps a favorite after reload', async ({
	page,
	context
}, info) => {
	await context.grantPermissions(['clipboard-read', 'clipboard-write']);
	await resetAppState(page);
	await importCode(page, 'helper.py', 'print("hello")\n');
	await seedProject(page);
	await openSnippets(page);

	await page.getByTestId('snippet-new').click();
	await page.getByTestId('snippet-title').fill('Print project');
	await page.getByTestId('snippet-language').selectOption('shell');
	await page.getByTestId('snippet-tags').fill('shell, project');
	await page.getByTestId('snippet-folder').fill('Demo');
	await page.getByTestId('snippet-project').selectOption(projectId);
	const formEditor = page.getByTestId('snippet-code').locator('.cm-content');
	await formEditor.click();
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.insertText(
		'echo ${PROJECT_NAME}\nprintf "${FILE_NAME}"\nliteral \\${PROJECT_NAME}\n'
	);
	await page.getByTestId('snippet-save').click();
	await expect(page.getByTestId('snippet-detail-title')).toHaveText('Print project');

	const search = page.getByTestId('snippet-search');
	await expect(search).toBeFocused();
	await page.keyboard.type('shell');
	await expect(page.getByTestId('snippet-row')).toHaveCount(1);
	await page.keyboard.press('Enter');
	await expect(page.getByTestId('snippet-status')).toContainText('Extrait copié');
	await expect
		.poll(() => page.evaluate(() => navigator.clipboard.readText()))
		.toBe('echo Snippet project\nprintf "helper.py"\nliteral ${PROJECT_NAME}\n');
	await expect(page.getByTestId('snippet-resolved')).toContainText('echo Snippet project');

	await page.getByTestId('snippet-favorite').click();
	await expect(page.getByTestId('snippet-favorite')).toHaveAttribute('aria-pressed', 'true');
	await page.getByTestId('snippet-favorites-filter').click();
	await expect(page.getByTestId('snippet-row')).toHaveCount(1);

	const beforeReload = await snippetRows(page);
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor({
		state: 'visible',
		timeout: 15_000
	});
	await openSnippets(page);
	await expect(page.getByTestId('snippet-row')).toHaveCount(1);
	await expect(page.getByTestId('snippet-favorite')).toHaveAttribute('aria-pressed', 'true');
	await expect(page.getByTestId('snippet-detail-title')).toHaveText('Print project');

	await attach(info, 'snippets-placeholders.json', {
		beforeReload,
		clipboard: 'echo Snippet project\nprintf "helper.py"\nliteral ${PROJECT_NAME}\n',
		favorite: true
	});
});

test('keeps search responsive with thousands of metadata rows', async ({ page }, info) => {
	await resetAppState(page);
	const rows: SnippetFixture[] = Array.from({ length: 3000 }, (_, index) => ({
		id: `bulk-${index}`,
		title: `Snippet ${String(index).padStart(4, '0')}`,
		code: `// body ${index}\nreturn ${index};\n`,
		language: 'javascript',
		tags: index % 2 === 0 ? ['bulk', 'even'] : ['bulk', 'odd'],
		favorite: index === 2999,
		createdAt: 1_700_000_000_000 + index,
		updatedAt: 1_700_000_000_000 + index
	}));
	await page.evaluate(
		(values) =>
			new Promise<void>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const tx = database.transaction('snippets', 'readwrite');
					const store = tx.objectStore('snippets');
					for (const row of values) store.put(row);
					tx.oncomplete = () => {
						database.close();
						resolve();
					};
					tx.onerror = () => {
						database.close();
						reject(tx.error);
					};
				};
			}),
		rows
	);
	await openSnippets(page);
	await expect(page.getByTestId('snippet-row').first()).toBeVisible({ timeout: 20_000 });

	const started = Date.now();
	await page.getByTestId('snippet-search').fill('Snippet');
	await expect(page.getByTestId('snippet-row')).toHaveCount(100, { timeout: 10_000 });
	const elapsed = Date.now() - started;
	expect(elapsed).toBeLessThan(3000);
	await expect(page.getByTestId('snippets-dialog').locator('.cm-editor')).toHaveCount(1);

	await page.getByTestId('snippet-search').fill('2999');
	await expect(page.getByTestId('snippet-row')).toHaveCount(1, { timeout: 10_000 });
	await expect(page.getByTestId('snippet-row').first()).toContainText('Snippet 2999');
	await page.getByTestId('snippet-search').fill('return 123');
	await expect(page.getByTestId('snippet-no-match')).toBeVisible();

	await attach(info, 'snippets-search-performance.json', {
		rows: rows.length,
		renderedLimit: 100,
		searchMilliseconds: elapsed,
		codeEditors: 1
	});
});

test('exports and imports exact snippet bytes', async ({ page }, info) => {
	await resetAppState(page);
	const code = 'const text = "${PROJECT_NAME}";\r\n\tconst emoji = "ok";\r\n';
	const row: SnippetFixture = {
		id: 'exact-bytes',
		title: 'Exact bytes',
		code,
		language: 'typescript',
		tags: ['bytes', 'exact'],
		folder: 'Binary safe',
		favorite: true,
		createdAt: 1_700_000_000_000,
		updatedAt: 1_700_000_000_100
	};
	await seedSnippet(page, row);
	await openSnippets(page);
	await expect(page.getByTestId('snippet-detail-title')).toHaveText('Exact bytes');

	const pending = page.waitForEvent('download');
	await page.getByTestId('snippet-export').click();
	const downloaded = await downloadBytes(await pending);
	const exported = JSON.parse(downloaded.toString('utf8'));
	expect(exported.format).toBe('mdsh-snippets');
	expect(exported.snippets[0].code).toBe(code);
	expect(exported.snippets[0].language).toBe('typescript');
	expect(exported.snippets[0].tags).toEqual(['bytes', 'exact']);
	await attach(info, 'snippets-export.json', exported);

	await resetAppState(page);
	await openSnippets(page);
	await page
		.getByTestId('snippets-dialog')
		.locator('input[type="file"][accept*="json"]')
		.setInputFiles({ name: 'snippets.json', mimeType: 'application/json', buffer: downloaded });
	await expect(page.getByTestId('snippet-row')).toHaveCount(1, { timeout: 20_000 });
	await expect(page.getByTestId('snippet-detail-title')).toHaveText('Exact bytes');
	const restored = await snippetRows(page);
	expect(restored[0]!.code).toBe(code);
	expect(restored[0]!.language).toBe('typescript');
	expect(restored[0]!.tags).toEqual(['bytes', 'exact']);
	expect(restored[0]!.favorite).toBe(true);

	await attach(info, 'snippets-import.json', { restored });
});

test('includes snippets in a backup round trip', async ({ page }, info) => {
	await resetAppState(page);
	const code = 'export function value() {\r\n\treturn "${PROJECT_NAME}";\r\n}\r\n';
	const row: SnippetFixture = {
		id: 'backup-snippet',
		title: 'Backup snippet',
		code,
		language: 'typescript',
		tags: ['backup'],
		folder: 'Backup',
		projectId,
		favorite: true,
		createdAt: 1_700_000_000_000,
		updatedAt: 1_700_000_000_100
	};
	await seedProject(page);
	await seedSnippet(page, row);

	await page.keyboard.press('ControlOrMeta+,');
	await expect(page.getByRole('dialog', { name: 'Réglages' })).toBeVisible();
	const pending = page.waitForEvent('download', { timeout: 15_000 });
	await page.getByRole('button', { name: 'Exporter une sauvegarde', exact: true }).click();
	const backup = await downloadBytes(await pending);
	const parsed = JSON.parse(backup.toString('utf8'));
	expect(parsed.snippets).toHaveLength(1);
	expect(parsed.snippets[0].code).toBe(code);
	await attach(info, 'snippets-backup.json', backup.toString('utf8'));
	await page.keyboard.press('Escape');

	await resetAppState(page);
	await page.keyboard.press('ControlOrMeta+,');
	await expect(page.getByRole('dialog', { name: 'Réglages' })).toBeVisible();
	await page
		.locator('input[type="file"][accept*="json"]')
		.setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: backup });
	const restoreDialog = page.getByRole('dialog', { name: 'Restaurer la sauvegarde' });
	await restoreDialog.getByRole('button', { name: 'Remplacer', exact: true }).click();
	await expect(restoreDialog).toBeHidden();
	await expect(
		page.getByRole('status').filter({ hasText: 'Sauvegarde restaurée' }).last()
	).toBeVisible();
	await page.keyboard.press('Escape');

	await openSnippets(page);
	await expect(page.getByTestId('snippet-detail-title')).toHaveText('Backup snippet');
	const restored = await snippetRows(page);
	expect(restored).toHaveLength(1);
	expect(restored[0]!.code).toBe(code);
	expect(restored[0]!.projectId).toBe(projectId);
	expect(restored[0]!.favorite).toBe(true);
	await attach(info, 'snippets-backup-restored.json', { restored });
});

test('fits a mobile width and exposes accessible names', async ({ page }, info) => {
	await page.setViewportSize({ width: 375, height: 812 });
	await resetAppState(page);
	await seedSnippet(page, {
		id: 'mobile-snippet',
		title: 'Mobile snippet',
		code: 'return 1;\n',
		language: 'javascript',
		tags: ['mobile'],
		favorite: false,
		createdAt: 1_700_000_000_000,
		updatedAt: 1_700_000_000_000
	});
	await openSnippets(page);
	const dialog = page.getByTestId('snippets-dialog');
	const panel = dialog.locator('section').first();
	await expect(panel).toBeVisible();
	const box = await panel.boundingBox();
	expect(box).not.toBeNull();
	expect(box!.width).toBeLessThanOrEqual(375);
	expect(box!.height).toBeLessThanOrEqual(812);
	await expect(page.getByTestId('snippet-search')).toHaveAttribute(
		'aria-label',
		'Rechercher un extrait par titre, étiquette, dossier ou langage'
	);
	await expect(
		dialog.getByRole('listbox', { name: 'Résultats de recherche des extraits' })
	).toBeVisible();
	await expect(dialog.getByRole('button', { name: 'Fermer les extraits' })).toBeVisible();
	await attach(info, 'snippets-mobile.json', {
		viewport: { width: 375, height: 812 },
		panel: box,
		searchLabel: await page.getByTestId('snippet-search').getAttribute('aria-label')
	});
	await info.attach('snippets-mobile.png', { body: await page.screenshot() });
});

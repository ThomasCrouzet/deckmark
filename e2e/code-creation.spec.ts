import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { resetAppState } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

async function openNewDocument(page: Page) {
	await page
		.locator('aside')
		.getByRole('button', { name: /Nouveau fichier|New file/ })
		.first()
		.click();
	await expect(page.getByTestId('create-note')).toBeVisible();
}

async function activeRow(page: Page) {
	return page.evaluate(
		() =>
			new Promise<{ name: string; content: string; kind?: string } | null>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const rows = request.result.transaction('drafts').objectStore('drafts').getAll();
					rows.onerror = () => reject(rows.error);
					rows.onsuccess = () => {
						const active = rows.result.find((row) => row.open !== false);
						request.result.close();
						resolve(active ?? null);
					};
				};
			})
	);
}

test('creates a code file with the selected language and extension', async ({
	page
}, info: TestInfo) => {
	await resetAppState(page);
	await openNewDocument(page);
	await page.getByTestId('create-code').click();
	await page.getByTestId('create-code-language').selectOption('python');
	await expect(page.getByTestId('create-code-name')).toHaveValue(/\.py$/);
	await page.getByTestId('create-code-submit').click();

	await expect(page.getByTestId('code-editor')).toBeVisible({ timeout: 20_000 });
	await expect(page.getByTestId('code-language')).toHaveText('Python');
	await expect(page.getByTestId('document-kind')).toHaveText(/Code/);
	await expect(page.locator('.cm-content')).toHaveText('');
	await expect.poll(async () => (await activeRow(page))?.name).toMatch(/\.py$/);
	const row = await activeRow(page);
	expect(row?.kind).toBe('code');
	expect(row?.content).toBe('');

	await info.attach('created-code.json', {
		body: JSON.stringify(row),
		contentType: 'application/json'
	});
});

test('creates a valid JSON file from the direct choice', async ({ page }, info: TestInfo) => {
	await resetAppState(page);
	await openNewDocument(page);
	await page.getByTestId('create-json').click();

	await expect(page.getByTestId('code-editor')).toBeVisible({ timeout: 20_000 });
	await expect(page.getByTestId('code-language')).toHaveText('JSON');
	await expect(page.getByTestId('json-status')).toBeVisible();
	await expect(page.locator('.cm-content')).toHaveText('{}');
	await expect.poll(async () => (await activeRow(page))?.name).toMatch(/\.json$/);

	await page.reload();
	await expect(page.getByTestId('code-language')).toHaveText('JSON');
	await expect(page.getByTestId('document-kind')).toHaveText(/Code/);
	await expect(page.locator('.cm-content')).toHaveText('{}');

	await info.attach('created-json.json', {
		body: JSON.stringify(await activeRow(page)),
		contentType: 'application/json'
	});
});

test('handles name collisions and rejects a mismatched extension', async ({
	page
}, info: TestInfo) => {
	await resetAppState(page);
	await openNewDocument(page);
	await page.getByTestId('create-code').click();
	await page.getByTestId('create-code-language').selectOption('rust');
	await page.getByTestId('create-code-submit').click();
	await expect(page.getByTestId('code-language')).toHaveText('Rust');

	await openNewDocument(page);
	await page.getByTestId('create-code').click();
	await page.getByTestId('create-code-language').selectOption('rust');
	await page.getByTestId('create-code-submit').click();
	const second = page
		.locator('aside')
		.getByRole('button', { name: /\(2\)\.rs/ })
		.first();
	await expect(second).toBeVisible();
	await expect(second).toContainText('Sans titre (2).rs');

	await openNewDocument(page);
	await page.getByTestId('create-code').click();
	await page.getByTestId('create-code-language').selectOption('python');
	await page.getByTestId('create-code-name').fill('wrong.rs');
	await expect(page.getByTestId('create-code-error')).toBeVisible();
	await expect(page.getByTestId('create-code-submit')).toBeDisabled();
	await page.getByTestId('create-code-cancel').click();
	await expect(page.getByTestId('create-code-submit')).toHaveCount(0);

	await info.attach('code-creation-collision.json', {
		body: JSON.stringify({
			secondName: await page
				.locator('aside')
				.getByRole('button', { name: /\(2\)\.rs/ })
				.first()
				.innerText()
		}),
		contentType: 'application/json'
	});
});

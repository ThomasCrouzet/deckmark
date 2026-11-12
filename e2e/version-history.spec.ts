import { expect, test, type Page } from '@playwright/test';
import { createFirstFile, openPalette, resetAppState, writeSourceContent } from './helpers';

interface DraftRow {
	id: string;
	name: string;
	content: string;
}

const CURRENT = '# Note\n\nCurrent line\n';

async function activeDraft(page: Page): Promise<DraftRow> {
	return page.evaluate(
		() =>
			new Promise<DraftRow>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const rows = database.transaction('drafts').objectStore('drafts').getAll();
					rows.onerror = () => reject(rows.error);
					rows.onsuccess = () => {
						database.close();
						const row = rows.result.find((entry) => entry.open !== false) ?? rows.result[0];
						if (!row) reject(new Error('No active draft'));
						else resolve({ id: row.id, name: row.name, content: row.content });
					};
				};
			})
	);
}

async function seedVersions(
	page: Page,
	draft: { id: string; name: string },
	versions: Array<{ id: string; content: string; createdAt: number }>
): Promise<void> {
	await page.evaluate(
		({ draftId, draftName, rows }) =>
			new Promise<void>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const transaction = database.transaction('versions', 'readwrite');
					const store = transaction.objectStore('versions');
					store.clear();
					for (const version of rows) {
						store.put({
							id: version.id,
							draftId,
							name: draftName,
							content: version.content,
							createdAt: version.createdAt
						});
					}
					transaction.oncomplete = () => {
						database.close();
						resolve();
					};
					transaction.onerror = () => reject(transaction.error);
					transaction.onabort = () => reject(transaction.error);
				};
			}),
		{ draftId: draft.id, draftName: draft.name, rows: versions }
	);
}

async function deleteVersion(page: Page, versionId: string): Promise<void> {
	await page.evaluate(
		(id) =>
			new Promise<void>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const transaction = database.transaction('versions', 'readwrite');
					transaction.objectStore('versions').delete(id);
					transaction.oncomplete = () => {
						database.close();
						resolve();
					};
					transaction.onerror = () => reject(transaction.error);
					transaction.onabort = () => reject(transaction.error);
				};
			}),
		versionId
	);
}

async function versionIds(page: Page): Promise<string[]> {
	return page.evaluate(
		() =>
			new Promise<string[]>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const rows = database.transaction('versions').objectStore('versions').getAll();
					rows.onerror = () => reject(rows.error);
					rows.onsuccess = () => {
						database.close();
						resolve(rows.result.map((row) => row.id).sort());
					};
				};
			})
	);
}

async function holdVersionRead(page: Page, versionId: string): Promise<void> {
	await page.evaluate((id) => {
		(
			window as unknown as {
				__MDSH_VERSION_READS__?: { hold: (value: string) => void };
			}
		).__MDSH_VERSION_READS__?.hold(id);
	}, versionId);
}

async function releaseVersionRead(page: Page): Promise<void> {
	await page.evaluate(() => {
		(
			window as unknown as {
				__MDSH_VERSION_READS__?: { release: () => void };
			}
		).__MDSH_VERSION_READS__?.release();
	});
}

async function openHistory(page: Page) {
	await openPalette(page);
	await page.getByRole('combobox').fill('Historique des versions');
	await page.keyboard.press('Enter');
	const history = page.getByRole('dialog', { name: /Historique des versions/ });
	await expect(history).toBeVisible();
	return history;
}

async function seedHistory(page: Page) {
	await resetAppState(page);
	await createFirstFile(page);
	await writeSourceContent(page, CURRENT);
	const draft = await activeDraft(page);
	const now = Date.now();
	await seedVersions(page, draft, [
		{ id: 'e2e-v-old', content: 'old line\n', createdAt: now - 300_000 },
		{ id: 'e2e-v-mid', content: 'middle line\n', createdAt: now - 240_000 },
		{ id: 'e2e-v-new', content: 'new line\n', createdAt: now - 180_000 }
	]);
	return draft;
}

test('settles the preview when the selected version disappears before its read', async ({
	page
}, info) => {
	test.setTimeout(120_000);
	await seedHistory(page);
	const history = await openHistory(page);
	const versions = history.getByRole('list', { name: 'Versions disponibles' });
	await expect(versions.getByRole('button')).toHaveCount(3);
	await expect(history.locator('[data-diff-kind="add"]')).toContainText('new line');

	await holdVersionRead(page, 'e2e-v-old');
	await versions.getByRole('button').last().click();
	await expect(history.getByText('Chargement…')).toBeVisible();

	// A same-origin tab, the retention pass, or a purge can remove the row
	// between the summary list and this body read.
	await deleteVersion(page, 'e2e-v-old');
	await expect(history.getByText('Chargement…')).toBeVisible();
	await releaseVersionRead(page);

	// A current read that resolves without a row must settle the preview.
	await expect(history.getByText('Chargement…')).toHaveCount(0);
	await expect(history.getByTestId('history-missing')).toBeVisible();
	await expect(history.getByTestId('history-missing')).toContainText(
		'Cette version n’est plus dans le stockage local.'
	);
	await expect(history.getByRole('button', { name: 'Restaurer cette version' })).toBeDisabled();

	// The recovery path refreshes the summaries and selects the newest
	// remaining version without touching the active document.
	await history.getByTestId('history-refresh').click();
	await expect(versions.getByRole('button')).toHaveCount(2);
	await expect(history.getByTestId('history-missing')).toHaveCount(0);
	await expect(history.locator('[data-diff-kind="add"]')).toContainText('new line');
	const after = await activeDraft(page);
	expect(after.content).toBe(CURRENT);
	expect(await versionIds(page)).toEqual(['e2e-v-mid', 'e2e-v-new']);

	await info.attach('missing-version.json', {
		body: JSON.stringify(
			{
				requested: 'e2e-v-old',
				rows: await versionIds(page),
				activeContentUnchanged: after.content === CURRENT,
				recoveredSelection: 'e2e-v-new',
				loadingSettled: true,
				restoreDisabled: true
			},
			null,
			2
		),
		contentType: 'application/json'
	});
});

test('keeps the newer preview when an older body read resolves late', async ({ page }, info) => {
	test.setTimeout(120_000);
	await seedHistory(page);
	const history = await openHistory(page);
	const versions = history.getByRole('list', { name: 'Versions disponibles' });
	await expect(versions.getByRole('button')).toHaveCount(3);
	await expect(history.locator('[data-diff-kind="add"]')).toContainText('new line');

	await holdVersionRead(page, 'e2e-v-mid');
	await versions.getByRole('button').nth(1).click();
	await expect(history.getByText('Chargement…')).toBeVisible();

	// The user moves on before the older read completes.
	await versions.getByRole('button').last().click();
	await expect(history.locator('[data-diff-kind="add"]')).toContainText('old line');

	await releaseVersionRead(page);
	await expect(history.locator('[data-diff-kind="add"]')).toContainText('old line');
	await expect(history.getByText('middle line')).toHaveCount(0);
	await expect(history.getByTestId('history-missing')).toHaveCount(0);

	await info.attach('out-of-order-version.json', {
		body: JSON.stringify(
			{ held: 'e2e-v-mid', displayed: 'e2e-v-old', stalePreviewPublished: false },
			null,
			2
		),
		contentType: 'application/json'
	});
});

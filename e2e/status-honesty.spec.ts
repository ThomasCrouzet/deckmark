import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { resetAppState, writeSourceContent } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

interface SeededDraft {
	id: string;
	name: string;
	content: string;
}

/**
 * Writes durable draft rows, selects the active document and reloads, so the
 * app restores the drafts as an earlier session created them. No write happens
 * in the current session until a test edits a document.
 */
async function seedDrafts(
	page: Page,
	drafts: SeededDraft[],
	activeId: string,
	mode: 'wysiwyg' | 'source' | 'read'
): Promise<void> {
	await page.evaluate(
		async ({ rows, active, selectedMode }) => {
			await new Promise<void>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const transaction = database.transaction('drafts', 'readwrite');
					const store = transaction.objectStore('drafts');
					rows.forEach((row, index) =>
						store.put({
							...row,
							createdAt: 1_700_000_000_000,
							updatedAt: 1_700_000_000_000,
							order: index,
							open: true
						})
					);
					transaction.oncomplete = () => {
						database.close();
						resolve();
					};
					transaction.onerror = () => reject(transaction.error);
				};
			});
			localStorage.setItem('mdsh:activeId', active);
			localStorage.setItem('mdsh:mode', selectedMode);
		},
		{ rows: drafts, active: activeId, selectedMode: mode }
	);
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor({
		state: 'visible',
		timeout: 15_000
	});
}

function largeNote(): string {
	const paragraph =
		'A large note keeps the render limit active until the user confirms the document. ';
	let content = '# Large note\n\n';
	while (content.length < 300_000) content += `${paragraph}\n\n`;
	return content;
}

test('shows the save time of the active document, not the last write', async ({
	page
}, info: TestInfo) => {
	await resetAppState(page);
	await seedDrafts(
		page,
		[
			{ id: 'aged-doc', name: 'aged.md', content: '# Aged\n\nRestored draft.' },
			{ id: 'fresh-doc', name: 'fresh.md', content: '# Fresh\n\nRestored draft.' }
		],
		'aged-doc',
		'source'
	);
	const saveState = page.getByTestId('save-state');
	await expect(page.locator('.cm-content').first()).toContainText('Restored draft');
	// A restored draft is durable before this session records a save for it.
	await expect(saveState).toHaveText('Brouillons locaux : enregistré');

	await page.locator('aside button[data-file-id="fresh-doc"]').click();
	await expect(page.locator('input[aria-label^="Nom du fichier"]')).toHaveValue('fresh');
	await writeSourceContent(page, '# Fresh\n\nEdited in this session.');
	// The label refreshes on a 10 s tick, so wait for the age itself.
	await expect(saveState).toHaveText(/il y a \d+s/, { timeout: 15_000 });
	const freshAge = Number((await saveState.innerText()).match(/il y a (\d+)s/)?.[1] ?? '0');
	expect(freshAge).toBeGreaterThanOrEqual(2);

	await page.locator('aside button[data-file-id="aged-doc"]').click();
	await expect(page.locator('input[aria-label^="Nom du fichier"]')).toHaveValue('aged');
	// The aged document has no write in this session. The fresh write must not
	// leak into its status line.
	await expect(saveState).toHaveText('Brouillons locaux : enregistré');

	await info.attach('per-document-status.json', {
		body: JSON.stringify({ freshAge, agedState: await saveState.innerText() }, null, 2),
		contentType: 'application/json'
	});
});

test('does not persist a render-constraint Source switch', async ({ page }, info: TestInfo) => {
	await resetAppState(page, { mode: 'wysiwyg' });
	await seedDrafts(
		page,
		[{ id: 'large-doc', name: 'large.md', content: largeNote() }],
		'large-doc',
		'wysiwyg'
	);
	const source = page.locator('button[data-mode="source"]');
	await expect(source).toHaveAttribute('aria-checked', 'true', { timeout: 30_000 });
	const readStoredMode = () => page.evaluate(() => localStorage.getItem('mdsh:mode'));
	// The forced Source view is not a preference.
	expect(await readStoredMode()).toBe('wysiwyg');
	await page.waitForTimeout(500);
	expect(await readStoredMode()).toBe('wysiwyg');

	// An explicit user choice still persists.
	await page.locator('button[data-mode="read"]').click();
	const confirm = page.getByRole('button', { name: 'Afficher le document', exact: true });
	if (await confirm.count()) await confirm.click();
	await expect(page.locator('button[data-mode="read"]')).toHaveAttribute('aria-checked', 'true', {
		timeout: 60_000
	});
	await expect.poll(readStoredMode).toBe('read');

	await info.attach('mode-persistence.json', {
		body: JSON.stringify(
			{
				forcedMode: 'source',
				storedAfterForcedSwitch: 'wysiwyg',
				storedAfterExplicitSwitch: 'read'
			},
			null,
			2
		),
		contentType: 'application/json'
	});
});

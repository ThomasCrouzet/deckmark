import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
	blockPreferenceStorage,
	createFirstFile,
	openPalette,
	resetAppState,
	writeSourceContent
} from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

async function openComments(page: Page) {
	await openPalette(page);
	await page
		.getByRole('dialog', { name: 'Palette de commandes' })
		.getByRole('option', { name: /commentaires éditoriaux/i })
		.click();
	await expect(page.getByTestId('comments-panel')).toBeVisible();
}

async function addComment(page: Page, quote: string, body: string) {
	await page.getByTestId('comment-quote').fill(quote);
	await page.getByTestId('comment-body').fill(body);
	await page.getByTestId('comment-author').fill('Reviewer');
	await page.getByTestId('comment-add').click();
}

async function storedComments(
	page: Page
): Promise<Array<{ draftId: string; body: string; author: string }>> {
	return page.evaluate(
		() =>
			new Promise<Array<{ draftId: string; body: string; author: string }>>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const transaction = database.transaction('comments');
					const read = transaction.objectStore('comments').getAll();
					transaction.oncomplete = () => {
						database.close();
						resolve(read.result as Array<{ draftId: string; body: string; author: string }>);
					};
					transaction.onerror = () => reject(transaction.error);
				};
			})
	);
}

async function seedDraft(page: Page, row: Record<string, unknown>): Promise<void> {
	await page.evaluate(async (seed) => {
		await new Promise<void>((resolve, reject) => {
			const request = indexedDB.open('mdsh');
			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				const database = request.result;
				const transaction = database.transaction('drafts', 'readwrite');
				transaction.objectStore('drafts').put(seed);
				transaction.oncomplete = () => {
					database.close();
					resolve();
				};
				transaction.onerror = () => reject(transaction.error);
			};
		});
		localStorage.setItem('mdsh:activeId', String(seed.id));
	}, row);
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
}

async function source(page: Page): Promise<string> {
	return page
		.locator('.cm-content .cm-line')
		.evaluateAll((lines) => lines.map((line) => line.textContent).join('\n'));
}

test('adds local comments without changing the Markdown and survives reload', async ({
	page
}, info: TestInfo) => {
	await resetAppState(page);
	await createFirstFile(page);
	const content = '# Guide\n\nUnique passage for review.\n\nSecond paragraph.';
	await writeSourceContent(page, content);
	await openComments(page);
	await addComment(page, 'Unique passage for review.', 'Please confirm this wording.');
	await expect(page.getByTestId('comments-panel')).toContainText('Please confirm this wording.');
	await expect(page.getByTestId('comments-panel')).toContainText('ancre valide');
	await expect(page.locator('.cm-content')).toContainText('Unique passage for review.');

	await page.getByRole('button', { name: 'Résoudre', exact: true }).click();
	await expect(page.getByTestId('comments-panel')).toContainText('résolu');
	await page.getByRole('button', { name: 'Rouvrir', exact: true }).click();
	await expect(page.getByTestId('comments-panel')).toContainText('ouvert');

	const downloadPromise = page.waitForEvent('download');
	await page.getByTestId('comments-export').click();
	const download = await downloadPromise;
	const report = JSON.parse(await readFile((await download.path())!, 'utf8')) as {
		comments: Array<{ anchor: { state: string } }>;
	};
	expect(report.comments).toHaveLength(1);
	expect(report.comments[0]?.anchor.state).toBe('attached');

	await page.keyboard.press('Escape');
	await expect(page.getByTestId('comments-panel')).toHaveCount(0);
	expect(await source(page)).toBe(content);

	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	await openComments(page);
	await expect(page.getByTestId('comments-panel')).toContainText('Please confirm this wording.');
	await info.attach('comments.json', {
		body: JSON.stringify({ report, sourceUnchanged: content }, null, 2),
		contentType: 'application/json'
	});
});

test('permanent purge removes orphaned comments from storage and backups', async ({
	page,
	context
}, info: TestInfo) => {
	await resetAppState(page);
	await createFirstFile(page);
	const content = '# Guide\n\nPermanent review passage.\n';
	await writeSourceContent(page, content);
	const draftId = await page.evaluate(() => localStorage.getItem('mdsh:activeId'));
	const name = `${await page.locator('#app-toolbar input').inputValue()}.md`;
	await openComments(page);
	await addComment(page, 'Permanent review passage.', 'Permanent review body.');
	await expect(page.getByTestId('comments-panel')).toContainText('Permanent review body.');
	expect(await storedComments(page)).toHaveLength(1);
	await page.keyboard.press('Escape');

	const observer = await context.newPage();
	await observer.goto('/');
	await observer.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	await openComments(observer);
	await expect(observer.getByTestId('comments-panel')).toContainText('Permanent review body.');

	await page
		.locator('aside')
		.getByRole('button', { name: /^Bibliothèque de documents/ })
		.click();
	const library = page.getByRole('dialog', { name: 'Bibliothèque de documents', exact: true });
	await library.getByRole('checkbox', { name: `Sélectionner ${name}`, exact: true }).check();
	await library.getByRole('button', { name: 'Supprimer la sélection', exact: true }).click();
	const confirmDelete = page.getByRole('dialog', {
		name: 'Supprimer 1 document(s) ?',
		exact: true
	});
	await confirmDelete.getByRole('button', { name: 'Supprimer la sélection', exact: true }).click();
	await expect(confirmDelete).toBeHidden();
	await page.keyboard.press('Escape');
	await expect(library).toBeHidden();

	const trash = page
		.locator('aside details')
		.filter({ has: page.locator('summary', { hasText: /^Corbeille/ }) });
	await trash.locator('summary').click();
	await trash
		.getByRole('button', { name: `Supprimer définitivement ${name}`, exact: true })
		.click();
	await page
		.getByRole('dialog', { name: 'Supprimer définitivement ce document ?', exact: true })
		.getByRole('button', { name: 'Supprimer définitivement', exact: true })
		.click();
	await expect.poll(async () => (await storedComments(page)).length).toBe(0);
	await expect.poll(async () => (await storedComments(observer)).length).toBe(0);
	await observer.close();

	await page.keyboard.press('ControlOrMeta+,');
	await expect(page.getByRole('dialog', { name: 'Réglages' })).toBeVisible();
	const downloadPromise = page.waitForEvent('download');
	await page.getByRole('button', { name: 'Exporter une sauvegarde', exact: true }).click();
	const download = await downloadPromise;
	const backup = JSON.parse(await readFile((await download.path())!, 'utf8')) as {
		comments?: unknown[];
	};
	expect(JSON.stringify(backup)).not.toContain('Permanent review body.');
	await page.keyboard.press('Escape');

	await seedDraft(page, {
		id: draftId,
		name,
		content,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		order: 0,
		open: true
	});
	await openComments(page);
	await expect(page.getByTestId('comments-panel')).not.toContainText('Permanent review body.');
	await info.attach('purged-comments.json', {
		body: JSON.stringify(
			{
				draftId,
				comment: { body: 'Permanent review body.', author: 'Reviewer' },
				remaining: await storedComments(page),
				backupComments: backup.comments ?? []
			},
			null,
			2
		),
		contentType: 'application/json'
	});
});

test('keeps a saved comment when the author preference is blocked', async ({
	page
}, info: TestInfo) => {
	await resetAppState(page);
	await createFirstFile(page);
	const content = '# Guide\n\nBlocked preference passage.\n';
	await writeSourceContent(page, content);
	await blockPreferenceStorage(page, ['mdsh:comment-author']);
	await openComments(page);
	await addComment(page, 'Blocked preference passage.', 'Saved once.');
	await expect(page.getByTestId('comments-panel')).toContainText('Saved once.');
	await expect(page.getByTestId('comment-body')).toHaveValue('');
	expect(await storedComments(page)).toHaveLength(1);

	// A second click with the cleared form cannot add a duplicate row.
	await page.getByTestId('comment-add').click();
	await expect(page.getByTestId('comment-body')).toHaveValue('');
	expect(await storedComments(page)).toHaveLength(1);

	// The blocked read does not stop the panel after a reload.
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	await openComments(page);
	await expect(page.getByTestId('comments-panel')).toContainText('Saved once.');
	const rows = await storedComments(page);
	await info.attach('comments-blocked-preference.json', {
		body: JSON.stringify({ rows, bodyCleared: true, duplicates: rows.length - 1 }, null, 2),
		contentType: 'application/json'
	});
});

test('reports moved and detached anchors without guessing', async ({ page }, info: TestInfo) => {
	await resetAppState(page);
	await createFirstFile(page);
	await writeSourceContent(page, 'Alpha unique. Beta tail.');
	await openComments(page);
	await addComment(page, 'Alpha unique.', 'Anchor test.');
	await page.keyboard.press('Escape');

	await writeSourceContent(page, 'Intro. Alpha unique. Beta tail.');
	await openComments(page);
	await expect(page.getByTestId('comments-panel')).toContainText('ancre déplacée');
	await page.keyboard.press('Escape');

	await writeSourceContent(page, 'Alpha removed. Beta tail.');
	await openComments(page);
	await expect(page.getByTestId('comments-panel')).toContainText('ancre perdue');
	await info.attach('comments-anchors.json', {
		body: JSON.stringify({ moved: true, detached: true }),
		contentType: 'application/json'
	});
});

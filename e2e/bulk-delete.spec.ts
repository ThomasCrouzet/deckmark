import { expect, test, type Page } from '@playwright/test';
import type { DraftRow, TrashedRow, VersionRow } from '../src/lib/db';
import { resetAppState } from './helpers';

interface DocumentSeed {
	id: string;
	content: string;
	open?: boolean;
	trashed?: boolean;
}

async function seedDocuments(page: Page, documents: DocumentSeed[], activeId: string | null) {
	await page.evaluate(
		async ({ documents, activeId }) => {
			const openDatabase = (name: string) =>
				new Promise<IDBDatabase>((resolve, reject) => {
					const request = indexedDB.open(name);
					request.onupgradeneeded = () => request.result.createObjectStore('handles');
					request.onsuccess = () => resolve(request.result);
					request.onerror = () => reject(request.error);
				});
			const database = await openDatabase('mdsh');
			const links = await openDatabase('mdsh-fs');
			const now = Date.now();
			await Promise.all([
				new Promise<void>((resolve, reject) => {
					const tx = database.transaction(['drafts', 'trashed', 'versions'], 'readwrite');
					documents.forEach((document, order) => {
						const row = {
							id: document.id,
							name: `${document.id}.md`,
							content: document.content,
							createdAt: now,
							updatedAt: now,
							order,
							open: document.open ?? true
						};
						if (document.trashed) {
							tx.objectStore('trashed').put({ id: row.id, file: row, order, trashedAt: now });
						} else tx.objectStore('drafts').put(row);
						tx.objectStore('versions').put({
							id: `history-${row.id}`,
							draftId: row.id,
							name: row.name,
							content: `History for ${row.id}`,
							createdAt: now
						});
					});
					tx.oncomplete = () => resolve();
					tx.onabort = () => reject(tx.error);
				}),
				new Promise<void>((resolve, reject) => {
					const tx = links.transaction('handles', 'readwrite');
					for (const document of documents) {
						tx.objectStore('handles').put(
							{ kind: 'path', path: `/bulk-delete/${document.id}.md`, epoch: 'legacy' },
							document.id
						);
					}
					tx.oncomplete = () => resolve();
					tx.onabort = () => reject(tx.error);
				})
			]);
			database.close();
			links.close();
			if (activeId) localStorage.setItem('mdsh:activeId', activeId);
		},
		{ documents, activeId }
	);
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
}

async function storedState(page: Page) {
	return page.evaluate(async () => {
		async function rows<T>(databaseName: string, table: string, keys = false): Promise<T[]> {
			return new Promise((resolve, reject) => {
				const request = indexedDB.open(databaseName);
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const tx = database.transaction(table);
					const store = tx.objectStore(table);
					const result = keys ? store.getAllKeys() : store.getAll();
					tx.oncomplete = () => {
						database.close();
						resolve(result.result as T[]);
					};
					tx.onabort = () => {
						database.close();
						reject(tx.error);
					};
				};
			});
		}
		return {
			drafts: await rows<DraftRow>('mdsh', 'drafts'),
			trash: await rows<TrashedRow>('mdsh', 'trashed'),
			versions: await rows<VersionRow>('mdsh', 'versions'),
			links: await rows<string>('mdsh-fs', 'handles', true)
		};
	});
}

async function openLibrary(page: Page) {
	await page
		.locator('aside')
		.getByRole('button', { name: /^Bibliothèque de documents/ })
		.click();
	const library = page.getByRole('dialog', { name: 'Bibliothèque de documents', exact: true });
	await expect(library.getByRole('textbox')).toBeFocused();
	return library;
}

async function openTrash(page: Page) {
	const trash = page
		.locator('aside details')
		.filter({ has: page.locator('summary', { hasText: /^Corbeille/ }) });
	await trash.locator('summary').click();
	return trash;
}

async function failTrashWrite(page: Page, operation: 'put' | 'delete') {
	await page.evaluate((operation) => {
		let calls = 0;
		if (operation === 'put') {
			const original = IDBObjectStore.prototype.put;
			IDBObjectStore.prototype.put = function (value, key) {
				const request =
					key === undefined ? original.call(this, value) : original.call(this, value, key);
				if (this.name === 'trashed' && ++calls === 2) {
					IDBObjectStore.prototype.put = original;
					this.transaction.abort();
				}
				return request;
			};
		} else {
			const original = IDBObjectStore.prototype.delete;
			IDBObjectStore.prototype.delete = function (key) {
				const request = original.call(this, key);
				if (this.name === 'trashed' && ++calls === 2) {
					IDBObjectStore.prototype.delete = original;
					this.transaction.abort();
				}
				return request;
			};
		}
	}, operation);
}

test.beforeEach(async ({ page }) => {
	await resetAppState(page);
});

test('library selection is accessible, scoped to results, and preserves retained documents', async ({
	page
}) => {
	await seedDocuments(
		page,
		[
			{ id: 'remove-open', content: 'Open document' },
			{ id: 'remove-closed', content: 'Closed document', open: false },
			{ id: 'keep-closed', content: 'Keep closed', open: false },
			{ id: 'keep-active', content: 'Keep [[remove-open]] and [[keep-closed]]' }
		],
		'keep-active'
	);
	const before = await storedState(page);
	const library = await openLibrary(page);
	await expect(
		library.getByRole('button', { name: 'Supprimer la sélection', exact: true })
	).toBeDisabled();
	const checkbox = library.getByRole('checkbox', {
		name: 'Sélectionner keep-active.md',
		exact: true
	});
	await checkbox.focus();
	await page.keyboard.press('Space');
	await expect(checkbox).toBeChecked();
	await expect(library.getByRole('status').filter({ hasText: /document\(s\)/ })).toHaveText(
		'1 document(s) sélectionné(s)'
	);
	await library.getByRole('textbox').fill('remove-');
	await expect(library.getByRole('status').filter({ hasText: /document\(s\)/ })).toHaveText(
		'0 document(s) sélectionné(s)'
	);
	await library
		.getByRole('checkbox', { name: 'Sélectionner tous les résultats', exact: true })
		.check();
	await expect(library.getByRole('status').filter({ hasText: /document\(s\)/ })).toHaveText(
		'2 document(s) sélectionné(s)'
	);
	await library.getByRole('button', { name: 'Supprimer la sélection', exact: true }).click();
	const confirm = page.getByRole('dialog', { name: 'Supprimer 2 document(s) ?', exact: true });
	await expect(confirm).toContainText('corbeille');
	await expect(confirm.getByRole('button', { name: 'Annuler', exact: true })).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(library).toBeVisible();
	await expect(library.getByRole('status').filter({ hasText: /document\(s\)/ })).toHaveText(
		'2 document(s) sélectionné(s)'
	);
	expect(await storedState(page)).toEqual(before);
	await library.getByRole('button', { name: 'Supprimer la sélection', exact: true }).click();
	await confirm.getByRole('button', { name: 'Supprimer la sélection', exact: true }).click();
	await expect(library.getByRole('status').filter({ hasText: /document\(s\)/ })).toHaveText(
		'0 document(s) sélectionné(s)'
	);
	await expect(library.getByRole('textbox')).toBeFocused();
	await expect
		.poll(async () => (await storedState(page)).trash.map((row) => row.id))
		.toEqual(['remove-closed', 'remove-open']);
	const after = await storedState(page);
	expect(after.drafts).toEqual(before.drafts.filter((row) => row.id.startsWith('keep-')));
	expect(after.versions).toEqual(before.versions);
	expect(after.links).toEqual(before.links);
	await library.getByRole('textbox').fill('');
	await expect(
		library.getByText('Liens introuvables ou ambigus (1)', { exact: true })
	).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page.locator('#app-toolbar input')).toHaveValue('keep-active');
	await page.reload();
	await expect(page.locator('#app-toolbar input')).toHaveValue('keep-active');
	const trash = await openTrash(page);
	await trash.getByRole('button', { name: 'Restaurer remove-closed.md', exact: true }).click();
	await expect(page.locator('#app-toolbar input')).toHaveValue('remove-closed');
	await expect(page.locator('.cm-content')).toContainText('Closed document');
	await expect
		.poll(async () => (await storedState(page)).drafts.some((row) => row.id === 'remove-closed'))
		.toBe(true);
});

test('deleting the active selection keeps the next open document active after reload', async ({
	page
}) => {
	await seedDocuments(
		page,
		[
			{ id: 'first', content: 'First' },
			{ id: 'active', content: 'Active' },
			{ id: 'next', content: 'Next' },
			{ id: 'closed', content: 'Closed', open: false }
		],
		'active'
	);
	const library = await openLibrary(page);
	await library.getByRole('checkbox', { name: 'Sélectionner active.md', exact: true }).check();
	await library.getByRole('checkbox', { name: 'Sélectionner closed.md', exact: true }).check();
	await library.getByRole('button', { name: 'Supprimer la sélection', exact: true }).click();
	await page
		.getByRole('dialog', { name: 'Supprimer 2 document(s) ?', exact: true })
		.getByRole('button', { name: 'Supprimer la sélection', exact: true })
		.click();
	await expect(library.getByRole('status').filter({ hasText: /document\(s\)/ })).toHaveText(
		'0 document(s) sélectionné(s)'
	);
	await page.keyboard.press('Escape');
	await expect(page.locator('#app-toolbar input')).toHaveValue('next');
	await page.reload();
	await expect(page.locator('#app-toolbar input')).toHaveValue('next');
	await expect(page.locator('.mdsh-file-row')).toHaveCount(2);
});

test('Delete all confirms the whole library even with a filter and handles a large corpus', async ({
	page
}) => {
	await seedDocuments(
		page,
		Array.from({ length: 200 }, (_, index) => ({
			id: `document-${String(index).padStart(3, '0')}`,
			content: `Document ${index}`,
			open: index < 3
		})),
		'document-000'
	);
	const library = await openLibrary(page);
	await library.getByRole('button', { name: 'Documents fermés', exact: true }).click();
	await library.getByRole('textbox').fill('document-199');
	await library
		.getByRole('checkbox', { name: 'Sélectionner tous les résultats', exact: true })
		.check();
	await expect(library.getByRole('status').filter({ hasText: /document\(s\)/ })).toHaveText(
		'1 document(s) sélectionné(s)'
	);
	await library.getByRole('button', { name: 'Tout supprimer', exact: true }).click();
	const confirm = page.getByRole('dialog', {
		name: 'Supprimer les 200 document(s) de la bibliothèque ?',
		exact: true
	});
	await expect(confirm).toContainText('documents fermés');
	await confirm.getByRole('button', { name: 'Annuler', exact: true }).click();
	expect((await storedState(page)).drafts).toHaveLength(200);
	await library.getByRole('button', { name: 'Tout supprimer', exact: true }).click();
	await confirm.getByRole('button', { name: 'Tout supprimer', exact: true }).click();
	await expect(library.getByRole('heading')).toHaveText('Bibliothèque de documents (0)');
	await expect(library.getByRole('button', { name: 'Tout supprimer', exact: true })).toBeDisabled();
	await expect(
		library.getByRole('checkbox', { name: 'Sélectionner tous les résultats', exact: true })
	).toBeDisabled();
	await page.reload();
	await expect(page.getByTestId('welcome-new')).toBeVisible();
	const state = await storedState(page);
	expect(state.drafts).toHaveLength(0);
	expect(state.trash).toHaveLength(200);
	expect(state.versions).toHaveLength(200);
	expect(state.links).toHaveLength(200);
});

test('trash selection and Empty trash preserve live ID collisions and retained history and links', async ({
	page
}) => {
	await seedDocuments(
		page,
		[
			{ id: 'live', content: 'Keep [[retained]]' },
			{ id: 'live', content: 'Old live variant', trashed: true },
			{ id: 'remove-one', content: 'One', trashed: true },
			{ id: 'remove-two', content: 'Two', trashed: true },
			{ id: 'retained', content: 'Restore later', trashed: true }
		],
		'live'
	);
	const before = await storedState(page);
	const trash = await openTrash(page);
	await trash.getByRole('checkbox', { name: 'Sélectionner remove-one.md', exact: true }).check();
	await trash.getByRole('checkbox', { name: 'Sélectionner remove-two.md', exact: true }).check();
	await expect(trash.getByRole('status')).toHaveText('2 document(s) sélectionné(s)');
	await trash.getByRole('button', { name: 'Supprimer la sélection', exact: true }).click();
	const confirm = page.getByRole('dialog', {
		name: 'Supprimer définitivement 2 document(s) ?',
		exact: true
	});
	await expect(confirm).toContainText('historique');
	await confirm.getByRole('button', { name: 'Annuler', exact: true }).click();
	expect(await storedState(page)).toEqual(before);
	await trash.getByRole('button', { name: 'Supprimer la sélection', exact: true }).click();
	await confirm.getByRole('button', { name: 'Supprimer définitivement', exact: true }).click();
	await expect(trash.getByRole('status')).toHaveText('0 document(s) sélectionné(s)');
	await expect(trash.locator('summary')).toBeFocused();
	await expect.poll(async () => (await storedState(page)).links).toEqual(['live', 'retained']);
	expect((await storedState(page)).versions.map((row) => row.draftId).sort()).toEqual([
		'live',
		'retained'
	]);
	await trash.getByRole('button', { name: 'Vider la corbeille', exact: true }).click();
	const empty = page.getByRole('dialog', {
		name: 'Vider la corbeille (2 document(s)) ?',
		exact: true
	});
	await empty.getByRole('button', { name: 'Annuler', exact: true }).click();
	await expect(
		trash.getByRole('button', { name: 'Restaurer retained.md', exact: true })
	).toBeVisible();
	await trash.getByRole('button', { name: 'Vider la corbeille', exact: true }).click();
	await empty.getByRole('button', { name: 'Vider la corbeille', exact: true }).click();
	await expect(trash).toHaveCount(0);
	await expect(
		page.locator('aside').getByRole('button', { name: /^Bibliothèque de documents/ })
	).toBeFocused();
	await page.reload();
	await expect(page.locator('#app-toolbar input')).toHaveValue('live');
	const after = await storedState(page);
	expect(after.trash).toEqual([]);
	expect(after.drafts).toEqual(before.drafts);
	expect(after.links).toEqual(['live']);
	expect(after.versions.map((row) => row.draftId)).toEqual(['live']);
});

for (const operation of ['put', 'delete'] as const) {
	test(`a failed trash ${operation} rolls back the whole batch and allows retry`, async ({
		page
	}) => {
		await seedDocuments(
			page,
			[
				{ id: 'one', content: 'One', trashed: operation === 'delete' },
				{ id: 'two', content: 'Two', trashed: operation === 'delete' },
				{ id: 'keep', content: 'Keep' }
			],
			'keep'
		);
		const before = await storedState(page);
		const panel = operation === 'put' ? await openLibrary(page) : await openTrash(page);
		await panel.getByRole('checkbox', { name: 'Sélectionner one.md', exact: true }).check();
		await panel.getByRole('checkbox', { name: 'Sélectionner two.md', exact: true }).check();
		await failTrashWrite(page, operation);
		const confirmName =
			operation === 'put'
				? 'Supprimer 2 document(s) ?'
				: 'Supprimer définitivement 2 document(s) ?';
		const confirmLabel =
			operation === 'put' ? 'Supprimer la sélection' : 'Supprimer définitivement';
		await panel.getByRole('button', { name: 'Supprimer la sélection', exact: true }).click();
		await page
			.getByRole('dialog', { name: confirmName, exact: true })
			.getByRole('button', { name: confirmLabel, exact: true })
			.click();
		await expect(
			page.getByText('Une opération de stockage local a échoué.', { exact: true })
		).toBeVisible();
		await expect(
			panel.getByRole('button', { name: 'Supprimer la sélection', exact: true })
		).toBeEnabled();
		await expect(panel.getByRole('status').filter({ hasText: /document\(s\)/ })).toHaveText(
			'2 document(s) sélectionné(s)'
		);
		expect(await storedState(page)).toEqual(before);
		await panel.getByRole('button', { name: 'Supprimer la sélection', exact: true }).click();
		await page
			.getByRole('dialog', { name: confirmName, exact: true })
			.getByRole('button', { name: confirmLabel, exact: true })
			.click();
		await expect
			.poll(async () => (await storedState(page)).trash.length)
			.toBe(operation === 'put' ? 2 : 0);
		if (operation === 'put') {
			await expect(panel.getByRole('status').filter({ hasText: /document\(s\)/ })).toHaveText(
				'0 document(s) sélectionné(s)'
			);
		} else await expect(panel).toHaveCount(0);
		await page.reload();
		await expect(page.locator('#app-toolbar input')).toHaveValue('keep');
	});
}

test('bulk deletion keeps the latest edit before the 400 ms save and restores the same ID', async ({
	page
}) => {
	await seedDocuments(page, [{ id: 'pending', content: 'Before' }], 'pending');
	await expect(page.locator('.cm-content')).toBeVisible();
	await page.clock.pauseAt(new Date());
	await page.locator('.cm-content').click();
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.insertText('Latest edit before debounce');
	const library = await openLibrary(page);
	await library.getByRole('button', { name: 'Tout supprimer', exact: true }).click();
	await page
		.getByRole('dialog', { name: 'Supprimer les 1 document(s) de la bibliothèque ?', exact: true })
		.getByRole('button', { name: 'Tout supprimer', exact: true })
		.click();
	await expect(library.getByRole('heading')).toHaveText('Bibliothèque de documents (0)');
	await expect(library.getByRole('button', { name: 'Tout supprimer', exact: true })).toBeDisabled();
	await page.clock.runFor(600);
	await page.clock.resume();
	await page.reload();
	const trash = await openTrash(page);
	await trash.getByRole('button', { name: 'Restaurer pending.md', exact: true }).click();
	await expect(page.locator('.cm-content')).toContainText('Latest edit before debounce');
	await expect
		.poll(async () => (await storedState(page)).drafts)
		.toEqual([expect.objectContaining({ id: 'pending', content: 'Latest edit before debounce' })]);
});

test('a failed pending save blocks deletion and retry keeps the retained edit', async ({
	page
}) => {
	await seedDocuments(
		page,
		[
			{ id: 'remove-one', content: 'One' },
			{ id: 'remove-two', content: 'Two', open: false },
			{ id: 'keep', content: 'Before' }
		],
		'keep'
	);
	await expect(page.locator('.cm-content')).toBeVisible();
	await page.clock.pauseAt(new Date());
	await page.locator('.cm-content').click();
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.insertText('Retained pending edit');
	await page.evaluate(() => {
		const original = IDBObjectStore.prototype.put;
		IDBObjectStore.prototype.put = function (value, key) {
			if (this.name === 'drafts') {
				IDBObjectStore.prototype.put = original;
				throw new DOMException('Injected write failure', 'UnknownError');
			}
			return key === undefined ? original.call(this, value) : original.call(this, value, key);
		};
	});
	const library = await openLibrary(page);
	await library.getByRole('textbox').fill('remove-');
	await library
		.getByRole('checkbox', { name: 'Sélectionner tous les résultats', exact: true })
		.check();
	await library.getByRole('button', { name: 'Supprimer la sélection', exact: true }).click();
	const confirm = page.getByRole('dialog', { name: 'Supprimer 2 document(s) ?', exact: true });
	await confirm.getByRole('button', { name: 'Supprimer la sélection', exact: true }).click();
	const warning = page.getByRole('alert').filter({ hasText: 'keep.md:' });
	await expect(warning).toBeVisible();
	await expect(warning).toContainText('Échec de l’enregistrement local');
	const retry = warning.getByRole('button', { name: "Réessayer l'enregistrement", exact: true });
	await expect(retry).toBeVisible();
	await expect(retry).toBeEnabled();
	const selectionStatus = library.getByRole('status').filter({ hasText: /document\(s\)/ });
	await expect(selectionStatus).toHaveText('2 document(s) sélectionné(s)');
	const failed = await storedState(page);
	expect(failed.trash).toEqual([]);
	expect(failed.drafts).toHaveLength(3);
	expect(failed.drafts.find((row) => row.id === 'keep')?.content).toBe('Before');
	await library.getByRole('button', { name: 'Supprimer la sélection', exact: true }).click();
	await confirm.getByRole('button', { name: 'Supprimer la sélection', exact: true }).click();
	await expect(selectionStatus).toHaveText('0 document(s) sélectionné(s)');
	await expect(warning).toHaveCount(0);
	await page.clock.resume();
	await page.reload();
	await expect(page.locator('.cm-content')).toContainText('Retained pending edit');
	expect((await storedState(page)).drafts).toEqual([
		expect.objectContaining({ id: 'keep', content: 'Retained pending edit' })
	]);
});

test('English bulk controls and confirmations are localized', async ({ page }) => {
	await seedDocuments(page, [{ id: 'english', content: 'English' }], 'english');
	await page.evaluate(() => localStorage.setItem('mdsh:locale', 'en'));
	await page.reload();
	await page
		.locator('aside')
		.getByRole('button', { name: /^Document library/ })
		.click();
	const library = page.getByRole('dialog', { name: 'Document library', exact: true });
	await library.getByRole('checkbox', { name: 'Select english.md', exact: true }).check();
	await expect(library.getByRole('status').filter({ hasText: /document\(s\)/ })).toHaveText(
		'1 document(s) selected'
	);
	await library.getByRole('button', { name: 'Delete selected', exact: true }).click();
	const confirm = page.getByRole('dialog', { name: 'Delete 1 document(s)?', exact: true });
	await expect(confirm.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
	await confirm.getByRole('button', { name: 'Delete selected', exact: true }).click();
	await expect(library.getByRole('status').filter({ hasText: /document\(s\)/ })).toHaveText(
		'0 document(s) selected'
	);
	await page.keyboard.press('Escape');
	const trash = page
		.locator('aside details')
		.filter({ has: page.locator('summary', { hasText: /^Trash/ }) });
	await trash.locator('summary').click();
	await trash.getByRole('checkbox', { name: 'Select all trash documents', exact: true }).check();
	await expect(trash.getByRole('status')).toHaveText('1 document(s) selected');
	await trash.getByRole('button', { name: 'Empty trash', exact: true }).click();
	await page
		.getByRole('dialog', { name: 'Empty trash (1 document(s))?', exact: true })
		.getByRole('button', { name: 'Empty trash', exact: true })
		.click();
	await expect(trash).toHaveCount(0);
});

async function prepareRemoteBatch(page: Page, operation: 'delete' | 'empty') {
	if (operation === 'empty') {
		const trash = await openTrash(page);
		await trash.getByRole('button', { name: 'Vider la corbeille', exact: true }).click();
		return page
			.getByRole('dialog', { name: 'Vider la corbeille (2 document(s)) ?', exact: true })
			.getByRole('button', { name: 'Vider la corbeille', exact: true });
	}
	const library = await openLibrary(page);
	await library.getByRole('checkbox', { name: 'Sélectionner remove-one.md', exact: true }).check();
	await library.getByRole('checkbox', { name: 'Sélectionner remove-two.md', exact: true }).check();
	await library.getByRole('button', { name: 'Supprimer la sélection', exact: true }).click();
	return page
		.getByRole('dialog', { name: 'Supprimer 2 document(s) ?', exact: true })
		.getByRole('button', { name: 'Supprimer la sélection', exact: true });
}

for (const operation of ['delete', 'empty'] as const) {
	test(`cross-tab ${operation} captures a visual edit before the editor debounce`, async ({
		page,
		context
	}, testInfo) => {
		const latest = 'Receiver edit before the editor debounce';
		await seedDocuments(
			page,
			[
				{ id: 'sender', content: 'Sender view\n' },
				{ id: 'receiver', content: 'Receiver base\n' },
				{ id: 'remove-one', content: 'One\n', open: false, trashed: operation === 'empty' },
				{ id: 'remove-two', content: 'Two\n', open: false, trashed: operation === 'empty' }
			],
			'sender'
		);
		const receiver = await context.newPage();
		await receiver.goto('/');
		await receiver.locator('aside button[data-file-id="receiver"]').click();
		await receiver.locator('button[data-mode="wysiwyg"]').click();
		const editor = receiver.locator('.ProseMirror');
		await expect(editor).toHaveText('Receiver base');
		await expect(receiver.locator('#app-statusbar')).toContainText('Brouillons locaux :');
		await page.locator('aside button[data-file-id="sender"]').click();
		const confirm = await prepareRemoteBatch(page, operation);

		// Pause the context before the edit to stop Milkdown's 200 ms report and the 400 ms save timer.
		await receiver.clock.pauseAt(new Date());
		await editor.click();
		await receiver.keyboard.press('ControlOrMeta+a');
		await receiver.keyboard.insertText(latest);
		await expect(editor).toHaveText(latest);
		await expect(receiver.locator('#app-statusbar')).toContainText('Brouillons locaux :');
		const beforeBroadcast = await storedState(receiver);
		expect(beforeBroadcast.drafts.find((row) => row.id === 'receiver')?.content).toBe(
			'Receiver base\n'
		);

		// The sender performs a real batch. Its BroadcastChannel message must capture the edit.
		await confirm.click();
		await expect(
			receiver.getByText('Des modifications ont été faites dans un autre onglet.', { exact: true })
		).toBeVisible();
		await expect(receiver.locator('#app-toolbar input')).toHaveValue('receiver');
		await expect(editor).toHaveText(latest);
		await expect(receiver.locator('#app-statusbar')).toContainText('enregistrement…');
		expect((await storedState(receiver)).drafts.find((row) => row.id === 'receiver')?.content).toBe(
			'Receiver base\n'
		);

		await receiver
			.getByRole('button', { name: 'Recharger depuis le stockage', exact: true })
			.click();
		await expect
			.poll(
				async () =>
					(await storedState(receiver)).drafts.find((row) => row.id === 'receiver')?.content
			)
			.toBe(`${latest}\n`);
		await expect(receiver.locator('#app-toolbar input')).toHaveValue('receiver');
		await expect(editor).toHaveText(latest);
		await expect(
			receiver
				.locator('aside')
				.getByRole('button', { name: 'Bibliothèque de documents (2)', exact: true })
		).toBeVisible();
		await receiver.clock.runFor(1000);
		await receiver.clock.resume();
		await receiver.reload();
		await receiver.locator('aside button[data-file-id="receiver"]').click();
		await expect(editor).toHaveText(latest);
		const afterReload = await storedState(receiver);
		expect(afterReload.drafts.map((row) => row.id)).toEqual(['receiver', 'sender']);
		expect(afterReload.drafts.find((row) => row.id === 'receiver')?.content).toBe(`${latest}\n`);
		expect(afterReload.trash).toHaveLength(operation === 'delete' ? 2 : 0);
		await testInfo.attach('cross-tab-editor-durability.json', {
			contentType: 'application/json',
			body: JSON.stringify({ operation, beforeBroadcast, afterReload }, null, 2)
		});
	});

	test(`cross-tab ${operation} keeps the receiving view until its document is removed`, async ({
		page,
		context
	}, testInfo) => {
		await seedDocuments(
			page,
			[
				{ id: 'sender', content: 'Sender view\n' },
				{ id: 'receiver', content: 'Receiver view\n' },
				{ id: 'remove-one', content: 'One\n', open: false, trashed: operation === 'empty' },
				{ id: 'remove-two', content: 'Two\n', open: false, trashed: operation === 'empty' }
			],
			'sender'
		);
		const receiver = await context.newPage();
		await receiver.goto('/');
		await receiver.locator('aside button[data-file-id="receiver"]').click();
		await expect(receiver.locator('#app-toolbar input')).toHaveValue('receiver');
		await expect(receiver.locator('.cm-content')).toContainText('Receiver view');
		await page.locator('aside button[data-file-id="sender"]').click();
		expect(await receiver.evaluate(() => localStorage.getItem('mdsh:activeId'))).toBe('sender');
		const confirm = await prepareRemoteBatch(page, operation);
		await confirm.click();
		if (operation === 'delete') {
			await expect(
				receiver
					.locator('aside')
					.getByRole('button', { name: 'Bibliothèque de documents (2)', exact: true })
			).toBeVisible();
		} else {
			await expect(receiver.locator('aside summary').filter({ hasText: /^Corbeille/ })).toHaveCount(
				0
			);
		}
		await expect(receiver.locator('#app-toolbar input')).toHaveValue('receiver');
		await expect(receiver.locator('.cm-content')).toContainText('Receiver view');
		await expect(
			receiver.getByRole('button', { name: 'Recharger depuis le stockage', exact: true })
		).toHaveCount(0);
		const retainedView = {
			localActive: await receiver.locator('#app-toolbar input').inputValue(),
			sharedActive: await receiver.evaluate(() => localStorage.getItem('mdsh:activeId')),
			storage: await storedState(receiver)
		};
		expect(retainedView.sharedActive).toBe('sender');

		if (operation === 'delete') await page.keyboard.press('Escape');
		const library = await openLibrary(page);
		await library.getByRole('checkbox', { name: 'Sélectionner receiver.md', exact: true }).check();
		await library.getByRole('button', { name: 'Supprimer la sélection', exact: true }).click();
		await page
			.getByRole('dialog', { name: 'Supprimer 1 document(s) ?', exact: true })
			.getByRole('button', { name: 'Supprimer la sélection', exact: true })
			.click();
		await expect(receiver.locator('aside button[data-file-id]')).toHaveCount(1);
		await expect(receiver.locator('#app-toolbar input')).toHaveValue('sender');
		await expect(receiver.locator('.cm-content')).toContainText('Sender view');
		const afterRemoval = await storedState(receiver);
		expect(afterRemoval.drafts.map((row) => row.id)).toEqual(['sender']);
		await testInfo.attach('cross-tab-active-view.json', {
			contentType: 'application/json',
			body: JSON.stringify({ operation, retainedView, afterRemoval }, null, 2)
		});
	});
}

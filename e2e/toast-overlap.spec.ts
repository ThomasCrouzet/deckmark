import { expect, test, type Locator, type Page } from '@playwright/test';
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

const words = {
	en: {
		library: 'Document library',
		all: 'Select all results',
		remove: 'Delete selected',
		confirm: 'Delete 2 document(s)?',
		selected: '2 document(s) selected',
		none: '0 document(s) selected',
		retry: 'Retry saving',
		dismiss: 'Close notification',
		failed: 'Local save failed'
	},
	fr: {
		library: 'Bibliothèque de documents',
		all: 'Sélectionner tous les résultats',
		remove: 'Supprimer la sélection',
		confirm: 'Supprimer 2 document(s) ?',
		selected: '2 document(s) sélectionné(s)',
		none: '0 document(s) sélectionné(s)',
		retry: "Réessayer l'enregistrement",
		dismiss: 'Fermer la notification',
		failed: 'Échec de l’enregistrement local'
	}
};

async function tabTo(page: Page, target: Locator) {
	for (let step = 0; step < 40; step++) {
		if (await target.evaluate((node) => node === document.activeElement)) return;
		await page.keyboard.press('Tab');
	}
	await expect(target).toBeFocused();
}

async function reachable(target: Locator) {
	await target.scrollIntoViewIfNeeded();
	await expect(target).toBeInViewport({ ratio: 1 });
	expect(
		await target.evaluate((node) => {
			const rect = node.getBoundingClientRect();
			return node.contains(
				document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
			);
		})
	).toBe(true);
}

test.afterEach(async ({ page }, info) => {
	await info.attach('final-screen.png', {
		body: await page.screenshot({ animations: 'disabled' }),
		contentType: 'image/png'
	});
	await info.attach('final-aria.txt', {
		body: await page.locator('body').ariaSnapshot(),
		contentType: 'text/plain'
	});
	await info.attach('durable-state.json', {
		body: JSON.stringify(await storedState(page)),
		contentType: 'application/json'
	});
});

for (const locale of ['en', 'fr'] as const) {
	for (const width of [320, 1280]) {
		for (const input of ['pointer', 'keyboard']) {
			test(`${locale} ${width} ${input}: persistent warning leaves delete and recovery controls reachable`, async ({
				page
			}, info) => {
				const text = words[locale];
				await resetAppState(page);
				await page.evaluate((value) => localStorage.setItem('mdsh:locale', value), locale);
				await seedDocuments(
					page,
					[
						{ id: 'remove-one', content: 'One' },
						{ id: 'remove-two', content: 'Two', open: false },
						{ id: 'keep-other', content: 'Other before' },
						{ id: 'keep', content: 'Before' }
					],
					'keep-other'
				);
				await page.clock.pauseAt(new Date());
				await page.locator('.cm-content').click();
				await page.keyboard.press('ControlOrMeta+a');
				await page.keyboard.insertText('Other retained edit');
				await page.locator('aside button[data-file-id="keep"]').click();
				await expect(page.locator('.cm-content')).toHaveText('Before');
				await page.locator('.cm-content').click();
				await page.keyboard.press('ControlOrMeta+a');
				await page.keyboard.insertText('Retained pending edit');
				await page.evaluate(() => {
					const original = IDBObjectStore.prototype.put;
					const pendingFailures = new Set(['keep', 'keep-other']);
					IDBObjectStore.prototype.put = function (value, key) {
						if (this.name === 'drafts' && pendingFailures.delete(value.id)) {
							if (pendingFailures.size === 0) IDBObjectStore.prototype.put = original;
							throw new DOMException('Injected write failure', 'UnknownError');
						}
						return key === undefined ? original.call(this, value) : original.call(this, value, key);
					};
				});
				await page
					.locator('aside')
					.getByRole('button', { name: new RegExp(`^${text.library}`) })
					.click();
				await page.setViewportSize({ width, height: 844 });
				const library = page.getByRole('dialog', { name: text.library, exact: true });
				const selectionStatus = library.getByRole('status').filter({ hasText: /document\(s\)/ });
				await library.getByRole('textbox').fill('remove-');
				await library.getByRole('checkbox', { name: text.all, exact: true }).check();
				const remove = library.getByRole('button', { name: text.remove, exact: true });
				await remove.click();
				const confirm = page.getByRole('dialog', { name: text.confirm, exact: true });
				await confirm.getByRole('button', { name: text.remove, exact: true }).click();
				const warning = page.getByRole('alert').filter({ hasText: 'keep.md:' });
				await expect(warning).toHaveCount(1);
				await expect(warning).toContainText(text.failed);
				const otherWarning = page.getByRole('alert').filter({ hasText: 'keep-other.md:' });
				await expect(otherWarning).toHaveCount(1);
				await expect(otherWarning).toContainText(text.failed);
				const retry = warning.getByRole('button', { name: text.retry, exact: true });
				const dismiss = warning.getByRole('button', { name: text.dismiss, exact: true });
				await expect(retry).toBeEnabled();
				await expect(dismiss).toBeEnabled();
				await expect(selectionStatus).toHaveText(text.selected);
				const failed = await storedState(page);
				expect(failed.trash).toEqual([]);
				expect(failed.drafts).toHaveLength(4);
				expect(failed.drafts.find((row) => row.id === 'keep')?.content).toBe('Before');
				expect(failed.drafts.find((row) => row.id === 'keep-other')?.content).toBe('Other before');
				await info.attach('library-list-before.json', {
					body: JSON.stringify(
						await library.locator('ul').evaluate((list) => ({
							clientHeight: list.clientHeight,
							scrollHeight: list.scrollHeight,
							bounds: list.getBoundingClientRect().toJSON()
						}))
					),
					contentType: 'application/json'
				});
				const row = (name: string) =>
					library.getByRole('checkbox', {
						name: `${locale === 'en' ? 'Select' : 'Sélectionner'} ${name}.md`,
						exact: true
					});
				const all = library.getByRole('checkbox', { name: text.all, exact: true });
				const toggle = async (control: Locator) => {
					if (input === 'keyboard') {
						await tabTo(page, control);
						await reachable(control);
						await page.keyboard.press('Space');
					} else await control.click();
				};
				await toggle(row('remove-one'));
				await expect(row('remove-one')).not.toBeChecked();
				await expect(row('remove-two')).toBeChecked();
				await expect(selectionStatus).toHaveText(text.selected.replace('2', '1'));
				await info.attach('library-row-reachable.png', {
					body: await page.screenshot({ animations: 'disabled' }),
					contentType: 'image/png'
				});
				await toggle(all);
				await expect(row('remove-one')).toBeChecked();
				await expect(selectionStatus).toHaveText(text.selected);
				await toggle(row('remove-two'));
				await expect(row('remove-two')).not.toBeChecked();
				await expect(row('remove-one')).toBeChecked();
				await expect(selectionStatus).toHaveText(text.selected.replace('2', '1'));
				await toggle(all);
				await expect(selectionStatus).toHaveText(text.selected);
				await toggle(all);
				await expect(selectionStatus).toHaveText(text.none);
				await expect(row('remove-one')).not.toBeChecked();
				await expect(row('remove-two')).not.toBeChecked();
				await expect(remove).toBeDisabled();
				await toggle(all);
				await expect(row('remove-one')).toBeChecked();
				await expect(row('remove-two')).toBeChecked();
				await expect(selectionStatus).toHaveText(text.selected);
				expect(await storedState(page)).toEqual(failed);
				await expect(warning).toHaveCount(1);
				await expect(otherWarning).toHaveCount(1);
				await info.attach('persistent-warning.png', {
					body: await page.screenshot({ animations: 'disabled' }),
					contentType: 'image/png'
				});
				await info.attach('persistent-warning.json', {
					body: JSON.stringify({
						warning: await warning.boundingBox(),
						remove: await remove.boundingBox(),
						retry: await retry.boundingBox(),
						dismiss: await dismiss.boundingBox()
					}),
					contentType: 'application/json'
				});
				if (input === 'keyboard') {
					await tabTo(page, retry);
					await tabTo(page, dismiss);
					await tabTo(page, remove);
				} else {
					await reachable(retry);
					await reachable(dismiss);
					await reachable(remove);
				}
				await expect(warning).toBeVisible();
				// Do not retry or dismiss the warning before the next delete attempt.
				if (input === 'keyboard') await page.keyboard.press('Enter');
				else await remove.click();
				await expect(confirm).toBeVisible();
				await expect(warning).toHaveCount(1);
				await expect(warning).toBeVisible();
				await info.attach('confirmation-warning.png', {
					body: await page.screenshot({ animations: 'disabled' }),
					contentType: 'image/png'
				});
				const confirmRemove = confirm.getByRole('button', { name: text.remove, exact: true });
				if (input === 'keyboard') {
					await tabTo(page, retry);
					await tabTo(page, dismiss);
					await tabTo(page, confirmRemove);
					await page.keyboard.press('Enter');
				} else {
					await reachable(retry);
					await reachable(dismiss);
					await reachable(confirmRemove);
					await confirmRemove.click();
				}
				await expect(selectionStatus).toHaveText(text.none);
				await expect(warning).toHaveCount(0);
				await expect(otherWarning).toHaveCount(0);
				await page.clock.resume();
				await page.reload();
				await expect(page.locator('.cm-content')).toContainText('Retained pending edit');
				expect((await storedState(page)).drafts).toEqual([
					expect.objectContaining({ id: 'keep', content: 'Retained pending edit' }),
					expect.objectContaining({ id: 'keep-other', content: 'Other retained edit' })
				]);
			});
		}
	}
}

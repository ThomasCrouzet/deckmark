import { expect, test, type Page } from '@playwright/test';
import { createFirstFile, resetAppState, writeSourceContent } from './helpers';

async function rows(page: Page) {
	return page.evaluate(
		() =>
			new Promise<Array<{ id: string; name: string; content: string; open?: boolean }>>(
				(resolve, reject) => {
					const request = indexedDB.open('mdsh');
					request.onerror = () => reject(request.error);
					request.onsuccess = () => {
						const database = request.result;
						const tx = database.transaction('drafts');
						const get = tx.objectStore('drafts').getAll();
						tx.oncomplete = () => {
							database.close();
							resolve(get.result);
						};
						tx.onabort = () => reject(tx.error);
					};
				}
			)
	);
}

test.afterEach(async ({ page, browser }, info) => {
	await info.attach('revision-evidence.json', {
		body: JSON.stringify(
			{ ...info.config.metadata, browser: browser.version(), rows: await rows(page) },
			null,
			2
		),
		contentType: 'application/json'
	});
});

test('the first close snapshot includes the final visual input', async ({ page }, info) => {
	await resetAppState(page);
	await createFirstFile(page);
	await writeSourceContent(page, 'Retained baseline.\n');
	await page.locator('button[data-mode="wysiwyg"]').click();
	const visual = page.locator('.ProseMirror');
	await expect(visual).toHaveText('Retained baseline.');
	await visual.click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.evaluate(() => {
		const snapshots: string[] = [];
		Object.assign(window, { closeSnapshots: snapshots });
		const put = IDBObjectStore.prototype.put;
		IDBObjectStore.prototype.put = function (value, key) {
			if (this.name === 'drafts' && value.open === false) snapshots.push(value.content);
			return key === undefined ? put.call(this, value) : put.call(this, value, key);
		};
		document.querySelector('.ProseMirror')!.addEventListener(
			'input',
			() => {
				queueMicrotask(() => {
					document
						.querySelector<HTMLButtonElement>('aside li button[aria-label^="Fermer "]')!
						.click();
				});
			},
			{ once: true }
		);
	});
	await page.keyboard.insertText('Z');
	await expect.poll(async () => (await rows(page))[0]?.open).toBe(false);
	const snapshots = await page.evaluate(
		() => (window as unknown as { closeSnapshots: string[] }).closeSnapshots
	);
	await info.attach('close-snapshots.json', {
		body: JSON.stringify(snapshots),
		contentType: 'application/json'
	});
	expect(snapshots.length).toBeGreaterThan(0);
	expect(snapshots[0]).toContain('Retained baseline.Z');
	await expect.poll(async () => (await rows(page))[0]?.content).toContain('Retained baseline.Z');
	await page.reload();
	expect((await rows(page))[0]?.content).toContain('Retained baseline.Z');
});

test('source mode barriers retain exact bytes and undo after immediate switches', async ({
	page
}) => {
	await resetAppState(page);
	await createFirstFile(page);
	const initial = '\uFEFF---\r\ntitle: Revision note\r\n---\r\n\r\nSource bytes.\r\n';
	await page.evaluate(async (content) => {
		await new Promise<void>((resolve, reject) => {
			const request = indexedDB.open('mdsh');
			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				const database = request.result;
				const tx = database.transaction('drafts', 'readwrite');
				const store = tx.objectStore('drafts');
				const get = store.getAll();
				get.onsuccess = () => store.put({ ...get.result[0], content });
				tx.oncomplete = () => {
					database.close();
					resolve();
				};
				tx.onabort = () => reject(tx.error);
			};
		});
	}, initial);
	await page.reload();
	await page.locator('[data-mode="source"]').click();
	const source = page.locator('.cm-content');
	await source.focus();
	await page.keyboard.press('ControlOrMeta+End');
	await page.evaluate(() => {
		document
			.querySelector('.cm-content')!
			.addEventListener(
				'input',
				() =>
					queueMicrotask(() =>
						document.querySelector<HTMLButtonElement>('[data-mode="read"]')!.click()
					),
				{ once: true }
			);
	});
	await page.keyboard.insertText('Z');
	await expect(page.locator('.mdsh-read')).toBeVisible();
	await page.locator('[data-mode="source"]').click();
	await expect(source).toBeVisible();
	await source.focus();
	await page.keyboard.insertText('Y');
	await expect.poll(async () => (await rows(page))[0]?.content).toBe(`${initial}ZY`);
	await page.keyboard.press('ControlOrMeta+z');
	await expect.poll(async () => (await rows(page))[0]?.content).toBe(`${initial}Z`);
	await page.reload();
	expect((await rows(page))[0]?.content).toBe(`${initial}Z`);
});

test('a cancelled outgoing capture keeps the view and permits a close retry', async ({ page }) => {
	await resetAppState(page);
	await createFirstFile(page);
	await writeSourceContent(page, 'Recoverable baseline.\n');
	await page.locator('[data-mode="wysiwyg"]').click();
	const visual = page.locator('.ProseMirror');
	await expect(visual).toHaveText('Recoverable baseline.');
	await visual.click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.evaluate(() => {
		window.addEventListener('mdsh:flush-editor', (event) => event.preventDefault(), { once: true });
		document
			.querySelector('.ProseMirror')!
			.addEventListener(
				'input',
				() =>
					queueMicrotask(() =>
						document
							.querySelector<HTMLButtonElement>('aside li button[aria-label^="Fermer "]')!
							.click()
					),
				{ once: true }
			);
	});
	await page.keyboard.insertText('Z');
	await expect(visual).toHaveText('Recoverable baseline.Z');
	await expect(page.getByRole('alert').first()).toBeVisible();
	expect((await rows(page))[0]?.open).not.toBe(false);
	await page.locator('aside li button[aria-label^="Fermer "]').click({ force: true });
	await expect.poll(async () => (await rows(page))[0]?.open).toBe(false);
	expect((await rows(page))[0]?.content).toContain('Recoverable baseline.Z');
});

import { expect, test, type Page } from '@playwright/test';
import { createFirstFile, renameActiveFile, resetAppState } from './helpers';

const retryLabel = "Réessayer l'enregistrement";
const names = ['Recovery Alpha.md', 'Recovery Beta.md'];
const contents = ['Alpha pending durable content', 'Beta pending durable content'];

interface SaveEvent {
	type: string;
	id?: string;
	at: number;
}

declare global {
	interface Window {
		saveRecoveryReview: { blocked: string[]; events: SaveEvent[] };
	}
}

async function drafts(page: Page): Promise<Array<{ id: string; name: string; content: string }>> {
	return page.evaluate(async () => {
		const database = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open('mdsh');
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		try {
			return await new Promise((resolve, reject) => {
				const tx = database.transaction('drafts');
				const request = tx.objectStore('drafts').getAll();
				tx.oncomplete = () => resolve(request.result);
				tx.onabort = () => reject(tx.error);
			});
		} finally {
			database.close();
		}
	});
}

async function prepare(page: Page, count = 1) {
	await resetAppState(page);
	await createFirstFile(page);
	await renameActiveFile(page, names[0]!);
	if (count === 2) {
		await page.locator('aside button[aria-label^="Nouveau fichier"]').click();
		await page.getByTestId('create-note').click();
		await renameActiveFile(page, names[1]!);
	}
	await expect
		.poll(async () => (await drafts(page)).map((row) => row.name).sort())
		.toEqual(names.slice(0, count));
	const rows = await drafts(page);
	// New notes open in Edit mode; this suite drives the CodeMirror source editor.
	await page.locator('button[data-mode="source"]').click();
	await expect(page.locator('.cm-content').first()).toBeVisible({ timeout: 10_000 });
	await page.evaluate(() => {
		window.saveRecoveryReview = { blocked: [], events: [] };
		const put = IDBObjectStore.prototype.put;
		IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
			const request = put.apply(this, args);
			if (this.name === 'drafts') {
				const id = (args[0] as { id: string }).id;
				const record = (type: string) =>
					window.saveRecoveryReview.events.push({ type, id, at: performance.now() });
				if (window.saveRecoveryReview.blocked.includes(id)) {
					record('draft-write-aborted');
					this.transaction.abort();
				} else {
					this.transaction.addEventListener('complete', () => record('draft-write-committed'), {
						once: true
					});
				}
			}
			return request;
		};
	});
	return rows;
}

async function select(page: Page, name: string) {
	const label = name.replace(/\.md$/, '');
	await page.locator('aside li button').filter({ hasText: label }).click();
	await expect(page.locator('input[aria-label^="Nom du fichier"]')).toHaveValue(label);
}

async function block(page: Page, ids: string[]) {
	await page.evaluate((ids) => {
		window.saveRecoveryReview.blocked = ids;
	}, ids);
}

async function abortedWrites(page: Page, id: string) {
	return page.evaluate(
		(id) =>
			window.saveRecoveryReview.events.filter(
				(event) => event.type === 'draft-write-aborted' && event.id === id
			).length,
		id
	);
}

async function retryWarningWhileBlocked(page: Page, draft: { id: string; name: string }) {
	const warning = page.getByRole('alert').filter({ hasText: draft.name });
	const before = await abortedWrites(page, draft.id);
	await warning.getByRole('button', { name: retryLabel }).click();
	await expect.poll(() => abortedWrites(page, draft.id)).toBeGreaterThan(before);
	await checkpoint(page, 'warning-retry-still-fails');
	await expect(warning).toBeVisible({ timeout: 1000 });
	await expect(warning.getByRole('button', { name: retryLabel })).toBeVisible();
	await expect(page.locator('footer')).toContainText('Non enregistré localement');
}

async function checkpoint(page: Page, name: string) {
	await test.info().attach(`${name}.json`, {
		body: JSON.stringify(
			{
				...test.info().config.metadata,
				fixture: {
					names,
					contents,
					failure: 'Abort the real draft write transaction at IDBObjectStore.put'
				},
				state: await page.evaluate(() => ({
					...window.saveRecoveryReview,
					alerts: [...document.querySelectorAll('[role="alert"]')].map((node) => node.textContent),
					footer: document.querySelector('footer')?.textContent
				})),
				drafts: await drafts(page)
			},
			null,
			2
		),
		contentType: 'application/json'
	});
}

test.afterEach(async ({ page, browser }, info) => {
	await info.attach('browser.json', {
		body: JSON.stringify({ browser: browser.version(), status: info.status }),
		contentType: 'application/json'
	});
	if (!page.isClosed()) await checkpoint(page, 'final-state');
});

test('footer retry clears the recovered draft warning before its old timer expires', async ({
	page
}) => {
	const [original] = await prepare(page);
	await block(page, [original!.id]);
	await page.locator('.cm-content').fill(contents[0]!);
	await expect(page.locator('footer')).toContainText('Non enregistré localement');
	const warning = page.getByRole('alert').filter({ hasText: /Échec de l’enregistrement local/ });
	await expect(warning).toBeVisible();
	expect((await drafts(page))[0]!.content).not.toBe(contents[0]);
	await checkpoint(page, 'failed-write');
	await block(page, []);
	await page.locator('footer').getByRole('button', { name: retryLabel }).click();
	await expect
		.poll(async () => (await drafts(page)).find((row) => row.id === original!.id)?.content)
		.toBe(contents[0]);
	await expect(page.locator('footer')).not.toContainText('Non enregistré localement');
	await checkpoint(page, 'recovered-write');
	await expect(warning).toHaveCount(0, { timeout: 1000 });
	await page.reload();
	await expect(page.locator('.cm-content')).toHaveText(contents[0]!);
});

test('file switches and partial retries preserve other draft warnings', async ({ page }) => {
	const rows = await prepare(page, 2);
	const alpha = rows.find((row) => row.name === names[0])!;
	const beta = rows.find((row) => row.name === names[1])!;
	await select(page, alpha.name);
	await block(page, [alpha.id]);
	await page.locator('.cm-content').fill(contents[0]!);
	await expect(page.locator('footer')).toContainText('Non enregistré localement');
	const warningA = page.getByRole('alert').filter({ hasText: alpha.name });
	await select(page, beta.name);
	await page.locator('.cm-content').fill('Beta successful independent save');
	await expect
		.poll(async () => (await drafts(page)).find((row) => row.id === beta.id)?.content)
		.toBe('Beta successful independent save');
	await checkpoint(page, 'switched-with-unresolved-failure');
	await expect(warningA).toBeVisible({ timeout: 1000 });
	await block(page, [alpha.id, beta.id]);
	await page.locator('.cm-content').fill(contents[1]!);
	const warningB = page.getByRole('alert').filter({ hasText: beta.name });
	await expect(warningB).toBeVisible();
	await expect(page.getByRole('alert')).toHaveCount(2);
	await retryWarningWhileBlocked(page, beta);
	await expect(warningA).toBeVisible();
	await expect(page.getByRole('alert')).toHaveCount(2);
	expect((await drafts(page)).find((row) => row.id === beta.id)?.content).toBe(
		'Beta successful independent save'
	);
	// An unsuccessful footer retry must not add an unowned aggregate warning.
	const beforeFooterRetry = await abortedWrites(page, beta.id);
	await page.locator('footer').getByRole('button', { name: retryLabel }).click();
	await expect.poll(() => abortedWrites(page, beta.id)).toBeGreaterThan(beforeFooterRetry);
	await checkpoint(page, 'retry-still-fails');
	await expect(page.getByRole('alert')).toHaveCount(2);
	await block(page, [beta.id]);
	await page.locator('footer').getByRole('button', { name: retryLabel }).click();
	await expect
		.poll(async () => (await drafts(page)).find((row) => row.id === alpha.id)?.content)
		.toBe(contents[0]);
	await expect(warningA).toHaveCount(0, { timeout: 1000 });
	await expect(warningB).toBeVisible();
	await expect(page.getByRole('alert')).toHaveCount(1);
	await expect(page.locator('footer')).toContainText('Non enregistré localement');
	await checkpoint(page, 'partial-recovery');
	await select(page, alpha.name);
	await expect(warningB).toBeVisible();
	await retryWarningWhileBlocked(page, beta);
	await expect(page.getByRole('alert')).toHaveCount(1);
	await block(page, []);
	await warningB.getByRole('button', { name: retryLabel }).click();
	await expect
		.poll(async () => (await drafts(page)).find((row) => row.id === beta.id)?.content)
		.toBe(contents[1]);
	await expect(page.getByRole('alert')).toHaveCount(0, { timeout: 1000 });
	await expect(page.locator('input[aria-label^="Nom du fichier"]')).toHaveValue(
		alpha.name.replace(/\.md$/, '')
	);
	await checkpoint(page, 'all-recovered');
	await page.reload();
	await expect(page.locator('.cm-content')).toHaveText(contents[0]!);
	await select(page, beta.name);
	await expect(page.locator('.cm-content')).toHaveText(contents[1]!);
});

test('manual dismissal allows one warning to return after another failed save', async ({
	page
}) => {
	const [original] = await prepare(page);
	await block(page, [original!.id]);
	await page.locator('.cm-content').fill(contents[0]!);
	const warning = page.getByRole('alert').filter({ hasText: original!.name });
	await expect(warning).toBeVisible();
	await warning.getByRole('button', { name: 'Fermer la notification' }).click();
	await expect(warning).toHaveCount(0);
	await expect(page.locator('footer')).toContainText('Non enregistré localement');
	const before = await abortedWrites(page, original!.id);
	const updated = contents[0] + ' after dismissal';
	await page.locator('.cm-content').fill(updated);
	await expect.poll(() => abortedWrites(page, original!.id)).toBeGreaterThan(before);
	await checkpoint(page, 'failure-after-manual-dismissal');
	await expect(warning).toBeVisible({ timeout: 1000 });
	await retryWarningWhileBlocked(page, original!);
	await expect(page.getByRole('alert')).toHaveCount(1);
	await block(page, []);
	await warning.getByRole('button', { name: retryLabel }).click();
	await expect
		.poll(async () => (await drafts(page)).find((row) => row.id === original!.id)?.content)
		.toBe(updated);
	await expect(warning).toHaveCount(0, { timeout: 1000 });
	await checkpoint(page, 'manual-dismissal-recovered');
	await page.reload();
	await expect(page.locator('.cm-content')).toHaveText(updated);
});

test('existing cross-tab toast action still dismisses its own notification', async ({ page }) => {
	const [original] = await prepare(page);
	await block(page, [original!.id]);
	await page.locator('.cm-content').fill(contents[0]!);
	const warning = page.getByRole('alert').filter({ hasText: original!.name });
	await expect(warning).toBeVisible();
	await page.evaluate((id) => {
		const channel = new BroadcastChannel('mdsh');
		channel.postMessage({ type: 'draft-written', id, updatedAt: Date.now() });
		channel.close();
	}, original!.id);
	const reload = page.getByRole('button', { name: 'Recharger depuis le stockage', exact: true });
	await expect(reload).toBeVisible();
	const before = await abortedWrites(page, original!.id);
	await reload.click();
	await expect(reload).toHaveCount(0);
	await expect.poll(() => abortedWrites(page, original!.id)).toBeGreaterThan(before);
	await expect(warning).toBeVisible();
	await expect(page.getByRole('alert')).toHaveCount(1);
	await checkpoint(page, 'default-action-dismissal');
	await block(page, []);
	await warning.getByRole('button', { name: retryLabel }).click();
	await expect
		.poll(async () => (await drafts(page)).find((row) => row.id === original!.id)?.content)
		.toBe(contents[0]);
	await expect(warning).toHaveCount(0, { timeout: 1000 });
});

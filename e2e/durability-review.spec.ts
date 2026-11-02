import { expect, test, type Page } from '@playwright/test';
import { createFirstFile, resetAppState, writeSourceContent } from './helpers';

const baseline = 'Baseline retained.\n';
const remote = 'Remote branch retained.\n';
const localToken = ' FINAL-LOCAL-INPUT';

interface ReviewEvent {
	type: string;
	at: number;
	content?: string;
}

declare global {
	interface Window {
		durabilityReview: {
			events: ReviewEvent[];
			release: boolean;
		};
	}
}

async function storedState(page: Page) {
	return page.evaluate(async () => {
		const database = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open('mdsh');
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		try {
			return await new Promise<{
				drafts: Array<{ id: string; name: string; content: string; open?: boolean }>;
				trash: Array<{ id: string; file: { content: string } }>;
				versions: Array<{ draftId: string; content: string }>;
			}>((resolve, reject) => {
				const tx = database.transaction(['drafts', 'trashed', 'versions']);
				const drafts = tx.objectStore('drafts').getAll();
				const trash = tx.objectStore('trashed').getAll();
				const versions = tx.objectStore('versions').getAll();
				tx.oncomplete = () =>
					resolve({ drafts: drafts.result, trash: trash.result, versions: versions.result });
				tx.onabort = () => reject(tx.error);
			});
		} finally {
			database.close();
		}
	});
}

async function prepareVisualNote(page: Page) {
	await resetAppState(page);
	await createFirstFile(page);
	await writeSourceContent(page, baseline);
	await page.locator('button[data-mode="wysiwyg"]').click();
	await expect(page.locator('.ProseMirror')).toHaveText(baseline.trim());
	await page.evaluate(() => {
		window.durabilityReview = { events: [], release: false };
		window.addEventListener('mdsh:flush-editor', () => {
			window.durabilityReview.events.push({ type: 'editor-flush', at: performance.now() });
		});
	});
	const before = await storedState(page);
	expect(before.drafts).toHaveLength(1);
	return before.drafts[0]!;
}

async function focusEnd(page: Page) {
	await page.locator('.ProseMirror').click();
	await page.keyboard.press('ControlOrMeta+End');
}

// Run the visible delete and confirmation handlers in the input task. This keeps
// browser automation latency outside the 200 ms Milkdown notification window.
async function armImmediateDelete(page: Page, abortTrash = false) {
	await page.locator('aside summary').filter({ hasText: 'Actions du document' }).click();
	await focusEnd(page);
	await page.evaluate((abortTrash) => {
		const record = (type: string, content?: string) =>
			window.durabilityReview.events.push({ type, at: performance.now(), content });
		if (abortTrash) {
			const put = IDBObjectStore.prototype.put;
			IDBObjectStore.prototype.put = function (value, key) {
				const request = key === undefined ? put.call(this, value) : put.call(this, value, key);
				if (this.name === 'trashed') {
					IDBObjectStore.prototype.put = put;
					record('trash-transaction-abort');
					this.transaction.abort();
				}
				return request;
			};
		}
		const observer = new MutationObserver(() => {
			const confirm = document.querySelector<HTMLButtonElement>(
				'[aria-labelledby="prompt-modal-title"] button.border-danger'
			);
			if (!confirm) return;
			observer.disconnect();
			record('delete-confirm');
			confirm.click();
		});
		observer.observe(document.body, { childList: true, subtree: true });
		document.querySelector('.ProseMirror')!.addEventListener(
			'input',
			(event) => {
				record(
					event.isTrusted ? 'trusted-local-input' : 'untrusted-input',
					event.target instanceof HTMLElement ? event.target.innerText : ''
				);
				queueMicrotask(() => {
					const button = [
						...document.querySelectorAll<HTMLButtonElement>('aside details button')
					].find(
						(button) => button.textContent?.trim() === 'Déplacer le document dans la corbeille'
					);
					if (!button) throw new Error('Single-file delete action is missing');
					record('delete-click');
					button.click();
				});
			},
			{ once: true }
		);
	}, abortTrash);
}

function eventTime(events: ReviewEvent[], type: string) {
	const event = events.find((event) => event.type === type);
	expect(event, `Missing event: ${type}`).toBeTruthy();
	return event!.at;
}

async function reloadWithEvidence(page: Page) {
	await page.evaluate(() => {
		if (window.durabilityReview) {
			sessionStorage.setItem(
				'durability-review-events',
				JSON.stringify(window.durabilityReview.events)
			);
		}
	});
	await page.reload();
}

test.afterEach(async ({ page, browser }, info) => {
	if (page.isClosed()) return;
	const events = await page.evaluate(() => {
		if (!window.durabilityReview)
			return JSON.parse(sessionStorage.getItem('durability-review-events') ?? '[]');
		window.durabilityReview.release = true;
		return window.durabilityReview.events;
	});
	await info.attach('durability-review.json', {
		body: JSON.stringify(
			{
				...info.config.metadata,
				browser: browser.version(),
				test: info.title,
				status: info.status,
				fixtures: { baseline, remote, localToken },
				events,
				stored: await storedState(page)
			},
			null,
			2
		),
		contentType: 'application/json'
	});
});

test('single delete restores the last visual input before Milkdown debounce', async ({ page }) => {
	const original = await prepareVisualNote(page);
	await armImmediateDelete(page);
	await page.keyboard.insertText(localToken);
	await expect.poll(async () => (await storedState(page)).trash.length).toBe(1);
	const events = await page.evaluate(() => window.durabilityReview.events);
	expect(
		eventTime(events, 'delete-confirm') - eventTime(events, 'trusted-local-input')
	).toBeLessThan(200);
	const trashed = await storedState(page);
	await test.info().attach('before-restore.json', {
		body: JSON.stringify({ events, trashed }),
		contentType: 'application/json'
	});
	await reloadWithEvidence(page);
	await page
		.locator('aside summary')
		.filter({ hasText: /^Corbeille/ })
		.click();
	await page.getByRole('button', { name: `Restaurer ${original.name}`, exact: true }).click();
	await expect.poll(async () => (await storedState(page)).trash.length).toBe(0);
	const restored = await storedState(page);
	await test
		.info()
		.attach('restored.json', { body: JSON.stringify(restored), contentType: 'application/json' });
	expect.soft(trashed.trash[0]!.file.content).toContain(localToken);
	expect.soft(restored.drafts.find((row) => row.id === original.id)?.content).toContain(localToken);
	await reloadWithEvidence(page);
	await expect(page.locator('.ProseMirror')).toContainText(localToken);
});

test('single delete rollback retains fresh visual input after an aborted trash transaction', async ({
	page
}) => {
	const original = await prepareVisualNote(page);
	await armImmediateDelete(page, true);
	await page.keyboard.insertText(localToken);
	await expect
		.poll(
			async () => (await storedState(page)).drafts.find((row) => row.id === original.id)?.content
		)
		.toContain(localToken);
	const events = await page.evaluate(() => window.durabilityReview.events);
	expect(
		eventTime(events, 'delete-confirm') - eventTime(events, 'trusted-local-input')
	).toBeLessThan(200);
	expect(eventTime(events, 'trash-transaction-abort')).toBeGreaterThan(
		eventTime(events, 'delete-confirm')
	);
	expect((await storedState(page)).trash).toHaveLength(0);
	await reloadWithEvidence(page);
	await expect(page.locator('.ProseMirror')).toContainText(localToken);
});

test('cross-tab read contention retains input made after the initial editor flush', async ({
	page
}) => {
	const original = await prepareVisualNote(page);
	await focusEnd(page);
	await page.evaluate(
		async ({ id, remote }) => {
			const record = (type: string, content?: string) =>
				window.durabilityReview.events.push({ type, at: performance.now(), content });
			const database = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			const tx = database.transaction('drafts', 'readwrite');
			const store = tx.objectStore('drafts');
			await new Promise<void>((resolve, reject) => {
				const existing = store.get(id);
				existing.onsuccess = () => {
					record('transaction-acquired');
					store.put({ ...existing.result, content: remote, updatedAt: Date.now() + 1 });
					const keepAlive = () => {
						const request = store.count();
						request.onsuccess = () => {
							if (!window.durabilityReview.release) keepAlive();
							else record('transaction-release');
						};
					};
					keepAlive();
					resolve();
				};
				existing.onerror = () => reject(existing.error);
			});
			tx.oncomplete = () => {
				record('transaction-committed');
				database.close();
			};
			tx.onabort = () => {
				record('transaction-aborted');
				database.close();
			};
			// Observe real requests. The read is delayed only by the live write transaction.
			const get = IDBObjectStore.prototype.get;
			IDBObjectStore.prototype.get = function (key) {
				const request = get.call(this, key);
				if (this.name === 'drafts' && this.transaction.mode === 'readonly' && key === id) {
					record('cross-tab-read-queued');
					request.addEventListener(
						'success',
						() => record('cross-tab-read-completed', request.result?.content),
						{ once: true }
					);
					IDBObjectStore.prototype.get = get;
				}
				return request;
			};
			document.querySelector('.ProseMirror')!.addEventListener(
				'input',
				(event) => {
					record(
						event.isTrusted ? 'trusted-local-input' : 'untrusted-input',
						event.target instanceof HTMLElement ? event.target.innerText : ''
					);
					queueMicrotask(() => {
						window.durabilityReview.release = true;
					});
				},
				{ once: true }
			);
			const channel = new BroadcastChannel('mdsh');
			record('remote-message-posted');
			channel.postMessage({ type: 'draft-written', id, updatedAt: Date.now() });
			channel.close();
		},
		{ id: original.id, remote }
	);
	await page.waitForFunction(() =>
		window.durabilityReview.events.some((event) => event.type === 'cross-tab-read-queued')
	);
	await page.keyboard.insertText(localToken);
	await page.waitForFunction(() =>
		window.durabilityReview.events.some((event) => event.type === 'cross-tab-read-completed')
	);
	const events = await page.evaluate(() => window.durabilityReview.events);
	const inputAt = eventTime(events, 'trusted-local-input');
	expect(eventTime(events, 'transaction-acquired')).toBeLessThan(
		eventTime(events, 'remote-message-posted')
	);
	expect(eventTime(events, 'editor-flush')).toBeLessThan(
		eventTime(events, 'cross-tab-read-queued')
	);
	expect(eventTime(events, 'cross-tab-read-queued')).toBeLessThan(inputAt);
	expect(eventTime(events, 'transaction-release')).toBeGreaterThanOrEqual(inputAt);
	expect(eventTime(events, 'cross-tab-read-completed') - inputAt).toBeLessThan(200);
	expect(events.find((event) => event.type === 'cross-tab-read-completed')?.content).toBe(remote);
	await expect.soft(page.locator('.ProseMirror')).toContainText(localToken);
	await expect
		.poll(async () => {
			const state = await storedState(page);
			return {
				local: state.drafts.find((row) => row.id === original.id)?.content.includes(localToken),
				remoteCopy: state.drafts.some(
					(row) => row.id !== original.id && row.content === remote && row.open === false
				),
				remoteHistory: state.versions.some(
					(row) => row.draftId === original.id && row.content === remote
				)
			};
		})
		.toEqual({ local: true, remoteCopy: true, remoteHistory: true });
	await reloadWithEvidence(page);
	await expect(page.locator('.ProseMirror')).toContainText(localToken);
});

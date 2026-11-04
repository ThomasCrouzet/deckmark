import { expect, test, type Page } from '@playwright/test';
import type { DraftRow } from '../src/lib/db';
import { createFirstFile, resetAppState } from './helpers';

interface SyncObservation {
	queued: number;
	completed: number;
	messages: string[];
	released: boolean;
}

declare global {
	interface Window {
		crossWindowReview: SyncObservation;
	}
}

test.use({ reducedMotion: 'reduce', serviceWorkers: 'block' });

async function holdDiskLinks(page: Page): Promise<void> {
	await page.evaluate(async () => {
		const observation: SyncObservation = {
			queued: 0,
			completed: 0,
			messages: [],
			released: false
		};
		window.crossWindowReview = observation;
		const channel = new BroadcastChannel('mdsh');
		channel.onmessage = (event: MessageEvent<{ type: string }>) => {
			observation.messages.push(event.data.type);
		};
		const original = IDBObjectStore.prototype.openCursor;
		IDBObjectStore.prototype.openCursor = function (...args) {
			const request = original.apply(this, args);
			if (this.transaction.db.name === 'mdsh-fs' && this.name === 'handles') {
				observation.queued++;
				this.transaction.addEventListener('complete', () => observation.completed++, {
					once: true
				});
			}
			return request;
		};
		await new Promise<void>((resolve, reject) => {
			const request = indexedDB.open('mdsh-fs');
			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				const database = request.result;
				const transaction = database.transaction('handles', 'readwrite');
				transaction.oncomplete = () => database.close();
				transaction.onerror = () => reject(transaction.error);
				const keepAlive = () => {
					const read = transaction.objectStore('handles').get('__cross_window_gate__');
					read.onsuccess = () => {
						resolve();
						if (!observation.released) keepAlive();
					};
				};
				keepAlive();
			};
		});
	});
}

async function commitRemote(page: Page, row: DraftRow, remove = false): Promise<void> {
	await page.evaluate(
		async ({ row, remove }) => {
			await new Promise<void>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const transaction = database.transaction('drafts', 'readwrite');
					const drafts = transaction.objectStore('drafts');
					if (remove) drafts.delete(row.id);
					else drafts.put(row);
					transaction.oncomplete = () => {
						database.close();
						resolve();
					};
					transaction.onerror = () => reject(transaction.error);
				};
			});
			const channel = new BroadcastChannel('mdsh');
			channel.postMessage(
				remove
					? { type: 'removed', id: row.id }
					: { type: 'draft-written', id: row.id, updatedAt: row.updatedAt }
			);
			channel.close();
		},
		{ row, remove }
	);
}

async function persistedDraft(page: Page, id: string): Promise<unknown> {
	return page.evaluate(
		(id) =>
			new Promise<unknown>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const read = database.transaction('drafts').objectStore('drafts').get(id);
					read.onsuccess = () => {
						database.close();
						resolve(read.result ?? null);
					};
					read.onerror = () => reject(read.error);
				};
			}),
		id
	);
}

for (const change of ['write', 'remove'] as const) {
	test(`a pending new-draft sync respects a later ${change}`, async ({ page, context }, info) => {
		await resetAppState(page);
		await createFirstFile(page);
		const activeName = await page.locator('#app-toolbar input').inputValue();
		const sender = await context.newPage();
		await sender.route('**/api/__cross_window_sender__', (route) =>
			route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Sender</title>' })
		);
		await sender.goto('/api/__cross_window_sender__');
		const first: DraftRow = {
			id: 'cross-window-review-draft',
			name: 'remote-review.md',
			content: '# Version one\n\nFirst remote bytes.\n',
			createdAt: 1_700_000_000_000,
			updatedAt: 1_700_000_000_001,
			order: 1,
			open: true
		};
		const latest: DraftRow = {
			...first,
			content: '# Version two\n\nLatest remote bytes, with accents: café.\n',
			updatedAt: first.updatedAt + 1
		};
		await holdDiskLinks(page);
		try {
			await commitRemote(sender, first);
			await expect.poll(() => page.evaluate(() => window.crossWindowReview.queued)).toBe(1);
			await expect(page.locator(`aside button[data-file-id="${first.id}"]`)).toHaveCount(0);
			await commitRemote(sender, latest, change === 'remove');
			await expect
				.poll(() => page.evaluate(() => window.crossWindowReview.messages))
				.toEqual(['draft-written', change === 'write' ? 'draft-written' : 'removed']);
			const queued = change === 'write' ? 2 : 1;
			await expect.poll(() => page.evaluate(() => window.crossWindowReview.queued)).toBe(queued);
			await page.evaluate(() => (window.crossWindowReview.released = true));
			await expect
				.poll(() => page.evaluate(() => window.crossWindowReview.completed))
				.toBeGreaterThanOrEqual(queued);
			await expect(page.locator('#app-toolbar input')).toHaveValue(activeName);
			if (change === 'write') {
				await expect(page.locator(`aside button[data-file-id="${first.id}"]`)).toBeVisible();
				await page.locator(`aside button[data-file-id="${first.id}"]`).click();
				await page.locator('#app-toolbar [data-mode="source"]').click();
				await expect
					.poll(() => page.locator('.cm-content .cm-line').allTextContents())
					.toEqual(latest.content.split('\n'));
				await expect.poll(() => persistedDraft(sender, first.id)).toEqual(latest);
			} else {
				await expect(page.locator(`aside button[data-file-id="${first.id}"]`)).toHaveCount(0);
				expect(await persistedDraft(sender, first.id)).toBeNull();
			}
		} finally {
			await page.evaluate(() => (window.crossWindowReview.released = true));
			await info.attach('sync-evidence.json', {
				body: JSON.stringify({
					first,
					latest,
					change,
					observation: await page.evaluate(() => window.crossWindowReview),
					persisted: await persistedDraft(sender, first.id)
				}),
				contentType: 'application/json'
			});
			await info.attach('sync-view.png', {
				body: await page.screenshot(),
				contentType: 'image/png'
			});
			await sender.close();
		}
	});
}

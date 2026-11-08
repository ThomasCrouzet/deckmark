import { expect, test, type Page } from '@playwright/test';
import { createFirstFile, resetAppState } from './helpers';

test.use({ serviceWorkers: 'block' });

const SIZE = 1_000_000;
const DRAFT = `${'d'.repeat(400)}\n`.repeat(Math.floor(SIZE / 401));
const PREVIOUS = `${'p'.repeat(400)}\n`.repeat(Math.floor(SIZE / 401));

interface DraftSummary {
	id: string;
	name: string;
	length: number;
	tail: string;
}

interface HistorySummary {
	count: number;
	newestLength: number;
	newestTail: string;
	matchesDraft: boolean;
}

async function loadDraftSummary(page: Page): Promise<DraftSummary> {
	return page.evaluate(
		() =>
			new Promise<DraftSummary>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const read = database.transaction('drafts').objectStore('drafts').getAll();
					read.onerror = () => reject(read.error);
					read.onsuccess = () => {
						database.close();
						const draft = read.result[0] as
							{ id: string; name: string; content: string } | undefined;
						if (!draft) {
							reject(new Error('No draft row'));
							return;
						}
						resolve({
							id: draft.id,
							name: draft.name,
							length: draft.content.length,
							tail: draft.content.slice(-8)
						});
					};
				};
			})
	);
}

async function seedLargeHistory(
	page: Page,
	options: { draft: string; version: string; versionCreatedAt: number }
): Promise<void> {
	await page.evaluate(
		({ draft, version, versionCreatedAt }) =>
			new Promise<void>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const read = database.transaction('drafts').objectStore('drafts').getAll();
					read.onerror = () => reject(read.error);
					read.onsuccess = () => {
						const row = read.result[0] as Record<string, unknown> | undefined;
						if (!row) {
							database.close();
							reject(new Error('No draft row to seed history'));
							return;
						}
						const transaction = database.transaction(['drafts', 'versions'], 'readwrite');
						transaction.oncomplete = () => {
							database.close();
							resolve();
						};
						transaction.onerror = () => reject(transaction.error);
						transaction.onabort = () => reject(transaction.error);
						transaction.objectStore('drafts').put({
							...row,
							content: draft,
							updatedAt: Date.now()
						});
						const versions = transaction.objectStore('versions');
						versions.clear();
						versions.put({
							id: 'issue-325-seed',
							draftId: row.id,
							name: row.name,
							content: version,
							createdAt: versionCreatedAt
						});
					};
				};
			}),
		options
	);
}

async function ageSeedVersion(page: Page): Promise<void> {
	await page.evaluate(
		() =>
			new Promise<void>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const transaction = database.transaction('versions', 'readwrite');
					transaction.oncomplete = () => {
						database.close();
						resolve();
					};
					transaction.onerror = () => reject(transaction.error);
					const store = transaction.objectStore('versions');
					const read = store.get('issue-325-seed');
					read.onerror = () => reject(read.error);
					read.onsuccess = () => {
						store.put({ ...read.result, createdAt: Date.now() - 5 * 60 * 1000 - 1000 });
					};
				};
			})
	);
}

async function loadHistorySummary(page: Page, draftId: string): Promise<HistorySummary> {
	return page.evaluate(
		(draftId) =>
			new Promise<HistorySummary>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const transaction = database.transaction(['drafts', 'versions']);
					const draftRead = transaction.objectStore('drafts').get(draftId);
					const versionsRead = transaction.objectStore('versions').getAll();
					transaction.oncomplete = () => {
						database.close();
						const draft = draftRead.result as { content: string } | undefined;
						const versions = (
							versionsRead.result as Array<{
								content: string;
								createdAt: number;
							}>
						).sort((a, b) => a.createdAt - b.createdAt);
						const newest = versions.at(-1);
						resolve({
							count: versions.length,
							newestLength: newest?.content.length ?? 0,
							newestTail: newest?.content.slice(-8) ?? '',
							matchesDraft: Boolean(draft && newest && newest.content === draft.content)
						});
					};
					transaction.onerror = () => reject(transaction.error);
				};
			}),
		draftId
	);
}

async function startPerfCapture(page: Page): Promise<void> {
	await page.evaluate(() => {
		const capture = window as Window & {
			__MDSH_EDITOR_PERF__?: boolean;
			historyPerf?: string[];
		};
		capture.__MDSH_EDITOR_PERF__ = true;
		capture.historyPerf = [];
		window.addEventListener('deckmark:editor-perf', (event) => {
			const detail = (event as CustomEvent<{ kind: string; name: string }>).detail;
			if (detail.kind === 'counter') capture.historyPerf?.push(detail.name);
		});
	});
}

async function perfCounters(page: Page): Promise<string[]> {
	return page.evaluate(() => (window as Window & { historyPerf?: string[] }).historyPerf ?? []);
}

async function appendToEnd(page: Page, text: string): Promise<void> {
	await page.locator('.cm-content').click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.insertText(text);
}

test('large draft checkpoints read the newest history key, not its body, while throttled', async ({
	page
}, info) => {
	test.setTimeout(180_000);
	await resetAppState(page);
	await createFirstFile(page);
	const draft = await loadDraftSummary(page);
	await seedLargeHistory(page, {
		draft: DRAFT,
		version: PREVIOUS,
		versionCreatedAt: Date.now()
	});
	await page.reload();
	await expect(page.locator('.cm-content')).toBeVisible({ timeout: 30_000 });
	await expect(page.locator('#app-statusbar')).toContainText('Brouillons locaux : enregistré', {
		timeout: 60_000
	});

	await startPerfCapture(page);
	await appendToEnd(page, ' T1');
	await expect
		.poll(async () => (await loadDraftSummary(page)).tail.endsWith(' T1'), { timeout: 30_000 })
		.toBe(true);
	await expect
		.poll(async () => (await perfCounters(page)).includes('history.latest-key'), {
			timeout: 30_000
		})
		.toBe(true);

	const counters = await perfCounters(page);
	const history = await loadHistorySummary(page, draft.id);
	expect(history.count).toBe(1);
	expect(counters).not.toContain('history.latest-body');
	expect(history.matchesDraft).toBe(false);
	await info.attach('throttled-history.json', {
		body: JSON.stringify({ draft, history, counters }, null, 2),
		contentType: 'application/json'
	});
});

test('an eligible large draft checkpoint reads and stores the exact draft', async ({
	page
}, info) => {
	test.setTimeout(180_000);
	await resetAppState(page);
	await createFirstFile(page);
	const draft = await loadDraftSummary(page);
	await seedLargeHistory(page, {
		draft: DRAFT,
		version: PREVIOUS,
		versionCreatedAt: Date.now()
	});
	await page.reload();
	await expect(page.locator('.cm-content')).toBeVisible({ timeout: 30_000 });
	await expect(page.locator('#app-statusbar')).toContainText('Brouillons locaux : enregistré', {
		timeout: 60_000
	});

	await ageSeedVersion(page);
	await startPerfCapture(page);
	await appendToEnd(page, ' T2');
	await expect
		.poll(async () => (await loadDraftSummary(page)).tail.endsWith(' T2'), { timeout: 30_000 })
		.toBe(true);
	await expect
		.poll(async () => (await loadHistorySummary(page, draft.id)).count, { timeout: 30_000 })
		.toBe(2);

	const history = await loadHistorySummary(page, draft.id);
	const counters = await perfCounters(page);
	expect(history.matchesDraft).toBe(true);
	expect(history.newestLength).toBe(DRAFT.length + 3);
	expect(counters).toContain('history.latest-body');
	await info.attach('eligible-history.json', {
		body: JSON.stringify({ draft, history, counters }, null, 2),
		contentType: 'application/json'
	});
});

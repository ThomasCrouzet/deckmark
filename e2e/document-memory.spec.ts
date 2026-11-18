import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resetAppState, seedFiles } from './helpers';

// Retained source owners of a closed durable document: the FileItem body, the
// document revision snapshot, the save-queue baseline, the metadata index
// content and the metadata Worker baseline. The probe reports logical
// characters and UTF-16 bytes for each owner. It is not a heap measurement.

interface MemoryDocument {
	id: string;
	name: string;
	state: string;
	contentDeferred: boolean;
	dirty: boolean;
	logicalChars: number;
	evictable: boolean;
	owners: string[];
	bytes: Record<string, number>;
}

interface MemoryStats {
	budgetBytes: number;
	retained: Record<string, { chars: number; bytes: number; documents: number }>;
	total: { chars: number; bytes: number };
	counters: Record<string, number>;
	heap: { usedJSHeapSize: number | null; totalJSHeapSize: number | null };
	documents: MemoryDocument[];
}

const pendingProbe = () =>
	new Promise<MemoryStats | null>((resolve) => {
		const probe = (window as unknown as { __MDSH_DOCUMENT_MEMORY__?: { stats: () => MemoryStats } })
			.__MDSH_DOCUMENT_MEMORY__;
		resolve(probe ? probe.stats() : null);
	});

async function memoryStats(page: Page): Promise<MemoryStats> {
	const stats = await page.evaluate(pendingProbe);
	if (!stats) throw new Error('document memory probe is not installed');
	return stats;
}

async function memoryDocument(page: Page, id: string): Promise<MemoryDocument | undefined> {
	const stats = await memoryStats(page);
	return stats.documents.find((entry) => entry.id === id);
}

async function openId(page: Page): Promise<string> {
	const button = page.locator('aside button[data-file-id]').first();
	await expect(button).toBeVisible();
	return (await button.getAttribute('data-file-id')) ?? '';
}

function largeNote(tag: string, chars: number): string {
	const head = `---\ntags: [${tag}]\n---\n\n# ${tag}\n\n[[memory-target]]\n\n`;
	const tail = '\n\nEnd of note.\n';
	const filler = 'Paragraph for the retained source owner check. '.repeat(
		Math.ceil(Math.max(0, chars - head.length - tail.length) / 50)
	);
	return head + filler.slice(0, Math.max(0, chars - head.length - tail.length)) + tail;
}

async function exportExact(page: Page): Promise<string> {
	const download = page.waitForEvent('download');
	await page.getByRole('button', { name: 'Exporter' }).first().click();
	const file = await download;
	const path = await file.path();
	if (!path) throw new Error('Exported Markdown has no path');
	return readFile(path, 'utf8');
}

async function attachEvidence(testInfo: TestInfo, name: string, payload: unknown): Promise<void> {
	await testInfo.attach(name, {
		body: JSON.stringify(payload, null, 2),
		contentType: 'application/json'
	});
}

test.describe('closed document source owners', () => {
	test.use({ locale: 'fr-FR' });

	test('releases every source owner after a durable close and restores exact bytes', async ({
		page
	}, testInfo) => {
		await resetAppState(page);
		const content = largeNote('memory-owner', 1_200_000);
		await seedFiles(page, [{ name: 'memory-owner.md', content }]);
		const id = await openId(page);

		await expect
			.poll(async () => (await memoryDocument(page, id))?.state, { timeout: 15_000 })
			.toBe('active');
		await expect
			.poll(async () => (await memoryDocument(page, id))?.logicalChars ?? 0)
			.toBe(content.length);

		await page
			.locator('aside')
			.getByRole('button', { name: /^Fermer / })
			.first()
			.click();

		await expect
			.poll(async () => (await memoryDocument(page, id))?.contentDeferred, { timeout: 15_000 })
			.toBe(true);
		const closed = await memoryDocument(page, id);
		expect(closed?.owners).toEqual([]);
		expect(closed?.state).toBe('deferred');

		// Titles, tags and wiki targets stay available without the body.
		await page.locator('aside summary', { hasText: 'Documents conservés' }).click();
		await page
			.locator('aside')
			.getByRole('button', { name: 'memory-owner.md', exact: true })
			.click();
		await expect
			.poll(async () => (await memoryDocument(page, id))?.contentDeferred, { timeout: 15_000 })
			.toBe(false);
		expect(await exportExact(page)).toBe(content);

		const after = await memoryStats(page);
		expect(after.counters.rehydrations).toBeGreaterThan(0);
		expect(after.counters.evictions).toBeGreaterThan(0);
		await attachEvidence(testInfo, 'document-memory-owners.json', {
			command:
				'npx playwright test e2e/document-memory.spec.ts --project=chromium --workers=1 --retries=0',
			contentChars: content.length,
			contentUtf16Bytes: content.length * 2,
			closed,
			after: {
				retained: after.retained,
				total: after.total,
				counters: after.counters,
				heap: after.heap
			}
		});
	});

	test('keeps cleared bodies under the byte budget across many closed notes', async ({
		page
	}, testInfo) => {
		await resetAppState(page);
		const bodies = Array.from({ length: 12 }, (_, index) => {
			const name = `bulk-${String(index).padStart(2, '0')}.md`;
			const content = largeNote(`bulk-${index}`, 512 * 1024);
			return { name, content };
		});
		await page.evaluate(async (rows) => {
			await new Promise<void>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const transaction = database.transaction('drafts', 'readwrite');
					const store = transaction.objectStore('drafts');
					const now = Date.now();
					rows.forEach((row, index) => {
						store.put({
							id: `bulk-${index}`,
							name: row.name,
							content: row.content,
							createdAt: now,
							updatedAt: now,
							order: index,
							open: false
						});
					});
					transaction.oncomplete = () => {
						database.close();
						resolve();
					};
					transaction.onerror = () => {
						database.close();
						reject(transaction.error);
					};
				};
			});
		}, bodies);
		await page.reload();
		await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor({
			state: 'visible',
			timeout: 15_000
		});

		await expect
			.poll(
				async () => {
					const stats = await memoryStats(page);
					return stats.documents.filter((entry) => entry.contentDeferred).length;
				},
				{ timeout: 20_000 }
			)
			.toBeGreaterThanOrEqual(8);

		const settled = await memoryStats(page);
		expect(settled.counters.evictions).toBeGreaterThanOrEqual(8);
		expect(settled.retained.fileItem.bytes).toBeLessThanOrEqual(settled.budgetBytes);
		expect(settled.retained.fileItem.documents).toBeLessThan(bodies.length);
		const evictedDocuments = settled.documents.filter((entry) => entry.contentDeferred);
		expect(evictedDocuments.length).toBeGreaterThanOrEqual(8);
		for (const document of evictedDocuments) expect(document.owners).toEqual([]);
		expect(settled.retained.revisions.documents).toBe(0);

		const evicted = evictedDocuments[0];
		expect(evicted).toBeTruthy();
		await page.locator('aside summary', { hasText: 'Documents conservés' }).click();
		await page.locator('aside').getByRole('button', { name: evicted!.name, exact: true }).click();
		await expect
			.poll(async () => (await memoryDocument(page, evicted!.id))?.contentDeferred, {
				timeout: 15_000
			})
			.toBe(false);
		const seeded = bodies.find((row) => row.name === evicted!.name)!;
		expect(await exportExact(page)).toBe(seeded.content);

		await attachEvidence(testInfo, 'document-memory-budget.json', {
			command:
				'npx playwright test e2e/document-memory.spec.ts --project=chromium --workers=1 --retries=0',
			seededNotes: bodies.length,
			seededChars: bodies.reduce((total, row) => total + row.content.length, 0),
			budgetBytes: settled.budgetBytes,
			before: { retained: settled.retained, counters: settled.counters, heap: settled.heap },
			rehydrated: evicted!.name
		});
	});

	test('evicts a disk-dirty but locally durable note and keeps its disk status', async ({
		page
	}, testInfo) => {
		await resetAppState(page);
		const content = largeNote('memory-disk', 1_200_000);
		const edited = `${content}\n\nDisk-dirty but durable.\n`;
		await seedFiles(page, [{ name: 'memory-disk.md', content: edited }]);
		const id = await openId(page);

		await expect
			.poll(async () => (await memoryDocument(page, id))?.logicalChars ?? 0, { timeout: 15_000 })
			.toBe(edited.length);
		const before = await memoryDocument(page, id);
		expect(before?.dirty).toBe(true);

		await page
			.locator('aside')
			.getByRole('button', { name: /^Fermer / })
			.first()
			.click();

		await expect
			.poll(async () => (await memoryDocument(page, id))?.contentDeferred, { timeout: 15_000 })
			.toBe(true);
		const closed = await memoryDocument(page, id);
		expect(closed?.dirty).toBe(true);
		expect(closed?.owners).toEqual([]);

		await page.locator('aside summary', { hasText: 'Documents conservés' }).click();
		await page
			.locator('aside')
			.getByRole('button', { name: 'memory-disk.md', exact: true })
			.click();
		await expect
			.poll(async () => (await memoryDocument(page, id))?.contentDeferred, { timeout: 15_000 })
			.toBe(false);
		expect(await exportExact(page)).toBe(edited);

		await attachEvidence(testInfo, 'document-memory-disk-dirty.json', {
			command:
				'npx playwright test e2e/document-memory.spec.ts --project=chromium --workers=1 --retries=0',
			editedChars: edited.length,
			closed,
			browser: await page.evaluate(() => navigator.userAgent)
		});
	});
});

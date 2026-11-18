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
	pending: boolean;
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

function largeNote(tag: string, chars: number, label = tag): string {
	const head = `---\ntags: [${tag}]\n---\n\n# ${label}\n\n[[memory-target]]\n\n`;
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

/** One note with a YAML title, a tag and optional leading body text. */
function titledNote(title: string, tag: string, chars: number, lead = ''): string {
	const head = `---\ntitle: ${title}\ntags: [${tag}]\n---\n\n# ${title}\n\n${lead}`;
	const tail = '\n\nEnd of note.\n';
	const line = 'Paragraph for the eviction metadata check.\n';
	const filler = Math.max(0, chars - head.length - tail.length);
	return head + line.repeat(Math.ceil(filler / line.length)).slice(0, filler) + tail;
}

/** Exact durable content of one draft, read by file name. */
async function storedByName(page: Page, name: string): Promise<string> {
	return page.evaluate(
		(draftName) =>
			new Promise<string>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const rows = database.transaction('drafts').objectStore('drafts').getAll();
					rows.onerror = () => {
						database.close();
						reject(rows.error);
					};
					rows.onsuccess = () => {
						database.close();
						const row = rows.result.find((entry: { name: string }) => entry.name === draftName);
						resolve((row as { content?: string } | undefined)?.content ?? '');
					};
				};
			}),
		name
	);
}

async function attachEvidence(testInfo: TestInfo, name: string, payload: unknown): Promise<void> {
	await testInfo.attach(name, {
		body: JSON.stringify(payload, null, 2),
		contentType: 'application/json'
	});
}

/**
 * Fails the durable write of a marked draft, so the case can prove that the
 * source of a failed local write is kept. The flag starts disabled and the case
 * turns it off before it retries the save.
 */
async function installDraftWriteFault(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const state = window as unknown as { __MDSH_FAIL_DRAFT_WRITES__?: boolean };
		state.__MDSH_FAIL_DRAFT_WRITES__ = false;
		const put = IDBObjectStore.prototype.put;
		IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
			const row = value as { content?: string } | undefined;
			if (
				state.__MDSH_FAIL_DRAFT_WRITES__ &&
				this.name === 'drafts' &&
				typeof row?.content === 'string' &&
				row.content.includes('FAILED-WRITE-MARKER')
			) {
				throw new DOMException('Injected quota failure', 'QuotaExceededError');
			}
			return arguments.length > 1
				? put.call(this, value as never, key as never)
				: put.call(this, value as never);
		} as typeof put;
	});
}

test.describe('closed document source owners', () => {
	test.use({ locale: 'fr-FR' });

	test('releases every source owner after a durable close and restores exact bytes', async ({
		page
	}, testInfo) => {
		await resetAppState(page);
		const content = largeNote('retention-tag', 1_200_000, 'memory-owner');
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

		// Titles and tags stay available without the body. The library filter
		// reads the derived tag list, so a tag that is absent from the file name
		// proves that the metadata survived the release.
		await page
			.locator('aside')
			.getByRole('button', { name: /^Bibliothèque de documents/ })
			.click();
		const library = page.getByRole('dialog', { name: /Bibliothèque de documents/ });
		await library.getByLabel('Filtrer par titre, nom de fichier ou tag').fill('retention-tag');
		const libraryEntry = library.getByRole('button', { name: 'Ouvrir memory-owner.md' });
		await expect(libraryEntry).toBeVisible();
		await libraryEntry.click();
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

	test('keeps the source of a failed local write and recovers it', async ({ page }, testInfo) => {
		await installDraftWriteFault(page);
		await resetAppState(page);
		const content = `${largeNote('retention-fail', 1_200_000, 'memory-fail')}\nFAILED-WRITE-MARKER\n`;
		await page.evaluate(() => {
			(window as unknown as { __MDSH_FAIL_DRAFT_WRITES__?: boolean }).__MDSH_FAIL_DRAFT_WRITES__ =
				true;
		});
		await seedFiles(page, [{ name: 'memory-fail.md', content }]);
		const id = await openId(page);

		await expect
			.poll(async () => (await memoryDocument(page, id))?.logicalChars ?? 0, { timeout: 15_000 })
			.toBe(content.length);
		await expect(page.locator('#app-statusbar')).toContainText('Non enregistré localement');

		// The write failed, so the source exists only in memory. A close must keep
		// the body and the failure.
		await page
			.locator('aside')
			.getByRole('button', { name: /^Fermer / })
			.first()
			.click();
		await page.waitForTimeout(1200);
		const closed = await memoryDocument(page, id);
		expect(closed?.contentDeferred).toBe(false);
		expect(closed?.logicalChars).toBe(content.length);
		expect(closed?.state).toBe('pending');

		await attachEvidence(testInfo, 'document-memory-failed-write.json', {
			command:
				'npx playwright test e2e/document-memory.spec.ts --project=chromium --workers=1 --retries=0',
			failed: closed,
			statusBar: await page.locator('#app-statusbar').innerText()
		});

		// A durable retry recovers the row, and the next close can release the body.
		await page.evaluate(() => {
			(window as unknown as { __MDSH_FAIL_DRAFT_WRITES__?: boolean }).__MDSH_FAIL_DRAFT_WRITES__ =
				false;
		});
		await page
			.locator('#app-statusbar')
			.getByRole('button', { name: "Réessayer l'enregistrement" })
			.click();
		await expect
			.poll(async () => (await memoryDocument(page, id))?.state, { timeout: 15_000 })
			.toBe('durable');

		await page.locator('aside summary', { hasText: 'Documents conservés' }).click();
		await page
			.locator('aside')
			.getByRole('button', { name: 'memory-fail.md', exact: true })
			.click();
		await expect
			.poll(async () => (await memoryDocument(page, id))?.contentDeferred, { timeout: 15_000 })
			.toBe(false);
		expect(await exportExact(page)).toBe(content);

		await page
			.locator('aside')
			.getByRole('button', { name: /^Fermer / })
			.first()
			.click();
		await expect
			.poll(async () => (await memoryDocument(page, id))?.contentDeferred, { timeout: 15_000 })
			.toBe(true);
	});

	test('holds every library body during a full export and releases it after', async ({
		page
	}, testInfo) => {
		await resetAppState(page);
		const bodies = Array.from({ length: 12 }, (_, index) => ({
			name: `export-${String(index).padStart(2, '0')}.md`,
			content: largeNote(`export-${index}`, 512 * 1024)
		}));
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
							id: `export-${index}`,
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
				async () =>
					(await memoryStats(page)).documents.filter((entry) => entry.contentDeferred).length,
				{ timeout: 20_000 }
			)
			.toBeGreaterThanOrEqual(8);

		const download = page.waitForEvent('download');
		await page.getByRole('button', { name: 'Palette de commandes' }).click();
		await page.keyboard.type('Exporter tous les fichiers');
		await page.keyboard.press('Enter');

		// The export pins every library body before it reads the rows. A close or
		// another reclaim pass cannot release them while the archive is built.
		await expect
			.poll(
				async () =>
					(await memoryStats(page)).documents.filter((entry) => entry.state === 'pinned').length,
				{ timeout: 15_000, intervals: [50, 50, 100] }
			)
			.toBeGreaterThan(0);
		const pinned = (await memoryStats(page)).documents.filter(
			(entry) => entry.state === 'pinned'
		).length;
		const archive = await download;
		expect(archive.suggestedFilename()).toMatch(/\.zip$/);

		const after = await memoryStats(page);
		expect(after.documents.some((entry) => entry.state === 'pinned')).toBe(false);
		expect(after.counters.pinAcquires).toBeGreaterThan(0);
		await attachEvidence(testInfo, 'document-memory-export-pins.json', {
			command:
				'npx playwright test e2e/document-memory.spec.ts --project=chromium --workers=1 --retries=0',
			libraryNotes: bodies.length,
			pinnedDocuments: pinned,
			pinAcquires: after.counters.pinAcquires,
			archive: archive.suggestedFilename()
		});
	});

	test('keeps tags, titles, backlinks, selection, scroll and the per-draft undo policy across eviction', async ({
		page
	}, testInfo) => {
		test.setTimeout(240_000);
		await resetAppState(page);
		const targetName = 'Memory Target.md';
		const sourceName = 'Memory Source.md';
		const source = titledNote(
			'Memory Source Title',
			'memoire-source',
			1_300_000,
			'A link to [[Memory Target]].\n\n'
		);
		const target = titledNote('Memory Target Title', 'memoire-survit', 1_300_000);
		await page.locator('input[type="file"][accept*="text/markdown"]').setInputFiles([
			{ name: sourceName, mimeType: 'text/markdown', buffer: Buffer.from(source) },
			{ name: targetName, mimeType: 'text/markdown', buffer: Buffer.from(target) }
		]);
		await expect(page.locator('aside li[aria-setsize]').first()).toHaveAttribute(
			'aria-setsize',
			'2'
		);

		const targetId = await page
			.locator('aside button[data-file-id]')
			.filter({ hasText: 'Memory Target Title' })
			.first()
			.getAttribute('data-file-id');
		const sourceId = await page
			.locator('aside button[data-file-id]')
			.filter({ hasText: 'Memory Source Title' })
			.first()
			.getAttribute('data-file-id');
		expect(targetId).toBeTruthy();
		expect(sourceId).toBeTruthy();
		await expect
			.poll(async () => (await memoryDocument(page, targetId!))?.logicalChars, { timeout: 30_000 })
			.toBe(target.length);

		// Accept one local edit and wait for the durable row before the close.
		const marker = ' visit-target';
		await page.locator('.cm-content').first().click();
		await page.keyboard.press('ControlOrMeta+End');
		await page.keyboard.insertText(marker);
		await expect
			.poll(async () => (await memoryDocument(page, targetId!))?.logicalChars, { timeout: 30_000 })
			.toBe(target.length + marker.length);
		await expect
			.poll(async () => (await memoryDocument(page, targetId!))?.pending, { timeout: 30_000 })
			.toBe(false);
		const savedTarget = await storedByName(page, targetName);
		expect(savedTarget).toBe(target + marker);

		await page.keyboard.press('ControlOrMeta+End');
		for (let index = 0; index < 5; index += 1) await page.keyboard.press('Shift+ArrowLeft');
		await page.waitForTimeout(300);
		const selected = await page.evaluate(() => window.getSelection()?.toString());
		expect(selected).toBe('arget');
		const scroller = page.locator('.cm-scroller').first();
		await expect
			.poll(() => scroller.evaluate((element) => element.scrollTop), { timeout: 10_000 })
			.toBeGreaterThan(100);
		const scrollBefore = await scroller.evaluate((element) => element.scrollTop);
		expect(scrollBefore).toBeGreaterThan(100);

		// Evict both notes: their bodies are above the closed body budget.
		await page
			.locator('aside')
			.getByRole('button', { name: 'Fermer Memory Target Title', exact: true })
			.click();
		await expect
			.poll(async () => (await memoryDocument(page, targetId!))?.contentDeferred, {
				timeout: 30_000
			})
			.toBe(true);
		await page
			.locator('aside')
			.getByRole('button', { name: 'Fermer Memory Source Title', exact: true })
			.click();
		await expect
			.poll(async () => (await memoryDocument(page, sourceId!))?.contentDeferred, {
				timeout: 30_000
			})
			.toBe(true);
		expect((await memoryDocument(page, targetId!))?.owners).toEqual([]);
		expect((await memoryDocument(page, sourceId!))?.owners).toEqual([]);

		// Title and tag live in the derived projection while the body is absent.
		await page
			.locator('aside')
			.getByRole('button', { name: /^Bibliothèque de documents/ })
			.click();
		const library = page.getByRole('dialog', { name: /Bibliothèque de documents/ });
		const filter = library.getByLabel('Filtrer par titre, nom de fichier ou tag');
		await filter.fill('memoire-survit');
		const targetRow = library.getByRole('button', { name: `Ouvrir ${targetName}` });
		await expect(targetRow).toBeVisible();
		await expect(library.getByRole('button', { name: `Ouvrir ${sourceName}` })).toBeHidden();
		await filter.fill('Memory Target Title');
		await expect(targetRow).toBeVisible();
		await targetRow.click();

		await expect
			.poll(async () => (await memoryDocument(page, targetId!))?.contentDeferred, {
				timeout: 30_000
			})
			.toBe(false);
		await expect(page.locator(`aside button[data-file-id="${targetId}"]`)).toHaveAttribute(
			'aria-label',
			/^Memory Target Title/
		);
		// The backlink target comes from the source body that was evicted too.
		const backlinks = page.locator('aside nav[aria-label="Backlinks"]');
		await expect(
			backlinks.getByRole('button', { name: 'Ouvrir Memory Source Title' })
		).toBeVisible();

		await page.locator('.cm-content').first().focus();
		await expect
			.poll(() => page.evaluate(() => window.getSelection()?.toString()), { timeout: 30_000 })
			.toBe(selected);
		await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
		const scrollAfter = await scroller.evaluate((element) => element.scrollTop);
		expect(Math.abs(scrollAfter - scrollBefore)).toBeLessThanOrEqual(8);

		// The restored per-draft history can undo only this note's own edit.
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(() => storedByName(page, targetName)).toBe(target);
		expect(await storedByName(page, sourceName)).toBe(source);
		await page.keyboard.press('ControlOrMeta+Shift+z');
		await expect.poll(() => storedByName(page, targetName)).toBe(savedTarget);

		// A changed title must not come back from the older projection after the
		// next eviction.
		const renamed = savedTarget.replace(
			'title: Memory Target Title',
			'title: Renamed Memory Target'
		);
		const editor = page.locator('.cm-content').first();
		await editor.click();
		await page.keyboard.press('ControlOrMeta+Home');
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('Shift+End');
		await page.keyboard.insertText('title: Renamed Memory Target');
		await expect
			.poll(async () => (await memoryDocument(page, targetId!))?.logicalChars, { timeout: 60_000 })
			.toBe(renamed.length);
		await expect
			.poll(async () => (await memoryDocument(page, targetId!))?.pending, { timeout: 60_000 })
			.toBe(false);
		await page
			.locator('aside')
			.getByRole('button', { name: 'Fermer Renamed Memory Target', exact: true })
			.click();
		await expect
			.poll(async () => (await memoryDocument(page, targetId!))?.contentDeferred, {
				timeout: 30_000
			})
			.toBe(true);
		await page
			.locator('aside')
			.getByRole('button', { name: /^Bibliothèque de documents/ })
			.click();
		await filter.fill('Renamed Memory Target');
		await expect(targetRow).toBeVisible();
		await filter.fill('Memory Target Title');
		await expect(targetRow).toBeHidden();
		await filter.fill('memoire-survit');
		await targetRow.click();
		await expect
			.poll(async () => (await memoryDocument(page, targetId!))?.contentDeferred, {
				timeout: 30_000
			})
			.toBe(false);
		expect(await exportExact(page)).toBe(renamed);

		await attachEvidence(testInfo, 'document-memory-eviction-metadata.json', {
			command:
				'npx playwright test e2e/document-memory.spec.ts --project=chromium --workers=1 --retries=0',
			targetChars: target.length,
			sourceChars: source.length,
			selected,
			scrollBefore,
			scrollAfter,
			undoRestoredTarget: true,
			sourceUnchangedByUndo: true,
			renamedTitle: 'Renamed Memory Target',
			browser: await page.evaluate(() => navigator.userAgent)
		});
	});
});

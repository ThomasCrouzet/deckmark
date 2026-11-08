import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type { DraftRow } from '../src/lib/db';
import { resetAppState } from './helpers';

test.use({ reducedMotion: 'reduce', serviceWorkers: 'block' });

async function draft(page: Page, name: string): Promise<DraftRow | null> {
	return page.evaluate(
		(name) =>
			new Promise<DraftRow | null>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const read = database.transaction('drafts').objectStore('drafts').getAll();
					read.onerror = () => reject(read.error);
					read.onsuccess = () => {
						database.close();
						resolve(read.result.find((row: DraftRow) => row.name === name) ?? null);
					};
				};
			}),
		name
	);
}

async function observe(page: Page) {
	return page.locator('.cm-editor').evaluate((editor) => {
		const selection = document.getSelection();
		let backward = false;
		if (selection?.anchorNode && selection.focusNode) {
			const anchor = document.createRange();
			const head = document.createRange();
			anchor.setStart(selection.anchorNode, selection.anchorOffset);
			head.setStart(selection.focusNode, selection.focusOffset);
			backward = anchor.compareBoundaryPoints(Range.START_TO_START, head) > 0;
		}
		return {
			selected: selection?.toString() ?? '',
			backward,
			scrollTop: editor.querySelector('.cm-scroller')?.scrollTop ?? 0,
			activeEditor: !!document.activeElement?.closest('.cm-editor')
		};
	});
}

async function commitExternal(page: Page, row: DraftRow): Promise<void> {
	await page.evaluate(
		(row) =>
			new Promise<void>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const transaction = database.transaction('drafts', 'readwrite');
					transaction.objectStore('drafts').put(row);
					transaction.onerror = () => reject(transaction.error);
					transaction.oncomplete = () => {
						database.close();
						const sender = new BroadcastChannel('mdsh');
						sender.postMessage({ type: 'draft-written', id: row.id, updatedAt: row.updatedAt });
						sender.close();
						resolve();
					};
				};
			}),
		row
	);
}

for (const mode of ['source', 'code'] as const) {
	test(`${mode} maps a reversed selection and viewport through a tiny external edit`, async ({
		page
	}, info) => {
		await resetAppState(page);
		const name = mode === 'source' ? 'external-selection.md' : 'external-selection.txt';
		const initial = Array.from(
			{ length: 180 },
			(_, index) => `row ${String(index).padStart(3, '0')} selected\n`
		).join('');
		const incoming = initial.replace('row 059', 'Row 059');
		await page.locator('input[type="file"][accept*="text/markdown"]').setInputFiles({
			name,
			mimeType: 'text/plain',
			buffer: Buffer.from(initial)
		});
		if (mode === 'source') await page.locator('button[data-mode="source"]').click();
		const editor = page.locator('.cm-content');
		await expect(editor).toBeVisible({ timeout: 20_000 });
		await expect.poll(async () => (await draft(page, name))?.content).toBe(initial);
		await editor.click();
		await page.keyboard.press('ControlOrMeta+Home');
		for (let line = 0; line < 60; line++) await page.keyboard.press('ArrowDown');
		await page.keyboard.press('End');
		for (let character = 0; character < 8; character++)
			await page.keyboard.press('Shift+ArrowLeft');
		await expect.poll(async () => (await observe(page)).selected).toBe('selected');
		const before = await observe(page);
		expect(before.backward).toBe(true);
		expect(before.scrollTop).toBeGreaterThan(0);
		const row = (await draft(page, name))!;
		let after: Awaited<ReturnType<typeof observe>> | null = null;
		try {
			await commitExternal(page, { ...row, content: incoming, updatedAt: row.updatedAt + 1 });
			await expect
				.poll(async () => {
					const text = await editor.innerText();
					return text.includes('Row 059') || (await observe(page)).selected !== 'selected';
				})
				.toBe(true);
			after = await observe(page);
			expect.soft(after.selected).toBe('selected');
			expect.soft(after.backward).toBe(true);
			expect.soft(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThanOrEqual(2);
			await page.waitForTimeout(500);
			expect((await draft(page, name))?.content).toBe(incoming);
		} finally {
			await info.attach('external-selection.json', {
				body: JSON.stringify(
					{
						mode,
						before,
						after: after ?? (await observe(page)),
						fixture: { name, initial, incoming },
						fixtureSha256: createHash('sha256').update(initial).digest('hex'),
						stored: await draft(page, name),
						browser: await page.context().browser()?.version(),
						source: info.config.metadata,
						status: info.status
					},
					null,
					2
				),
				contentType: 'application/json'
			});
			await info.attach('external-selection.png', {
				body: await page.screenshot(),
				contentType: 'image/png'
			});
		}
	});
}

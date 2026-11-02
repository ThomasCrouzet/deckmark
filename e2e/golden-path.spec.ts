import { test, expect } from '@playwright/test';
import { resetAppState, createFirstFile, switchToSource, writeSourceContent } from './helpers';

test.describe('Golden path - persistence lifecycle', () => {
	test.beforeEach(async ({ page }) => {
		await resetAppState(page);
	});

	test('creates a file and keeps its content after reload', async ({ page }, testInfo) => {
		await createFirstFile(page);
		// Select source mode in the UI so CodeMirror is visible. On WebKit,
		// resetAppState can reload before localStorage persists the mode.
		await switchToSource(page);
		const cm = page.locator('.cm-content').first();
		await expect(cm).toBeVisible({ timeout: 10_000 });

		const payload = 'Bonjour\n\nContenu de test E2E';
		await cm.click();
		// Type into the CodeMirror contenteditable to simulate user input.
		await page.keyboard.type(payload);

		const status = page.locator('#app-statusbar');
		await expect(status).toContainText('Brouillons locaux : enregistré');

		// Reload the page.
		await page.reload();
		// WebKit does not always restore the mode after reload. Select source mode before
		// the content check.
		await switchToSource(page);
		const cmAfter = page.locator('.cm-content').first();
		await expect(cmAfter).toBeVisible({ timeout: 10_000 });
		// CodeMirror renders each line in `.cm-line`. Join the lines for comparison.
		await expect(async () => {
			const text = await cmAfter.evaluate((el) => {
				const lines = el.querySelectorAll('.cm-line');
				return Array.from(lines)
					.map((l) =>
						(l.textContent ?? '').replace(new RegExp(String.fromCharCode(0x200b), 'g'), '')
					)
					.join('\n');
			});
			expect(text).toBe(payload);
		}).toPass({ timeout: 10_000 });
		await expect(status.getByText('Brouillons locaux : enregistré', { exact: true })).toBeVisible();
		await testInfo.attach('restored-save-status', {
			body: await page.screenshot({ animations: 'disabled' }),
			contentType: 'image/png'
		});
	});

	test('blocks input during a slow load and keeps later creations', async ({ page }) => {
		await createFirstFile(page);
		await writeSourceContent(page, 'Document conservé avant rechargement');
		const readDrafts = () =>
			page.evaluate(
				() =>
					new Promise<Array<{ content: string }>>((resolve, reject) => {
						const request = indexedDB.open('mdsh');
						request.onerror = () => reject(request.error);
						request.onsuccess = () => {
							const database = request.result;
							const transaction = database.transaction('drafts');
							const rows = transaction.objectStore('drafts').getAll();
							rows.onsuccess = () => resolve(rows.result);
							rows.onerror = () => reject(rows.error);
							transaction.oncomplete = () => database.close();
						};
					})
			);
		await expect
			.poll(async () => (await readDrafts()).map((row) => row.content))
			.toEqual(['Document conservé avant rechargement']);

		// Keep the initial result that Dexie read. count() keeps the transaction active
		// without a network delay or data change.
		await page.addInitScript(() => {
			if (sessionStorage.getItem('mdsh:test:read-gate')) return;
			sessionStorage.setItem('mdsh:test:read-gate', 'used');
			const gate = { blocked: false, release: () => {} };
			(window as typeof window & { mdshReadGate: typeof gate }).mdshReadGate = gate;
			const original = IDBIndex.prototype.getAll;
			IDBIndex.prototype.getAll = function (...args: Parameters<IDBIndex['getAll']>) {
				const request = original.apply(this, args);
				if (this.name !== 'order' || this.objectStore.name !== 'drafts' || gate.blocked)
					return request;
				const store = this.objectStore;
				request.addEventListener(
					'success',
					(event) => {
						event.stopImmediatePropagation();
						gate.blocked = true;
						let released = false;
						const keepAlive = () => {
							store.count().onsuccess = () => {
								if (!released) keepAlive();
							};
						};
						keepAlive();
						gate.release = () => {
							released = true;
							request.dispatchEvent(new Event('success'));
						};
					},
					{ once: true }
				);
				return request;
			};
		});
		await page.reload();
		await expect
			.poll(() =>
				page.evaluate(
					() =>
						(window as typeof window & { mdshReadGate?: { blocked: boolean } }).mdshReadGate
							?.blocked
				)
			)
			.toBe(true);
		const shell = page.locator('.mdsh-shell');
		await expect(shell).toHaveAttribute('aria-busy', 'true');
		await expect(shell).toHaveAttribute('inert', '');
		const button = page.getByTestId('welcome-new');
		const box = await button.boundingBox();
		expect(box).not.toBeNull();
		await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
		await page.keyboard.press('ControlOrMeta+n');
		const dropPrevented = await page.evaluate(() => {
			const transfer = new DataTransfer();
			transfer.items.add(
				new File(['Document déposé trop tôt'], 'before-ready.md', { type: 'text/markdown' })
			);
			const event = new DragEvent('drop', {
				bubbles: true,
				cancelable: true,
				dataTransfer: transfer
			});
			window.dispatchEvent(event);
			return event.defaultPrevented;
		});
		expect(dropPrevented).toBe(true);
		await expect(page.locator('input[aria-label^="Nom du fichier"]')).toHaveCount(0);
		await page.evaluate(() =>
			(window as typeof window & { mdshReadGate: { release: () => void } }).mdshReadGate.release()
		);
		await expect(shell).toHaveAttribute('aria-busy', 'false');
		await expect(shell).not.toHaveAttribute('inert');
		await expect
			.poll(async () => (await readDrafts()).map((row) => row.content))
			.toEqual(['Document conservé avant rechargement']);

		await page.keyboard.press('ControlOrMeta+n');
		await page.getByTestId('create-note').click();
		await writeSourceContent(page, 'Création après chargement');
		const expected = ['Création après chargement', 'Document conservé avant rechargement'].sort();
		await expect
			.poll(async () => (await readDrafts()).map((row) => row.content).sort())
			.toEqual(expected);
		await page.reload();
		await expect(page.locator('.mdsh-shell[aria-busy="false"]:not([inert])')).toBeVisible();
		await expect(page.locator('.cm-content')).toContainText('Création après chargement');
		expect((await readDrafts()).map((row) => row.content).sort()).toEqual(expected);
	});

	test('lists files in the sidebar after creation', async ({ page }) => {
		await createFirstFile(page);

		// Open the sidebar because the viewport width can close it.
		const toggle = page.getByRole('button', { name: 'Afficher/masquer le panneau' });
		if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
		await expect(toggle).toHaveAttribute('aria-expanded', 'true');

		// A file item must appear in the sidebar.
		const sidebarItem = page
			.locator('aside')
			.getByText(/Sans titre/)
			.first();
		await expect(sidebarItem).toBeVisible({ timeout: 5000 });
	});
});

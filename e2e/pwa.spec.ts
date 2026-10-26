import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createFirstFile, openPalette, writeSourceContent } from './helpers';
import { expect, test } from '@playwright/test';

/**
 * §1.2 - PWA installation regression test.
 *
 * The static manifest and its document link must remain available in the built app.
 * Without this link, the browser ignores all installation features.
 *
 * Run this test against the build, where the server emits the actual manifest.
 */
test.describe('PWA - manifest', () => {
	test('links the document to the manifest', async ({ page }) => {
		await page.goto('/');

		const manifestLink = page.locator('head link[rel="manifest"]');
		await expect(manifestLink).toHaveCount(1);

		const href = await manifestLink.getAttribute('href');
		expect(href, 'href du manifest absent').toBeTruthy();
		expect(href).toContain('manifest.webmanifest');
	});

	test('serves a valid manifest with a name and icons', async ({ page, request }) => {
		await page.goto('/');
		const href = await page.locator('head link[rel="manifest"]').getAttribute('href');
		expect(href).toBeTruthy();

		const res = await request.get(new URL(href as string, page.url()).toString());
		expect(res.ok(), `manifest non servi (HTTP ${res.status()})`).toBeTruthy();

		const manifest = (await res.json()) as {
			name?: string;
			icons?: Array<{ src: string; sizes?: string }>;
		};
		expect(manifest.name).toBeTruthy();
		expect(Array.isArray(manifest.icons) && manifest.icons.length).toBeGreaterThan(0);
	});
});

/**
 * §A1.5 - Offline startup regression test from the 2026-06-16 audit.
 * The precache must contain the complete app shell: the SPA fallback document,
 * blocking Tailwind CSS, and startup JavaScript chunks. Startup must not depend
 * on the disposable runtime cache `mdsh-immutable-v1`.
 *
 * After the first online load, the test deletes the runtime cache, goes offline,
 * and reloads. Missing startup assets or an incorrect `navigateFallback` value
 * leave the page blank and cause the final assertion to time out.
 *
 * Run only in Chromium. The WebKit golden-path project does not support this flow.
 */
test.describe('PWA - offline startup from the precache', () => {
	test('starts and stays interactive offline with only the precache', async ({
		page,
		context,
		browser
	}, testInfo) => {
		// 1. Load online to register the service worker and fill the precache.
		await page.goto('/');

		// Wait for an active service worker. Its install step fills the precache before
		// `ready` resolves.
		await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));

		// 2. `registerType: 'prompt'` does not call clientsClaim. Reload after activation
		// until the service worker controls the page.
		await expect(async () => {
			await page.reload();
			expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
		}).toPass({ timeout: 30_000 });

		// 3. Delete the runtime cache. All startup assets must now come from the precache.
		await page.evaluate(() => caches.delete('mdsh-immutable-v1'));

		// 4. Go offline and reload. Only the precache can serve the app shell.
		await context.setOffline(true);
		await page.reload();

		// 5. Verify that the app shell starts and runs its entry JavaScript.
		await expect(page.locator('main').getByRole('button', { name: /Nouveau fichier/ })).toBeVisible(
			{ timeout: 15_000 }
		);

		await createFirstFile(page);
		await page.locator('button[data-mode="wysiwyg"]').click();
		await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 20_000 });
		const png = (await readFile('static/pwa-192x192.png')).toString('base64');
		await writeSourceContent(
			page,
			`# Hors ligne\n\n$e^{i\\pi}+1=0$\n\n![Image locale](data:image/png;base64,${png})`
		);
		await page.locator('button[data-mode="read"]').click();
		await expect(page.locator('.mdsh-preview math')).toBeAttached();
		await expect
			.poll(() =>
				page
					.locator('.mdsh-preview img')
					.evaluate((element) => (element as HTMLImageElement).naturalWidth)
			)
			.toBe(192);
		await openPalette(page);
		await page.getByRole('combobox').fill('Exporter en HTML');
		const downloading = page.waitForEvent('download');
		await page.keyboard.press('Enter');
		const download = await downloading;
		const output = testInfo.outputPath('first-visit-offline.html');
		await download.saveAs(output);
		const html = await readFile(output, 'utf8');
		expect(html).toContain('data:image/png;base64,');
		expect(html).toContain('data:font/woff2;base64,');
		const exportedContext = await browser.newContext({ offline: true });
		try {
			const exportedPage = await exportedContext.newPage();
			await exportedPage.goto(pathToFileURL(output).href);
			await expect(exportedPage.locator('math')).toBeAttached();
			await expect
				.poll(() =>
					exportedPage
						.locator('img')
						.evaluate((element) => (element as HTMLImageElement).naturalWidth)
				)
				.toBe(192);
		} finally {
			await exportedContext.close();
		}
		await context.setOffline(false);
	});
});

// The server exposes two actual HTML and service worker releases for one app bundle.
// The browser performs the install, wait, and activation steps.
test('recovers two dirty clients after a real update and persistence failure', async ({
	browser
}, testInfo) => {
	const { resolve } = await import('node:path');
	const { createPwaUpdateServer } = await import('./pwa-update-server');
	const server = await createPwaUpdateServer(resolve('build'));
	const context = await browser.newContext({ locale: 'fr-FR' });
	await context.addInitScript(() => {
		localStorage.setItem('mdsh:locale', 'fr');
		localStorage.setItem('mdsh:mode', 'source');
	});
	try {
		const first = await context.newPage();
		await first.goto(server.origin);
		await first.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
		await first.reload();
		await expect.poll(() => first.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
		await createFirstFile(first);
		await writeSourceContent(first, '# Premier, état durable');
		const second = await context.newPage();
		await second.goto(server.origin);
		await second.locator('aside button[aria-label^="Nouveau fichier"]').click();
		await writeSourceContent(second, '# Second, état durable');

		async function contents() {
			return first.evaluate(
				() =>
					new Promise<string[]>((resolve, reject) => {
						const request = indexedDB.open('mdsh');
						request.onerror = () => reject(request.error);
						request.onsuccess = () => {
							const database = request.result;
							const rows = database.transaction('drafts').objectStore('drafts').getAll();
							rows.onsuccess = () => {
								database.close();
								resolve(rows.result.map((row: { content: string }) => row.content).sort());
							};
							rows.onerror = () => {
								database.close();
								reject(rows.error);
							};
						};
					})
			);
		}
		await expect.poll(contents).toEqual(['# Premier, état durable', '# Second, état durable']);
		await first.evaluate(() => {
			const original = IDBObjectStore.prototype.put;
			IDBObjectStore.prototype.put = function (...args: Parameters<typeof original>) {
				if (this.name === 'drafts')
					throw new DOMException('Stockage indisponible pour le test', 'QuotaExceededError');
				return original.apply(this, args);
			};
			(window as Window & { restoreDraftWrites?: () => void }).restoreDraftWrites = () => {
				IDBObjectStore.prototype.put = original;
			};
		});
		await first.locator('.cm-content').fill('# Premier, dernière frappe non enregistrée');
		await expect(first.getByRole('alert').first()).toBeVisible();
		server.publishNextVersion();
		await first.evaluate(async () => (await navigator.serviceWorker.ready).update());
		const reloadFirst = first.getByRole('button', { name: 'Recharger', exact: true });
		const reloadSecond = second.getByRole('button', { name: 'Recharger', exact: true });
		await expect(reloadFirst).toBeVisible({ timeout: 15000 });
		await expect(reloadSecond).toBeVisible({ timeout: 15000 });
		// A persistent update notice must not cover desktop or mobile mode controls.
		for (const width of [1280, 390]) {
			await second.setViewportSize({ width, height: 844 });
			await second.locator('button[data-mode="read"]').click();
			await expect(second.locator('.mdsh-preview')).toContainText('Second, état durable');
			await second.locator('button[data-mode="source"]').click();
			await expect(second.locator('.cm-content')).toHaveText('# Second, état durable');
			await expect(reloadSecond).toBeVisible();
			await testInfo.attach(`update-notice-${width}`, {
				body: await second.screenshot(),
				contentType: 'image/png'
			});
		}
		await expect(first.locator('meta[name="pwa-test-release"]')).toHaveAttribute('content', '1');
		await expect(second.locator('meta[name="pwa-test-release"]')).toHaveAttribute('content', '1');
		await reloadFirst.click();
		await expect(
			first
				.getByRole('alert')
				.filter({ hasText: /enregistr|sauvegarde|stockage/i })
				.first()
		).toBeVisible();
		await expect
			.poll(() => first.evaluate(async () => !!(await navigator.serviceWorker.ready).waiting))
			.toBe(true);
		await expect(first.locator('.cm-content')).toHaveText(
			'# Premier, dernière frappe non enregistrée'
		);
		await expect.poll(contents).toEqual(['# Premier, état durable', '# Second, état durable']);

		// The second client activates the next version. The first client delays its reload
		// while its durability barrier fails.
		await second.locator('.cm-content').fill('# Second, dernière frappe avant activation');
		await reloadSecond.click();
		await expect(second.locator('meta[name="pwa-test-release"]')).toHaveAttribute('content', '2', {
			timeout: 15000
		});
		await expect(second.locator('.cm-content')).toHaveText(
			'# Second, dernière frappe avant activation'
		);
		await expect(first.locator('meta[name="pwa-test-release"]')).toHaveAttribute('content', '1');
		await expect(first.locator('.cm-content')).toHaveText(
			'# Premier, dernière frappe non enregistrée'
		);
		await expect
			.poll(() =>
				first.evaluate(async () => {
					const worker = navigator.serviceWorker.controller;
					if (!worker) return 0;
					return new Promise<number>((resolve) => {
						const channel = new MessageChannel();
						channel.port1.onmessage = (event) => resolve(event.data as number);
						worker.postMessage({ type: 'PWA_TEST_VERSION' }, [channel.port2]);
					});
				})
			)
			.toBe(2);
		await expect
			.poll(contents)
			.toEqual(['# Premier, état durable', '# Second, dernière frappe avant activation']);
		await first.evaluate(() =>
			(window as Window & { restoreDraftWrites?: () => void }).restoreDraftWrites?.()
		);
		// The next edit retries the save. A manual reload is then safe.
		await first.locator('.cm-content').fill('# Premier, reprise enregistrée');
		await expect
			.poll(contents)
			.toEqual(['# Premier, reprise enregistrée', '# Second, dernière frappe avant activation']);
		await first.reload();
		await expect(first.locator('meta[name="pwa-test-release"]')).toHaveAttribute('content', '2');
		await expect
			.poll(contents)
			.toEqual(['# Premier, reprise enregistrée', '# Second, dernière frappe avant activation']);
	} finally {
		await context.close();
		await server.close();
	}
});

import { test, expect } from '@playwright/test';
import { resetAppState, createFirstFile, writeSourceContent } from './helpers';

test.describe('§5.13 - Search & replace in-file (⌘F)', () => {
	test.beforeEach(async ({ page }) => {
		// `resetAppState` selects source mode by default, so CodeMirror is visible.
		await resetAppState(page);
		await createFirstFile(page);
	});

	test('opens the CodeMirror search panel and matches a pattern with ⌘F', async ({ page }) => {
		// Select source mode with an idempotent click. Do not depend on async mode
		// restoration after reload. Under CI load, the app can stay in WYSIWYG mode
		// and never show `.cm-content`.
		const sourceBtn = page.locator('button[data-mode="source"]');
		if (await sourceBtn.count()) await sourceBtn.click();
		const cm = page.locator('.cm-content').first();
		await expect(cm).toBeVisible({ timeout: 15_000 });

		// Enter content with two occurrences of "foo".
		await cm.click();
		await page.keyboard.type('# Hello');
		await page.keyboard.press('Enter');
		await page.keyboard.press('Enter');
		await page.keyboard.type('foo bar foo baz');

		// Wait for the 400 ms save delay and a margin to prevent effect races.
		await page.waitForTimeout(500);

		// Use Meta on macOS and Control on other platforms.
		const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
		await page.keyboard.press(`${mod}+f`);

		// CodeMirror renders the panel in `.cm-panels` at the bottom by default.
		// The main input has `name="search"`.
		const panel = page.locator('.cm-panels');
		await expect(panel).toBeVisible({ timeout: 5000 });

		const searchInput = panel.locator('input[name="search"]');
		await expect(searchInput).toBeVisible();
		// Type with the keyboard because the input has focus. `fill()` does not call
		// all CodeMirror handlers and can fail to apply the query.
		await page.keyboard.type('foo');

		// CodeMirror marks matches with `.cm-searchMatch`.
		await expect(page.locator('.cm-searchMatch')).toHaveCount(2, { timeout: 5000 });

		// Escape closes the panel.
		await page.keyboard.press('Escape');
		await expect(panel).toHaveCount(0, { timeout: 5000 });
	});

	test('fails closed when the replacement worker cannot start', async ({ page }, info) => {
		const source = '# Note\n\nneedle one\n\nneedle two';
		await writeSourceContent(page, source);
		await page.addInitScript(() => {
			const NativeWorker = Worker;
			window.Worker = new Proxy(NativeWorker, {
				construct(target, args) {
					if (String(args[0]).includes('replace.worker'))
						throw new Error('Worker blocked for regression proof');
					return Reflect.construct(target, args);
				}
			});
		});
		await page.reload();
		await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor({
			state: 'visible',
			timeout: 15_000
		});
		await page.keyboard.press('ControlOrMeta+Shift+f');
		await page.getByRole('combobox').fill('needle');
		await expect(page.locator('#search-listbox button').first()).toBeVisible({ timeout: 10_000 });
		await page.getByTitle('Remplacer dans tous les fichiers').click();
		await page.getByLabel('Texte de remplacement').fill('replacement');
		await page.getByRole('button', { name: 'Remplacer tout' }).click();
		const dialog = page.getByRole('dialog', { name: 'Recherche cross-fichiers' });
		await expect(dialog.getByRole('alert')).toContainText('Recherche indisponible', {
			timeout: 10_000
		});
		await expect(page.getByRole('region', { name: 'Aperçu du remplacement' })).toHaveCount(0);
		// The panel stays usable after the failure.
		await page.getByLabel('Texte de remplacement').fill('still editable');
		await expect(page.getByLabel('Texte de remplacement')).toHaveValue('still editable');
		const saved = await page.evaluate(
			() =>
				new Promise<string>((resolve, reject) => {
					const request = indexedDB.open('mdsh');
					request.onerror = () => reject(request.error);
					request.onsuccess = () => {
						const rows = request.result.transaction('drafts').objectStore('drafts').getAll();
						rows.onerror = () => reject(rows.error);
						rows.onsuccess = () => {
							request.result.close();
							const latest = rows.result
								.filter((row) => row.open !== false)
								.sort((a, b) => b.updatedAt - a.updatedAt)[0];
							resolve(latest?.content ?? '');
						};
					};
				})
		);
		expect(saved).toBe(source);
		await info.attach('replace-worker-unavailable.json', {
			body: JSON.stringify({ source, saved }),
			contentType: 'application/json'
		});
	});

	test('finds text in WYSIWYG without changing mode or content', async ({ page }) => {
		await writeSourceContent(page, 'texte un\n\ntexte deux');
		// Select WYSIWYG from the toolbar radio group.
		await page.getByRole('radio', { name: 'Mode WYSIWYG' }).click();
		// Wait for the lazy Milkdown module to mount ProseMirror.
		const editor = page.locator('.ProseMirror');
		await expect(editor.locator('p')).toHaveText(['texte un', 'texte deux'], {
			timeout: 15_000
		});

		const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
		await page.keyboard.press(`${mod}+f`);

		const find = page.getByRole('searchbox', { name: 'Rechercher dans ce document' });
		await expect(find).toBeFocused();
		await find.fill('texte');
		const results = page.locator('[data-document-navigation]').getByRole('status');
		await expect(results).toHaveText('1/2');
		await find.press('Enter');
		await expect(results).toHaveText('2/2');
		await expect(page.getByRole('radio', { name: 'Mode WYSIWYG' })).toHaveAttribute(
			'aria-checked',
			'true'
		);
		await find.press('Escape');
		await expect(find).toHaveCount(0);
		await expect(editor).toBeFocused();
		await expect(editor.locator('p')).toHaveText(['texte un', 'texte deux']);
		await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('texte');
	});
});

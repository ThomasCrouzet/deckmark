import { test, expect, type Page } from '@playwright/test';
import { resetAppState } from './helpers';

/** Seed open drafts directly so a touch test does not need the hidden drawer. */
async function seedLibrary(page: Page, count: number): Promise<void> {
	await page.evaluate(async (total) => {
		await new Promise<void>((resolve, reject) => {
			const request = indexedDB.open('mdsh');
			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				const database = request.result;
				const transaction = database.transaction('drafts', 'readwrite');
				const store = transaction.objectStore('drafts');
				const now = Date.now();
				for (let index = 0; index < total; index += 1) {
					store.put({
						id: `touch-${index}`,
						name: `touch-${index}.md`,
						content: `# Touch ${index}\n`,
						createdAt: now + index,
						updatedAt: now + index,
						order: index,
						open: true
					});
				}
				transaction.oncomplete = () => {
					database.close();
					resolve();
				};
				transaction.onerror = () => reject(transaction.error);
			};
		});
		window.localStorage.setItem('mdsh:activeId', 'touch-0');
	}, count);
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor({
		state: 'visible',
		timeout: 15_000
	});
}

// Run this spec only in the `mobile-chromium` project. The desktop viewport does
// not use the drawer.
test.describe('Mobile UI - sidebar drawer', () => {
	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(!testInfo.project.name.startsWith('mobile-'), 'mobile-only');
		await resetAppState(page);
	});

	test('hides the sidebar by default on a mobile viewport', async ({ page }) => {
		// The sidebar `<aside>` stays in the DOM but is not visible until it opens.
		const drawer = page.locator('aside').first();
		const isHiddenInitially = await drawer.evaluate((el) => {
			const r = el.getBoundingClientRect();
			// Accept an off-screen, zero-width, or hidden drawer.
			const style = getComputedStyle(el);
			return (
				style.display === 'none' || style.visibility === 'hidden' || r.right <= 0 || r.width === 0
			);
		});
		expect(isHiddenInitially).toBe(true);
	});

	test('opens the sidebar drawer from the Menu button', async ({ page }) => {
		// The mobile toolbar menu button has the "Menu" accessible name.
		await page.getByRole('button', { name: 'Menu' }).click();
		const drawer = page.locator('aside').first();
		await expect(drawer).toBeVisible();
	});

	test('Welcome CTAs are reachable without horizontal overflow on toolbar', async ({ page }) => {
		await expect(page.getByTestId('welcome-new')).toBeVisible();
		await expect(page.getByTestId('welcome-demo')).toBeVisible();
		const header = page.locator('header').first();
		const overflow = await header.evaluate((el) => {
			const r = el.getBoundingClientRect();
			return r.right > window.innerWidth + 1 || r.left < -1;
		});
		expect(overflow).toBe(false);
	});

	test('palette opens from the toolbar on mobile viewport', async ({ page }) => {
		// Palette control is always present; open via FR aria-label (locale pinned).
		await page.getByRole('button', { name: 'Palette de commandes' }).click();
		await expect(page.getByRole('dialog', { name: 'Palette de commandes' })).toBeVisible();
	});
});

test.describe('Touch-only multi-file selection', () => {
	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(!testInfo.project.name.startsWith('mobile-'), 'mobile-only');
		await resetAppState(page);
		await seedLibrary(page, 3);
		await page.getByRole('button', { name: 'Menu' }).click();
		await expect(page.locator('#files-panel')).toBeVisible();
	});

	test('selects files by tap and reaches the batch actions', async ({ page }) => {
		const toggle = page.getByTestId('selection-mode-toggle');
		await expect(toggle).toBeVisible();
		await expect(toggle).toHaveAttribute('aria-pressed', 'false');
		await expect(toggle).toHaveAccessibleName('Sélectionner plusieurs fichiers');

		const activeBefore = await page.locator('#app-toolbar input').inputValue();
		await toggle.click();
		await expect(toggle).toHaveAttribute('aria-pressed', 'true');
		await expect(toggle).toHaveAccessibleName('Terminer la sélection');

		const rows = page.locator('aside ul[aria-label*="Fichiers ouverts"] button[data-file-id]');
		await expect(rows).toHaveCount(3);
		await rows.nth(0).click();
		await rows.nth(2).click();

		// The taps build a selection and do not open the file or close the drawer.
		await expect(page.getByTestId('selection-count')).toHaveText('2 sélectionnés');
		await expect(rows.nth(0)).toHaveAttribute('aria-pressed', 'true');
		await expect(rows.nth(1)).toHaveAttribute('aria-pressed', 'false');
		await expect(rows.nth(2)).toHaveAttribute('aria-pressed', 'true');
		await expect(page.locator('#files-panel')).toBeVisible();
		await expect(page.locator('#app-toolbar input')).toHaveValue(activeBefore);

		const group = page.locator('aside [aria-label="Sélection de fichiers"]');
		await expect(group.getByRole('button', { name: 'Exporter la sélection en ZIP' })).toBeEnabled();
		await expect(group.getByRole('button', { name: 'Fermer la sélection' })).toBeEnabled();
		await expect(group.getByRole('button', { name: 'Désélectionner tout' })).toBeEnabled();

		const downloadPromise = page.waitForEvent('download');
		await group.getByRole('button', { name: 'Exporter la sélection en ZIP' }).click();
		const download = await downloadPromise;
		expect(download.suggestedFilename()).toMatch(/\.zip$/);

		await group.getByRole('button', { name: 'Désélectionner tout' }).click();
		await expect(page.getByTestId('selection-count')).toHaveText('0 sélectionnés');
		await expect(rows.nth(0)).toHaveAttribute('aria-pressed', 'false');

		await rows.nth(0).click();
		await rows.nth(2).click();
		await group.getByRole('button', { name: 'Fermer la sélection' }).click();
		await expect(rows).toHaveCount(1);

		// A normal tap after leaving the mode opens the file and closes the drawer.
		await toggle.click();
		await expect(toggle).toHaveAttribute('aria-pressed', 'false');
		await rows.first().click();
		await expect(page.locator('#files-panel')).toHaveAttribute('aria-hidden', 'true');
		await expect(page.locator('.cm-content')).toContainText('Touch');
	});

	test('supports the keyboard and starts clean after the drawer closes', async ({ page }) => {
		const toggle = page.getByTestId('selection-mode-toggle');
		await toggle.focus();
		await page.keyboard.press('Enter');
		await expect(toggle).toHaveAttribute('aria-pressed', 'true');

		const rows = page.locator('aside ul[aria-label*="Fichiers ouverts"] button[data-file-id]');
		await rows.nth(1).focus();
		await page.keyboard.press(' ');
		await expect(rows.nth(1)).toHaveAttribute('aria-pressed', 'true');
		await expect(page.getByTestId('selection-count')).toHaveText('1 sélectionnés');
		await page.keyboard.press(' ');
		await expect(rows.nth(1)).toHaveAttribute('aria-pressed', 'false');

		await page.keyboard.press('Escape');
		await expect(page.locator('#files-panel')).toHaveAttribute('aria-hidden', 'true');
		await page.getByRole('button', { name: 'Menu' }).click();
		await expect(toggle).toHaveAttribute('aria-pressed', 'false');
		await expect(page.getByTestId('selection-count')).toHaveCount(0);
		await expect(rows.nth(1)).toHaveAttribute('aria-pressed', 'false');
	});
});

test('mobile actions expose export and the document library with a neutral keyboard icon', async ({
	page
}) => {
	await resetAppState(page);
	await page.getByTestId('welcome-new').click();
	await page.getByTestId('create-note').click();
	// New notes open in Edit mode; this action bar check uses the source editor.
	await page.locator('button[data-mode="source"]').click();
	await page.locator('.cm-content').fill('# Mobile note');
	await expect(page.locator('#app-toolbar .lucide-keyboard')).toBeVisible();
	await expect(page.locator('#app-toolbar .lucide-command')).toHaveCount(0);
	await page.getByRole('button', { name: 'Actions', exact: true }).click();
	const actions = page.getByRole('dialog', { name: 'Actions', exact: true });
	await expect(actions.getByRole('button', { name: 'Exporter en PDF' })).toBeVisible();
	await actions.getByRole('button', { name: 'Bibliothèque de documents', exact: true }).click();
	await expect(page.getByRole('dialog', { name: 'Bibliothèque de documents' })).toBeVisible();
});

import { test, expect } from '@playwright/test';
import { resetAppState } from './helpers';

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

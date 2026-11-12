import { test, expect, type Page } from '@playwright/test';
import { resetAppState } from './helpers';

// Seed one project so the sidebar explorer and its New Project control exist.
async function importProjectForDrawer(page: Page): Promise<void> {
	const zip = new (await import('jszip')).default();
	zip.file('README.md', '# Projet\n');
	await page.getByRole('button', { name: 'Menu' }).click();
	await page.getByTestId('projects-open').click();
	const panel = page.getByRole('dialog', { name: 'Projets Markdown' });
	await panel.locator('input[type=file][accept=".zip"]').setInputFiles({
		name: 'projet-drawer.zip',
		mimeType: 'application/zip',
		buffer: await zip.generateAsync({ type: 'nodebuffer' })
	});
	await expect(panel.locator('select option')).toHaveCount(1);
	await panel.getByRole('button', { name: 'Fermer les projets' }).click();
	await expect(panel).toBeHidden();
	await page.getByRole('button', { name: 'Menu' }).click();
	await expect(page.locator('#files-panel')).toBeVisible();
}

const drawer = (page: Page) => page.locator('#files-panel');

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

	test('Escape cancels a nested project prompt and keeps the drawer open', async ({ page }) => {
		await importProjectForDrawer(page);
		await page.getByTestId('sidebar-new-project').click();
		const prompt = page.getByRole('dialog', { name: 'Nom du projet' });
		await expect(prompt).toBeVisible();
		await expect(prompt.locator('input')).toBeFocused();

		await page.evaluate(() => {
			const records: Array<{ defaultPrevented: boolean; composing: boolean }> = [];
			(window as unknown as { __mdshEscapeRecords: typeof records }).__mdshEscapeRecords = records;
			window.addEventListener('keydown', (event) => {
				if (event.key === 'Escape')
					records.push({ defaultPrevented: event.defaultPrevented, composing: event.isComposing });
			});
		});

		// One Escape belongs to the foreground prompt only.
		await page.keyboard.press('Escape');
		await expect(prompt).toBeHidden();
		await expect(drawer(page)).toBeVisible();
		await expect(drawer(page)).not.toHaveAttribute('aria-hidden', 'true');
		await expect(page.getByTestId('sidebar-new-project')).toBeFocused();

		// Tab and Shift+Tab stay inside the drawer after the prompt closes.
		const projectSummary = drawer(page).locator('summary').first();
		await page.keyboard.press('Tab');
		await expect(projectSummary).toBeFocused();
		await page.keyboard.press('Shift+Tab');
		await expect(page.getByTestId('sidebar-new-project')).toBeFocused();

		expect(
			await page.evaluate(
				() =>
					(window as unknown as { __mdshEscapeRecords: Array<{ defaultPrevented: boolean }> })
						.__mdshEscapeRecords
			)
		).toEqual([{ defaultPrevented: true, composing: false }]);

		// With no foreground dialog, Escape closes the drawer and only the drawer.
		await page.keyboard.press('Escape');
		await expect(drawer(page)).toHaveAttribute('aria-hidden', 'true');
		await expect(drawer(page)).toHaveAttribute('inert', '');
		await expect(drawer(page)).toHaveClass(/-translate-x-full/);
		expect(
			await page.evaluate(
				() =>
					(window as unknown as { __mdshEscapeRecords: Array<{ defaultPrevented: boolean }> })
						.__mdshEscapeRecords
			)
		).toEqual([
			{ defaultPrevented: true, composing: false },
			{ defaultPrevented: false, composing: false }
		]);

		// The closed drawer returns focus to the visible toolbar trigger.
		const menuTrigger = page.getByRole('button', { name: 'Menu' });
		await expect(menuTrigger).toBeFocused();
		await expect(menuTrigger).toBeVisible();
	});

	test('Escape cancels a deletion confirmation opened from the drawer', async ({ page }) => {
		await page.getByTestId('welcome-new').click();
		await page.getByTestId('create-note').click();
		await expect(page.locator('input[aria-label^="Nom du fichier"]')).toBeVisible();
		await page.getByRole('button', { name: 'Menu' }).click();
		await expect(drawer(page)).toBeVisible();
		const actions = drawer(page).locator('details').filter({ hasText: 'Actions du document' });
		const confirm = page.getByRole('dialog', { name: 'Déplacer ce document dans la corbeille ?' });
		const deleteButton = actions.getByRole('button', { name: /corbeille/ });

		async function openDeleteConfirm() {
			if ((await actions.getAttribute('open')) === null) await actions.locator('summary').click();
			await deleteButton.click();
			await expect(confirm).toBeVisible();
		}

		await openDeleteConfirm();
		await page.keyboard.press('Escape');
		await expect(confirm).toBeHidden();
		await expect(drawer(page)).toBeVisible();
		await expect(drawer(page)).not.toHaveAttribute('aria-hidden', 'true');
		await expect(deleteButton).toBeFocused();

		// The explicit Cancel button leaves the same state as Escape.
		await openDeleteConfirm();
		await confirm.getByRole('button', { name: 'Annuler' }).click();
		await expect(confirm).toBeHidden();
		await expect(drawer(page)).toBeVisible();
		await expect(drawer(page)).not.toHaveAttribute('aria-hidden', 'true');
		await expect(deleteButton).toBeFocused();
	});

	test('an IME composition Escape does not cancel the prompt or close the drawer', async ({
		page
	}) => {
		await importProjectForDrawer(page);
		await page.getByTestId('sidebar-new-project').click();
		const prompt = page.getByRole('dialog', { name: 'Nom du projet' });
		const input = prompt.locator('input');
		await expect(input).toBeFocused();

		await input.evaluate((element) => {
			element.dispatchEvent(
				new KeyboardEvent('keydown', {
					key: 'Escape',
					isComposing: true,
					bubbles: true,
					cancelable: true
				})
			);
		});

		await expect(prompt).toBeVisible();
		await expect(drawer(page)).toBeVisible();
		await expect(drawer(page)).not.toHaveAttribute('aria-hidden', 'true');
	});

	test('an IME composition end Escape with keyCode 229 keeps the prompt and drawer', async ({
		page
	}) => {
		await importProjectForDrawer(page);
		await page.getByTestId('sidebar-new-project').click();
		const prompt = page.getByRole('dialog', { name: 'Nom du projet' });
		const input = prompt.locator('input');
		await expect(input).toBeFocused();

		// Some engines end a composition with `isComposing` false and key code 229.
		const records = await input.evaluate((element) => {
			const seen: Array<{ keyCode: number; composing: boolean; defaultPrevented: boolean }> = [];
			const event = new KeyboardEvent('keydown', {
				key: 'Escape',
				isComposing: false,
				keyCode: 229,
				bubbles: true,
				cancelable: true
			});
			element.dispatchEvent(event);
			seen.push({
				keyCode: event.keyCode,
				composing: event.isComposing,
				defaultPrevented: event.defaultPrevented
			});
			return seen;
		});

		expect(records).toEqual([{ keyCode: 229, composing: false, defaultPrevented: false }]);
		await expect(prompt).toBeVisible();
		await expect(drawer(page)).toBeVisible();
		await expect(drawer(page)).not.toHaveAttribute('aria-hidden', 'true');
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

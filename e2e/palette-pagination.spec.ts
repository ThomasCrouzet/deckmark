import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { resetAppState, openPalette } from './helpers';

/**
 * Seeds named workspaces so the command palette has more than one page of
 * commands. A workspace contributes one "Load workspace" command.
 */
async function seedWorkspaces(page: Page, count: number): Promise<void> {
	await page.evaluate(async (total) => {
		await new Promise<void>((resolve, reject) => {
			const request = indexedDB.open('mdsh');
			request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
			request.onsuccess = () => {
				const database = request.result;
				const transaction = database.transaction('workspaces', 'readwrite');
				const store = transaction.objectStore('workspaces');
				const now = Date.now();
				for (let index = 0; index < total; index += 1) {
					store.put({
						id: `e2e-pagination-${index}`,
						name: `E2E workspace ${index.toString().padStart(3, '0')}`,
						fileIds: [],
						activeId: null,
						createdAt: now - index,
						updatedAt: now - index
					});
				}
				transaction.oncomplete = () => {
					database.close();
					resolve();
				};
				transaction.onerror = () => reject(transaction.error ?? new Error('Seed failed'));
				transaction.onabort = () => reject(transaction.error ?? new Error('Seed aborted'));
			};
		});
	}, count);
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor({
		state: 'visible',
		timeout: 15_000
	});
}

test.describe('Command palette small and disabled states', () => {
	test.beforeEach(async ({ page }) => {
		await resetAppState(page);
	});

	test('keeps small, empty and disabled states consistent with French labels', async ({
		page
	}, info) => {
		await openPalette(page);
		const dialog = page.getByRole('dialog', { name: 'Palette de commandes', exact: true });
		const listbox = page.locator('#cmd-palette-listbox');
		const input = page.getByRole('combobox');
		await expect(listbox).toBeVisible();

		// Fewer than 100 matches: no pagination action is offered.
		const initialCount = await listbox.locator(':scope > *').count();
		expect(initialCount).toBeGreaterThan(0);
		expect(initialCount).toBeLessThan(100);
		await expect(dialog.getByRole('button', { name: /Afficher .* commandes de plus/ })).toHaveCount(
			0
		);

		// A command that needs a document is announced disabled and stays inert.
		await input.fill('Mode lecture');
		await expect(listbox.locator(':scope > *')).toHaveCount(1);
		const disabled = listbox.getByRole('option');
		await expect(disabled).toHaveAttribute('aria-disabled', 'true');
		await expect(disabled).toHaveAccessibleName(/Mode lecture/);
		await expect(disabled).toHaveAttribute('aria-selected', 'true');
		await input.press('Enter');
		await expect(dialog).toBeVisible();
		await expect(page.locator('.mdsh-preview')).toHaveCount(0);
		await disabled.dispatchEvent('click');
		await expect(dialog).toBeVisible();

		// A query change keeps exactly one selected option and a live
		// active descendant, then resets to the full list.
		await input.fill('Mode');
		await expect(listbox.locator('[aria-selected="true"]')).toHaveCount(1);
		await expect(input).toHaveAttribute('aria-activedescendant', /.+/);
		await expect(listbox.locator(':scope > *').first()).toBeVisible();

		await input.fill('');
		await expect(listbox.locator(':scope > *')).toHaveCount(initialCount);

		// Pointer activation of an available command closes the palette.
		await input.fill('Créer un document');
		const available = listbox.getByRole('option').first();
		await expect(available).not.toHaveAttribute('aria-disabled', 'true');
		await available.click();
		await expect(dialog).not.toBeVisible();

		await info.attach('palette-small-states.json', {
			body: JSON.stringify({
				initialCount,
				disabledLabel: 'Mode lecture',
				pointerActivation: 'Créer un document'
			}),
			contentType: 'application/json'
		});
	});
});

test.describe('Command palette pagination accessibility', () => {
	test.beforeEach(async ({ page }) => {
		await resetAppState(page);
		await seedWorkspaces(page, 220);
	});

	test('keeps the Show more control outside the listbox and pages with the keyboard', async ({
		page
	}, info) => {
		await openPalette(page);
		const dialog = page.getByRole('dialog', { name: 'Palette de commandes', exact: true });
		const listbox = page.locator('#cmd-palette-listbox');
		await expect(listbox).toBeVisible();

		// The first page is capped at 100 options.
		await expect(listbox.locator(':scope > *')).toHaveCount(100);
		// Every owned child of the listbox must be an option or a named group.
		await expect(listbox.locator(':scope > :not([role="option"]):not([role="group"])')).toHaveCount(
			0
		);
		await expect(listbox.getByRole('button')).toHaveCount(0);

		const showMore = dialog.getByRole('button', { name: /Afficher .* commandes de plus/ });
		await expect(showMore).toBeVisible();

		// A keyboard user reaches the action with Tab and activates it with Enter.
		await page.getByRole('combobox').focus();
		// Walk the popup tab order. The close control and, on engines that make a
		// scroll container tabbable, the listbox can come first.
		for (let step = 0; step < 5; step += 1) {
			if (await showMore.evaluate((element) => element === document.activeElement)) break;
			await page.keyboard.press('Tab');
		}
		await expect(showMore).toBeFocused();
		await page.keyboard.press('Enter');

		// The next page renders, the query text is unchanged, and the combobox
		// keeps the focus so arrow navigation continues.
		await expect(listbox.locator(':scope > *')).toHaveCount(200);
		await expect(page.getByRole('combobox')).toHaveValue('');
		await expect(page.getByRole('combobox')).toBeFocused();
		await expect(dialog.locator('#cmd-palette-pagination-status')).toContainText('200');

		// The option beyond the first page is reachable and announced through
		// aria-activedescendant.
		for (let index = 0; index < 100; index += 1) await page.keyboard.press('ArrowDown');
		const selected = page.locator('#cmd-palette-listbox > [aria-selected="true"]');
		await expect(selected).toHaveCount(1);
		const optionId = await selected.getAttribute('id');
		const option101Id = await listbox.locator(':scope > *').nth(100).getAttribute('id');
		expect(optionId).toBe(option101Id);
		await expect(page.getByRole('combobox')).toHaveAttribute('aria-activedescendant', optionId!);

		// The paginated state has no serious or critical axe violation.
		await page.evaluate(async () => {
			await Promise.all(
				document.getAnimations().map((animation) => animation.finished.catch(() => {}))
			);
		});
		const results = await new AxeBuilder({ page }).include('.mdsh-dialog-panel').analyze();
		const blocking = results.violations.filter(
			(violation) => violation.impact === 'critical' || violation.impact === 'serious'
		);
		expect(
			blocking.map((violation) => ({
				id: violation.id,
				impact: violation.impact,
				targets: violation.nodes.map((node) => node.target)
			}))
		).toEqual([]);

		await info.attach('palette-pagination.json', {
			body: JSON.stringify({
				firstPageOptions: 100,
				secondPageOptions: 200,
				activeDescendant: optionId,
				blockingViolations: blocking.length
			}),
			contentType: 'application/json'
		});

		// A query change resets the page cap and the empty state stays a listbox
		// with one option.
		await page.getByRole('combobox').fill('zzzz-no-such-command');
		await expect(listbox.locator(':scope > *')).toHaveCount(1);
		await expect(listbox.locator('[role="option"]')).toHaveCount(1);
		await expect(dialog.getByRole('button', { name: /Afficher .* commandes de plus/ })).toHaveCount(
			0
		);
		await expect(listbox.getByText('Aucune commande.')).toBeVisible();

		await page.getByRole('combobox').fill('');
		await expect(listbox.locator(':scope > *')).toHaveCount(100);
	});
});

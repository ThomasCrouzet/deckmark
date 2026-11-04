import { expect, test } from '@playwright/test';
import { resetAppState } from './helpers';

for (const locale of ['en', 'fr'] as const) {
	for (const width of [320, 390, 768, 1024, 1280, 1600]) {
		test(`compact toolbar keeps document actions reachable at ${width} in ${locale}`, async ({
			page
		}, info) => {
			await page.setViewportSize({ width, height: 900 });
			await resetAppState(page);
			await page.evaluate((value) => localStorage.setItem('mdsh:locale', value), locale);
			await page.reload();
			await page.getByTestId('welcome-new').click();
			await page.getByTestId('create-note').click();
			const toolbar = page.locator('#app-toolbar');
			const title = toolbar.locator('input');
			await title.fill('A clear plan for the next release');
			await title.press('Enter');
			await expect(title).toHaveValue('A clear plan for the next release');
			const observations = [];
			for (const mode of ['source', 'read', 'wysiwyg']) {
				const button = toolbar.locator(`button[data-mode="${mode}"]`);
				await expect(button.locator('span')).toBeVisible();
				await button.click();
				await expect(button).toHaveAttribute('aria-checked', 'true');
				const geometry = await toolbar.evaluate((element) => {
					const box = element.getBoundingClientRect();
					return {
						height: box.height,
						width: box.width,
						pageOverflow: document.documentElement.scrollWidth > innerWidth,
						controls: [...element.querySelectorAll('button, input')]
							.filter((control) => control.getClientRects().length > 0)
							.map((control) => {
								const bounds = control.getBoundingClientRect();
								return {
									name: control.getAttribute('aria-label'),
									width: bounds.width,
									height: bounds.height,
									inside:
										bounds.left >= box.left - 1 &&
										bounds.right <= box.right + 1 &&
										bounds.top >= box.top - 1 &&
										bounds.bottom <= box.bottom + 1
								};
							})
					};
				});
				observations.push({ mode, ...geometry });
				expect.soft(geometry.height).toBeLessThanOrEqual(width >= 1024 ? 56 : 106);
				expect.soft(geometry.pageOverflow).toBe(false);
				expect.soft(geometry.controls.filter((control) => !control.inside)).toEqual([]);
				if (width <= 768)
					expect
						.soft(geometry.controls.filter((control) => control.width < 44 || control.height < 44))
						.toEqual([]);
			}
			await info.attach('toolbar-geometry.json', {
				body: JSON.stringify({ locale, viewport: { width, height: 900 }, observations }, null, 2),
				contentType: 'application/json'
			});
			await info.attach('toolbar.png', { body: await page.screenshot(), contentType: 'image/png' });
			await toolbar.locator('[data-actions-trigger]').click();
			const actions = page.getByRole('dialog', { name: 'Actions', exact: true });
			await expect(actions).toBeVisible();
			await page.keyboard.press('Escape');
			await expect(toolbar.locator('[data-actions-trigger]')).toBeFocused();
			await page.keyboard.press('ControlOrMeta+Shift+p');
			await expect(page.getByRole('combobox')).toBeFocused();
			await page.keyboard.press('Escape');
		});
	}
}

import { expect, test } from '@playwright/test';
import { createFirstFile, resetAppState, writeSourceContent } from './helpers';

test('reading mode shows bullets and numbering while task lists keep only their checkboxes', async ({
	page
}, testInfo) => {
	await resetAppState(page);
	await page.keyboard.press('ControlOrMeta+,');
	await page.getByRole('button', { name: 'Système', exact: true }).click();
	await page.keyboard.press('Escape');
	await createFirstFile(page);
	const fixture =
		'# Reading lists\n\n- First bullet\n  - Nested bullet\n    - Deep bullet\n- Second bullet\n\n3. Third item\n4. Fourth item\n   1. Nested number\n\n- [ ] Pending task\n- [x] Completed task';
	await writeSourceContent(page, fixture);
	await page.locator('button[data-mode="wysiwyg"]').click();
	await expect(page.locator('.ProseMirror')).toContainText('Deep bullet');
	await page.locator('button[data-mode="read"]').click();
	const article = page.locator('.mdsh-preview');
	for (const colorScheme of ['light', 'dark'] as const) {
		await page.emulateMedia({ colorScheme });
		await expect(page.locator('html')).toHaveAttribute('data-theme', colorScheme);
		await expect(article.locator('ul').first()).toHaveCSS('list-style-type', 'disc');
		await expect(article.locator('ul ul').first()).toHaveCSS('list-style-type', 'circle');
		await expect(article.locator('ul ul ul')).toHaveCSS('list-style-type', 'square');
		await expect(article.locator('ol').first()).toHaveCSS('list-style-type', 'decimal');
		await expect(article.locator('ol').first()).toHaveAttribute('start', '3');
		await expect(article.locator('ol ol')).toHaveCSS('list-style-type', 'decimal');
		for (const item of await article.locator('li:not(.task-list-item)').all()) {
			await expect(item).toHaveCSS('display', 'list-item');
		}
		for (const task of await article.locator('.task-list-item').all()) {
			await expect(task).toHaveCSS('list-style-type', 'none');
			await expect(task.locator('input[type="checkbox"]')).toBeVisible();
		}
		await expect(article.locator('.task-list-item')).toHaveCount(2);
		await testInfo.attach(`reading-lists-${colorScheme}`, {
			body: await article.screenshot(),
			contentType: 'image/png'
		});
	}
	await testInfo.attach('list-fixture', { body: fixture, contentType: 'text/markdown' });
	await page.getByTestId('slides-open').click();
	const slide = page.getByTestId('slide-canvas');
	await expect(slide.locator('.task-list-item')).toHaveCount(2);
	for (const task of await slide.locator('.task-list-item').all()) {
		await expect(task).toHaveCSS('list-style-type', 'none');
	}
	await testInfo.attach('slide-lists', {
		body: await page.screenshot(),
		contentType: 'image/png'
	});
});

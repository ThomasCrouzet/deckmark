import { test, expect } from '@playwright/test';
import { createFirstFile, resetAppState, writeSourceContent } from './helpers';

const fixture = [
	'# Split preview',
	'',
	'Opening paragraph.',
	'',
	'## Middle section',
	'',
	'Middle paragraph.',
	'',
	'## Final section',
	'',
	'Final paragraph.',
	'',
	'<script>window.__splitUnsafe = true</script>'
].join('\n');

test.beforeEach(async ({ page }) => {
	await resetAppState(page);
	await createFirstFile(page);
	await writeSourceContent(page, fixture);
});

test('keeps one editable source and renders a sanitized delayed preview', async ({
	page
}, testInfo) => {
	const toggle = page.getByRole('button', { name: 'Afficher l’aperçu' });
	await expect(toggle).toHaveAttribute('aria-pressed', 'false');
	await toggle.click();
	await expect(page.getByRole('button', { name: 'Masquer l’aperçu' })).toHaveAttribute(
		'aria-pressed',
		'true'
	);

	const split = page.getByTestId('split-view');
	await expect(split).toBeVisible();
	await expect(split.locator('.cm-content')).toHaveCount(1);
	await expect(split.getByRole('region', { name: 'Aperçu du rendu' })).toContainText(
		'Final paragraph.'
	);
	await expect(split.locator('script')).toHaveCount(0);
	await expect
		.poll(() => page.evaluate(() => (window as Window & { __splitUnsafe?: boolean }).__splitUnsafe))
		.toBeUndefined();

	const editor = split.locator('.cm-content');
	await editor.click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.insertText('\nDelayed update marker');
	expect(await split.getByRole('region', { name: 'Aperçu du rendu' }).textContent()).not.toContain(
		'Delayed update marker'
	);
	await expect(split.getByRole('region', { name: 'Aperçu du rendu' })).toContainText(
		'Delayed update marker'
	);

	await page.getByRole('button', { name: 'Masquer l’aperçu' }).click();
	await expect(page.getByTestId('split-view')).toHaveCount(0);
	await page.locator('.cm-content').focus();
	await page.keyboard.press('ControlOrMeta+z');
	await expect(page.locator('.cm-content')).not.toContainText('Delayed update marker');

	await testInfo.attach('split-view-fixture', { body: fixture, contentType: 'text/markdown' });
	await testInfo.attach('split-view', {
		body: await page.screenshot(),
		contentType: 'image/png'
	});
});

test('resizes with the keyboard and restores the saved split', async ({ page }) => {
	await page.getByRole('button', { name: 'Afficher l’aperçu' }).click();
	const separator = page.getByRole('separator', {
		name: 'Redimensionner la source et l’aperçu'
	});
	await expect(separator).toHaveAttribute('aria-valuenow', '50');
	await separator.focus();
	await page.keyboard.press('ArrowRight');
	await expect(separator).toHaveAttribute('aria-valuenow', '55');

	await page.reload();
	await expect(page.getByRole('button', { name: 'Masquer l’aperçu' })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
	await expect(
		page.getByRole('separator', { name: 'Redimensionner la source et l’aperçu' })
	).toHaveAttribute('aria-valuenow', '55');
});

test('synchronizes sections and stacks both panes on a narrow screen', async ({ page }) => {
	await page.getByRole('button', { name: 'Afficher l’aperçu' }).click();
	const split = page.getByTestId('split-view');
	const editor = split.locator('.cm-content');
	await editor.click();
	await page.keyboard.press('ControlOrMeta+End');
	await expect(split.getByRole('heading', { name: 'Final section' })).toBeInViewport();

	await page.setViewportSize({ width: 390, height: 720 });
	await expect(page.getByRole('separator')).toHaveAttribute('aria-orientation', 'horizontal');
	await expect
		.poll(async () => {
			const sourceBox = await split.getByRole('region', { name: 'Source Markdown' }).boundingBox();
			const previewBox = await split.getByRole('region', { name: 'Aperçu du rendu' }).boundingBox();
			return sourceBox !== null && previewBox !== null && previewBox.y > sourceBox.y;
		})
		.toBe(true);
});

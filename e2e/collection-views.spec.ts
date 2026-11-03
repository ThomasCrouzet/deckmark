import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { openPalette, resetAppState, seedFiles } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

const files = [
	{
		name: 'Alpha',
		content: '---\ntitle: Alpha\ntags: [docs]\nstatus: active\npriority: 2\n---\n\n# Alpha\n'
	},
	{
		name: 'Beta',
		content: '---\ntitle: Beta\ntags: [review]\nstatus: done\npriority: 1\n---\n\n# Beta\n'
	},
	{
		name: 'Gamma',
		content: '---\ntitle: Gamma\ntags: [docs]\nstatus: active\npriority: 3\n---\n\n# Gamma\n'
	}
];

async function openCollection(page: Page) {
	await openPalette(page);
	await page
		.getByRole('dialog', { name: 'Palette de commandes' })
		.getByRole('option', { name: /vues tableau/i })
		.click();
	await expect(page.getByTestId('collection-panel')).toBeVisible();
	await expect(page.getByTestId('collection-table')).toBeVisible();
}

test('filters, sorts and groups note properties', async ({ page }, info: TestInfo) => {
	await resetAppState(page);
	await seedFiles(page, files);
	await openCollection(page);
	const table = page.getByTestId('collection-table');
	await expect(table).toContainText('Alpha');
	await expect(table).toContainText('Beta');
	await expect(table).toContainText('Gamma');

	await page.getByTestId('collection-filter').fill('docs');
	await expect(table).toContainText('Alpha');
	await expect(table).not.toContainText('Beta');
	await page.getByTestId('collection-filter').fill('');

	await page.getByTestId('collection-sort').selectOption('priority');
	await page.getByTestId('collection-direction').click();
	const firstRow = table.locator('tbody tr').first();
	await expect(firstRow).toContainText('Gamma');

	await page.getByTestId('collection-group').selectOption('status');
	await page.getByRole('button', { name: 'Tableau blanc' }).click();
	await expect(page.getByTestId('collection-board')).toContainText('active');
	await expect(page.getByTestId('collection-board')).toContainText('done');

	await page.getByPlaceholder('Nom de la vue').fill('Active docs');
	await page.getByTestId('collection-save-view').click();
	await page.keyboard.press('Escape');
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	await openCollection(page);
	await expect(page.getByTestId('collection-views')).toContainText('Active docs');
	await page.getByTestId('collection-views').selectOption({ label: 'Active docs' });
	await expect(page.getByTestId('collection-filter')).toHaveValue('');

	await info.attach('collection-views.json', {
		body: JSON.stringify({ files: files.length, savedView: 'Active docs', grouped: true }),
		contentType: 'application/json'
	});
	await info.attach('collection-views.png', { body: await page.screenshot() });
});

test('opens a note from the table', async ({ page }) => {
	await resetAppState(page);
	await seedFiles(page, files);
	await openCollection(page);
	await page.getByTestId('collection-table').getByRole('button', { name: 'Beta' }).click();
	await expect(page.getByTestId('collection-panel')).toHaveCount(0);
	await expect(page.locator('.cm-content')).toContainText('# Beta');
});

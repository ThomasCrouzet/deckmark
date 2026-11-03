import { expect, test, type TestInfo } from '@playwright/test';
import { openPalette, resetAppState, seedFiles } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

async function openSemantic(page: import('@playwright/test').Page) {
	await openPalette(page);
	await page
		.getByRole('dialog', { name: 'Palette de commandes' })
		.getByRole('option', { name: /index de recherche local/i })
		.click();
	await expect(page.getByTestId('semantic-panel')).toBeVisible();
}

test('builds, searches and clears a local index without network access', async ({
	page
}, info: TestInfo) => {
	let external = 0;
	page.on('request', (request) => {
		const url = request.url();
		if (
			!url.startsWith('http://127.0.0.1:4174') &&
			!url.startsWith('data:') &&
			!url.startsWith('blob:')
		)
			external++;
	});
	await resetAppState(page);
	await seedFiles(page, [
		{ name: 'Guide', content: '# Guide\n\nDocumentation for the editor.\n' },
		{ name: 'Recipe', content: '# Recipe\n\nCooking instructions.\n' }
	]);
	await openSemantic(page);
	await expect(page.getByTestId('semantic-enabled')).not.toBeChecked();
	await page.getByTestId('semantic-enabled').check();
	await page.getByTestId('semantic-index').click();
	await expect(page.getByTestId('semantic-panel')).toContainText('2 document');
	await page.getByTestId('semantic-query').fill('document');
	await expect(page.getByTestId('semantic-hit').first()).toContainText('Guide');
	await page.getByTestId('semantic-hit').first().click();
	await expect(page.getByTestId('semantic-panel')).toHaveCount(0);
	await expect(page.locator('.cm-content')).toContainText('Documentation');

	await openSemantic(page);
	await expect(page.getByTestId('semantic-enabled')).toBeChecked();
	await page.getByTestId('semantic-clear').click();
	await expect(page.getByTestId('semantic-panel')).toContainText('0 document');
	expect(external).toBe(0);

	await info.attach('semantic-search.json', {
		body: JSON.stringify({ indexed: 2, query: 'document', externalRequests: external }),
		contentType: 'application/json'
	});
});

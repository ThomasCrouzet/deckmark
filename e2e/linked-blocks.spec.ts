import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { openPalette, resetAppState, seedFiles, writeSourceContent } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

const source =
	'# Source\n\n<!-- mdsh-block id="intro" -->\nCanonical paragraph.\n<!-- /mdsh-block -->\n';

async function sourceText(page: Page): Promise<string> {
	return page
		.locator('.cm-content .cm-line')
		.evaluateAll((lines) => lines.map((line) => line.textContent).join('\n'));
}

async function openBlocks(page: Page) {
	await openPalette(page);
	await page
		.getByRole('dialog', { name: 'Palette de commandes' })
		.getByRole('option', { name: /blocs de contenu liés/i })
		.click();
	await expect(page.getByTestId('linked-blocks-panel')).toBeVisible();
}

test('inserts, updates, freezes and detaches a linked block', async ({ page }, info: TestInfo) => {
	await resetAppState(page);
	await seedFiles(page, [
		{ name: 'Source', content: source },
		{ name: 'Consumer', content: '# Consumer\n\nIntro follows.\n' }
	]);
	await openBlocks(page);
	await page.getByTestId('blocks-source').selectOption({ index: 0 });
	await page.getByTestId('blocks-insert').click();
	await expect(page.locator('.cm-content')).toContainText('Canonical paragraph.');
	expect(await sourceText(page)).toContain('mdsh-include');

	await page.keyboard.press('Escape');
	await page
		.locator('aside')
		.getByRole('button', { name: /^Source/ })
		.first()
		.click();
	await writeSourceContent(
		page,
		'# Source\n\n<!-- mdsh-block id="intro" -->\nUpdated paragraph.\n<!-- /mdsh-block -->\n'
	);
	await page
		.locator('aside')
		.getByRole('button', { name: /^Consumer/ })
		.first()
		.click();
	await openBlocks(page);
	await expect(page.getByTestId('link-changed')).toBeVisible();
	await page.getByRole('button', { name: 'Mettre à jour' }).click();
	await expect(page.locator('.cm-content')).toContainText('Updated paragraph.');
	await expect(page.locator('.cm-content')).not.toContainText('Canonical paragraph.');

	await page.getByRole('button', { name: 'Figer l’instantané' }).click();
	await expect(page.getByTestId('link-frozen')).toBeVisible();

	await page.getByRole('button', { name: 'Détacher' }).click();
	await expect(page.locator('.cm-content')).toContainText('Updated paragraph.');
	expect(await sourceText(page)).not.toContain('mdsh-include');

	await info.attach('linked-blocks.json', {
		body: JSON.stringify({ inserted: true, updated: true, frozen: true, detached: true }),
		contentType: 'application/json'
	});
	await info.attach('linked-blocks.png', { body: await page.screenshot() });
});

test('inserts the selected block when one file defines several blocks', async ({
	page
}, info: TestInfo) => {
	await resetAppState(page);
	await seedFiles(page, [
		{
			name: 'Source',
			content:
				'<!-- mdsh-block id="alpha" -->\nAAA\n<!-- /mdsh-block -->\n\n' +
				'<!-- mdsh-block id="beta" -->\nBBB\n<!-- /mdsh-block -->\n'
		},
		{ name: 'Consumer', content: '# Consumer\n\nIntro follows.\n' }
	]);
	await openBlocks(page);
	await page.getByTestId('blocks-source').selectOption({ index: 1 });
	await page.getByTestId('blocks-insert').click();
	const inserted = await sourceText(page);
	expect(inserted).toContain('block="beta"');
	expect(inserted).toContain('BBB');
	expect(inserted).not.toContain('AAA');
	await info.attach('linked-blocks-multiple.json', {
		body: JSON.stringify({ inserted }),
		contentType: 'application/json'
	});
});

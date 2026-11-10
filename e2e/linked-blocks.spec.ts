import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { openPalette, resetAppState, seedFiles, writeSourceContent } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

async function importProject(
	page: Page,
	name: string,
	files: Record<string, string>
): Promise<void> {
	const zip = new (await import('jszip')).default();
	for (const [path, content] of Object.entries(files)) zip.file(path, content);
	await page.getByTestId('projects-open').click();
	const panel = page.getByRole('dialog', { name: 'Projets Markdown' });
	await panel.locator('input[type=file][accept=".zip"]').setInputFiles({
		name: `${name}.zip`,
		mimeType: 'application/zip',
		buffer: await zip.generateAsync({ type: 'nodebuffer' })
	});
	await panel.getByRole('button', { name: 'Fermer les projets' }).click();
}

async function openProjectDocument(page: Page, project: string, folder: string, path: string) {
	const root = page.locator(`[data-project-root-name="${project}"]`);
	const details = root.locator('details').first();
	if ((await details.getAttribute('open')) === null) await root.locator('summary').first().click();
	const group = root.locator(`[data-project-folder="${folder}"]`);
	const groupDetails = group.locator('details').first();
	if ((await groupDetails.getAttribute('open')) === null)
		await group.locator('summary').first().click();
	await root.locator(`[data-project-document="${path}"] button[data-file-id]`).click();
}

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

test('offers only same-project sources and inserts project B content', async ({
	page
}, info: TestInfo) => {
	await resetAppState(page);
	await importProject(page, 'Alpha', {
		'README.md': '# Alpha\n',
		'docs/secret.md': '<!-- mdsh-block id="part" -->\nA-only\n<!-- /mdsh-block -->\n'
	});
	await importProject(page, 'Beta', {
		'notes/consumer.md': '# Consumer\n\nIntro follows.\n',
		'docs/local.md': '<!-- mdsh-block id="part" -->\nB-local\n<!-- /mdsh-block -->\n'
	});
	await openProjectDocument(page, 'Beta', 'notes', 'notes/consumer.md');
	await openBlocks(page);
	const options = page.getByTestId('blocks-source').locator('option');
	await expect(options).toHaveCount(1);
	await expect(options.first()).toContainText('docs/local.md');
	await expect(page.getByTestId('blocks-source')).not.toContainText('docs/secret.md');
	await page.getByTestId('blocks-source').selectOption({ index: 0 });
	await page.getByTestId('blocks-insert').click();
	await expect(page.locator('.cm-content')).toContainText('B-local');
	await expect(page.locator('.cm-content')).not.toContainText('A-only');
	const inserted = await sourceText(page);
	expect(inserted).toContain('source="docs/local.md"');
	await expect(page.getByTestId('link-current')).toBeVisible();
	await info.attach('linked-blocks-project-scope.json', {
		body: JSON.stringify({ options: await options.allTextContents(), inserted }),
		contentType: 'application/json'
	});
	await info.attach('linked-blocks-project-scope.png', { body: await page.screenshot() });
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

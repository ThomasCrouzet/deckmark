import { expect, test, type Locator, type Page } from '@playwright/test';
import { createFirstFile, resetAppState, writeSourceContent } from './helpers';

test.use({ locale: 'fr-FR', reducedMotion: 'reduce' });

const actionsDialog = (page: Page) => page.getByRole('dialog', { name: 'Actions', exact: true });

async function openActions(page: Page) {
	await page.locator('[data-actions-trigger]').click();
	await expect(actionsDialog(page)).toBeVisible();
}

async function clickAction(page: Page, name: string) {
	await openActions(page);
	await actionsDialog(page).getByRole('button', { name, exact: true }).click();
}

async function mockSavePicker(page: Page, name: string) {
	await page.evaluate(async (target) => {
		const root = await navigator.storage.getDirectory();
		const handle = await root.getFileHandle(target, { create: true });
		Object.defineProperty(window, 'showSaveFilePicker', {
			configurable: true,
			value: async () => handle
		});
	}, name);
}

function readOpfs(page: Page, name: string): Promise<string> {
	return page.evaluate(async (target) => {
		const root = await navigator.storage.getDirectory();
		const handle = await root.getFileHandle(target);
		return (await handle.getFile()).text();
	}, name);
}

/** Visible buttons that render exactly one glyph, with normalized SVG markup. */
async function glyphs(buttons: Locator) {
	return buttons.evaluateAll((elements) =>
		elements
			.filter((element) => element.getClientRects().length > 0 && element.querySelector('svg'))
			.map((element) => ({
				name: element.getAttribute('aria-label') ?? element.textContent?.trim() ?? '',
				glyph: element.querySelector('svg')!.innerHTML.replace(/\s+/g, ' ')
			}))
	);
}

test('the toolbar keeps Save and Export, and labels the disk writes in Actions', async ({
	page
}, info) => {
	await resetAppState(page);
	await createFirstFile(page);
	const toolbar = page.locator('#app-toolbar');

	await expect(toolbar.getByTestId('save-document')).toBeVisible();
	await expect(toolbar.getByRole('button', { name: 'Exporter', exact: true })).toBeVisible();
	// Issue #721: these actions moved to the labeled Actions menu.
	await expect(toolbar.getByTestId('save-as')).toHaveCount(0);
	await expect(toolbar.getByTestId('save-to-disk')).toHaveCount(0);
	await expect(toolbar.getByRole('button', { name: 'Exporter en PDF', exact: true })).toHaveCount(
		0
	);

	await openActions(page);
	const labels = [
		'Enregistrer',
		'Enregistrer sous',
		'Enregistrer sur le disque',
		'Télécharger',
		'Exporter en PDF'
	];
	for (const label of labels)
		await expect(
			actionsDialog(page).getByRole('button', { name: label, exact: true })
		).toBeVisible();

	await info.attach('actions-menu.json', {
		body: JSON.stringify({ toolbar: ['Enregistrer', 'Exporter'], actions: labels }, null, 2),
		contentType: 'application/json'
	});
	await info.attach('actions-menu.png', { body: await page.screenshot() });
});

test('toolbar Save, menu Save As, menu Save to disk and toolbar Export still work', async ({
	page
}, info) => {
	await resetAppState(page);
	await createFirstFile(page);
	await writeSourceContent(page, '# Actions\n\nFirst body');

	// Save to disk works from the Actions menu and links the draft.
	await mockSavePicker(page, 'disk-copy.md');
	await clickAction(page, 'Enregistrer sur le disque');
	await expect.poll(() => readOpfs(page, 'disk-copy.md')).toContain('First body');

	// The toolbar Save writes the linked file in place.
	await writeSourceContent(page, '# Actions\n\nSecond body');
	await page.getByTestId('save-document').click();
	await expect.poll(() => readOpfs(page, 'disk-copy.md')).toContain('Second body');

	// Save As writes a second file and keeps the link unchanged.
	await mockSavePicker(page, 'actions-copy.md');
	await clickAction(page, 'Enregistrer sous');
	await expect.poll(() => readOpfs(page, 'actions-copy.md')).toContain('Second body');
	expect(await readOpfs(page, 'disk-copy.md')).toContain('Second body');

	// Export stays on the toolbar.
	const pending = page.waitForEvent('download');
	await page.locator('#app-toolbar').getByRole('button', { name: 'Exporter', exact: true }).click();
	const download = await pending;
	expect(download.suggestedFilename()).toMatch(/\.md$/);

	await info.attach('actions-workflow.json', {
		body: JSON.stringify(
			{
				savedToDisk: await readOpfs(page, 'disk-copy.md'),
				savedAs: await readOpfs(page, 'actions-copy.md'),
				exported: download.suggestedFilename()
			},
			null,
			2
		),
		contentType: 'application/json'
	});
	await info.attach('actions-workflow.png', { body: await page.screenshot() });
});

test('Save and Export use distinct glyphs in the toolbar and the Actions menu', async ({
	page
}, info) => {
	await resetAppState(page);
	await createFirstFile(page);

	const toolbarGlyphs = await glyphs(page.locator('#app-toolbar button'));
	const toolbarDuplicates = toolbarGlyphs.filter(
		(entry, index) => toolbarGlyphs.findIndex((other) => other.glyph === entry.glyph) !== index
	);
	expect(toolbarGlyphs.length).toBeGreaterThan(4);
	expect(toolbarDuplicates).toEqual([]);
	const toolbarSave = toolbarGlyphs.find((entry) => entry.name === 'Enregistrer');
	const toolbarExport = toolbarGlyphs.find((entry) => entry.name === 'Exporter');
	expect(toolbarSave).toBeDefined();
	expect(toolbarExport).toBeDefined();
	expect(toolbarSave!.glyph).not.toBe(toolbarExport!.glyph);

	await openActions(page);
	const actionGlyphs = await glyphs(actionsDialog(page).locator('button'));
	const names = ['Enregistrer', 'Enregistrer sous', 'Enregistrer sur le disque', 'Télécharger'];
	const cluster = actionGlyphs.filter((entry) => names.includes(entry.name));
	expect(cluster).toHaveLength(names.length);
	expect(new Set(cluster.map((entry) => entry.glyph)).size).toBe(cluster.length);

	await info.attach('glyph-map.json', {
		body: JSON.stringify({ toolbar: toolbarGlyphs, actions: cluster }, null, 2),
		contentType: 'application/json'
	});
	await info.attach('glyph-map.png', { body: await page.screenshot() });
});

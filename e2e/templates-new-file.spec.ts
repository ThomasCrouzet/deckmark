import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createFirstFile, openPalette, resetAppState, writeSourceContent } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

async function openNewDocument(page: Page) {
	await page.locator('aside button[aria-label^="Nouveau fichier"]').first().click();
	const dialog = page.getByRole('dialog', { name: 'Créer un document' });
	await expect(dialog).toBeVisible();
	await expect(page.getByTestId('create-template-builtin:readme')).toBeVisible();
	return dialog;
}

async function sourceText(page: Page): Promise<string> {
	await page.locator('button[data-mode="source"]').click();
	await expect(page.locator('.cm-content').first()).toBeVisible();
	return page
		.locator('.cm-content .cm-line')
		.evaluateAll((lines) => lines.map((line) => line.textContent).join('\n'));
}

test('offers built-in starters and creates them in Edit', async ({ page }, info: TestInfo) => {
	await resetAppState(page);
	await createFirstFile(page);
	const dialog = await openNewDocument(page);
	for (const id of ['readme', 'specification', 'incident', 'personal-notes']) {
		await expect(page.getByTestId(`create-template-builtin:${id}`)).toBeVisible();
	}

	await page.getByTestId('template-search').fill('incident');
	await expect(page.getByTestId('create-template-builtin:readme')).toHaveCount(0);
	await page.getByTestId('create-template-builtin:incident').click();
	await expect(dialog).toHaveCount(0);
	await expect(page.locator('[data-mode="wysiwyg"]')).toHaveAttribute('aria-checked', 'true');
	await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 20_000 });
	await expect(page.locator('.ProseMirror')).toContainText('Incident -');

	const content = await sourceText(page);
	expect(content).toContain('# Incident -');
	expect(content).toContain('## Root cause');
	expect(content).toContain('## Follow-up');

	await info.attach('builtin-templates.json', {
		body: JSON.stringify({ template: 'builtin:incident', content }, null, 2),
		contentType: 'application/json'
	});
});

test('creates a user template from a note and reuses it after reload', async ({
	page
}, info: TestInfo) => {
	await resetAppState(page);
	await createFirstFile(page);
	const original = '# Personal procedure\n\nKeep this exact text.';
	await writeSourceContent(page, original);
	await openPalette(page);
	const palette = page.getByRole('dialog', { name: 'Palette de commandes' });
	await palette.getByRole('option', { name: /Enregistrer le fichier comme modèle/ }).click();
	const prompt = page.getByRole('dialog', { name: 'Nom du modèle ?' });
	await prompt.locator('input').fill('Procédure perso');
	await prompt.getByRole('button', { name: 'Enregistrer le modèle', exact: true }).click();
	await expect(page.getByText('Modèle enregistré.')).toBeVisible();

	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	const dialog = await openNewDocument(page);
	await page.getByTestId('template-search').fill('Procédure');
	const template = dialog.getByRole('button', { name: /Procédure perso/ });
	await expect(template).toBeVisible();
	await template.click();
	await expect(page.locator('[data-mode="wysiwyg"]')).toHaveAttribute('aria-checked', 'true');
	await expect(page.locator('.ProseMirror')).toContainText('Personal procedure');

	const content = await sourceText(page);
	expect(content).toContain(original);

	await info.attach('user-template.json', {
		body: JSON.stringify({ original, content, persistedAfterReload: true }, null, 2),
		contentType: 'application/json'
	});
	await info.attach('user-template.png', { body: await page.screenshot() });
});

test('saves a presentation as a template and creates a new deck', async ({
	page
}, info: TestInfo) => {
	await resetAppState(page);
	await createFirstFile(page);
	await openNewDocument(page);
	await page.getByTestId('create-presentation').click();
	await expect(page.getByTestId('presentation-editor')).toBeVisible({ timeout: 20_000 });

	await page.getByTestId('slide-advanced').click();
	await page.getByTestId('slide-save-template').click();
	const prompt = page.getByRole('dialog', { name: 'Nom du modèle ?' });
	await prompt.locator('input').fill('Deck modèle');
	await prompt.getByRole('button', { name: 'Enregistrer le modèle', exact: true }).click();
	await expect(page.getByText('Modèle enregistré.')).toBeVisible();

	await page.locator('aside button[aria-label^="Nouveau fichier"]').first().click();
	await expect(page.getByTestId('create-template-builtin:readme')).toBeVisible();
	await page.getByTestId('template-search').fill('Deck');
	const template = page
		.getByRole('dialog', { name: 'Créer un document' })
		.getByRole('button', { name: /Deck modèle/ });
	await expect(template).toContainText('Présentation');
	await template.click();
	await expect(page.getByTestId('presentation-editor')).toBeVisible({ timeout: 20_000 });
	await expect(page.getByTestId('document-kind')).toHaveText('Présentation');

	await info.attach('presentation-template.json', {
		body: JSON.stringify({
			template: 'Deck modèle',
			kind: await page.getByTestId('document-kind').innerText(),
			slides: await page.locator('[data-testid="presentation-editor"]').innerText()
		}),
		contentType: 'application/json'
	});
});

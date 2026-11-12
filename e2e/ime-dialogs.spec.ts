import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { resetAppState } from './helpers';

async function dispatchEscape(
	locator: Locator,
	options: { composing?: boolean; legacyKeyCode?: boolean } = {}
) {
	return locator.evaluate(
		(element, value) => {
			const event = new KeyboardEvent('keydown', {
				key: 'Escape',
				bubbles: true,
				cancelable: true,
				isComposing: value.composing
			});
			if (value.legacyKeyCode) Object.defineProperty(event, 'keyCode', { value: 229 });
			element.dispatchEvent(event);
			return event.defaultPrevented;
		},
		{ composing: options.composing ?? true, legacyKeyCode: options.legacyKeyCode ?? false }
	);
}

async function openCommand(page: Page, label: string) {
	await page.keyboard.press('ControlOrMeta+Shift+P');
	const palette = page.getByRole('dialog', { name: 'Palette de commandes' });
	await expect(palette).toBeVisible();
	await palette.locator('input[type="text"]').fill(label);
	await page.keyboard.press('Enter');
}

async function attach(info: TestInfo, name: string, value: unknown) {
	await info.attach(name, {
		body: JSON.stringify(value, null, 2),
		contentType: 'application/json'
	});
}

test('keeps cross-file search open for composing Escape', async ({ page }, info) => {
	await resetAppState(page);
	await openCommand(page, 'Recherche cross-fichiers');
	const dialog = page.getByRole('dialog', { name: 'Recherche cross-fichiers' });
	await expect(dialog).toBeVisible();
	const input = dialog.getByRole('combobox');
	await expect(input).toBeFocused();

	const composing = await dispatchEscape(input, { composing: true });
	await expect(dialog).toBeVisible();
	const legacy = await dispatchEscape(input, { legacyKeyCode: true });
	await expect(dialog).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();
	await attach(info, 'ime-search.json', { composing, legacy, normal: 'closed' });
});

test('keeps the command palette open for composing Escape', async ({ page }, info) => {
	await resetAppState(page);
	await page.keyboard.press('ControlOrMeta+Shift+P');
	const palette = page.getByRole('dialog', { name: 'Palette de commandes' });
	await expect(palette).toBeVisible();
	const input = palette.locator('input[type="text"]');
	await expect(input).toBeFocused();

	await dispatchEscape(input, { composing: true });
	await expect(palette).toBeVisible();
	await dispatchEscape(input, { legacyKeyCode: true });
	await expect(palette).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(palette).toBeHidden();
	await attach(info, 'ime-palette.json', { composing: 'kept open', legacy: 'kept open' });
});

test('keeps an unsaved snippet form for composing Escape', async ({ page }, info) => {
	await resetAppState(page);
	await openCommand(page, 'extraits');
	const snippets = page.getByTestId('snippets-dialog');
	await expect(snippets).toBeVisible({ timeout: 20_000 });
	await page.getByTestId('snippet-new').click();
	const title = page.getByTestId('snippet-title');
	await expect(title).toBeFocused();
	await title.fill('Composition draft');

	await dispatchEscape(title, { composing: true });
	await expect(page.getByTestId('snippet-form')).toBeVisible();
	await expect(title).toHaveValue('Composition draft');
	await dispatchEscape(title, { legacyKeyCode: true });
	await expect(title).toHaveValue('Composition draft');
	await expect(snippets).toBeVisible();

	await page.keyboard.press('Escape');
	await expect(page.getByTestId('snippet-form')).toHaveCount(0);
	await expect(snippets).toBeVisible();
	await attach(info, 'ime-snippets.json', {
		titleAfterComposition: 'Composition draft',
		formAfterNormalEscape: 'closed',
		dialog: 'open'
	});
	await info.attach('ime-snippets.png', { body: await page.screenshot() });
});

test('keeps the New Document code form for composing Escape', async ({ page }, info) => {
	await resetAppState(page);
	await page
		.locator('aside')
		.getByRole('button', { name: /Nouveau fichier|New file/ })
		.first()
		.click();
	await expect(page.getByTestId('create-note')).toBeVisible();
	await page.getByTestId('create-code').click();
	const name = page.getByTestId('create-code-name');
	await expect(page.getByTestId('create-code-language')).toBeFocused();
	await name.fill('draft.py');

	await dispatchEscape(name, { composing: true });
	await expect(name).toBeVisible();
	await expect(page.getByTestId('create-code')).toHaveAttribute('aria-expanded', 'true');
	await dispatchEscape(name, { legacyKeyCode: true });
	await expect(name).toHaveValue('draft.py');

	await page.keyboard.press('Escape');
	await expect(page.getByTestId('create-code-name')).toHaveCount(0);
	await expect(page.getByTestId('create-code')).toHaveAttribute('aria-expanded', 'false');
	await expect(page.getByTestId('create-code')).toBeFocused();
	await attach(info, 'ime-new-document.json', {
		valueAfterComposition: 'draft.py',
		focusAfterEscape: 'create-code'
	});
});

test('keeps Settings open for composing Escape', async ({ page }, info) => {
	await resetAppState(page);
	await page.keyboard.press('ControlOrMeta+,');
	const settings = page.getByRole('dialog', { name: 'Réglages' });
	await expect(settings).toBeVisible();
	const field = settings.getByTestId('ai-model');
	await expect(settings.getByRole('button', { name: 'Fermer' })).toBeFocused();
	await settings.getByTestId('ai-settings').locator('summary').click();
	await field.click();
	await expect(field).toBeFocused();

	await dispatchEscape(field, { composing: true });
	await expect(settings).toBeVisible();
	await dispatchEscape(field, { legacyKeyCode: true });
	await expect(settings).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(settings).toBeHidden();
	await attach(info, 'ime-settings.json', { composing: 'kept open', legacy: 'kept open' });
});

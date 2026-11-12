import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { resetAppState } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

async function openNewDocument(page: Page) {
	await page
		.locator('aside')
		.getByRole('button', { name: /Nouveau fichier|New file/ })
		.first()
		.click();
	await expect(page.getByTestId('create-note')).toBeVisible();
}

async function activeRow(page: Page) {
	return page.evaluate(
		() =>
			new Promise<{ name: string; content: string; kind?: string } | null>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const rows = request.result.transaction('drafts').objectStore('drafts').getAll();
					rows.onerror = () => reject(rows.error);
					rows.onsuccess = () => {
						const active = rows.result.find((row) => row.open !== false);
						request.result.close();
						resolve(active ?? null);
					};
				};
			})
	);
}

test('creates a code file with the selected language and extension', async ({
	page
}, info: TestInfo) => {
	await resetAppState(page);
	await openNewDocument(page);
	await page.getByTestId('create-code').click();
	await page.getByTestId('create-code-language').selectOption('python');
	await expect(page.getByTestId('create-code-name')).toHaveValue(/\.py$/);
	await page.getByTestId('create-code-submit').click();

	await expect(page.getByTestId('code-editor')).toBeVisible({ timeout: 20_000 });
	await expect(page.getByTestId('code-language')).toHaveText('Python');
	await expect(page.getByTestId('document-kind')).toHaveText(/Code/);
	await expect(page.locator('.cm-content')).toHaveText('');
	await expect.poll(async () => (await activeRow(page))?.name).toMatch(/\.py$/);
	const row = await activeRow(page);
	expect(row?.kind).toBe('code');
	expect(row?.content).toBe('');

	await info.attach('created-code.json', {
		body: JSON.stringify(row),
		contentType: 'application/json'
	});
});

test('creates a valid JSON file from the direct choice', async ({ page }, info: TestInfo) => {
	await resetAppState(page);
	await openNewDocument(page);
	await page.getByTestId('create-json').click();

	await expect(page.getByTestId('code-editor')).toBeVisible({ timeout: 20_000 });
	await expect(page.getByTestId('code-language')).toHaveText('JSON');
	await expect(page.getByTestId('json-status')).toBeVisible();
	await expect(page.locator('.cm-content')).toHaveText('{}');
	await expect.poll(async () => (await activeRow(page))?.name).toMatch(/\.json$/);

	await page.reload();
	await expect(page.getByTestId('code-language')).toHaveText('JSON');
	await expect(page.getByTestId('document-kind')).toHaveText(/Code/);
	await expect(page.locator('.cm-content')).toHaveText('{}');

	await info.attach('created-json.json', {
		body: JSON.stringify(await activeRow(page)),
		contentType: 'application/json'
	});
});

test('returns focus to Create Code after Escape closes the code form', async ({ page }, info) => {
	await resetAppState(page);
	await openNewDocument(page);
	const codeButton = page.getByTestId('create-code');
	await codeButton.click();
	const language = page.getByTestId('create-code-language');
	await expect(language).toBeFocused();

	await page.keyboard.press('Escape');
	await expect(page.getByTestId('create-code-submit')).toHaveCount(0);
	await expect(codeButton).toHaveAttribute('aria-expanded', 'false');
	await expect(codeButton).toBeFocused();

	await page.keyboard.press('Tab');
	const nextFocus = await page.evaluate(() => {
		const active = document.activeElement;
		return {
			testId: active instanceof HTMLElement ? (active.dataset.testid ?? null) : null,
			tag: active?.tagName ?? null,
			insideDialog: !!active?.closest('[role="dialog"]')
		};
	});
	expect(nextFocus.insideDialog).toBe(true);
	expect(nextFocus.tag).not.toBe('BODY');

	await codeButton.focus();
	await page.keyboard.press('Shift+Tab');
	const reverseFocus = await page.evaluate(() => {
		const active = document.activeElement;
		return {
			tag: active?.tagName ?? null,
			insideDialog: !!active?.closest('[role="dialog"]')
		};
	});
	expect(reverseFocus.insideDialog).toBe(true);
	expect(reverseFocus.tag).not.toBe('BODY');

	await codeButton.focus();
	await page.keyboard.press('Enter');
	await expect(page.getByTestId('create-code-language')).toBeFocused();
	await info.attach('code-form-focus.json', {
		body: JSON.stringify({
			afterEscape: 'create-code',
			nextFocus,
			reverseFocus,
			afterReopen: 'create-code-language'
		}),
		contentType: 'application/json'
	});
});

test('returns focus to Create Code at a narrow viewport', async ({ page }, info) => {
	await page.setViewportSize({ width: 375, height: 812 });
	await resetAppState(page);
	await page.getByTestId('welcome-new').click();
	await expect(page.getByTestId('create-note')).toBeVisible();
	const codeButton = page.getByTestId('create-code');
	await codeButton.click();
	await expect(page.getByTestId('create-code-language')).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(codeButton).toBeFocused();
	await expect(codeButton).toHaveAttribute('aria-expanded', 'false');
	const dialogBox = await page.getByRole('dialog').boundingBox();
	expect(dialogBox).not.toBeNull();
	expect(dialogBox!.width).toBeLessThanOrEqual(375);
	await info.attach('code-form-focus-mobile.json', {
		body: JSON.stringify({ viewport: '375x812', activeTestId: 'create-code', dialogBox }),
		contentType: 'application/json'
	});
});

test('returns focus to Create Code after the Cancel button closes the code form', async ({
	page
}, info) => {
	await resetAppState(page);
	await openNewDocument(page);
	const codeButton = page.getByTestId('create-code');

	await codeButton.click();
	const enterName = page.getByTestId('create-code-name');
	await expect(enterName).toBeVisible();
	await enterName.fill('enter.py');
	await page.getByTestId('create-code-cancel').focus();
	await page.keyboard.press('Enter');
	await expect(page.getByTestId('create-code-name')).toHaveCount(0);
	await expect(page.getByTestId('create-code-submit')).toHaveCount(0);
	await expect(codeButton).toHaveAttribute('aria-expanded', 'false');
	await expect(codeButton).toBeFocused();
	expect(await page.getByTestId('code-editor').count()).toBe(0);

	await codeButton.click();
	const name = page.getByTestId('create-code-name');
	await expect(name).toBeVisible();
	await name.fill('draft.py');
	await page.getByTestId('create-code-cancel').focus();
	await page.keyboard.press('Space');
	await expect(page.getByTestId('create-code-submit')).toHaveCount(0);
	await expect(codeButton).toBeFocused();
	expect(await page.getByTestId('code-editor').count()).toBe(0);

	await codeButton.click();
	const pointerName = page.getByTestId('create-code-name');
	await expect(pointerName).toBeVisible();
	await pointerName.fill('pointer.py');
	await page.getByTestId('create-code-cancel').click();
	await expect(page.getByTestId('create-code-submit')).toHaveCount(0);
	await expect(codeButton).toHaveAttribute('aria-expanded', 'false');
	await expect(codeButton).toBeFocused();
	expect(await page.getByTestId('code-editor').count()).toBe(0);
	await info.attach('code-form-cancel-focus.json', {
		body: JSON.stringify({
			keyboardActivation: ['Enter', 'Space'],
			pointerActivation: 'click',
			activeTestId: 'create-code',
			codeEditors: 0
		}),
		contentType: 'application/json'
	});
});

test('does not refocus a removed code form after an early close', async ({ page }, info) => {
	await resetAppState(page);
	await openNewDocument(page);
	const codeButton = page.getByTestId('create-code');
	await codeButton.click();
	await page.keyboard.press('Escape');
	await expect(codeButton).toBeFocused();
	await page.waitForTimeout(250);
	await expect(codeButton).toBeFocused();
	expect(await page.getByTestId('create-code-language').count()).toBe(0);
	await info.attach('code-form-early-close.json', {
		body: JSON.stringify({ activeTestId: 'create-code', delayMs: 250 }),
		contentType: 'application/json'
	});
});

test('does not return focus into a code form after the dialog closes', async ({ page }, info) => {
	await resetAppState(page);
	await openNewDocument(page);
	await page.getByTestId('create-code').click();
	await page
		.getByRole('dialog')
		.getByRole('button', { name: /^(Annuler|Cancel)$/ })
		.last()
		.click();
	await expect(page.getByTestId('create-code')).toHaveCount(0);
	await page.waitForTimeout(250);
	const active = await page.evaluate(() => ({
		testId:
			document.activeElement instanceof HTMLElement
				? (document.activeElement.dataset.testid ?? null)
				: null,
		tag: document.activeElement?.tagName ?? null
	}));
	expect(active.testId).not.toBe('create-code-language');
	expect(active.testId).not.toBe('create-code-name');
	await info.attach('code-form-dialog-close.json', {
		body: JSON.stringify(active),
		contentType: 'application/json'
	});
});

test('handles name collisions and rejects a mismatched extension', async ({
	page
}, info: TestInfo) => {
	await resetAppState(page);
	await openNewDocument(page);
	await page.getByTestId('create-code').click();
	await page.getByTestId('create-code-language').selectOption('rust');
	await page.getByTestId('create-code-submit').click();
	await expect(page.getByTestId('code-language')).toHaveText('Rust');

	await openNewDocument(page);
	await page.getByTestId('create-code').click();
	await page.getByTestId('create-code-language').selectOption('rust');
	await page.getByTestId('create-code-submit').click();
	const second = page
		.locator('aside')
		.getByRole('button', { name: /\(2\)\.rs/ })
		.first();
	await expect(second).toBeVisible();
	await expect(second).toContainText('Sans titre (2).rs');

	await openNewDocument(page);
	await page.getByTestId('create-code').click();
	await page.getByTestId('create-code-language').selectOption('python');
	await page.getByTestId('create-code-name').fill('wrong.rs');
	await expect(page.getByTestId('create-code-error')).toBeVisible();
	await expect(page.getByTestId('create-code-submit')).toBeDisabled();
	await page.getByTestId('create-code-cancel').click();
	await expect(page.getByTestId('create-code-submit')).toHaveCount(0);

	await info.attach('code-creation-collision.json', {
		body: JSON.stringify({
			secondName: await page
				.locator('aside')
				.getByRole('button', { name: /\(2\)\.rs/ })
				.first()
				.innerText()
		}),
		contentType: 'application/json'
	});
});

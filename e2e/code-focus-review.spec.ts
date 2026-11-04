import { expect, test, type Page } from '@playwright/test';
import { resetAppState } from './helpers';

test.use({ serviceWorkers: 'block' });

async function holdCodeEditor(page: Page) {
	let release = () => {};
	let requested = false;
	const gate = new Promise<void>((resolve) => (release = resolve));
	await page.route('**/*', async (route) => {
		if (route.request().resourceType() !== 'script') return route.continue();
		const response = await route.fetch();
		if ((await response.text()).includes('code editor load')) {
			requested = true;
			await gate;
		}
		await route.fulfill({ response });
	});
	return { release, requested: () => requested };
}

async function openSnippets(page: Page) {
	await page.keyboard.press('ControlOrMeta+Shift+P');
	const palette = page.getByRole('dialog', { name: 'Palette de commandes' });
	await palette.locator('input[type="text"]').fill('extraits');
	await expect(palette.getByRole('option').first()).toContainText('Extraits de code');
	await page.keyboard.press('Enter');
	await expect(page.getByTestId('snippets-dialog').locator('section').first()).toHaveAttribute(
		'aria-busy',
		'false'
	);
}

async function finishMountFrames(page: Page) {
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			)
	);
}

test('keeps title typing in the title when the snippet editor loads late', async ({
	page,
	context
}, info) => {
	await context.grantPermissions(['clipboard-read', 'clipboard-write']);
	await resetAppState(page);
	const loading = await holdCodeEditor(page);
	await openSnippets(page);
	await page.getByTestId('snippet-new').click();
	const title = page.getByTestId('snippet-title');
	try {
		await expect.poll(loading.requested).toBe(true);
		await title.fill('Print');
		await expect(title).toBeFocused();
	} finally {
		loading.release();
	}
	const editor = page.getByTestId('snippet-code').locator('.cm-content');
	await expect(editor).toBeVisible();
	await finishMountFrames(page);
	await page.keyboard.insertText(' project');
	await info.attach('focus-after-load.json', {
		body: JSON.stringify({
			title: await title.inputValue(),
			code: await editor.innerText(),
			focused: await page.evaluate(() => document.activeElement?.outerHTML)
		}),
		contentType: 'application/json'
	});
	await expect(title).toHaveValue('Print project');
	await expect(title).toBeFocused();
	await expect(editor).toHaveText('');
	const code = 'print("café project")\n';
	await editor.click();
	await page.keyboard.insertText(code);
	await page.getByTestId('snippet-save').click();
	await expect(page.getByTestId('snippet-detail-title')).toHaveText('Print project');
	await expect(page.getByTestId('snippet-detail').locator('.cm-content')).toBeVisible();
	await finishMountFrames(page);
	await expect(page.getByTestId('snippet-search')).toBeFocused();
	await page.keyboard.press('Enter');
	await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(code);
	await page.getByTestId('snippet-favorite').click();
	await expect(page.getByTestId('snippet-favorite')).toHaveAttribute('aria-pressed', 'true');
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	await openSnippets(page);
	await expect(page.getByTestId('snippet-detail-title')).toHaveText('Print project');
	await expect(page.getByTestId('snippet-favorite')).toHaveAttribute('aria-pressed', 'true');
	await expect(page.getByTestId('snippet-detail').locator('.cm-content')).toBeVisible();
	await finishMountFrames(page);
	await expect(page.getByTestId('snippet-search')).toBeFocused();
	await page.evaluate(() => navigator.clipboard.writeText(''));
	await page.keyboard.press('Enter');
	await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(code);
	const clipboard = await page.evaluate(() => navigator.clipboard.readText());
	expect(clipboard).toBe(code);
	await info.attach('saved-snippet.json', {
		body: JSON.stringify({
			title: await page.getByTestId('snippet-detail-title').innerText(),
			clipboard,
			favorite: true
		}),
		contentType: 'application/json'
	});
	await info.attach('saved-snippet.png', {
		body: await page.screenshot(),
		contentType: 'image/png'
	});
});

test('focuses a new code document when no control has focus', async ({ page }, info) => {
	await resetAppState(page);
	const loading = await holdCodeEditor(page);
	await page.locator('input[type="file"][accept*="text/markdown"]').setInputFiles({
		name: 'initial-focus.py',
		mimeType: 'text/plain',
		buffer: Buffer.from('print("initial")\n')
	});
	try {
		await expect.poll(loading.requested).toBe(true);
		expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
	} finally {
		loading.release();
	}
	const editor = page.getByTestId('code-editor').locator('.cm-content');
	await expect(editor).toBeFocused();
	await page.keyboard.press('ControlOrMeta+Home');
	await page.keyboard.insertText('# Ready\n');
	await expect(editor).toHaveText('# Readyprint("initial")');
	await info.attach('initial-focus.json', {
		body: JSON.stringify({
			code: await editor.innerText(),
			focused: await editor.evaluate((node) => node === document.activeElement)
		}),
		contentType: 'application/json'
	});
});

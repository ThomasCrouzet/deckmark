import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { createFirstFile, resetAppState } from './helpers';

test.use({ reducedMotion: 'reduce', serviceWorkers: 'block' });

const png = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lYQ7WQAAAABJRU5ErkJggg==',
	'base64'
);

for (const fixture of [
	{ name: 'script.py', mimeType: 'text/x-python', buffer: Buffer.from('print("hello")\n') },
	{ name: 'pixel.png', mimeType: 'image/png', buffer: png }
]) {
	test(`rename preserves the extension and bytes of ${fixture.name}`, async ({ page }, info) => {
		await resetAppState(page);
		await page.locator('input[type="file"][accept*="text/markdown"]').setInputFiles(fixture);
		const input = page.locator('#app-toolbar input');
		await input.fill('renamed');
		await input.press('Enter');
		const expected = `renamed.${fixture.name.split('.').at(-1)}`;
		await expect(page.locator('aside button[data-file-id]')).toContainText(expected);
		const downloadPromise = page.waitForEvent('download');
		await page
			.locator('#app-toolbar')
			.getByRole('button', { name: 'Exporter', exact: true })
			.click();
		const download = await downloadPromise;
		expect(download.suggestedFilename()).toBe(expected);
		const bytes = await readFile((await download.path())!);
		expect(bytes.equals(fixture.buffer)).toBe(true);
		await info.attach(expected, { body: bytes, contentType: fixture.mimeType });
		await expect(page.locator('#app-toolbar .title-save')).toHaveText('enregistré');
		await page.reload();
		await expect(page.locator('aside button[data-file-id]')).toContainText(expected);
		await info.attach('renamed.png', { body: await page.screenshot(), contentType: 'image/png' });
	});
}

test('a delayed note editor does not interrupt file-name input', async ({ page }, info) => {
	await resetAppState(page);
	// Wait for the welcome screen before the CSS gate. The gate must delay the
	// editor load, not the first render of the screen that starts the action.
	await page.locator('main [data-testid="welcome-new"]').waitFor({ state: 'visible' });
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	let delayed = 0;
	await page.route('**/_app/immutable/assets/*.css', async (route) => {
		delayed++;
		await gate;
		await route.continue();
	});
	try {
		await createFirstFile(page);
		await expect.poll(() => delayed).toBeGreaterThan(0);
		const input = page.locator('#app-toolbar input');
		await input.fill('A name entered during load');
		release();
		await expect(page.locator('.ProseMirror')).toBeVisible();
		await expect(input).toBeFocused();
		await input.press('End');
		await page.keyboard.type(' and completed');
		await input.press('Enter');
		await expect(input).toHaveValue('A name entered during load and completed');
		await expect(page.locator('aside button[data-file-id]')).toHaveAccessibleName(
			'A name entered during load and completed'
		);
		await info.attach('focus.png', { body: await page.screenshot(), contentType: 'image/png' });
	} finally {
		release();
	}
});

test('renaming a note leaves code literals unchanged', async ({ page }, info) => {
	await resetAppState(page);
	const code = 'print("[[target]]")\n';
	await page.locator('input[type="file"][accept*="text/markdown"]').setInputFiles([
		{ name: 'target.md', mimeType: 'text/markdown', buffer: Buffer.from('# Target\n') },
		{ name: 'script.py', mimeType: 'text/plain', buffer: Buffer.from(code) }
	]);
	await page.locator('aside button[data-file-id][aria-label^="target"]').click();
	const input = page.locator('#app-toolbar input');
	await input.fill('renamed');
	await input.press('Enter');
	await expect(page.locator('aside button[data-file-id][aria-label^="renamed"]')).toBeVisible();
	await page.locator('aside button[data-file-id][aria-label^="script.py"]').click();
	const downloadPromise = page.waitForEvent('download');
	await page.getByRole('button', { name: 'Exporter', exact: true }).click();
	const download = await downloadPromise;
	const bytes = await readFile((await download.path())!);
	expect(bytes.toString()).toBe(code);
	await info.attach('script.py', { body: bytes, contentType: 'text/plain' });
});

test('a new document in another window appears without changing the active draft', async ({
	page,
	context
}, info) => {
	await resetAppState(page);
	await createFirstFile(page);
	const currentName = await page.locator('#app-toolbar input').inputValue();
	const other = await context.newPage();
	try {
		await other.goto('/');
		await other.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
		await other.locator('input[type="file"][accept*="text/markdown"]').setInputFiles({
			name: 'captured.md',
			mimeType: 'text/markdown',
			buffer: Buffer.from('# Captured elsewhere\n')
		});
		await expect(page.locator('aside button[data-file-id][aria-label^="captured"]')).toBeVisible();
		await expect(page.locator('#app-toolbar input')).toHaveValue(currentName);
		await page.locator('aside button[data-file-id][aria-label^="captured"]').click();
		await page.locator('#app-toolbar [data-mode="source"]').click();
		await expect(page.locator('.cm-content')).toContainText('Captured elsewhere');
		await info.attach('cross-window.png', {
			body: await page.screenshot(),
			contentType: 'image/png'
		});
	} finally {
		await other.close();
	}
});

import { expect, test } from '@playwright/test';
import { createFirstFile, openPalette, resetAppState, writeSourceContent } from './helpers';

for (const mode of ['read', 'wysiwyg'] as const) {
	test(`updates ${mode} diagrams when the system theme changes`, async ({ page }, testInfo) => {
		await page.emulateMedia({ colorScheme: 'light' });
		await resetAppState(page);
		await page.keyboard.press('ControlOrMeta+,');
		await page.getByRole('button', { name: 'Système', exact: true }).click();
		await page.keyboard.press('Escape');
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
		await createFirstFile(page);
		await writeSourceContent(page, '```mermaid\ngraph LR\nA --> B\n```');
		await page.locator(`button[data-mode="${mode}"]`).click();
		const node = page
			.locator(
				mode === 'read' ? '.mdsh-preview svg .node rect' : '.mdsh-mermaid-svg svg .node rect'
			)
			.first();
		await expect(node).toBeVisible();
		const light = await node.evaluate((element) => getComputedStyle(element).fill);
		await page.emulateMedia({ colorScheme: 'dark' });
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
		await expect
			.poll(() => node.evaluate((element) => getComputedStyle(element).fill))
			.not.toBe(light);
		await testInfo.attach(`system-theme-${mode}`, {
			body: await page.screenshot(),
			contentType: 'image/png'
		});
	});
}

test('keeps shorter fences inside a presentation code sample', async ({ page }, testInfo) => {
	await resetAppState(page);
	await createFirstFile(page);
	const fixture =
		'# First slide\n\n````markdown\n```js\n---\n```\nInside the sample\n````\n\n---\n\n# Last slide';
	await writeSourceContent(page, fixture);
	await openPalette(page);
	await page.getByRole('combobox').fill('Présentation');
	await page.keyboard.press('Enter');
	const dialog = page.getByRole('dialog');
	await expect(dialog).toContainText('1 / 2');
	await expect(dialog.locator('pre')).toContainText('Inside the sample');
	await page.keyboard.press('ArrowRight');
	await expect(dialog).toContainText('2 / 2');
	await expect(dialog.locator('h1')).toHaveText('Last slide');
	await testInfo.attach('presentation-fixture', { body: fixture, contentType: 'text/markdown' });
	await testInfo.attach('presentation-last-slide', {
		body: await page.screenshot(),
		contentType: 'image/png'
	});
});

test('shows source headings after a horizontal rule without front matter', async ({
	page
}, testInfo) => {
	await resetAppState(page);
	await createFirstFile(page);
	const fixture = '---\n\n# Visible heading\n\nText.';
	await writeSourceContent(page, fixture);
	await openPalette(page);
	await page.getByRole('combobox').fill('Plan du document');
	await page.keyboard.press('Enter');
	await expect(
		page.locator('[data-document-navigation]').getByRole('button', { name: 'Visible heading' })
	).toBeVisible();
	await testInfo.attach('outline-fixture', { body: fixture, contentType: 'text/markdown' });
});

test('an hourly update failure leaves the offline editor usable', async ({
	page,
	context
}, testInfo) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await page.clock.install();
	await page.goto('/');
	await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
	await expect(async () => {
		await page.reload();
		expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
	}).toPass({ timeout: 30_000 });
	await expect(page.locator('.mdsh-shell[aria-busy="false"]')).toBeVisible();
	await createFirstFile(page);
	await context.setOffline(true);
	await page.clock.fastForward(60 * 60 * 1000 + 1000);
	await writeSourceContent(page, '# Offline after one hour');
	await expect(page.locator('.cm-content')).toContainText('Offline after one hour');
	expect(errors).toEqual([]);
	await testInfo.attach('offline-errors', {
		body: JSON.stringify(errors),
		contentType: 'application/json'
	});
});

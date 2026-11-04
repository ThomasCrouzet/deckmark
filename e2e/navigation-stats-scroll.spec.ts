import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createFirstFile, resetAppState, seedFiles, writeSourceContent } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

async function seedTwo(page: Page) {
	await seedFiles(page, [
		{ name: 'First', content: 'Premier document.' },
		{ name: 'Second', content: 'Second document.' }
	]);
}

test('the logo opens the start view and keeps tabs and pending edits', async ({
	page
}, info: TestInfo) => {
	await resetAppState(page);
	await seedTwo(page);
	const editor = page.locator('.cm-content').first();
	await editor.click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.insertText(' Modification non enregistrée.');

	const logo = page.getByTestId('home-logo');
	await logo.click();
	await expect(page.getByTestId('welcome-new')).toBeVisible();
	await expect(
		page.locator('main').getByRole('button', { name: /Retrouver vos documents/ })
	).toBeVisible();
	await expect(
		page
			.locator('aside')
			.getByRole('button', { name: /^First/ })
			.first()
	).toBeVisible();
	await expect(
		page
			.locator('aside')
			.getByRole('button', { name: /^Second/ })
			.first()
	).toBeVisible();

	await page
		.locator('aside')
		.getByRole('button', { name: /^Second/ })
		.first()
		.click();
	await expect(page.locator('.cm-content').first()).toContainText('Modification non enregistrée.');

	await logo.focus();
	await expect(logo).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(page.getByTestId('welcome-new')).toBeVisible();

	await info.attach('logo-home.json', {
		body: JSON.stringify({
			welcomeVisible: true,
			libraryCount: await page
				.locator('main')
				.getByRole('button', { name: /Retrouver vos documents/ })
				.innerText(),
			unsavedContentKept: true
		}),
		contentType: 'application/json'
	});
	await info.attach('logo-home.png', { body: await page.screenshot() });
});

test('counts the current selection in Source, Edit and Read', async ({ page }, info: TestInfo) => {
	await resetAppState(page);
	await createFirstFile(page);
	const content = 'Un cœur 🎉\n\nDeuxième ligne';
	await writeSourceContent(page, content);
	const expected = await page.evaluate((text) => {
		const trimmed = text.trim();
		return {
			chars: Array.from(text).length,
			words: trimmed.split(/\s+/u).length,
			lines: text.split('\n').length
		};
	}, content);

	const status = page.getByTestId('document-stats');
	const selection = page.getByTestId('selection-stats');
	const source = page.locator('.cm-content').first();
	await source.click();
	await page.keyboard.press('ControlOrMeta+a');
	await expect(selection).toBeVisible();
	await expect(status).toContainText(`${expected.words} mots`);
	await expect(status).toContainText(`${expected.chars} car.`);
	await expect(status).toContainText(`${expected.lines} lignes`);

	await page.keyboard.press('ArrowRight');
	await expect(selection).toHaveCount(0);
	await expect(status).toContainText(`${expected.words} mots`);

	await page.locator('button[data-mode="wysiwyg"]').click();
	const visual = page.locator('.ProseMirror');
	await expect(visual).toBeVisible({ timeout: 20_000 });
	await visual.click();
	await page.keyboard.press('ControlOrMeta+a');
	await expect(selection).toBeVisible();
	await expect(status).toContainText(`${expected.words} mots`);

	await page.locator('button[data-mode="read"]').click();
	const paragraph = page.locator('.mdsh-preview p').first();
	await expect(paragraph).toBeVisible();
	await paragraph.selectText();
	await expect(selection).toBeVisible();
	const readText = await page.evaluate(() => window.getSelection()?.toString() ?? '');
	await expect(status).toContainText(`${Array.from(readText).length} car.`);

	await info.attach('selection-stats.json', {
		body: JSON.stringify({ content, expected, readText }, null, 2),
		contentType: 'application/json'
	});
	await info.attach('selection-stats.png', { body: await page.screenshot() });
});

test('scroll controls reach both ends of long notes in every mode', async ({
	page
}, info: TestInfo) => {
	await resetAppState(page);
	await createFirstFile(page);
	const long = Array.from({ length: 160 }, (_, index) => `Ligne ${index + 1}.`).join('\n\n');
	await writeSourceContent(page, long);
	const top = page.getByTestId('scroll-top');
	const bottom = page.getByTestId('scroll-bottom');

	await page.locator('.cm-scroller').evaluate((element) => {
		element.scrollTop = 0;
	});
	await expect(bottom).toBeVisible();
	await expect(top).toBeDisabled();
	await bottom.click();
	await expect
		.poll(() =>
			page.locator('.cm-scroller').evaluate((element) => {
				return element.scrollTop + element.clientHeight >= element.scrollHeight - 2;
			})
		)
		.toBe(true);
	await expect(top).toBeEnabled();
	await top.click();
	await expect
		.poll(() => page.locator('.cm-scroller').evaluate((element) => element.scrollTop))
		.toBe(0);
	await expect(top).toBeDisabled();

	await page.locator('.cm-scroller').evaluate((element) => {
		element.scrollTop = 0;
	});
	await expect(top).toBeDisabled();
	await page.keyboard.press('Alt+End');
	await expect
		.poll(() =>
			page
				.locator('.cm-scroller')
				.evaluate((element) => element.scrollTop + element.clientHeight >= element.scrollHeight - 2)
		)
		.toBe(true);
	await page.keyboard.press('Alt+Home');
	await expect
		.poll(() => page.locator('.cm-scroller').evaluate((element) => element.scrollTop))
		.toBe(0);

	for (const mode of ['wysiwyg', 'read'] as const) {
		await page.locator(`button[data-mode="${mode}"]`).click();
		const scroller = mode === 'read' ? '.mdsh-read' : '.mdsh-editor';
		await expect(page.locator(scroller)).toBeVisible({ timeout: 20_000 });
		await expect(bottom).toBeVisible();
		await bottom.click();
		await expect
			.poll(() =>
				page
					.locator(scroller)
					.evaluate(
						(element) => element.scrollTop + element.clientHeight >= element.scrollHeight - 2
					)
			)
			.toBe(true);
		await top.click();
		await expect
			.poll(() => page.locator(scroller).evaluate((element) => element.scrollTop))
			.toBe(0);
	}

	await page.setViewportSize({ width: 390, height: 700 });
	await expect(top).toBeVisible();
	const box = await top.boundingBox();
	expect(box?.width ?? 0).toBeGreaterThanOrEqual(36);
	expect(box?.height ?? 0).toBeGreaterThanOrEqual(36);

	await info.attach('scroll-navigation.json', {
		body: JSON.stringify({
			modes: ['source', 'wysiwyg', 'read'],
			keyboard: ['Alt+Home', 'Alt+End']
		}),
		contentType: 'application/json'
	});
	await info.attach('scroll-navigation.png', { body: await page.screenshot() });
});

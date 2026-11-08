import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createFirstFile, resetAppState, seedFiles, writeSourceContent } from './helpers';
import { enableTypewriter, installTypewriterProbe } from './typewriter-helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

test('typewriter coalesces caret bursts and cancels work on mode exit', async ({ page }, info) => {
	await resetAppState(page);
	await createFirstFile(page);
	await writeSourceContent(
		page,
		Array.from({ length: 80 }, () => 'wrapped text '.repeat(40)).join('\n')
	);
	await page.locator('.cm-content').press('ControlOrMeta+Home');
	await enableTypewriter(page);
	await installTypewriterProbe(page);
	await page.evaluate(async () => {
		window.typewriterProbe.burst(30, true);
		await window.typewriterProbe.settle();
	});
	const burst = await page.evaluate(() => window.typewriterProbe.sample());
	await info.attach('typewriter-burst.json', {
		body: JSON.stringify(burst, null, 2),
		contentType: 'application/json'
	});
	expect.soft(burst.head - burst.anchor).toBe(30);
	expect
		.soft(burst.maxPending, 'one CodeMirror measure frame, no per-key frames')
		.toBeLessThanOrEqual(2);
	expect.soft(burst.centerHeads.length).toBeLessThanOrEqual(1);
	expect.soft(burst.centerHeads.every((head) => head === burst.head)).toBe(true);
	await page.evaluate(async () => {
		window.typewriterProbe.burst(1, false);
		await window.typewriterProbe.settle();
	});
	const centered = await page.evaluate(() => window.typewriterProbe.sample());
	await info.attach('typewriter-centered.json', {
		body: JSON.stringify(centered, null, 2),
		contentType: 'application/json'
	});
	expect.soft(centered.centerHeads, 'collapsing a centered selection needs no scroll').toEqual([]);
	await page.evaluate(async () => {
		window.typewriterProbe.burst(30, false);
		(document.querySelector('button[data-mode="read"]') as HTMLButtonElement).click();
		await window.typewriterProbe.settle();
	});
	await expect(page.locator('.cm-content')).toHaveCount(0);
	const exited = await page.evaluate(() => window.typewriterProbe.sample());
	await info.attach('typewriter-exit.json', {
		body: JSON.stringify(exited, null, 2),
		contentType: 'application/json'
	});
	expect(exited.detachedDispatches).toBe(0);
});

async function seedTwo(page: Page) {
	await seedFiles(page, [
		{ name: 'First', content: 'Premier document.' },
		{ name: 'Second', content: 'Second document.' }
	]);
}

test('typewriter cancels queued centering on disable and file switch', async ({ page }, info) => {
	await resetAppState(page);
	await seedFiles(page, [
		{ name: 'Other', content: 'Other document.' },
		{ name: 'Typewriter', content: 'wrapped text '.repeat(400) }
	]);
	await page.locator('.cm-content').press('ControlOrMeta+Home');
	const results = [];
	for (let cycle = 0; cycle < 3; cycle += 1) {
		await enableTypewriter(page);
		await installTypewriterProbe(page);
		await page.getByRole('button', { name: 'Palette de commandes', exact: true }).click();
		await page.getByRole('dialog').getByRole('combobox').fill('typewriter');
		const disable = page.getByRole('option', { name: /Désactiver le mode typewriter/ });
		await disable.evaluate(async (element) => {
			window.typewriterProbe.burst(30, true);
			(element as HTMLElement).click();
			await window.typewriterProbe.settle();
		});
		await expect(page.locator('body')).not.toHaveClass(/typewriter-mode/);
		const disabled = await page.evaluate(() => window.typewriterProbe.sample());
		results.push(disabled);
		expect.soft(disabled.centerHeads).toEqual([]);
	}
	await enableTypewriter(page);
	await installTypewriterProbe(page);
	await page
		.locator('aside')
		.getByRole('button', { name: /^Other/ })
		.first()
		.evaluate(async (element) => {
			window.typewriterProbe.burst(30, false);
			(element as HTMLElement).click();
			await window.typewriterProbe.settle();
		});
	await expect(page.locator('.cm-content')).toContainText('Other document.');
	const switched = await page.evaluate(() => window.typewriterProbe.sample());
	await info.attach('typewriter-lifecycle.json', {
		body: JSON.stringify({ disabled: results, switched }, null, 2),
		contentType: 'application/json'
	});
	expect(switched.detachedDispatches).toBe(0);
	expect(switched.centerHeads).toEqual([]);
});

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

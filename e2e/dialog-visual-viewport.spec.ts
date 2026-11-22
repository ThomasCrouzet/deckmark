import { expect, test, type Locator, type Page } from '@playwright/test';
import { resetAppState, writeSourceContent } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

type FakeViewport = { set: (height: number, offsetTop: number) => void };

declare global {
	interface Window {
		__mdshTestViewport?: FakeViewport;
	}
}

/**
 * Install a controllable visual viewport before the application starts. Mobile
 * WebKit and mobile Chromium move the visual viewport without changing the
 * layout viewport when the software keyboard opens; the simulation reproduces
 * that geometry without a physical keyboard. It is not device evidence.
 */
async function installVisualViewport(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const target = new EventTarget();
		const state = { height: window.innerHeight, offsetTop: 0 };
		Object.defineProperty(target, 'height', { get: () => state.height });
		Object.defineProperty(target, 'offsetTop', { get: () => state.offsetTop });
		Object.defineProperties(target, {
			width: { get: () => window.innerWidth },
			offsetLeft: { get: () => 0 },
			pageTop: { get: () => state.offsetTop },
			pageLeft: { get: () => 0 },
			scale: { get: () => 1 }
		});
		Object.defineProperty(window, 'visualViewport', {
			configurable: true,
			value: target
		});
		window.__mdshTestViewport = {
			set(height: number, offsetTop: number) {
				state.height = height;
				state.offsetTop = offsetTop;
				target.dispatchEvent(new Event('resize'));
				target.dispatchEvent(new Event('scroll'));
			}
		};
	});
}

async function shrinkVisualViewport(page: Page, height: number, offsetTop: number): Promise<void> {
	await page.evaluate(
		({ height, offsetTop }) => window.__mdshTestViewport?.set(height, offsetTop),
		{ height, offsetTop }
	);
}

async function restoreVisualViewport(page: Page): Promise<void> {
	await page.evaluate(() => window.__mdshTestViewport?.set(window.innerHeight, 0));
}

async function visibleRegion(page: Page): Promise<{ top: number; bottom: number }> {
	return page.evaluate(() => {
		const viewport = window.visualViewport;
		return {
			top: viewport?.offsetTop ?? 0,
			bottom: (viewport?.offsetTop ?? 0) + (viewport?.height ?? 0)
		};
	});
}

async function expectInsideVisibleRegion(page: Page, locator: Locator): Promise<void> {
	await expect
		.poll(
			async () => {
				const box = await locator.boundingBox();
				const region = await visibleRegion(page);
				if (!box) return false;
				return box.y >= region.top - 1 && box.y + box.height <= region.bottom + 1;
			},
			{ timeout: 5_000 }
		)
		.toBe(true);
}

async function dialogPanel(dialog: Locator): Promise<Locator> {
	return dialog.locator('.mdsh-dialog-panel');
}

async function openSettings(page: Page): Promise<Locator> {
	await page.keyboard.press('Control+,');
	const dialog = page.locator('[role="dialog"][aria-labelledby="settings-title"]');
	await expect(dialog).toBeVisible();
	return dialog;
}

async function openSearch(page: Page): Promise<Locator> {
	await page.keyboard.press('Control+Shift+F');
	const dialog = page.getByRole('dialog', { name: 'Cross-file search', exact: true });
	await expect(dialog).toBeVisible();
	return dialog;
}

async function openPalette(page: Page): Promise<Locator> {
	await page.keyboard.press('Control+Shift+P');
	const dialog = page.getByRole('dialog', { name: 'Command palette', exact: true });
	await expect(dialog).toBeVisible();
	return dialog;
}

async function openComments(page: Page): Promise<Locator> {
	const palette = await openPalette(page);
	await palette.getByRole('option', { name: /Open editorial comments/i }).click();
	const dialog = page.getByTestId('comments-panel');
	await expect(dialog).toBeVisible();
	return dialog;
}

test.beforeEach(async ({ page }) => {
	await installVisualViewport(page);
	await resetAppState(page);
	await page.evaluate(() => localStorage.setItem('mdsh:locale', 'en'));
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
});

test('keeps dialog controls inside a shrinking visual viewport', async ({ page }, info) => {
	await page.getByTestId('welcome-new').click();
	await page.getByTestId('create-note').click();
	await expect(page.getByTestId('document-kind')).toHaveText('Note', { timeout: 15_000 });
	await writeSourceContent(page, '# Review note\n\nA searchable review paragraph.\n');

	const evidence: Array<Record<string, unknown>> = [];

	// Settings: a lower field, the close control and dialog scroll stay usable.
	{
		const dialog = await openSettings(page);
		const panel = await dialogPanel(dialog);
		expect(await dialog.evaluate((element) => (element as HTMLElement).style.top)).toBe('');
		await shrinkVisualViewport(page, 380, 120);
		await expect
			.poll(() => dialog.evaluate((element) => (element as HTMLElement).style.top))
			.toBe('120px');
		await expect
			.poll(() => dialog.evaluate((element) => (element as HTMLElement).style.height))
			.toBe('380px');
		await expectInsideVisibleRegion(page, panel);
		await expectInsideVisibleRegion(
			page,
			dialog.getByRole('button', { name: 'Close', exact: true })
		);
		const scrolled = await dialog.evaluate((element) => {
			const content = element.querySelector<HTMLElement>('.mdsh-dialog-panel > div');
			if (!content) return null;
			const before = content.scrollTop;
			content.scrollTop = content.scrollHeight;
			return { before, after: content.scrollTop, scrollHeight: content.scrollHeight };
		});
		expect(scrolled).not.toBeNull();
		expect(scrolled!.scrollHeight).toBeGreaterThanOrEqual(scrolled!.after);
		await restoreVisualViewport(page);
		await expect
			.poll(() => dialog.evaluate((element) => (element as HTMLElement).style.top))
			.toBe('');
		evidence.push({ dialog: 'settings', scrolled });
		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();
		await expect(page.locator('.cm-content')).toBeFocused();
	}

	// Search: query, selection and results survive the viewport change.
	{
		const dialog = await openSearch(page);
		const input = dialog.getByRole('combobox');
		const result = dialog.getByRole('option').filter({ hasText: 'Review note' });
		await input.fill('Review');
		await input.evaluate((element: HTMLInputElement) => element.setSelectionRange(2, 4));
		await expect(result).toBeVisible();
		await shrinkVisualViewport(page, 360, 160);
		await expectInsideVisibleRegion(page, await dialogPanel(dialog));
		await expectInsideVisibleRegion(page, input);
		await expectInsideVisibleRegion(page, result);
		await expectInsideVisibleRegion(
			page,
			dialog.getByRole('button', { name: 'Close', exact: true })
		);
		await expect(input).toHaveValue('Review');
		expect(
			await input.evaluate((element: HTMLInputElement) => [
				element.selectionStart,
				element.selectionEnd
			])
		).toEqual([2, 4]);
		await expect(result).toBeVisible();
		await restoreVisualViewport(page);
		await expectInsideVisibleRegion(page, await dialogPanel(dialog));
		await expectInsideVisibleRegion(page, result);
		evidence.push({ dialog: 'search', value: 'Review', selection: [2, 4] });
		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();
		expect(await input.isVisible()).toBe(false);
		await expect(page.locator('.cm-content')).toBeFocused();
	}

	// Command palette: the query field, the first command and the close control
	// stay reachable.
	{
		const dialog = await openPalette(page);
		const input = dialog.getByRole('combobox');
		await input.fill('settings');
		const command = dialog.getByRole('option').first();
		await expect(command).toBeVisible();
		await shrinkVisualViewport(page, 340, 200);
		await expectInsideVisibleRegion(page, await dialogPanel(dialog));
		await expectInsideVisibleRegion(page, input);
		await expectInsideVisibleRegion(page, command);
		await expectInsideVisibleRegion(
			page,
			dialog.getByRole('button', { name: 'Close', exact: true })
		);
		await expect(input).toHaveValue('settings');
		await restoreVisualViewport(page);
		await expectInsideVisibleRegion(page, await dialogPanel(dialog));
		evidence.push({ dialog: 'palette', value: 'settings' });
		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();
		await expect(page.locator('.cm-content')).toBeFocused();
	}

	// Document library: the filter field and the close control stay reachable.
	{
		const trigger = page.locator('aside').getByRole('button', { name: /^Document library/ });
		await trigger.click();
		const dialog = page.getByRole('dialog', { name: /^Document library/, exact: false });
		await expect(dialog).toBeVisible();
		const filter = dialog.getByRole('textbox');
		await expect(filter).toBeFocused();
		await filter.fill('Review');
		await shrinkVisualViewport(page, 320, 240);
		await expectInsideVisibleRegion(page, await dialogPanel(dialog));
		await expectInsideVisibleRegion(page, filter);
		await expectInsideVisibleRegion(
			page,
			dialog.getByRole('button', { name: 'Close', exact: true })
		);
		await expect(filter).toHaveValue('Review');
		await restoreVisualViewport(page);
		evidence.push({ dialog: 'library', value: 'Review' });
		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();
		await expect(trigger).toBeFocused();
	}

	await info.attach('visual-viewport-dialogs.json', {
		body: JSON.stringify(
			{
				command:
					'npx playwright test e2e/dialog-visual-viewport.spec.ts --project=chromium --workers=1 --retries=0',
				method: 'synthetic VisualViewport override, not a physical keyboard',
				sourceViewport: await page.evaluate(() => ({
					innerHeight: window.innerHeight,
					visualHeight: window.visualViewport?.height,
					visualOffsetTop: window.visualViewport?.offsetTop
				})),
				cases: evidence
			},
			null,
			2
		),
		contentType: 'application/json'
	});
});

test('keeps the prompt modal inside a shrinking visual viewport', async ({ page }, info) => {
	await page.getByTestId('welcome-new').click();
	await page.getByTestId('create-note').click();
	await expect(page.getByTestId('document-kind')).toHaveText('Note', { timeout: 15_000 });

	const palette = await openPalette(page);
	await palette.locator('input[type="text"]').fill('rename');
	await palette.getByRole('option', { name: /Rename document/i }).click();
	const prompt = page.getByRole('dialog', { name: 'Document name', exact: true });
	await expect(prompt).toBeVisible();
	const input = prompt.getByRole('textbox');
	await expect(input).toBeFocused();

	// The prompt overlay must follow the same visual-viewport contract as the
	// other dialogs. It applied only the focus trap before issue #723.
	expect(await prompt.evaluate((element) => (element as HTMLElement).style.top)).toBe('');
	await shrinkVisualViewport(page, 360, 140);
	await expect
		.poll(() => prompt.evaluate((element) => (element as HTMLElement).style.top))
		.toBe('140px');
	await expect
		.poll(() => prompt.evaluate((element) => (element as HTMLElement).style.height))
		.toBe('360px');
	await expectInsideVisibleRegion(page, await dialogPanel(prompt));
	await expectInsideVisibleRegion(page, input);
	await expectInsideVisibleRegion(
		page,
		prompt.getByRole('button', { name: 'Cancel', exact: true })
	);
	await expect(input).toBeFocused();

	await restoreVisualViewport(page);
	await expect
		.poll(() => prompt.evaluate((element) => (element as HTMLElement).style.top))
		.toBe('');
	await expectInsideVisibleRegion(page, await dialogPanel(prompt));

	await info.attach('visual-viewport-prompt.json', {
		body: JSON.stringify(
			{
				command:
					'npx playwright test e2e/dialog-visual-viewport.spec.ts --project=chromium --workers=1 --retries=0',
				method: 'synthetic VisualViewport override, not a physical keyboard',
				keyboard: { height: 360, offsetTop: 140 },
				dialog: 'prompt',
				inputFocused: true
			},
			null,
			2
		),
		contentType: 'application/json'
	});
	await page.keyboard.press('Escape');
	await expect(prompt).toBeHidden();
});

test('keeps the comment form and its actions inside a shrinking visual viewport', async ({
	page
}, info) => {
	await page.getByTestId('welcome-new').click();
	await page.getByTestId('create-note').click();
	await expect(page.getByTestId('document-kind')).toHaveText('Note', { timeout: 15_000 });
	await writeSourceContent(page, '# Review note\n\nA searchable review paragraph.\n');

	const dialog = await openComments(page);
	const backdrop = page.locator('.comments-backdrop');
	const quote = dialog.getByTestId('comment-quote');
	const body = dialog.getByTestId('comment-body');
	const author = dialog.getByTestId('comment-author');
	await quote.fill('A searchable review paragraph.');
	await body.fill('Check the wording.');
	await body.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(5, 14));
	await author.fill('Reviewer');
	await expect(page.locator('.mdsh-shell')).toHaveAttribute('inert', '');

	// The keyboard shifts the visible region. The shared dialog contract must
	// move and resize the comment overlay to the same region.
	await shrinkVisualViewport(page, 360, 140);
	await expect.poll(() => backdrop.evaluate((element) => element.style.height)).toBe('360px');
	await expectInsideVisibleRegion(page, dialog);
	await expectInsideVisibleRegion(page, author);
	expect(
		await body.evaluate((element: HTMLTextAreaElement) => [
			element.selectionStart,
			element.selectionEnd
		])
	).toEqual([5, 14]);

	const close = dialog.getByRole('button', { name: 'Close', exact: true });
	await expectInsideVisibleRegion(page, close);
	for (let index = 0; index < 12; index += 1) {
		await page.keyboard.press('Tab');
		expect(
			await page.evaluate(
				() => document.activeElement?.closest('[data-testid="comments-panel"]') !== null
			)
		).toBe(true);
	}

	// The reviewed quote, the submit action and the new row stay reachable by
	// scrolling inside the dialog.
	await quote.scrollIntoViewIfNeeded();
	await expectInsideVisibleRegion(page, quote);
	const add = dialog.getByTestId('comment-add');
	await add.scrollIntoViewIfNeeded();
	await expectInsideVisibleRegion(page, add);
	await add.click();
	await expect(dialog).toContainText('Check the wording.');
	const row = dialog.locator('article.comment').filter({ hasText: 'Check the wording.' });
	await row.scrollIntoViewIfNeeded();
	await expectInsideVisibleRegion(page, row);

	// Closing the keyboard restores the full overlay and keeps the rows.
	await restoreVisualViewport(page);
	await expect.poll(() => backdrop.evaluate((element) => element.style.height)).toBe('');
	await expectInsideVisibleRegion(page, dialog);
	await expect(dialog).toContainText('Check the wording.');

	await info.attach('visual-viewport-comments.json', {
		body: JSON.stringify(
			{
				command:
					'npx playwright test e2e/dialog-visual-viewport.spec.ts --project=chromium --workers=1 --retries=0',
				method: 'synthetic VisualViewport override, not a physical keyboard',
				keyboard: { height: 360, offsetTop: 140 },
				selection: [5, 14],
				backgroundInert: true,
				rows: 1
			},
			null,
			2
		),
		contentType: 'application/json'
	});
	await page.keyboard.press('Escape');
	await expect(dialog).toHaveCount(0);
});

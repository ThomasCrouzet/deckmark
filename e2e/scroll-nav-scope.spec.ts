import { expect, test, type Page } from '@playwright/test';
import { resetAppState, writeSourceContent } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

async function start(page: Page): Promise<void> {
	await resetAppState(page);
	await page.evaluate(() => localStorage.setItem('mdsh:locale', 'en'));
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	await page.getByTestId('welcome-new').click();
	await page.getByTestId('create-note').click();
	await expect(page.getByTestId('document-kind')).toHaveText('Note', { timeout: 15_000 });
	await page.locator('button[data-mode="source"]').click();
	await expect(page.locator('.cm-content')).toBeVisible();
}

async function scrollTop(page: Page): Promise<number> {
	return page.locator('.cm-scroller').evaluate((element) => element.scrollTop);
}

async function scrollerTop(page: Page, selector: string): Promise<number> {
	return page.locator(selector).evaluate((element) => element.scrollTop);
}

async function scrollerBottom(page: Page, selector: string): Promise<boolean> {
	return page
		.locator(selector)
		.evaluate((element) => element.scrollTop + element.clientHeight >= element.scrollHeight - 2);
}

async function recordDefaultPrevented(page: Page, key: 'Home' | 'End'): Promise<void> {
	await page.evaluate((key) => {
		(window as Window & { __altKeyPrevented?: boolean }).__altKeyPrevented = undefined;
		window.addEventListener('keydown', (event) => {
			if (event.altKey && event.key === key)
				(window as Window & { __altKeyPrevented?: boolean }).__altKeyPrevented =
					event.defaultPrevented;
		});
	}, key);
}

async function defaultPrevented(page: Page): Promise<boolean | undefined> {
	return page.evaluate(
		() => (window as Window & { __altKeyPrevented?: boolean }).__altKeyPrevented
	);
}

test('scopes Alt+Home and Alt+End to the visible active note', async ({ page }, info) => {
	const long = Array.from({ length: 160 }, (_, index) => `Paragraph ${index + 1}.`).join('\n\n');
	await start(page);
	await writeSourceContent(page, `# Long note\n\n${long}\n`);
	const scroller = page.locator('.cm-scroller');
	await expect(page.getByTestId('scroll-bottom')).toBeVisible();

	// The eligible note navigates to both boundaries.
	await page.locator('.cm-content').click();
	await page.keyboard.press('Alt+End');
	await expect.poll(async () => Math.round(await scrollTop(page))).toBeGreaterThan(100);
	await page.keyboard.press('Alt+Home');
	await expect.poll(async () => await scrollTop(page)).toBeLessThan(2);

	await scroller.evaluate((element) => {
		element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) / 2);
	});
	await expect.poll(async () => await scrollTop(page)).toBeGreaterThan(100);
	const middle = await scrollTop(page);

	// A foreground dialog owns the keyboard. The inert note must not move and
	// the shortcut must not consume the event.
	await page.keyboard.press('Control+,');
	const settings = page.locator('[role="dialog"][aria-labelledby="settings-title"]');
	await expect(settings).toBeVisible();
	await settings.getByRole('button', { name: 'Close', exact: true }).focus();
	await recordDefaultPrevented(page, 'Home');
	await page.keyboard.press('Alt+Home');
	expect(await scrollTop(page)).toBe(middle);
	expect(await defaultPrevented(page)).toBe(false);
	await expect(settings).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(settings).toBeHidden();

	// A focused field outside the note keeps its own key behavior.
	await page
		.locator('#app-toolbar')
		.getByRole('textbox', { name: /^File name/ })
		.focus();
	await recordDefaultPrevented(page, 'Home');
	await page.keyboard.press('Alt+Home');
	expect(await scrollTop(page)).toBe(middle);
	expect(await defaultPrevented(page)).toBe(false);

	// Composition uses the same boundary.
	await page.locator('.cm-content').click();
	await page.locator('.cm-content').evaluate((element) => {
		element.dispatchEvent(
			new KeyboardEvent('keydown', {
				key: 'End',
				altKey: true,
				bubbles: true,
				cancelable: true,
				isComposing: true
			})
		);
	});
	await page.waitForTimeout(50);
	expect(await scrollTop(page)).toBe(middle);

	// A short note has no scroll target and must not consume the shortcut.
	await writeSourceContent(page, '# Short note\n\nOne paragraph.\n');
	await expect(page.getByTestId('scroll-bottom')).toHaveCount(0);
	await page.locator('.cm-content').click();
	await recordDefaultPrevented(page, 'End');
	await page.keyboard.press('Alt+End');
	expect(await scrollTop(page)).toBe(0);
	expect(await defaultPrevented(page)).toBe(false);

	await info.attach('scroll-nav-scope.json', {
		body: JSON.stringify(
			{
				command:
					'npx playwright test e2e/scroll-nav-scope.spec.ts --project=chromium --workers=1 --retries=0',
				middleScrollTop: Math.round(middle),
				dialog: 'settings',
				checks: ['dialog open', 'outside field focus', 'IME composition', 'short note'],
				limitation:
					'Synthetic composition and desktop emulation are not hardware keyboard evidence.'
			},
			null,
			2
		),
		contentType: 'application/json'
	});
});

test('navigates the current note with the keyboard in Edit and Read', async ({ page }, info) => {
	const long = Array.from({ length: 160 }, (_, index) => `Paragraph ${index + 1}.`).join('\n\n');
	await start(page);
	await writeSourceContent(page, `# Long note\n\n${long}\n`);
	await expect(page.getByTestId('scroll-bottom')).toBeVisible();

	// Edit mode: the visual editor scroller takes both boundaries.
	await page.locator('button[data-mode="wysiwyg"]').click();
	const editor = page.locator('.mdsh-editor');
	await expect(editor).toBeVisible({ timeout: 20_000 });
	await page.locator('.milkdown .ProseMirror').click();
	await page.keyboard.press('Alt+End');
	await expect.poll(() => scrollerBottom(page, '.mdsh-editor')).toBe(true);
	await page.keyboard.press('Alt+Home');
	await expect.poll(() => scrollerTop(page, '.mdsh-editor')).toBeLessThan(2);

	// Read mode: the rendered document scroller takes them too.
	await page.locator('button[data-mode="read"]').click();
	const read = page.locator('.mdsh-read');
	await expect(page.locator('.mdsh-preview')).toBeVisible({ timeout: 20_000 });
	await read.focus();
	await page.keyboard.press('Alt+End');
	await expect.poll(() => scrollerBottom(page, '.mdsh-read')).toBe(true);
	await page.keyboard.press('Alt+Home');
	await expect.poll(() => scrollerTop(page, '.mdsh-read')).toBeLessThan(2);

	// The buttons stay available in Read mode for pointer and touch input.
	await expect(page.getByTestId('scroll-top')).toBeDisabled();
	await expect(page.getByTestId('scroll-bottom')).toBeEnabled();

	await info.attach('scroll-nav-modes.json', {
		body: JSON.stringify(
			{
				command:
					'npx playwright test e2e/scroll-nav-scope.spec.ts --project=chromium --workers=1 --retries=0',
				modes: ['wysiwyg', 'read'],
				keys: ['Alt+Home', 'Alt+End'],
				limitation: 'A Playwright keyboard event does not prove a physical keyboard.'
			},
			null,
			2
		),
		contentType: 'application/json'
	});
});

test('keeps the scroll shortcut on the live note after mode, file and workspace switches', async ({
	page
}, info) => {
	const long = Array.from({ length: 160 }, (_, index) => `Paragraph ${index + 1}.`).join('\n\n');
	await start(page);
	await writeSourceContent(page, `# Long note\n\n${long}\n`);
	await expect(page.getByTestId('scroll-bottom')).toBeVisible();
	const title = page.getByRole('textbox', { name: /^File name/ });
	await title.fill('Long note');
	await title.press('Enter');
	await page.waitForTimeout(900);

	// A mode switch moves the new scroller and leaves no stale one behind.
	await page.locator('.cm-scroller').evaluate((element) => {
		element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) / 2);
	});
	await page.locator('button[data-mode="read"]').click();
	await expect(page.locator('.mdsh-preview')).toBeVisible({ timeout: 20_000 });
	await page.locator('.mdsh-read').focus();
	await page.keyboard.press('Alt+Home');
	await expect.poll(() => scrollerTop(page, '.mdsh-read')).toBeLessThan(2);
	await page.locator('button[data-mode="source"]').click();
	await expect(page.locator('.cm-content')).toBeVisible();

	// A short second note has no scroll range. A stale long scroller would
	// consume the key and move, so the event must stay with the browser.
	await page.locator('aside button[aria-label^="New file"]').first().click();
	await page.getByTestId('create-note').click();
	await expect(title).not.toHaveValue('Long note');
	await page.locator('button[data-mode="source"]').click();
	await expect(page.locator('.cm-content')).toBeVisible();
	await page.locator('.cm-content').click();
	await recordDefaultPrevented(page, 'End');
	await page.keyboard.press('Alt+End');
	expect(await scrollTop(page)).toBe(0);
	const shortNotePrevented = await defaultPrevented(page);
	expect(shortNotePrevented).toBe(false);
	await expect(page.getByTestId('scroll-bottom')).toHaveCount(0);

	// The long note takes the shortcut again after the file switch back.
	await page.locator('aside button[data-file-id]').filter({ hasText: 'Long note' }).click();
	await expect(title).toHaveValue('Long note');
	await expect(page.locator('.cm-content')).toBeVisible();
	await page.keyboard.press('Alt+End');
	await expect.poll(() => scrollerBottom(page, '.cm-scroller')).toBe(true);

	// An orientation change keeps the shortcut on the live scroller. Keep a
	// desktop width so the sidebar tabs do not become a closed drawer.
	await page.setViewportSize({ width: 1000, height: 420 });
	await page.keyboard.press('Alt+Home');
	await expect.poll(() => scrollerTop(page, '.cm-scroller')).toBeLessThan(2);
	await page.keyboard.press('Alt+End');
	await expect.poll(() => scrollerBottom(page, '.cm-scroller')).toBe(true);

	// A workspace switch unmounts the note listener. The presentation keeps
	// the key and no hidden note moves.
	await page.keyboard.press('Control+n');
	await page.getByTestId('create-presentation').click();
	await expect(page.getByTestId('presentation-editor')).toBeVisible({ timeout: 20_000 });
	await expect(page.locator('.cm-scroller')).toHaveCount(0);
	await recordDefaultPrevented(page, 'End');
	await page.keyboard.press('Alt+End');
	// The presentation workspace owns the key, so the window note handler never
	// sees the event and no hidden note can move.
	const presentationPrevented = await defaultPrevented(page);
	expect(presentationPrevented).toBeUndefined();
	await expect(page.getByTestId('scroll-bottom')).toHaveCount(0);

	// The note takes the shortcut again after the workspace switch back.
	await page.locator('aside button[data-file-id]').filter({ hasText: 'Long note' }).click();
	await expect(title).toHaveValue('Long note');
	await expect(page.locator('.cm-content')).toBeVisible();
	await page.keyboard.press('Alt+End');
	await expect.poll(() => scrollerBottom(page, '.cm-scroller')).toBe(true);

	await info.attach('scroll-nav-switches.json', {
		body: JSON.stringify(
			{
				command:
					'npx playwright test e2e/scroll-nav-scope.spec.ts --project=chromium --workers=1 --retries=0',
				checks: ['mode switch', 'short note', 'file switch', 'orientation', 'workspace switch'],
				shortNotePrevented,
				windowKeydownDelivered: presentationPrevented !== undefined,
				limitation: 'Desktop emulation is not a physical keyboard or context menu result.'
			},
			null,
			2
		),
		contentType: 'application/json'
	});
});

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

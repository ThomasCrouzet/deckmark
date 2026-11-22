import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createFirstFile, resetAppState } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

async function focusedSurface(page: Page): Promise<string | null> {
	return page.evaluate(() => {
		const active = document.activeElement;
		if (!active) return null;
		if (active.closest('.cm-editor')) return 'source';
		if (active.closest('.ProseMirror, .milkdown')) return 'wysiwyg';
		if (active.closest('.mdsh-read')) return 'read';
		return active.getAttribute('data-mode') ?? active.tagName.toLowerCase();
	});
}

async function mode(page: Page): Promise<string | null> {
	return page.locator('[data-mode][aria-checked="true"]').getAttribute('data-mode');
}

async function attach(info: TestInfo, name: string, value: unknown) {
	await info.attach(name, {
		body: JSON.stringify(value, null, 2),
		contentType: 'application/json'
	});
}

/**
 * Issue #717: the mode switch remounts the editor. Without a carried caret
 * request the next key goes to the toolbar button and the typed bytes are lost.
 */
test('keeps the caret across Edit, Source and Read switches', async ({ page }, info) => {
	await resetAppState(page, { mode: 'wysiwyg' });
	await createFirstFile(page);
	const visual = page.locator('.ProseMirror').first();
	await expect(visual).toBeVisible({ timeout: 20_000 });
	await expect.poll(() => focusedSurface(page)).toBe('wysiwyg');

	await page.keyboard.insertText('Edit start');
	await expect(visual).toContainText('Edit start');

	// The documented Source shortcut. The physical key sends Control+/.
	await page.keyboard.press('Control+/');
	const source = page.locator('.cm-content').first();
	await expect(source).toBeVisible({ timeout: 20_000 });
	await expect.poll(() => mode(page)).toBe('source');
	await expect.poll(() => focusedSurface(page)).toBe('source');
	await page.keyboard.insertText(' source typed');
	await expect(source).toContainText('Edit start source typed');

	// Back to Edit through the documented shortcut, then keep typing. The
	// restored selection is the one the visual editor owned before the switch.
	await page.keyboard.press('Control+e');
	await expect(visual).toBeVisible({ timeout: 20_000 });
	await expect.poll(() => mode(page)).toBe('wysiwyg');
	await expect.poll(() => focusedSurface(page)).toBe('wysiwyg');
	await page.keyboard.insertText(' edit again');
	await expect(visual).toContainText('edit again');
	await expect(visual).toContainText('source typed');

	// Read has no caret. The reading scroller takes the keyboard instead.
	await page.keyboard.press('Control+r');
	await expect(page.locator('.mdsh-read')).toBeVisible();
	await expect.poll(() => mode(page)).toBe('read');
	await expect.poll(() => focusedSurface(page)).toBe('read');

	await page.keyboard.press('Control+e');
	await expect(visual).toBeVisible({ timeout: 20_000 });
	await expect.poll(() => focusedSurface(page)).toBe('wysiwyg');
	await page.keyboard.insertText(' final edit');
	await expect(visual).toContainText('final edit');

	await attach(info, 'editor-mode-focus.json', {
		command: 'npx playwright test e2e/editor-mode-focus.spec.ts --project=chromium --workers=1',
		editToSource: 'Control+/ keeps the caret in the source view',
		sourceToEdit: 'Control+e keeps the caret in the visual editor',
		readSurface: 'Control+r focuses the reading scroller',
		content: await visual.textContent()
	});
	await info.attach('editor-mode-focus.png', { body: await page.screenshot() });
});

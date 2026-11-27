import { test, expect, type Page } from '@playwright/test';
import {
	createFirstFile,
	renameActiveFile,
	resetAppState,
	switchToSource,
	writeSourceContent
} from './helpers';

// ProseMirror reads the DOM selection on the asynchronous selectionchange
// event. A key can reach the editor before that event, mainly on a slow
// machine or in WebKit. The editor must then act on the caret that the user
// sees. The shipped failures were an Enter that replaced the old range, text
// that landed at the old caret, and a saved caret that stayed at the start of
// the note.
//
// These cases hold the selectionchange event back for the editor. The browser
// still moves the caret and runs every key natively. The held event models the
// late delivery without any timing assumption.

declare global {
	interface Window {
		__holdSelectionChange?: boolean;
		__MDSH_EDITOR_VIEW__?: { state: { selection: { head: number } } };
	}
}

async function installSelectionChangeHold(page: Page): Promise<void> {
	await page.addInitScript(() => {
		// A capture listener on the document runs before the editor listener.
		document.addEventListener(
			'selectionchange',
			(event) => {
				if (window.__holdSelectionChange) event.stopImmediatePropagation();
			},
			true
		);
	});
}

async function holdSelectionChange(page: Page, hold: boolean): Promise<void> {
	await page.evaluate((value) => {
		window.__holdSelectionChange = value;
	}, hold);
}

/** Select `text` in the visual editor with a DOM range and focus the editor. */
async function selectDomText(page: Page, text: string): Promise<void> {
	await page.locator('.ProseMirror').evaluate((root, wanted) => {
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		const nodes: { node: Node; from: number; to: number }[] = [];
		let content = '';
		let node: Node | null;
		while ((node = walker.nextNode())) {
			const from = content.length;
			content += node.textContent;
			nodes.push({ node, from, to: content.length });
		}
		const index = content.indexOf(wanted);
		if (index < 0) throw new Error(`Text not found: ${wanted}`);
		const first = nodes.find(({ from, to }) => from <= index && to > index)!;
		const last = nodes.find(
			({ from, to }) => from < index + wanted.length && to >= index + wanted.length
		)!;
		const range = document.createRange();
		range.setStart(first.node, index - first.from);
		range.setEnd(last.node, index + wanted.length - last.from);
		(root as HTMLElement).focus();
		const selection = window.getSelection()!;
		selection.removeAllRanges();
		selection.addRange(range);
	}, text);
	await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(text);
}

async function openVisual(page: Page, source: string): Promise<void> {
	await resetAppState(page, { mode: 'source' });
	await createFirstFile(page);
	await writeSourceContent(page, source);
	await page.locator('[data-mode=wysiwyg]').click();
	await expect(page.locator('.ProseMirror')).toHaveAttribute('contenteditable', 'true', {
		timeout: 30_000
	});
}

test.describe('visual editor selection sync before the next key', () => {
	test.beforeEach(async ({ page }) => {
		await installSelectionChangeHold(page);
	});

	test('Enter after a native caret move splits at the caret, not at the old range', async ({
		page
	}) => {
		await openVisual(page, 'Intro **bold words** kept.\n\nTail paragraph.\n');
		await holdSelectionChange(page, true);
		await selectDomText(page, 'bold words kept.');
		await page.keyboard.press('ArrowLeft');
		await expect.poll(() => page.evaluate(() => window.getSelection()?.isCollapsed)).toBe(true);
		await page.keyboard.press('Enter');
		await holdSelectionChange(page, false);
		await expect(page.locator('.ProseMirror > p')).toHaveText([
			'Intro',
			'bold words kept.',
			'Tail paragraph.'
		]);
	});

	test('typed text lands at the caret that a native move placed', async ({ page }) => {
		await openVisual(page, 'First line.\n\nSecond line.\n\nLast line.\n');
		await holdSelectionChange(page, true);
		await selectDomText(page, 'Second line.');
		await page.keyboard.press('ArrowRight');
		await expect.poll(() => page.evaluate(() => window.getSelection()?.isCollapsed)).toBe(true);
		await page.keyboard.type(' ABC');
		await holdSelectionChange(page, false);
		await expect(page.locator('.ProseMirror > p')).toHaveText([
			'First line.',
			'Second line. ABC',
			'Last line.'
		]);
	});

	test('new paragraphs follow a caret that the DOM got just before the focus', async ({ page }) => {
		await openVisual(page, 'First line.\n\nSecond line.\n\nLast line.\n');
		await holdSelectionChange(page, true);
		await page.locator('.ProseMirror').evaluate((root) => {
			const paragraphs = root.querySelectorAll(':scope > p');
			const last = paragraphs[paragraphs.length - 1]!;
			const range = document.createRange();
			range.selectNodeContents(last);
			range.collapse(false);
			const selection = window.getSelection()!;
			selection.removeAllRanges();
			selection.addRange(range);
			(root as HTMLElement).focus();
		});
		for (const text of ['Added alpha.', 'Added bravo.']) {
			await page.keyboard.press('Enter');
			await page.keyboard.insertText(text);
		}
		await holdSelectionChange(page, false);
		await expect(page.locator('.ProseMirror > p')).toHaveText([
			'First line.',
			'Second line.',
			'Last line.',
			'Added alpha.',
			'Added bravo.'
		]);
		await switchToSource(page);
		await expect(page.locator('.cm-content')).toContainText('Added bravo.');
		const lines = await page
			.locator('.cm-content .cm-line')
			.evaluateAll((elements) => elements.map((line) => line.textContent ?? '').filter(Boolean));
		expect(lines).toEqual([
			'First line.',
			'Second line.',
			'Last line.',
			'Added alpha.',
			'Added bravo.'
		]);
	});

	test('a file switch right after a native caret move keeps that caret', async ({ page }) => {
		await resetAppState(page, { mode: 'wysiwyg' });
		await createFirstFile(page);
		await renameActiveFile(page, 'Caret A.md');
		const editor = page.locator('.ProseMirror');
		await expect(editor).toHaveAttribute('contenteditable', 'true', { timeout: 20_000 });
		await editor.fill('Base locale');
		await expect(editor).toContainText('Base locale');
		await holdSelectionChange(page, true);
		await page.keyboard.press('ControlOrMeta+a');
		await page.keyboard.press('ArrowLeft');
		for (let index = 0; index < 4; index++) await page.keyboard.press('ArrowRight');
		await page.keyboard.press('ControlOrMeta+n');
		await page.getByTestId('create-note').click();
		await expect(editor).toBeVisible({ timeout: 20_000 });
		await holdSelectionChange(page, false);
		const fileName = page.locator('input[aria-label^="Nom du fichier"]');
		await fileName.fill('Caret B.md');
		await fileName.press('Enter');
		await page.locator('button[data-file-id]').filter({ hasText: 'Caret A' }).click();
		await expect(editor).toContainText('Base locale');
		await editor.focus();
		await page.keyboard.insertText('X');
		await expect(editor).toContainText('BaseX locale');
	});

	test('focus after a note opens again applies the saved caret', async ({ page }) => {
		await resetAppState(page, { mode: 'wysiwyg' });
		await createFirstFile(page);
		await renameActiveFile(page, 'Caret A.md');
		const editor = page.locator('.ProseMirror');
		await expect(editor).toHaveAttribute('contenteditable', 'true', { timeout: 20_000 });
		await editor.fill('Base locale');
		await page.keyboard.press('Home');
		for (let index = 0; index < 4; index++) await page.keyboard.press('ArrowRight');
		await page.keyboard.press('ControlOrMeta+n');
		await page.getByTestId('create-note').click();
		await expect(editor).toBeVisible({ timeout: 20_000 });
		await page.locator('button[data-file-id]').filter({ hasText: 'Caret A' }).click();
		await expect(editor).toContainText('Base locale');
		// The saved caret is in the editor state. No key has moved it since.
		await expect
			.poll(() => page.evaluate(() => window.__MDSH_EDITOR_VIEW__?.state.selection.head))
			.toBe(5);
		await editor.focus();
		await page.keyboard.insertText('X');
		await expect(editor).toContainText('BaseX locale');
	});
});

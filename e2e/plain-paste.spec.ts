import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { createFirstFile, resetAppState, writeSourceContent } from './helpers';

const fixtures = {
	paragraph: '# Existing title\n\nDestination paragraph.\n',
	heading: '# Target heading\n\nBody.\n',
	list: '- Target item\n- Second item\n',
	table: '| HEAD | OTHER |\n| --- | --- |\n| ALPHA | BETA |\n'
};

const richPayload = {
	html: [
		'<h1>Source title</h1>',
		'<p><strong>Bold source</strong> and <a href="https://example.com/source">link source</a></p>',
		'<ul><li>Source item</li></ul>'
	].join(''),
	text: 'Source title\nBold source and link source\nSource item'
};

async function savedContent(page: Page): Promise<string> {
	return page.evaluate(
		() =>
			new Promise<string>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const rows = database.transaction('drafts').objectStore('drafts').getAll();
					rows.onerror = () => {
						database.close();
						reject(rows.error);
					};
					rows.onsuccess = () => {
						database.close();
						const row = rows.result.find((item) => item.open !== false);
						if (typeof row?.content !== 'string') reject(new Error('Missing note content'));
						else resolve(row.content);
					};
				};
			})
	);
}

async function openVisual(page: Page, fixture: string): Promise<Locator> {
	await createFirstFile(page);
	await writeSourceContent(page, fixture);
	await page.locator('button[data-mode="wysiwyg"]').click();
	const editor = page.locator('.ProseMirror');
	await expect(editor).toBeVisible({ timeout: 30_000 });
	return editor;
}

async function caretAfter(page: Page, needle: string, scopeSelector = '.ProseMirror') {
	await page.evaluate(
		({ needle: text, scopeSelector: scope }) => {
			const editor = document.querySelector<HTMLElement>('.ProseMirror');
			const root = document.querySelector<HTMLElement>(scope);
			if (!editor || !root) throw new Error(`Missing editor or scope: ${scope}`);
			const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
			let node: Text | null;
			while ((node = walker.nextNode() as Text | null)) {
				const index = node.data.indexOf(text);
				if (index < 0) continue;
				const range = document.createRange();
				range.setStart(node, index + text.length);
				range.collapse(true);
				editor.focus();
				const selection = window.getSelection();
				selection?.removeAllRanges();
				selection?.addRange(range);
				return;
			}
			throw new Error(`Text not found: ${text}`);
		},
		{ needle, scopeSelector }
	);
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			)
	);
}

async function selectText(page: Page, needle: string) {
	await page.evaluate((text) => {
		const editor = document.querySelector<HTMLElement>('.ProseMirror');
		if (!editor) throw new Error('Missing editor');
		const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
		let node: Text | null;
		while ((node = walker.nextNode() as Text | null)) {
			const index = node.data.indexOf(text);
			if (index < 0) continue;
			const range = document.createRange();
			range.setStart(node, index);
			range.setEnd(node, index + text.length);
			editor.focus();
			const selection = window.getSelection();
			selection?.removeAllRanges();
			selection?.addRange(range);
			return;
		}
		throw new Error(`Text not found: ${text}`);
	}, needle);
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			)
	);
}

async function writeText(page: Page, text: string) {
	await page.evaluate((value) => navigator.clipboard.writeText(value), text);
}

async function writeRich(page: Page, payload: { html: string; text: string }) {
	await page.evaluate(async (value) => {
		await navigator.clipboard.write([
			new ClipboardItem({
				'text/html': new Blob([value.html], { type: 'text/html' }),
				'text/plain': new Blob([value.text], { type: 'text/plain' })
			})
		]);
	}, payload);
}

interface Snapshot {
	markdown: string;
	visualText: string;
	h1Text: string[];
	h2Text: string[];
	strongText: string[];
	codeText: string[];
	linkText: string[];
	liText: string[];
	cellText: string[];
	rows: number;
}

async function snapshot(page: Page, editor: Locator): Promise<Snapshot> {
	return {
		markdown: await savedContent(page),
		visualText: await editor.innerText(),
		h1Text: await editor.locator('h1').allInnerTexts(),
		h2Text: await editor.locator('h2').allInnerTexts(),
		strongText: await editor.locator('strong').allInnerTexts(),
		codeText: await editor.locator('code').allInnerTexts(),
		linkText: await editor.locator('a').allInnerTexts(),
		liText: await editor.locator('li').allInnerTexts(),
		cellText: await editor.locator('td, th').allInnerTexts(),
		rows: await editor.locator('tr').count()
	};
}

async function record(
	page: Page,
	info: TestInfo,
	fixture: string,
	clipboard: { html?: string; text: string },
	stage: string,
	result: Snapshot
) {
	await info.attach(`${stage}.json`, {
		body: JSON.stringify(
			{
				command: info.config.metadata.command,
				source: info.config.metadata.source,
				workingDiffSha256: info.config.metadata.workingDiffSha256,
				environment: info.config.metadata.environment,
				project: info.project.name,
				status: info.status,
				stage,
				fixture,
				clipboard,
				result
			},
			null,
			2
		),
		contentType: 'application/json'
	});
}

async function pauseForSave(page: Page) {
	await page.waitForTimeout(900);
}

async function reloadVisual(page: Page): Promise<Locator> {
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	await page.locator('button[data-mode="wysiwyg"]').click();
	const editor = page.locator('.ProseMirror');
	await expect(editor).toBeVisible({ timeout: 30_000 });
	return editor;
}

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

test.beforeEach(async ({ page, context }, info) => {
	test.skip(info.project.name !== 'chromium', 'System clipboard access requires Chromium.');
	await context.grantPermissions(['clipboard-read', 'clipboard-write']);
	await resetAppState(page);
});

test('shift paste keeps Markdown characters literal and survives reload', async ({
	page
}, info) => {
	const editor = await openVisual(page, fixtures.paragraph);
	const clipboard = { text: '**not bold** and `not code`' };
	await writeText(page, clipboard.text);
	await caretAfter(page, 'Destination paragraph.');
	await page.keyboard.press('ControlOrMeta+Shift+v');
	await pauseForSave(page);
	const result = await snapshot(page, editor);
	await record(page, info, fixtures.paragraph, clipboard, 'literal', result);

	expect.soft(result.visualText).toContain('**not bold** and `not code`');
	expect.soft(result.strongText).toEqual([]);
	expect.soft(result.codeText).toEqual([]);

	const reloaded = await reloadVisual(page);
	const afterReload = await snapshot(page, reloaded);
	await record(page, info, fixtures.paragraph, clipboard, 'literal-reload', afterReload);
	expect.soft(afterReload.visualText).toContain('**not bold** and `not code`');
	expect.soft(afterReload.strongText).toEqual([]);
	expect.soft(afterReload.codeText).toEqual([]);
});

test('shift paste keeps heading syntax literal and survives reload', async ({ page }, info) => {
	const editor = await openVisual(page, '# Existing title\n\nTarget.\n');
	const clipboard = { text: '## Not a plain heading' };
	await writeText(page, clipboard.text);
	await selectText(page, 'Target.');
	await page.keyboard.press('ControlOrMeta+Shift+v');
	await pauseForSave(page);
	const result = await snapshot(page, editor);
	await record(page, info, '# Existing title\n\nTarget.\n', clipboard, 'literal-heading', result);
	expect.soft(result.h2Text).toEqual([]);
	expect.soft(result.visualText).toContain('## Not a plain heading');

	const reloaded = await reloadVisual(page);
	const afterReload = await snapshot(page, reloaded);
	await record(
		page,
		info,
		'# Existing title\n\nTarget.\n',
		clipboard,
		'literal-heading-reload',
		afterReload
	);
	expect.soft(afterReload.h2Text).toEqual([]);
	expect.soft(afterReload.visualText).toContain('## Not a plain heading');
});

test('shift paste keeps the destination heading', async ({ page }, info) => {
	const editor = await openVisual(page, fixtures.heading);
	const clipboard = { text: ' Pasted line' };
	await writeText(page, clipboard.text);
	await caretAfter(page, 'Target heading');
	await page.keyboard.press('ControlOrMeta+Shift+v');
	await pauseForSave(page);
	const result = await snapshot(page, editor);
	await record(page, info, fixtures.heading, clipboard, 'heading', result);
	expect.soft(result.h1Text).toEqual(['Target heading Pasted line']);
});

test('shift paste keeps the destination list item and adds a new item', async ({ page }, info) => {
	const editor = await openVisual(page, fixtures.list);
	const clipboard = { text: ' First line\nSecond line\n\nNew paragraph' };
	await writeText(page, clipboard.text);
	await caretAfter(page, 'Target item');
	await page.keyboard.press('ControlOrMeta+Shift+v');
	await pauseForSave(page);
	const result = await snapshot(page, editor);
	await record(page, info, fixtures.list, clipboard, 'list', result);
	expect.soft(result.visualText).toContain('First line');
	expect.soft(result.visualText).toContain('Second line');
	expect.soft(result.liText).toHaveLength(3);
	expect.soft(result.liText[0]).toContain('First line');
	expect.soft(result.liText[0]).toContain('Second line');
	expect.soft(result.liText[1]).toContain('New paragraph');
	expect.soft(result.liText[2]).toContain('Second item');
});

test('shift paste keeps the destination heading and moves later paragraphs below it', async ({
	page
}, info) => {
	const editor = await openVisual(page, fixtures.heading);
	const clipboard = { text: ' First paragraph\n\nSecond paragraph' };
	await writeText(page, clipboard.text);
	await caretAfter(page, 'Target heading');
	await page.keyboard.press('ControlOrMeta+Shift+v');
	await pauseForSave(page);
	const result = await snapshot(page, editor);
	await record(page, info, fixtures.heading, clipboard, 'heading-paragraphs', result);
	expect.soft(result.h1Text).toEqual(['Target heading First paragraph']);
	expect.soft(result.visualText).toContain('Second paragraph');
	expect.soft(result.markdown).toContain('Second paragraph');
});

test('shift paste numbers new ordered list items', async ({ page }, info) => {
	const fixture = '1. Target item\n2. Second item\n';
	const editor = await openVisual(page, fixture);
	const clipboard = { text: ' First line\n\nNew paragraph' };
	await writeText(page, clipboard.text);
	await caretAfter(page, 'Target item');
	await page.keyboard.press('ControlOrMeta+Shift+v');
	await pauseForSave(page);
	const result = await snapshot(page, editor);
	await record(page, info, fixture, clipboard, 'ordered-list', result);
	expect.soft(result.liText).toHaveLength(3);
	expect.soft(result.liText[1]).toContain('New paragraph');
	expect.soft(result.markdown).toContain('New paragraph');
});

test('shift paste creates an unchecked task item in a task list', async ({ page }, info) => {
	const fixture = '- [ ] Target item\n- [x] Second item\n';
	const editor = await openVisual(page, fixture);
	const clipboard = { text: ' First line\n\nNew task' };
	await writeText(page, clipboard.text);
	await caretAfter(page, 'Target item');
	await page.keyboard.press('ControlOrMeta+Shift+v');
	await pauseForSave(page);
	const result = await snapshot(page, editor);
	await record(page, info, fixture, clipboard, 'task-list', result);
	expect.soft(result.liText).toHaveLength(3);
	expect.soft(result.liText[1]).toContain('New task');
	expect.soft(result.markdown).toContain('[ ] New task');
});

test('shift paste keeps multiple lines inside one table cell', async ({ page }, info) => {
	const editor = await openVisual(page, fixtures.table);
	const clipboard = { text: 'ONE\nTWO' };
	await writeText(page, clipboard.text);
	await caretAfter(page, 'ALPHA', '.ProseMirror td');
	await page.keyboard.press('ControlOrMeta+Shift+v');
	await pauseForSave(page);
	const result = await snapshot(page, editor);
	await record(page, info, fixtures.table, clipboard, 'table', result);
	expect.soft(result.markdown).toContain('ALPHAONE');
	expect.soft(result.markdown).toContain('BETA');
	expect.soft(result.cellText[2]).toContain('ONE');
	expect.soft(result.cellText[2]).toContain('TWO');
	expect.soft(result.rows).toBe(2);
});

test('shift paste with a blank line creates a second paragraph', async ({ page }, info) => {
	const editor = await openVisual(page, fixtures.paragraph);
	const clipboard = { text: ' First paragraph\n\nSecond paragraph' };
	await writeText(page, clipboard.text);
	await caretAfter(page, 'Destination paragraph.');
	await page.keyboard.press('ControlOrMeta+Shift+v');
	await pauseForSave(page);
	const result = await snapshot(page, editor);
	await record(page, info, fixtures.paragraph, clipboard, 'blank-line', result);
	expect.soft(result.visualText).toContain('First paragraph');
	expect.soft(result.visualText).toContain('Second paragraph');
	expect.soft(result.markdown).toContain('\n\nSecond paragraph');
});

test('the command palette exposes paste as plain text', async ({ page }, info) => {
	const editor = await openVisual(page, fixtures.paragraph);
	const clipboard = { text: '**not bold**' };
	await writeText(page, clipboard.text);
	await caretAfter(page, 'Destination paragraph.');
	await page.keyboard.press('ControlOrMeta+Shift+p');
	const palette = page.getByRole('combobox');
	await palette.fill('Coller en texte brut');
	await page.keyboard.press('Enter');
	await pauseForSave(page);
	const result = await snapshot(page, editor);
	await record(page, info, fixtures.paragraph, clipboard, 'palette', result);
	expect.soft(result.visualText).toContain('**not bold**');
	expect.soft(result.strongText).toEqual([]);
});

test('rich paste still keeps source structure', async ({ page }, info) => {
	const editor = await openVisual(page, fixtures.paragraph);
	await writeRich(page, richPayload);
	await caretAfter(page, 'Destination paragraph.');
	await page.keyboard.press('ControlOrMeta+v');
	await pauseForSave(page);
	const result = await snapshot(page, editor);
	await record(page, info, fixtures.paragraph, richPayload, 'rich', result);
	expect.soft(result.strongText.join(' ')).toContain('Bold source');
	expect.soft(result.linkText).toContain('link source');
	expect.soft(result.liText.join(' ')).toContain('Source item');
});

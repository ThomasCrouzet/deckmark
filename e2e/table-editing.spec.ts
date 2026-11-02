import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { createFirstFile, resetAppState, writeSourceContent } from './helpers';

const fixture =
	'# Before\n\n| HEADING | OTHER |\n| --- | --- |\n| ALPHA | BETA |\n| GAMMA | DELTA |\n\nAfter table.\n';

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

test('first cell clicks keep existing text when typing starts', async ({ page }, info) => {
	await resetAppState(page);
	await createFirstFile(page);
	await writeSourceContent(page, fixture);
	await page.locator('button[data-mode="wysiwyg"]').click();
	let expected = fixture;
	const selections = [];
	for (const token of ['HEADING', 'ALPHA', 'GAMMA']) {
		const cell = page.locator('.ProseMirror th, .ProseMirror td').filter({ hasText: token });
		await cell.locator('p').click();
		const selection = await cell.evaluate(async (element) => {
			await new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			);
			const current = window.getSelection();
			return {
				collapsed: current?.isCollapsed,
				inside: element.contains(current?.anchorNode ?? null),
				text: current?.toString()
			};
		});
		selections.push({ token, ...selection });
		expect(selection).toEqual({ collapsed: true, inside: true, text: '' });
		await page.keyboard.type('TAIL');
		await expect(cell).toHaveText(`${token}TAIL`);
		expected = expected.replace(token, `${token}TAIL`);
		await expect.poll(() => savedContent(page)).toBe(expected);
	}
	await page.reload();
	await expect.poll(() => savedContent(page)).toBe(expected);
	await info.attach('first-cell-clicks.json', {
		body: JSON.stringify({ fixture, expected, selections }, null, 2),
		contentType: 'application/json'
	});
});

test('table controls have names and hidden controls leave the tab order', async ({
	page
}, info) => {
	await resetAppState(page);
	await createFirstFile(page);
	await writeSourceContent(page, fixture);
	await page.locator('button[data-mode="wysiwyg"]').click();
	const editor = page.locator('.ProseMirror');
	const block = editor.locator('.milkdown-table-block');
	await editor.locator('td').first().hover();
	await page.locator('[data-role="row-drag-handle"][data-show="true"]').click();
	const unnamed = await block.evaluate((root) =>
		Array.from(root.querySelectorAll('button'))
			.filter((button) => button.tabIndex >= 0)
			.filter((button) => !button.getAttribute('aria-label')?.trim())
			.map((button) => button.outerHTML.slice(0, 120))
	);
	expect(unnamed).toEqual([]);
	const hiddenTabbable = await block.evaluate((root) => {
		const isHidden = (start: Element | null) => {
			for (
				let current = start;
				current && current !== root.parentElement;
				current = current.parentElement
			) {
				if (current.getAttribute('data-show') === 'false') return true;
				if (getComputedStyle(current).opacity === '0') return true;
			}
			return false;
		};
		return Array.from(root.querySelectorAll('button')).filter(
			(button) => isHidden(button) && button.tabIndex >= 0
		).length;
	});
	expect(hiddenTabbable).toBe(0);
	await editor.locator('td').last().click();
	await page.keyboard.press('End');
	await page.keyboard.press('Tab');
	const focused = await page.evaluate(() => {
		const element = document.activeElement;
		if (!(element instanceof HTMLElement)) return null;
		let hidden = false;
		for (let current: HTMLElement | null = element; current; current = current.parentElement) {
			if (current.getAttribute('data-show') === 'false') hidden = true;
			if (getComputedStyle(current).opacity === '0') hidden = true;
		}
		return {
			tag: element.tagName,
			label: element.getAttribute('aria-label') ?? element.textContent?.trim() ?? '',
			hidden
		};
	});
	expect(focused?.hidden).toBe(false);
	await info.attach('table-controls.json', {
		body: JSON.stringify({ unnamed, hiddenTabbable, focused }, null, 2),
		contentType: 'application/json'
	});
});

test('trailing and empty-cell breaks survive reload and undo', async ({ page }, info) => {
	await resetAppState(page);
	await createFirstFile(page);
	const input = fixture.replace('GAMMA', '');
	await writeSourceContent(page, input);
	await page.locator('button[data-mode="wysiwyg"]').click();
	const editor = page.locator('.ProseMirror');
	const body = editor.locator('td').first();
	await body.getByText('ALPHA', { exact: true }).click();
	await page.keyboard.press('End');
	await page.keyboard.press('Enter');
	await expect.poll(() => savedContent(page)).toContain('ALPHA<br>');
	await page.keyboard.press('ControlOrMeta+z');
	await expect.poll(() => savedContent(page)).toBe(input);
	await page.keyboard.press('ControlOrMeta+Shift+z');
	await expect.poll(() => savedContent(page)).toContain('ALPHA<br>');
	const empty = editor.locator('td').nth(2);
	await empty.locator('p').click();
	await page.keyboard.press('Enter');
	await expect.poll(async () => (await savedContent(page)).match(/<br>/g)?.length).toBe(2);
	const saved = await savedContent(page);
	await page.reload();
	await expect(body.locator('br:not(.ProseMirror-trailingBreak)')).toHaveCount(1);
	await expect(empty.locator('br:not(.ProseMirror-trailingBreak)')).toHaveCount(1);
	await empty.locator('p').click();
	await page.keyboard.press('ControlOrMeta+Enter');
	await page.keyboard.insertText('Outside.');
	await expect(editor.locator(':scope > p').filter({ hasText: 'Outside.' })).toBeVisible();
	await expect(editor.locator('td')).toHaveCount(4);
	await expect.poll(() => savedContent(page)).toContain('Outside.');
	await info.attach('table-trailing.json', {
		body: JSON.stringify({ input, saved, finalSaved: await savedContent(page) }, null, 2),
		contentType: 'application/json'
	});
});

test('imported safe break tags are editable without rendering other HTML', async ({
	page
}, info) => {
	await resetAppState(page);
	await createFirstFile(page);
	const input =
		'# Before\n\n| H<br>HEAD | OTHER |\n| --- | --- |\n| A<br>B<BR/>C<br /> | <br> |\n| <span>inert</span> | `a<br>b` |\n\nAfter table.\n';
	await writeSourceContent(page, input);
	await page.locator('button[data-mode="wysiwyg"]').click();
	const editor = page.locator('.ProseMirror');
	const cell = editor.locator('td').first();
	await expect(cell).toHaveText('ABC');
	await expect(cell.locator('br:not(.ProseMirror-trailingBreak)')).toHaveCount(3);
	await expect(editor.locator('th').first()).toHaveText('HHEAD');
	await expect(
		editor.locator('td').nth(1).locator('br:not(.ProseMirror-trailingBreak)')
	).toHaveCount(1);
	await expect(editor.locator('td').nth(2)).toHaveText('<span>inert</span>');
	await expect(editor.locator('td').nth(3).locator('code')).toHaveText('a<br>b');
	await editor.locator('th').nth(1).getByText('OTHER', { exact: true }).click();
	await page.keyboard.press('End');
	await page.keyboard.insertText('EDIT');
	await expect.poll(() => savedContent(page)).toBe(input.replace('OTHER', 'OTHEREDIT'));
	await page.reload();
	await expect(cell).toHaveText('ABC');
	await expect(cell.locator('br:not(.ProseMirror-trailingBreak)')).toHaveCount(3);
	await expect.poll(() => savedContent(page)).toBe(input.replace('OTHER', 'OTHEREDIT'));
	await expect(
		editor.locator('td').nth(1).locator('br:not(.ProseMirror-trailingBreak)')
	).toHaveCount(1);
	await info.attach('table-import.json', {
		body: JSON.stringify({ input, saved: await savedContent(page) }, null, 2),
		contentType: 'application/json'
	});
});

test('HTML paste keeps line breaks and adjacent cells', async ({ page, context }, info) => {
	test.skip(info.project.name !== 'chromium', 'Browser clipboard permissions require Chromium.');
	await context.grantPermissions(['clipboard-read', 'clipboard-write']);
	await resetAppState(page);
	await createFirstFile(page);
	await writeSourceContent(page, fixture);
	await page.locator('button[data-mode="wysiwyg"]').click();
	const cell = page.locator('.ProseMirror td').first();
	await cell.getByText('ALPHA', { exact: true }).click();
	await page.keyboard.press('End');
	await info.attach('paste-selection.json', {
		body: JSON.stringify(
			await page.evaluate(() => {
				const selection = window.getSelection();
				return {
					selected: selection?.toString(),
					anchor: selection?.anchorNode?.textContent,
					anchorOffset: selection?.anchorOffset,
					focus: selection?.focusNode?.textContent,
					focusOffset: selection?.focusOffset,
					active: document.activeElement?.outerHTML.slice(0, 250)
				};
			})
		),
		contentType: 'application/json'
	});
	await page.evaluate(async () => {
		await navigator.clipboard.write([
			new ClipboardItem({
				'text/html': new Blob(['<p>ONE<br>TWO<br><br></p>'], { type: 'text/html' }),
				'text/plain': new Blob(['ONE\nTWO\n\n'], { type: 'text/plain' })
			})
		]);
	});
	await page.keyboard.press('ControlOrMeta+v');
	await expect(cell).toHaveText('ALPHAONETWO');
	await expect(cell.locator('br:not(.ProseMirror-trailingBreak)')).toHaveCount(3);
	await expect.poll(async () => (await savedContent(page)).match(/<br>/g)?.length).toBe(3);
	await page.reload();
	await expect(cell).toHaveText('ALPHAONETWO');
	await expect(cell.locator('br:not(.ProseMirror-trailingBreak)')).toHaveCount(3);
	await expect(page.locator('.ProseMirror td').nth(1)).toHaveText('BETA');
	await info.attach('table-paste.json', {
		body: JSON.stringify({ fixture, saved: await savedContent(page) }, null, 2),
		contentType: 'application/json'
	});
});

test('pasting a copied row keeps one table and the surrounding paragraphs', async ({
	page,
	context
}, info) => {
	test.skip(info.project.name !== 'chromium', 'Browser clipboard permissions require Chromium.');
	await context.grantPermissions(['clipboard-read', 'clipboard-write']);
	await resetAppState(page);
	await createFirstFile(page);
	await writeSourceContent(page, fixture);
	await page.locator('button[data-mode="wysiwyg"]').click();
	const editor = page.locator('.ProseMirror');
	await editor.locator('td').first().hover();
	await page.locator('[data-role="row-drag-handle"][data-show="true"]').click();
	await page.keyboard.press('ControlOrMeta+c');
	await editor.locator('td').nth(2).click();
	await page.keyboard.press('Home');
	await page.keyboard.press('ControlOrMeta+v');
	await expect(editor.locator('table.children')).toHaveCount(1);
	await expect(editor.locator('table.children th, table.children td')).toHaveCount(6);
	await expect(editor.locator('table.children')).toContainText('ALPHA');
	await expect(editor.locator(':scope > p').last()).toHaveText('After table.');
	await expect(editor.locator('h1')).toHaveText('Before');
	await expect.poll(() => savedContent(page)).not.toBe(fixture);
	const saved = await savedContent(page);
	await page.reload();
	await expect.poll(() => savedContent(page)).toBe(saved);
	await expect(editor.locator('table.children')).toHaveCount(1);
	await info.attach('table-row-paste.json', {
		body: JSON.stringify({ fixture, saved }, null, 2),
		contentType: 'application/json'
	});
});

test('a break inside formatted text keeps both text segments', async ({ page }, info) => {
	await resetAppState(page);
	await createFirstFile(page);
	const input = fixture.replace('ALPHA', '**LEFT RIGHT**');
	await writeSourceContent(page, input);
	await page.locator('button[data-mode="wysiwyg"]').click();
	const cell = page.locator('.ProseMirror td').first();
	await cell.locator('strong').click();
	await page.keyboard.press('Home');
	for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
	await page.keyboard.press('Enter');
	await expect(cell).toHaveText('LEFT RIGHT');
	await expect(cell.locator('br:not(.ProseMirror-trailingBreak)')).toHaveCount(1);
	await expect.poll(() => savedContent(page)).toContain('<br>');
	await page.reload();
	await expect(cell).toHaveText('LEFT RIGHT');
	await expect(cell.locator('br:not(.ProseMirror-trailingBreak)')).toHaveCount(1);
	await expect(cell.locator('strong')).toHaveText(['LEFT ', 'RIGHT']);
	await info.attach('table-formatted.json', {
		body: JSON.stringify({ input, saved: await savedContent(page) }, null, 2),
		contentType: 'application/json'
	});
});

test('WebKit ignores the Enter event that confirms an IME composition', async ({ page }, info) => {
	test.skip(
		info.project.name !== 'webkit',
		'This event sequence checks the Safari composition guard.'
	);
	await resetAppState(page);
	await createFirstFile(page);
	await writeSourceContent(page, fixture);
	await page.locator('button[data-mode="wysiwyg"]').click();
	const cell = page.locator('.ProseMirror td').first();
	await cell.getByText('ALPHA', { exact: true }).dblclick();
	await page.keyboard.press('End');
	await page.keyboard.insertText('IME');
	await expect(cell).toHaveText('ALPHAIME');
	const events = await page.locator('.ProseMirror').evaluate((editor) => {
		editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
		editor.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
		const confirm = new KeyboardEvent('keydown', {
			key: 'Enter',
			code: 'Enter',
			keyCode: 13,
			bubbles: true,
			cancelable: true
		});
		editor.dispatchEvent(confirm);
		return {
			userAgent: navigator.userAgent,
			syntheticComposition: true,
			confirmPrevented: confirm.defaultPrevented
		};
	});
	await info.attach('composition-events.json', {
		body: JSON.stringify(events),
		contentType: 'application/json'
	});
	await expect(cell.locator('br:not(.ProseMirror-trailingBreak)')).toHaveCount(0);
	await page.keyboard.press('Enter');
	await expect(cell.locator('br:not(.ProseMirror-trailingBreak)')).toHaveCount(1);
	await expect.poll(() => savedContent(page)).toContain('ALPHAIME<br>');
});

for (const key of ['Enter', 'Shift+Enter']) {
	for (const token of ['HEADING', 'ALPHA']) {
		test(`${key} keeps new lines inside the ${token} table cell`, async ({ page }, info) => {
			await resetAppState(page);
			await createFirstFile(page);
			await writeSourceContent(page, fixture);
			await expect.poll(() => savedContent(page)).toBe(fixture);
			await page.locator('button[data-mode="wysiwyg"]').click();
			const editor = page.locator('.ProseMirror');
			const cell = editor
				.locator(token === 'HEADING' ? 'th' : 'td')
				.filter({ hasText: token })
				.first();
			const evidence = { fixture, key, token, saved: '', exported: '' };
			try {
				await expect(cell).toBeVisible();
				await cell.getByText(token, { exact: true }).click();
				await page.keyboard.press('End');
				await page.keyboard.press(key);
				await page.keyboard.insertText('SECOND');
				await expect(cell).toHaveText(`${token}SECOND`);
				await expect(cell.locator('br[data-type="hardbreak"]')).toHaveCount(1);
				await page.keyboard.press(key);
				await page.keyboard.press(key);
				await page.keyboard.insertText('THIRD');
				await expect(cell).toHaveText(`${token}SECONDTHIRD`);
				await expect(cell.locator('br[data-type="hardbreak"]')).toHaveCount(3);
				await expect(editor.locator('table.children')).toHaveCount(1);
				await expect(editor.locator('th, td')).toHaveCount(6);
				await expect(editor.locator('h1')).toHaveText('Before');
				await expect(editor.locator(':scope > p').last()).toHaveText('After table.');
				await expect.poll(() => savedContent(page)).toContain('THIRD');
				evidence.saved = await savedContent(page);
				expect(evidence.saved).toBe(fixture.replace(token, `${token}<br>SECOND<br><br>THIRD`));
				await page.locator('button[data-mode="read"]').click();
				const renderedCell = page
					.locator('.mdsh-read')
					.locator(token === 'HEADING' ? 'th' : 'td')
					.filter({ hasText: token });
				await expect(renderedCell).toHaveText(`${token}SECONDTHIRD`);
				await expect(renderedCell.locator('br')).toHaveCount(3);
				await page.locator('button[data-mode="wysiwyg"]').click();
				await expect(cell.locator('br[data-type="hardbreak"]')).toHaveCount(3);
				await page.reload();
				await expect(cell).toHaveText(`${token}SECONDTHIRD`);
				await expect(cell.locator('br[data-type="hardbreak"]')).toHaveCount(3);
				await expect.poll(() => savedContent(page)).toBe(evidence.saved);
				const pending = page.waitForEvent('download');
				await page.getByRole('button', { name: 'Exporter', exact: true }).click();
				const download = await pending;
				const path = info.outputPath('table.md');
				await download.saveAs(path);
				evidence.exported = await readFile(path, 'utf8');
				expect(evidence.exported).toBe(evidence.saved);
				await info.attach('table.md', { path, contentType: 'text/markdown' });
			} finally {
				await info.attach('table-workflow.json', {
					body: JSON.stringify(
						{
							...evidence,
							finalSaved: await savedContent(page),
							editorHTML: await editor.innerHTML().catch(() => '')
						},
						null,
						2
					),
					contentType: 'application/json'
				});
				await info.attach('table.png', { body: await page.screenshot(), contentType: 'image/png' });
			}
		});
	}
}

import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { resetAppState } from './helpers';
import { importMarkdown, presentationFixture } from './presentation-helpers';

const marker = '<!-- mdsh-presentation\n{}\n-->';
const initial = '# Guard note\n\nSaved paragraph.';
const continuation = '\n\nRetained after rejection.';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

test.beforeEach(async ({ page }) => {
	await resetAppState(page);
	await page.evaluate(() => localStorage.setItem('mdsh:locale', 'en'));
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
});

test.afterEach(async ({ page, browser }, info) => {
	await info.attach('result.json', {
		body: JSON.stringify(
			{
				command: info.config.metadata.command,
				source: info.config.metadata.source,
				workingDiffSha256: info.config.metadata.workingDiffSha256,
				environment: info.config.metadata.environment,
				browser: browser.version(),
				status: info.status,
				fixtures: { initial, marker, continuation }
			},
			null,
			2
		),
		contentType: 'application/json'
	});
	await info.attach('final.png', { body: await page.screenshot(), contentType: 'image/png' });
});

async function sourceText(page: Page) {
	return page
		.locator('[data-testid="mdsh-source"] .cm-line')
		.evaluateAll((lines) => lines.map((line) => line.textContent).join('\n'));
}

async function record(page: Page, info: TestInfo, stage: string) {
	await info.attach(`${stage}.json`, {
		body: JSON.stringify(
			{
				source: await page.locator('[data-testid="mdsh-source"] .cm-content').allInnerTexts(),
				visual: await page.locator('.ProseMirror').allInnerTexts(),
				mode: await page.locator('[data-mode][aria-checked="true"]').getAttribute('data-mode'),
				saved: await page.locator('.title-save').innerText(),
				kind: await page.getByTestId('document-kind').innerText()
			},
			null,
			2
		),
		contentType: 'application/json'
	});
}

async function exportNote(page: Page, info: TestInfo, stage: string) {
	await page.keyboard.press('ControlOrMeta+Shift+p');
	await page.getByRole('combobox').fill('Export all files (ZIP)');
	const download = page.waitForEvent('download');
	await page.keyboard.press('Enter');
	const chunks: Buffer[] = [];
	for await (const chunk of (await (await download).createReadStream())!) chunks.push(chunk);
	const bytes = Buffer.concat(chunks);
	await info.attach(`${stage}.zip`, { body: bytes, contentType: 'application/zip' });
	const zip = await (await import('jszip')).default.loadAsync(bytes);
	const file = Object.values(zip.files).find((file) => file.name.endsWith('.md'))!;
	const source = await file.async('string');
	await info.attach(`${stage}.md`, { body: source, contentType: 'text/markdown' });
	return source;
}

async function reopen(page: Page) {
	await page.getByRole('button', { name: 'Close Guard note', exact: true }).click();
	await page.locator('summary').filter({ hasText: 'Saved documents' }).click();
	await page.getByRole('button', { name: 'Guard note.md', exact: true }).click();
	await expect(page.getByTestId('document-kind')).toHaveText('Note');
}

for (const split of [false, true]) {
	test(`rejects source conversion before acceptance${split ? ' in split view' : ''}`, async ({
		page
	}, info) => {
		await importMarkdown(page, initial, 'Guard note.md');
		if (split) await page.getByTestId('split-view-toggle').click();
		const source = page.locator('[data-testid="mdsh-source"] .cm-content');
		await expect(source).toBeVisible();
		await expect(page.locator('.title-save')).toHaveText('saved');
		await record(page, info, 'before');
		await source.focus();
		await page.keyboard.press('ControlOrMeta+End');
		await page.keyboard.insertText(`\n\n${marker}`);
		await expect(page.getByRole('alert')).toContainText('cannot become a presentation');
		await record(page, info, 'rejected');
		await info.attach('rejected.png', { body: await page.screenshot(), contentType: 'image/png' });
		expect.soft(await sourceText(page)).toBe(initial);
		await page.keyboard.insertText(continuation);
		await record(page, info, 'continued');
		expect.soft(await sourceText(page)).toBe(initial + continuation);
		await page.keyboard.press('ControlOrMeta+z');
		expect.soft(await sourceText(page)).toBe(initial);
		await page.keyboard.press('ControlOrMeta+Shift+z');
		expect.soft(await sourceText(page)).toBe(initial + continuation);
		await page.locator('[data-mode="read"]').click();
		await record(page, info, 'read');
		await page.locator('[data-mode="source"]').click();
		await expect(source).toBeVisible();
		await record(page, info, 'source-return');
		expect.soft(await sourceText(page)).toBe(initial + continuation);
		expect.soft(await exportNote(page, info, 'export')).toBe(initial + continuation);
		await expect(page.locator('.title-save')).toHaveText('saved');
		await reopen(page);
		await record(page, info, 'reopened');
		expect.soft(await sourceText(page)).toBe(initial + continuation);
		await page.reload();
		await expect(source).toBeVisible();
		await record(page, info, 'reload');
		expect(await sourceText(page)).toBe(initial + continuation);
	});
}

test('rejects visual HTML marker nodes before acceptance and keeps later edits', async ({
	page
}, info) => {
	await importMarkdown(page, initial, 'Guard note.md');
	await page.locator('[data-mode="wysiwyg"]').click();
	const visual = page.locator('.ProseMirror');
	await expect(visual).toBeVisible({ timeout: 30000 });
	await visual.click();
	await page.keyboard.press('ControlOrMeta+End');
	await record(page, info, 'before');
	// Milkdown copies HTML atoms as spans with the value in a data attribute.
	const clipboard = await visual.evaluate((element, value) => {
		const atom = document.createElement('span');
		atom.dataset.type = 'html';
		atom.dataset.value = value;
		atom.textContent = value;
		const data = new DataTransfer();
		data.setData('text/html', `<p>${atom.outerHTML}</p>`);
		data.setData('text/plain', value);
		// Firefox clears data passed to a synthetic ClipboardEvent constructor.
		const event = new Event('paste', { bubbles: true, cancelable: true });
		Object.defineProperty(event, 'clipboardData', { value: data });
		element.dispatchEvent(event);
		return {
			html: data.getData('text/html'),
			text: data.getData('text/plain'),
			handled: event.defaultPrevented
		};
	}, `\n\n${marker}`);
	await info.attach('clipboard.json', {
		body: JSON.stringify(clipboard),
		contentType: 'application/json'
	});
	await expect(page.getByRole('alert')).toContainText('cannot become a presentation');
	await record(page, info, 'rejected');
	await info.attach('rejected.png', { body: await page.screenshot(), contentType: 'image/png' });
	await expect.soft(visual).not.toContainText('mdsh-presentation');
	await page.keyboard.insertText(' Retained visual edit.');
	await expect(visual).toContainText('Retained visual edit.');
	await page.keyboard.press('ControlOrMeta+z');
	await expect(visual).not.toContainText('Retained visual edit.');
	await page.keyboard.press('ControlOrMeta+Shift+z');
	await expect(visual).toContainText('Retained visual edit.');
	await page.locator('[data-mode="source"]').click();
	await record(page, info, 'source-return');
	const expected = initial + ' Retained visual edit.';
	expect.soft(await sourceText(page)).toBe(expected);
	expect.soft(await exportNote(page, info, 'export')).toBe(expected);
	await expect(page.locator('.title-save')).toHaveText('saved');
	await reopen(page);
	await record(page, info, 'reopened');
	expect(await sourceText(page)).toBe(expected);
});

test('keeps front matter and fenced marker bytes through source and visual edits', async ({
	page
}, info) => {
	const fixture =
		'\uFEFF---\r\nexample: |\r\n  <!-- mdsh-presentation\r\n  {}\r\n  -->\r\n---\r\n\r\n# Guard note\r\n\r\nSaved paragraph.\r\n\r\n~~~html\r\n' +
		marker.replaceAll('\n', '\r\n') +
		'\r\n~~~\r\n';
	await info.attach('fixture.md', { body: fixture, contentType: 'text/markdown' });
	await importMarkdown(page, fixture, 'Guard note.md');
	const source = page.locator('[data-testid="mdsh-source"] .cm-content');
	await source.focus();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.insertText('Source addition.');
	await page.locator('[data-mode="wysiwyg"]').click();
	await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 30000 });
	await page.locator('.ProseMirror p').filter({ hasText: 'Saved paragraph.' }).click();
	await page.keyboard.press('End');
	await page.keyboard.insertText(' Visual addition.');
	await page.locator('[data-mode="source"]').click();
	await record(page, info, 'edited');
	const expected =
		fixture.replace('Saved paragraph.', 'Saved paragraph. Visual addition.') + 'Source addition.';
	expect(await exportNote(page, info, 'edited')).toBe(expected);
	await expect(page.getByRole('alert')).toHaveCount(0);
	await expect(page.locator('.title-save')).toHaveText('saved');
	await reopen(page);
	expect(await exportNote(page, info, 'reopened')).toBe(expected);
});

test('imports presentation markers through the file importer', async ({ page }, info) => {
	const fixture = presentationFixture(['# Imported deck']);
	await importMarkdown(page, fixture, 'Imported deck.md');
	await expect(page.getByTestId('document-kind')).toHaveText('Presentation');
	await expect(page.getByTestId('presentation-editor')).toBeVisible();
	await info.attach('imported.md', { body: fixture, contentType: 'text/markdown' });
});

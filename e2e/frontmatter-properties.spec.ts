import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createFirstFile, openPalette, resetAppState, writeSourceContent } from './helpers';
import { databaseState } from './storage-evidence';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

async function source(page: Page): Promise<string> {
	return page
		.locator('.cm-content .cm-line')
		.evaluateAll((lines) => lines.map((line) => line.textContent).join('\n'));
}

async function openProperties(page: Page) {
	await openPalette(page);
	await page
		.getByRole('dialog', { name: 'Palette de commandes' })
		.getByRole('option', { name: /propriétés du document/i })
		.click();
	await expect(page.getByTestId('frontmatter-panel')).toBeVisible();
}

test('edits typed front matter and preserves unrelated bytes', async ({ page }, info: TestInfo) => {
	await resetAppState(page);
	await createFirstFile(page);
	const initial =
		'---\ntitle: "First"\n# keep this comment\ntags: [alpha, beta]\ndraft: true\ncount: 2\n---\n\n# Body\n\nUnchanged.\n';
	await writeSourceContent(page, initial);
	await openProperties(page);
	await expect(page.getByTestId('frontmatter-title')).toBeVisible();

	await page.getByTestId('frontmatter-title').locator('input').fill('Second');
	await page.getByTestId('frontmatter-tags').locator('input').fill('gamma, delta');
	await page.getByTestId('frontmatter-draft').locator('input').uncheck();
	await page.getByTestId('frontmatter-new-key').fill('author');
	await page.getByTestId('frontmatter-new-value').fill('Thomas');
	await page.getByTestId('frontmatter-add').click();
	await page.getByTestId('frontmatter-save').click();
	await expect(page.getByTestId('frontmatter-panel')).toHaveCount(0);

	const updated = await source(page);
	expect(updated).toContain('title: Second');
	expect(updated).toContain('# keep this comment');
	expect(updated).toContain('tags: [gamma, delta]');
	expect(updated).toContain('draft: false');
	expect(updated).toContain('count: 2');
	expect(updated).toContain('author: Thomas');
	expect(updated).toContain('# Body\n\nUnchanged.\n');

	await openProperties(page);
	await page.getByTestId('frontmatter-remove-count').click();
	await page.getByTestId('frontmatter-save').click();
	const removed = await source(page);
	expect(removed).not.toContain('count:');
	expect(removed).toContain('# keep this comment');

	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	await expect(page.locator('.cm-content')).toContainText('Unchanged.');
	await info.attach('frontmatter-properties.json', {
		body: JSON.stringify({ initial, updated, removed }, null, 2),
		contentType: 'application/json'
	});
});

test('undoes and redoes a saved numeric property without losing the note', async ({
	page
}, info) => {
	await resetAppState(page);
	await createFirstFile(page);
	const initial = '---\ncount: 12\n---\n\n# Body\n\nKeep this note.\n';
	await writeSourceContent(page, initial);
	await openProperties(page);
	const field = page.getByTestId('frontmatter-count').locator('input');
	await field.focus();
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.type('-12.75');
	await page.getByTestId('frontmatter-save').click();
	await expect(page.getByTestId('frontmatter-panel')).toHaveCount(0);
	const editor = page.locator('.cm-content').first();
	await expect(editor).toContainText('count: -12.75');
	await expect(editor).toContainText('Keep this note.');
	await editor.click();
	await page.keyboard.press('ControlOrMeta+z');
	await expect(editor).toContainText('count: 12');
	await expect(editor).toContainText('Keep this note.');
	await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y');
	await expect(editor).toContainText('count: -12.75');
	await expect(editor).toContainText('Keep this note.');
	await expect
		.poll(async () => (await databaseState(page)).drafts.map((row) => row.content).join('\n'), {
			timeout: 20_000
		})
		.toContain('count: -12.75');
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	await expect(page.locator('.cm-content').first()).toContainText('count: -12.75');
	await expect(page.locator('.cm-content').first()).toContainText('Keep this note.');
	await info.attach('frontmatter-undo.json', {
		body: JSON.stringify({ initial, restored: 'count: 12', redone: 'count: -12.75' }),
		contentType: 'application/json'
	});
});

test('does not make another tab edit undoable in this source editor', async ({
	page,
	context
}, info) => {
	await resetAppState(page);
	await createFirstFile(page);
	await writeSourceContent(page, '---\ncount: 12\n---\n\n# Body\n');
	await expect
		.poll(async () => (await databaseState(page)).drafts.map((row) => row.content).join('\n'))
		.toContain('count: 12');
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	const editor = page.locator('.cm-content').first();
	await expect(editor).toContainText('count: 12');
	const other = await context.newPage();
	await other.goto('/');
	await other.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	const otherEditor = other.locator('.cm-content').first();
	await expect(otherEditor).toContainText('count: 12');
	await otherEditor.click();
	await other.keyboard.press('ControlOrMeta+End');
	await other.keyboard.insertText(' Remote marker.');
	await expect(editor).toContainText('Remote marker.', { timeout: 20_000 });
	await editor.click();
	await page.keyboard.press('ControlOrMeta+z');
	await expect(editor).toContainText('Remote marker.');
	await expect(editor).toContainText('count: 12');
	await other.close();
	await info.attach('frontmatter-external-undo.json', {
		body: JSON.stringify({ remoteMarkerPreserved: true }),
		contentType: 'application/json'
	});
});

test('keeps a comment-only value separate from the new property text', async ({
	page
}, info: TestInfo) => {
	await resetAppState(page);
	await createFirstFile(page);
	const initial = '---\ntitle: # keep this comment\nstatus: draft\n---\n\n# Body\n';
	await writeSourceContent(page, initial);
	await openProperties(page);
	const title = page.getByTestId('frontmatter-title').locator('input');
	await expect(title).toHaveValue('');
	await title.fill('New');
	await page.getByTestId('frontmatter-save').click();
	await expect(page.getByTestId('frontmatter-panel')).toHaveCount(0);

	const updated = await source(page);
	expect(updated).toContain('title: New # keep this comment');
	expect(updated).not.toContain('title: New#');
	expect(updated).toContain('status: draft');
	// Wait for the 400 ms draft save before reload. WebKit can reload first.
	await expect
		.poll(async () => (await databaseState(page)).drafts.map((row) => row.content).join('\n'), {
			timeout: 20_000
		})
		.toContain('title: New # keep this comment');

	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	await openProperties(page);
	await expect(page.getByTestId('frontmatter-title').locator('input')).toHaveValue('New');
	await info.attach('frontmatter-comment-only.json', {
		body: JSON.stringify({ initial, updated }, null, 2),
		contentType: 'application/json'
	});
});

test('rejects a key that already exists as an unsupported YAML node', async ({
	page
}, info: TestInfo) => {
	await resetAppState(page);
	await createFirstFile(page);
	const initial = '---\nmeta:\n  owner: Ada\ntitle: Original\n---\n\n# Body\n';
	await writeSourceContent(page, initial);
	await openProperties(page);
	await expect(page.getByTestId('frontmatter-meta')).toHaveCount(0);

	await page.getByTestId('frontmatter-new-key').fill('meta');
	await page.getByTestId('frontmatter-new-value').fill('replaced');
	await page.getByTestId('frontmatter-add').click();
	await expect(page.getByTestId('frontmatter-add-error')).toContainText('meta');
	await expect(page.getByTestId('frontmatter-meta')).toHaveCount(0);
	await expect(page.getByTestId('frontmatter-save')).toBeEnabled();
	expect(await source(page)).toBe(initial);

	await page.getByTestId('frontmatter-new-key').fill('author');
	await page.getByTestId('frontmatter-new-value').fill('Ada');
	await page.getByTestId('frontmatter-add').click();
	await expect(page.getByTestId('frontmatter-add-error')).toHaveCount(0);
	await page.getByTestId('frontmatter-save').click();
	await expect(page.getByTestId('frontmatter-panel')).toHaveCount(0);
	const updated = await source(page);
	expect(updated).toContain('meta:\n  owner: Ada');
	expect(updated).toContain('title: Original');
	expect(updated).toContain('author: Ada');
	await info.attach('frontmatter-unsupported-key.json', {
		body: JSON.stringify({ initial, updated }, null, 2),
		contentType: 'application/json'
	});
});

test('replaces a block-style tag list without leaving old items', async ({
	page
}, info: TestInfo) => {
	await resetAppState(page);
	await createFirstFile(page);
	const initial = '---\ntags:\n  - old\n  - obsolete\nstatus: draft\n---\n\n# Body\n\nKeep.\n';
	await writeSourceContent(page, initial);
	await openProperties(page);
	await expect(page.getByTestId('frontmatter-tags').locator('input')).toHaveValue('old, obsolete');
	await page.getByTestId('frontmatter-tags').locator('input').fill('new, next');
	await page.getByTestId('frontmatter-save').click();
	await expect(page.getByTestId('frontmatter-panel')).toHaveCount(0);

	const updated = await source(page);
	expect(updated).toContain('tags:\n  - new\n  - next\n');
	expect(updated).not.toContain('old');
	expect(updated).not.toContain('obsolete');
	expect(updated).toContain('status: draft');
	expect(updated).toContain('# Body\n\nKeep.\n');

	await openProperties(page);
	await expect(page.getByTestId('frontmatter-tags').locator('input')).toHaveValue('new, next');
	await page.getByTestId('frontmatter-status').locator('input').fill('final');
	await page.getByTestId('frontmatter-save').click();
	const renamed = await source(page);
	expect(renamed).toContain('tags:\n  - new\n  - next\n');
	expect(renamed).toContain('status: final');
	await info.attach('frontmatter-block-tags.json', {
		body: JSON.stringify({ initial, updated, renamed }, null, 2),
		contentType: 'application/json'
	});
});

test('keeps the BOM at offset zero when it creates front matter', async ({
	page
}, info: TestInfo) => {
	await resetAppState(page);
	await createFirstFile(page);
	await writeSourceContent(page, '\uFEFF# Heading\n\nBody stays.\n');
	await openProperties(page);
	await page.getByTestId('frontmatter-new-key').fill('title');
	await page.getByTestId('frontmatter-new-value').fill('Hello');
	await page.getByTestId('frontmatter-add').click();
	await page.getByTestId('frontmatter-save').click();
	await expect(page.getByTestId('frontmatter-panel')).toHaveCount(0);

	const downloadPromise = page.waitForEvent('download');
	await page.getByRole('button', { name: 'Exporter' }).first().click();
	const download = await downloadPromise;
	const path = await download.path();
	if (!path) throw new Error('The exported Markdown file is missing');
	const bytes = await readFile(path);
	const text = bytes.toString('utf8');
	expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
	expect(text.startsWith('\uFEFF---\ntitle: Hello\n---\n')).toBe(true);
	expect(text).toContain('# Heading');
	expect(text).toContain('Body stays.');

	await openProperties(page);
	await expect(page.getByTestId('frontmatter-title').locator('input')).toHaveValue('Hello');
	await info.attach('frontmatter-bom.json', {
		body: JSON.stringify({ bytes: bytes.length, startsWithBom: true, text }, null, 2),
		contentType: 'application/json'
	});
});

test('keeps YAML-like text as a string property', async ({ page }, info: TestInfo) => {
	await resetAppState(page);
	await createFirstFile(page);
	const initial = '---\nauthor: Alice\ntags: [docs]\ndraft: true\n---\n\n# Body\n';
	await writeSourceContent(page, initial);
	await openProperties(page);

	await page.getByTestId('frontmatter-author').locator('input').fill('true');
	await page.getByTestId('frontmatter-tags').locator('input').fill('123, true');
	await page.getByTestId('frontmatter-save').click();
	const first = await source(page);
	expect(first).toContain("author: 'true'");
	expect(first).toContain("tags: ['123', 'true']");
	expect(first).toContain('draft: true');

	await openProperties(page);
	await expect(page.getByTestId('frontmatter-author').locator('input')).toHaveValue('true');
	await expect(page.getByTestId('frontmatter-tags').locator('input')).toHaveValue('123, true');
	await page.getByTestId('frontmatter-author').locator('input').fill('0123');
	await page.getByTestId('frontmatter-save').click();
	const second = await source(page);
	expect(second).toContain("author: '0123'");
	expect(second).toContain("tags: ['123', 'true']");
	expect(second).toContain('draft: true');

	await openProperties(page);
	await expect(page.getByTestId('frontmatter-author').locator('input')).toHaveValue('0123');
	await expect(page.getByTestId('frontmatter-tags').locator('input')).toHaveValue('123, true');
	await info.attach('frontmatter-strings.json', {
		body: JSON.stringify({ initial, first, second }, null, 2),
		contentType: 'application/json'
	});
});

test('keeps intermediate numeric input states before parsing', async ({ page }, info: TestInfo) => {
	await resetAppState(page);
	await createFirstFile(page);
	const initial = '---\npriority: 12\nscore: -2.5\ndue: 2026-11-12\n---\n\n# Body\n\nKeep.\n';
	await writeSourceContent(page, initial);
	await openProperties(page);
	const priority = page.getByTestId('frontmatter-priority').locator('input');
	const score = page.getByTestId('frontmatter-score').locator('input');
	type Sample = { field: string; step: string; value: string; caret: number | null };
	const samples: Sample[] = [];
	const scientificSamples: Sample[] = [];

	async function caretOf(input: typeof priority): Promise<number | null> {
		return input.evaluate((element) => (element as HTMLInputElement).selectionStart);
	}

	async function typeKeys(target: Sample[], field: string, input: typeof priority, text: string) {
		for (const character of text) {
			await page.keyboard.type(character);
			target.push({
				field,
				step: `type ${character}`,
				value: await input.inputValue(),
				caret: await caretOf(input)
			});
		}
	}

	async function clearField(target: Sample[], field: string, input: typeof priority, step: string) {
		await input.click();
		await page.keyboard.press('Control+a');
		await page.keyboard.press('Backspace');
		target.push({ field, step, value: await input.inputValue(), caret: await caretOf(input) });
	}

	await expect(priority).toHaveValue('12');
	await expect(score).toHaveValue('-2.5');
	await clearField(samples, 'priority', priority, 'cleared');
	await typeKeys(samples, 'priority', priority, '-12.75');
	await clearField(samples, 'score', score, 'cleared');
	await typeKeys(samples, 'score', score, '0.125');

	expect(samples).toEqual([
		{ field: 'priority', step: 'cleared', value: '', caret: 0 },
		{ field: 'priority', step: 'type -', value: '-', caret: 1 },
		{ field: 'priority', step: 'type 1', value: '-1', caret: 2 },
		{ field: 'priority', step: 'type 2', value: '-12', caret: 3 },
		{ field: 'priority', step: 'type .', value: '-12.', caret: 4 },
		{ field: 'priority', step: 'type 7', value: '-12.7', caret: 5 },
		{ field: 'priority', step: 'type 5', value: '-12.75', caret: 6 },
		{ field: 'score', step: 'cleared', value: '', caret: 0 },
		{ field: 'score', step: 'type 0', value: '0', caret: 1 },
		{ field: 'score', step: 'type .', value: '0.', caret: 2 },
		{ field: 'score', step: 'type 1', value: '0.1', caret: 3 },
		{ field: 'score', step: 'type 2', value: '0.12', caret: 4 },
		{ field: 'score', step: 'type 5', value: '0.125', caret: 5 }
	]);

	await page.getByTestId('frontmatter-save').click();
	await expect(page.getByTestId('frontmatter-panel')).toHaveCount(0);
	const updated = await source(page);
	expect(updated).toContain('priority: -12.75');
	expect(updated).toContain('score: 0.125');
	expect(updated).toContain('due: 2026-11-12');
	expect(updated).toContain('# Body\n\nKeep.\n');

	await openProperties(page);
	const reopenedPriority = page.getByTestId('frontmatter-priority').locator('input');
	await expect(page.getByTestId('frontmatter-priority').locator('small')).toHaveText('nombre');
	await expect(reopenedPriority).toHaveValue('-12.75');
	await clearField(scientificSamples, 'priority', reopenedPriority, 'cleared again');
	await typeKeys(scientificSamples, 'priority', reopenedPriority, '1e3');
	expect(scientificSamples).toEqual([
		{ field: 'priority', step: 'cleared again', value: '', caret: 0 },
		{ field: 'priority', step: 'type 1', value: '1', caret: 1 },
		{ field: 'priority', step: 'type e', value: '1e', caret: 2 },
		{ field: 'priority', step: 'type 3', value: '1e3', caret: 3 }
	]);
	await page.getByTestId('frontmatter-save').click();
	await expect(page.getByTestId('frontmatter-panel')).toHaveCount(0);
	const scientific = await source(page);
	expect(scientific).toContain('priority: 1000');
	expect(scientific).toContain('score: 0.125');
	expect(scientific).toContain('due: 2026-11-12');

	await openProperties(page);
	await expect(page.getByTestId('frontmatter-priority').locator('input')).toHaveValue('1000');
	await expect(page.getByTestId('frontmatter-due').locator('small')).toHaveText('date');
	await expect(page.getByTestId('frontmatter-due').locator('input')).toHaveValue('2026-11-12');
	await info.attach('frontmatter-number-input.json', {
		body: JSON.stringify({ initial, updated, scientific, samples, scientificSamples }, null, 2),
		contentType: 'application/json'
	});
});

test('keeps parser string tokens out of the numeric editor', async ({ page }, info: TestInfo) => {
	await resetAppState(page);
	await createFirstFile(page);
	const initial = '---\ntitle: "First"\nscore: -.5\nbig: 1e999\n---\n\n# Body\n\nKeep.\n';
	await writeSourceContent(page, initial);
	await openProperties(page);
	const score = page.getByTestId('frontmatter-score');
	const big = page.getByTestId('frontmatter-big');

	await expect(score.locator('small')).toHaveText('texte');
	await expect(score.locator('input')).toHaveValue('-.5');
	await expect(big.locator('small')).toHaveText('texte');
	await expect(big.locator('input')).toHaveValue('1e999');

	await page.getByTestId('frontmatter-title').locator('input').fill('Second');
	await page.getByTestId('frontmatter-save').click();
	await expect(page.getByTestId('frontmatter-panel')).toHaveCount(0);
	const updated = await source(page);
	expect(updated).toContain('title: Second');
	expect(updated).toContain('score: -.5');
	expect(updated).toContain('big: 1e999');
	expect(updated).toContain('# Body\n\nKeep.\n');

	await openProperties(page);
	await expect(page.getByTestId('frontmatter-score').locator('input')).toHaveValue('-.5');
	await expect(page.getByTestId('frontmatter-big').locator('input')).toHaveValue('1e999');
	await page.getByTestId('frontmatter-remove-big').click();
	await page.getByTestId('frontmatter-save').click();
	await expect(page.getByTestId('frontmatter-panel')).toHaveCount(0);
	const removed = await source(page);
	expect(removed).not.toContain('big:');
	expect(removed).toContain('score: -.5');
	expect(removed).toContain('title: Second');
	expect(removed).toContain('# Body\n\nKeep.\n');

	await info.attach('frontmatter-source-numbers.json', {
		body: JSON.stringify({ initial, updated, removed }, null, 2),
		contentType: 'application/json'
	});
});

test('refuses an incomplete numeric value and keeps the typed text', async ({
	page
}, info: TestInfo) => {
	await resetAppState(page);
	await createFirstFile(page);
	const initial = '---\npriority: 12\n---\n\n# Body\n\nKeep.\n';
	await writeSourceContent(page, initial);
	await openProperties(page);
	const priority = page.getByTestId('frontmatter-priority').locator('input');
	const numberError = page.getByTestId('frontmatter-number-error-priority');

	await priority.click();
	await page.keyboard.press('Control+a');
	await page.keyboard.press('Backspace');
	await page.getByTestId('frontmatter-save').click();
	await expect(page.getByTestId('frontmatter-panel')).toBeVisible();
	await expect(numberError).toContainText('nombre complet');
	await expect(priority).toHaveValue('');
	await expect(priority).toBeFocused();
	expect(await source(page)).toBe(initial);

	await page.keyboard.type('-');
	await page.getByTestId('frontmatter-save').click();
	await expect(numberError).toContainText('nombre complet');
	await expect(priority).toHaveValue('-');
	await expect(priority).toBeFocused();
	expect(await source(page)).toBe(initial);

	await page.keyboard.type('12');
	await expect(numberError).toHaveCount(0);
	await page.getByTestId('frontmatter-save').click();
	await expect(page.getByTestId('frontmatter-panel')).toHaveCount(0);
	const updated = await source(page);
	expect(updated).toContain('priority: -12');
	expect(updated).toContain('# Body\n\nKeep.\n');
	await info.attach('frontmatter-number-invalid.json', {
		body: JSON.stringify({ initial, updated, blockedValues: ['', '-'] }, null, 2),
		contentType: 'application/json'
	});
});

test('reports malformed YAML and refuses to edit it', async ({ page }, info: TestInfo) => {
	await resetAppState(page);
	await createFirstFile(page);
	await writeSourceContent(page, '---\ntitle: [unclosed\n---\n\n# Body\n');
	await openProperties(page);
	await expect(page.getByTestId('frontmatter-error')).toContainText('invalide');
	await expect(page.getByTestId('frontmatter-save')).toHaveCount(0);
	await expect(page.locator('.cm-content')).toContainText('[unclosed');
	await info.attach('frontmatter-invalid.json', {
		body: JSON.stringify({ rejected: true }),
		contentType: 'application/json'
	});
});

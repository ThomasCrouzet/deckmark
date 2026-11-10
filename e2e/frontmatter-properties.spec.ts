import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createFirstFile, openPalette, resetAppState, writeSourceContent } from './helpers';

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

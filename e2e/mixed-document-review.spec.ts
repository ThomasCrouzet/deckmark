import { expect, test, type Download, type Page, type TestInfo } from '@playwright/test';
import { resetAppState } from './helpers';
import {
	exportPresentation,
	openPresentationSource,
	presentationFixture,
	waitForPresentation
} from './presentation-helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

const stamp = 1_725_000_000_000;
const speech = 'Private speech: keep [[target-identifier]] and ../notes/guide.md exactly.';
const deck = presentationFixture([
	'# MixedNeedle deck\n\n[[target-identifier]]\n\n[Project guide](../notes/guide.md#destination)',
	'# Closing slide'
]).replace('"notes":""', `"notes":${JSON.stringify(speech)}`);
const note = '# MixedNeedle note\n\n[Guide](guide.md#destination)\n\nCONVERSION_SLOT\n';
const guide =
	'# Guide\n\nMixedNeedle reference.\n\nInline CONVERSION_SLOT stays a note.\n\n## Destination\n';
const expectedFiles = { 'notes/note.md': note, 'notes/guide.md': guide, 'slides/deck.md': deck };
const fixture = {
	format: 'mdsh-backup',
	schemaVersion: 2,
	exportedAt: stamp,
	projects: [{ id: 'mixed-project', name: 'Mixed review', createdAt: stamp, updatedAt: stamp }],
	drafts: Object.entries(expectedFiles).map(([relativePath, content], order) => ({
		id: ['note-identifier', 'target-identifier', 'deck-identifier'][order],
		name: relativePath.split('/').at(-1)!,
		relativePath,
		content,
		projectId: 'mixed-project',
		createdAt: stamp,
		updatedAt: stamp,
		order,
		open: true
	})),
	workspaces: [],
	templates: [],
	projectAssets: []
};

async function settings(page: Page) {
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	await page.keyboard.press('ControlOrMeta+,');
	const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
	await expect(dialog).toBeVisible();
	return dialog;
}

async function retainDownload(download: Download, info: TestInfo, name: string, mime: string) {
	const path = info.outputPath(name);
	await download.saveAs(path);
	await info.attach(name, { path, contentType: mime });
	return (await import('node:fs/promises')).readFile(path);
}

async function backup(page: Page, info: TestInfo, name: string) {
	const dialog = await settings(page);
	const pending = page.waitForEvent('download');
	await dialog.getByRole('button', { name: 'Export a backup', exact: true }).click();
	const bytes = await retainDownload(await pending, info, `${name}.json`, 'application/json');
	await page.keyboard.press('Escape');
	return JSON.parse(bytes.toString()) as typeof fixture;
}

async function project(page: Page) {
	await page.getByTestId('projects-open').click();
	const panel = page.getByRole('dialog', { name: 'Markdown projects' });
	await panel.locator('select').selectOption({ label: 'Mixed review' });
	return panel;
}

async function openDocument(page: Page, path: string) {
	const panel = await project(page);
	await panel.getByRole('button', { name: `Open ${path}`, exact: true }).click();
}

async function checkProject(page: Page, info: TestInfo, name: string, expected = expectedFiles) {
	const panel = await project(page);
	const pending = page.waitForEvent('download');
	await panel.getByRole('button', { name: 'Export project', exact: true }).click();
	const bytes = await retainDownload(await pending, info, `${name}.zip`, 'application/zip');
	await panel.getByRole('button', { name: 'Close projects', exact: true }).click();
	const zip = await (await import('jszip')).default.loadAsync(bytes);
	for (const [path, content] of Object.entries(expected)) {
		expect(zip.file(path), path).not.toBeNull();
		expect(await zip.file(path)!.async('nodebuffer'), path).toEqual(Buffer.from(content));
	}
}

async function search(page: Page, query: string) {
	await page.keyboard.press('ControlOrMeta+Shift+p');
	await page.getByRole('combobox').fill('Cross-file search');
	await page.getByRole('option', { name: /^Cross-file search/ }).click();
	const dialog = page.getByRole('dialog', { name: 'Cross-file search', exact: true });
	await dialog.getByRole('combobox').fill(query);
	await expect(dialog.getByRole('option').first()).toContainText(query);
	return dialog;
}

async function replacePreview(page: Page, query: string, replacement: string) {
	const dialog = await search(page, query);
	const toggle = dialog.getByRole('button', { name: 'Show cross-file replace' });
	if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
	await dialog.getByRole('textbox', { name: 'Replacement text' }).fill(replacement);
	await dialog.getByRole('button', { name: 'Replace all', exact: true }).click();
	await expect(dialog.getByRole('heading', { name: 'Replacement preview' })).toBeVisible();
	return dialog;
}

test.beforeEach(async ({ page }, info) => {
	await resetAppState(page);
	await page.evaluate(() => localStorage.setItem('mdsh:locale', 'en'));
	await page.reload();
	await settings(page);
	await info.attach('mixed-input.json', {
		body: JSON.stringify(fixture, null, 2),
		contentType: 'application/json'
	});
	await page.locator('input[type=file][accept*="json"]').setInputFiles({
		name: 'mixed.json',
		mimeType: 'application/json',
		buffer: Buffer.from(JSON.stringify(fixture))
	});
	const restore = page.getByRole('dialog', { name: 'Restore the backup', exact: true });
	await restore.getByRole('button', { name: 'Merge', exact: true }).click();
	await expect(restore).toBeHidden();
	await expect(
		page.getByRole('status').filter({ hasText: 'Backup restored' }).last()
	).toBeVisible();
	await page.keyboard.press('Escape');
});

test.afterEach(async ({ page, browser }, info) => {
	await info.attach('mixed-result.json', {
		body: JSON.stringify(
			{
				test: info.title,
				status: info.status,
				metadata: info.config.metadata,
				browser: browser.version(),
				baseURL: info.project.use.baseURL,
				fixtures: fixture,
				errors: info.errors
			},
			null,
			2
		),
		contentType: 'application/json'
	});
	await info.attach('mixed-final.png', { body: await page.screenshot(), contentType: 'image/png' });
});

test('mixed search names each type and activates the correct editor without changing source', async ({
	page
}, info) => {
	let dialog = await search(page, 'MixedNeedle');
	await expect(dialog.getByRole('option')).toHaveCount(3);
	const noteHit = dialog.getByRole('option').filter({ hasText: 'MixedNeedle note' });
	const deckHit = dialog.getByRole('option').filter({ hasText: 'MixedNeedle deck' });
	await expect(noteHit.getByText('Note', { exact: true })).toBeVisible();
	await expect(deckHit.getByText('Presentation', { exact: true })).toBeVisible();
	await info.attach('mixed-search.png', {
		body: await page.screenshot(),
		contentType: 'image/png'
	});
	await noteHit.click();
	await expect(page.getByTestId('document-kind')).toHaveText('Note');
	await expect(page.locator('.cm-content').first()).toContainText('MixedNeedle note');
	await expect(page.getByTestId('presentation-editor')).toHaveCount(0);
	dialog = await search(page, 'MixedNeedle');
	await dialog.getByRole('option').filter({ hasText: 'MixedNeedle deck' }).click();
	const editor = await waitForPresentation(page);
	await expect(page.getByTestId('document-kind')).toHaveText('Presentation');
	await expect(editor.getByTestId('slide-canvas')).toContainText('MixedNeedle deck');
	await expect(page.locator('.cm-content')).toHaveCount(0);
	await expect(editor.getByTestId('slide-notes')).toHaveValue(speech);
	await openPresentationSource(editor);
	await expect(editor.getByTestId('slide-source-editor')).toHaveValue(deck);
	await editor.getByTestId('slide-source-cancel').click();
	await checkProject(page, info, 'search-project');
});

test('bulk replacement changes only notes and rejects a note conversion atomically', async ({
	page
}, info) => {
	const dialog = await replacePreview(page, 'MixedNeedle', 'ChangedNeedle');
	const entries = dialog.getByRole('list', { name: 'Replacement preview' });
	await expect(entries.getByRole('button')).toHaveCount(2);
	await expect(entries).toContainText('note.md');
	await expect(entries).toContainText('guide.md');
	await expect(entries).not.toContainText('deck.md');
	await info.attach('notes-only-preview.png', {
		body: await page.screenshot(),
		contentType: 'image/png'
	});
	await dialog.getByRole('button', { name: 'Confirm replacement', exact: true }).click();
	await expect(dialog).toBeHidden();
	const changed = {
		...expectedFiles,
		'notes/note.md': note.replace('MixedNeedle', 'ChangedNeedle'),
		'notes/guide.md': guide.replace('MixedNeedle', 'ChangedNeedle')
	};
	await checkProject(page, info, 'notes-replaced', changed);
	const conversion = await replacePreview(page, 'CONVERSION_SLOT', '<!-- mdsh-presentation');
	await expect(
		conversion.getByRole('list', { name: 'Replacement preview' }).getByRole('button')
	).toHaveCount(2);
	await expect(conversion.locator('[data-diff-kind="add"]')).toContainText('mdsh-presentation');
	await conversion.getByRole('button', { name: 'Confirm replacement', exact: true }).click();
	await expect(conversion.getByRole('alert')).toBeVisible();
	await expect(conversion.getByRole('heading', { name: 'Replacement preview' })).toHaveCount(0);
	await info.attach('conversion-rejected.png', {
		body: await page.screenshot(),
		contentType: 'image/png'
	});
	await page.keyboard.press('Escape');
	await page.reload();
	await openDocument(page, 'notes/note.md');
	await expect(page.getByTestId('document-kind')).toHaveText('Note');
	await expect(page.locator('.cm-content').first()).toContainText('CONVERSION_SLOT');
	await checkProject(page, info, 'conversion-rejected-project', changed);
});

test('merged deck keeps exact links and speech after rejected Apply in storage and exports', async ({
	page
}, info) => {
	const merged = await backup(page, info, 'merged-backup');
	expect(merged.drafts).toHaveLength(3);
	expect(merged.drafts.find((row) => row.relativePath === 'notes/guide.md')!.id).not.toBe(
		'target-identifier'
	);
	expect(merged.drafts.find((row) => row.relativePath === 'slides/deck.md')!.content).toBe(deck);
	await openDocument(page, 'slides/deck.md');
	const editor = await waitForPresentation(page);
	await expect(editor.getByTestId('slide-notes')).toHaveValue(speech);
	await openPresentationSource(editor);
	await editor
		.getByTestId('slide-source-editor')
		.fill('# Rejected plain note\n\nLost speech and links.');
	await editor.getByTestId('slide-source-apply').click();
	await expect(editor.getByRole('alert')).toContainText('presentation data');
	await expect(editor.getByTestId('slide-source-editor')).toHaveValue(
		'# Rejected plain note\n\nLost speech and links.'
	);
	await info.attach('apply-rejected.png', {
		body: await page.screenshot(),
		contentType: 'image/png'
	});
	const pending = page.waitForEvent('download');
	await exportPresentation(editor, 'md');
	expect(await retainDownload(await pending, info, 'rejected-apply.md', 'text/markdown')).toEqual(
		Buffer.from(deck)
	);
	const rejected = await backup(page, info, 'rejected-apply-backup');
	expect(rejected.drafts.find((row) => row.relativePath === 'slides/deck.md')!.content).toBe(deck);
	await checkProject(page, info, 'rejected-apply-project');
	await page.reload();
	await openDocument(page, 'slides/deck.md');
	await expect(editor.getByTestId('slide-notes')).toHaveValue(speech);
	await openPresentationSource(editor);
	await expect(editor.getByTestId('slide-source-editor')).toHaveValue(deck);
	await editor.getByTestId('slide-source-cancel').click();
	await checkProject(page, info, 'reloaded-project');
});

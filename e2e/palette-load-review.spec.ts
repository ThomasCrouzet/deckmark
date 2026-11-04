import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { TemplateRow, WorkspaceRow } from '../src/lib/db';
import { resetAppState } from './helpers';
import { importMarkdown } from './presentation-helpers';

declare global {
	interface Window {
		releasePaletteReviewLoads: () => Promise<void>;
	}
}

const markdown = '# Palette load review\n\nCorrect HTML bytes: café & tea.\n';
const workspace: WorkspaceRow = {
	id: 'palette-review-workspace',
	name: 'Export as loaded workspace',
	fileIds: [],
	activeId: null,
	createdAt: 1_700_000_000_000,
	updatedAt: 1_700_000_000_000
};
const template: TemplateRow = {
	id: 'palette-review-template',
	name: 'Export as loaded template',
	content: '# Saved template\n',
	kind: 'note',
	builtin: false,
	createdAt: 1_700_000_000_000,
	updatedAt: 1_700_000_000_000
};

test.use({ locale: 'en-US', reducedMotion: 'reduce', serviceWorkers: 'block' });

test.afterEach(async ({ page }, info) => {
	await info.attach('palette-load-fixtures.json', {
		body: JSON.stringify({ markdown, workspace, template }, null, 2),
		contentType: 'application/json'
	});
	await info.attach('palette-load-result.png', {
		body: await page.screenshot(),
		contentType: 'image/png'
	});
});

test('keeps the query and keyboard selection when initial saved commands load', async ({
	page
}, info) => {
	await resetAppState(page);
	await page.evaluate(() => localStorage.setItem('mdsh:locale', 'en'));
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	await importMarkdown(page, markdown, 'palette-load-review.md');
	await expect(page.locator('.cm-content').first()).toContainText('Palette load review');
	await page.evaluate(
		({ workspace, template }) =>
			new Promise<void>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const transaction = database.transaction(['workspaces', 'templates'], 'readwrite');
					transaction.objectStore('workspaces').put(workspace);
					transaction.objectStore('templates').put(template);
					transaction.oncomplete = () => {
						database.close();
						resolve();
					};
					transaction.onabort = () => {
						database.close();
						reject(transaction.error);
					};
				};
			}),
		{ workspace, template }
	);
	await page.evaluate(
		() =>
			new Promise<void>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const transaction = database.transaction(['workspaces', 'templates'], 'readwrite');
					let held = true;
					const completed = new Promise<void>((done, fail) => {
						transaction.oncomplete = () => {
							database.close();
							done();
						};
						transaction.onabort = () => {
							database.close();
							fail(transaction.error);
						};
					});
					window.releasePaletteReviewLoads = () => {
						held = false;
						return completed;
					};
					const keepAlive = () => {
						const read = transaction.objectStore('workspaces').get('__palette_review_lock__');
						read.onerror = () => reject(read.error);
						read.onsuccess = () => {
							resolve();
							if (held) keepAlive();
						};
					};
					keepAlive();
				};
			})
	);

	const input = page.getByRole('combobox');
	const htmlOption = page.getByRole('option', { name: 'Export as HTML', exact: true });
	const loadedWorkspace = page.getByRole('option', {
		name: 'Load the "Export as loaded workspace" workspace',
		exact: true
	});
	const loadedTemplate = page.getByRole('option', {
		name: 'New: Export as loaded template',
		exact: true
	});
	try {
		await page.keyboard.press('ControlOrMeta+Shift+p');
		await expect(input).toBeFocused();
		await input.pressSequentially('Export as');
		await expect(page.getByRole('option', { selected: true })).toContainText('Export as PDF');
		await input.press('ArrowDown');
		await expect(htmlOption).toHaveAttribute('aria-selected', 'true');
		await expect(loadedWorkspace).toHaveCount(0);
		await expect(loadedTemplate).toHaveCount(0);
		await info.attach('palette-before-release.png', {
			body: await page.screenshot(),
			contentType: 'image/png'
		});
	} finally {
		await page.evaluate(() => window.releasePaletteReviewLoads());
	}

	await expect(loadedWorkspace).toBeVisible();
	await expect(loadedTemplate).toBeVisible();
	await expect.soft(input).toHaveValue('Export as');
	await expect.soft(input).toBeFocused();
	await expect.soft(htmlOption).toHaveAttribute('aria-selected', 'true');
	await expect.soft(input).toHaveAttribute('aria-activedescendant', 'cmd-palette-opt-export-html');
	if (info.errors.length) return;

	const downloading = page.waitForEvent('download');
	await input.press('Enter');
	const download = await downloading;
	expect(download.suggestedFilename()).toBe('palette-load-review.html');
	const path = info.outputPath(download.suggestedFilename());
	await download.saveAs(path);
	await info.attach('palette-export.html', { path, contentType: 'text/html' });
	const html = await readFile(path, 'utf8');
	expect(html).toMatch(/<!doctype html>/i);
	expect(html.trim()).toMatch(/<\/html>$/i);
	const content = await page.evaluate((html) => {
		const document = new DOMParser().parseFromString(html, 'text/html');
		return {
			title: document.title,
			heading: document.querySelector('h1')?.textContent,
			paragraph: document.querySelector('p')?.textContent
		};
	}, html);
	expect(content).toEqual({
		title: 'Palette load review',
		heading: 'Palette load review',
		paragraph: 'Correct HTML bytes: café & tea.'
	});
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await page.keyboard.press('ControlOrMeta+Shift+p');
	await expect(input).toHaveValue('');
	await expect(input).toBeFocused();
	await expect(page.getByRole('option', { selected: true })).toHaveText(/Document outline/);
});

import { expect, test } from '@playwright/test';
import { resetAppState } from './helpers';
import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';
import {
	importMarkdown,
	openPresentationSource,
	presentationFixture
} from './presentation-helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

test.beforeEach(async ({ page }) => {
	await resetAppState(page);
	await page.evaluate(() => localStorage.setItem('mdsh:locale', 'en'));
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
});

test('keeps note mode and imported bytes across file switches', async ({ page }, info) => {
	await page.getByTestId('welcome-new').click();
	await page.getByTestId('create-note').click();
	await expect(page.getByTestId('document-kind')).toHaveText('Note', { timeout: 15_000 });
	await page.locator('button[data-mode="source"]').click();
	await expect(page.locator('.cm-content')).toBeVisible();
	const fixture = await readFile('e2e/fixtures/presentation-complete.md', 'utf8');
	await importMarkdown(page, fixture, 'Existing deck.md');
	const editor = page.getByTestId('presentation-editor');
	await expect(editor.getByTestId('slide-thumbnail')).toHaveCount(3);
	await expect(page.getByRole('radiogroup')).toHaveCount(0);
	await expect(page.getByTestId('split-view-toggle')).toHaveCount(0);
	await openPresentationSource(editor);
	await expect(editor.getByTestId('slide-source-editor')).toHaveValue(fixture);
	await editor.getByTestId('slide-source-cancel').click();
	await editor.focus();
	await page.keyboard.press('Control+Shift+Tab');
	await expect(page.getByTestId('document-kind')).toHaveText('Note', { timeout: 15_000 });
	await expect(page.locator('.cm-content')).toBeVisible();
	await page.keyboard.press('Control+Tab');
	await expect(editor.getByTestId('slide-thumbnail')).toHaveCount(3);
	await openPresentationSource(editor);
	await expect(editor.getByTestId('slide-source-editor')).toHaveValue(fixture);
	await info.attach('unchanged-import.md', { body: fixture, contentType: 'text/markdown' });
});

test('applies valid source and keeps malformed data in the presentation editor', async ({
	page
}) => {
	const fixture = presentationFixture(['# Before']);
	await importMarkdown(page, fixture);
	const editor = page.getByTestId('presentation-editor');
	await openPresentationSource(editor);
	const source = editor.getByTestId('slide-source-editor');
	await source.fill(fixture.replace('# Before', '# After'));
	await editor.getByTestId('slide-source-apply').click();
	await expect(editor.getByTestId('slide-canvas')).toContainText('After');
	await openPresentationSource(editor);
	for (const invalid of [
		'# Note',
		'```md\n<!-- mdsh-presentation\n{}\n-->\n```',
		'---\nexample: |\n  <!-- mdsh-presentation\n  {}\n  -->\n---\n# Note'
	]) {
		await source.fill(invalid);
		await editor.getByTestId('slide-source-apply').click();
		await expect(editor.getByRole('alert')).toContainText('presentation data');
		await expect(source).toHaveValue(invalid);
	}
	await source.fill('<!-- mdsh-presentation\n{broken}\n-->');
	await editor.getByTestId('slide-source-apply').click();
	await expect(editor.getByTestId('slide-source-error')).toBeVisible();
	await expect(page.getByTestId('document-kind')).toHaveText('Presentation');
	await source.fill(fixture);
	await editor.getByTestId('slide-source-apply').click();
	await expect(editor.getByTestId('slide-canvas')).toContainText('Before');
});

test('offers direct creation and disables Present for notes', async ({ page }) => {
	await page.keyboard.press('ControlOrMeta+Shift+p');
	let palette = page.getByRole('dialog');
	await palette.getByRole('combobox').fill('Create a note');
	await palette.getByRole('option', { name: 'Create a note', exact: true }).click();
	await expect(page.getByTestId('document-kind')).toHaveText('Note', { timeout: 15_000 });
	await page.keyboard.press('ControlOrMeta+Shift+p');
	palette = page.getByRole('dialog');
	await palette.getByRole('combobox').fill('Present active file');
	await expect(palette.getByRole('option')).toHaveAttribute('aria-disabled', 'true');
	await page.keyboard.press('Escape');
	await page.keyboard.press('ControlOrMeta+Shift+p');
	palette = page.getByRole('dialog');
	await palette.getByRole('combobox').fill('Create a presentation');
	await palette.getByRole('option', { name: 'Create a presentation', exact: true }).click();
	const editor = page.getByTestId('presentation-editor');
	await expect(editor).toBeVisible();
	await editor.focus();
	await page.keyboard.press('ControlOrMeta+n');
	await expect(page.getByTestId('create-note')).toBeFocused();
	await page.keyboard.press('Escape');
	await editor.focus();
	await page.keyboard.press('ControlOrMeta+Shift+l');
	await expect(editor).toHaveAttribute('aria-modal', 'true');
	await page.keyboard.press('Escape');
});

test('does not convert a note through the note source editor', async ({ page }) => {
	await page.getByTestId('welcome-new').click();
	await page.getByTestId('create-note').click();
	await page.locator('button[data-mode="source"]').click();
	const source = page.locator('.cm-content');
	await source.fill(presentationFixture(['# Not a note']));
	await expect(page.getByRole('alert')).toContainText('cannot become a presentation');
	await expect(page.getByTestId('document-kind')).toHaveText('Note', { timeout: 15_000 });
	await expect(page.getByTestId('presentation-editor')).toHaveCount(0);
	// Wait for the 400 ms save delay and a margin so the draft is durable before reload.
	await page.waitForTimeout(600);
	await page.reload();
	await expect(page.getByTestId('document-kind')).toHaveText('Note', { timeout: 15_000 });
	await expect(source).not.toContainText('mdsh-presentation');
});

test('keeps creation and editing reachable at 200 percent zoom', async ({ page }, info) => {
	await page.setViewportSize({ width: 320, height: 900 });
	await page.evaluate(() => {
		document.documentElement.style.zoom = '2';
	});
	await page.getByTestId('welcome-new').click();
	await expect(page.getByTestId('create-note')).toBeFocused();
	await expect(page.getByTestId('create-presentation')).toBeVisible();
	await page.getByTestId('create-presentation').click();
	const editor = page.getByTestId('presentation-editor');
	await editor.getByTestId('slide-present').scrollIntoViewIfNeeded();
	await expect(editor.getByTestId('slide-present')).toBeInViewport();
	const width = await page.evaluate(() => ({
		scroll: document.documentElement.scrollWidth,
		viewport: document.documentElement.clientWidth
	}));
	expect(width.scroll).toBeLessThanOrEqual(width.viewport);
	await info.attach('zoom-200.png', { body: await page.screenshot(), contentType: 'image/png' });
	await info.attach('zoom-200.json', {
		body: JSON.stringify({
			method: 'CSS zoom',
			factor: 2,
			viewport: { width: 320, height: 900 },
			width
		}),
		contentType: 'application/json'
	});
});

test('retains an unapplied source draft across file switches', async ({ page }) => {
	const fixture = presentationFixture(['# Stored']);
	await importMarkdown(page, fixture);
	const editor = page.getByTestId('presentation-editor');
	await openPresentationSource(editor);
	const source = editor.getByTestId('slide-source-editor');
	const draft = fixture.replace('# Stored', '# Unapplied');
	await source.fill(draft);
	await openPresentationSource(editor);
	await expect(source).toHaveValue(draft);
	await source.focus();
	await page.keyboard.press('ControlOrMeta+n');
	await page.getByTestId('create-note').click();
	await expect(page.getByTestId('document-kind')).toHaveText('Note', { timeout: 15_000 });
	await page.keyboard.press('Control+Shift+Tab');
	await expect(source).toHaveValue(draft);
	await editor.getByTestId('slide-source-cancel').click();
	await openPresentationSource(editor);
	await expect(source).toHaveValue(fixture);
});

test('preserves a malformed-source correction when another tab repairs the file', async ({
	page,
	context
}) => {
	const malformed = '<!-- mdsh-presentation\n{broken}\n-->';
	await importMarkdown(page, malformed, 'Repair.md');
	// The second tab must load the committed fixture, not race the 400 ms save.
	await expect(page.locator('.save-state')).toHaveText('saved');
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					new Promise<string[]>((resolve, reject) => {
						const request = indexedDB.open('mdsh');
						request.onerror = () => reject(request.error);
						request.onsuccess = () => {
							const database = request.result;
							const transaction = database.transaction('drafts', 'readonly');
							const rows = transaction.objectStore('drafts').getAll();
							transaction.oncomplete = () => {
								database.close();
								resolve(rows.result.map((row: { content: string }) => row.content));
							};
							transaction.onabort = () => {
								database.close();
								reject(transaction.error);
							};
						};
					})
			)
		)
		.toEqual([malformed]);
	const source = page.getByTestId('slide-source-editor');
	const correction = presentationFixture(['# Local correction']);
	await source.fill(correction);
	const other = await context.newPage();
	await other.goto('/');
	await expect(other.getByTestId('slide-source-editor')).toBeVisible();
	await expect(other.getByTestId('slide-source-editor')).toHaveValue(malformed);
	await other.getByTestId('slide-source-editor').fill(presentationFixture(['# Remote repair']));
	await other.getByTestId('slide-source-apply').click();
	await expect(other.locator('.save-state')).toHaveText('saved');
	await expect(page.getByTestId('presentation-editor')).toContainText('changed');
	await expect(source).toHaveValue(correction);
	await page.getByTestId('slide-source-apply').click();
	await expect(page.getByRole('alert')).toContainText('changed');
	await expect(source).toHaveValue(correction);
	await page.getByTestId('slide-source-cancel').click();
	await expect(page.getByTestId('slide-canvas')).toContainText('Remote repair');
	await other.close();
});

test('creates, edits, presents, and exports with the keyboard only', async ({ page }, info) => {
	async function tabTo(testId: string, backwards = false) {
		for (let count = 0; count < 90; count++) {
			if (await page.getByTestId(testId).evaluate((element) => element === document.activeElement))
				return;
			await page.keyboard.press(backwards ? 'Shift+Tab' : 'Tab');
		}
		await expect(page.getByTestId(testId)).toBeFocused();
	}
	await page.keyboard.press('ControlOrMeta+n');
	await expect(page.getByTestId('create-note')).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(page.getByTestId('document-kind')).toHaveText('Note', { timeout: 15_000 });
	await page.keyboard.press('ControlOrMeta+n');
	await expect(page.getByTestId('create-note')).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(page.getByTestId('create-presentation')).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(page.getByTestId('document-kind')).toHaveText('Presentation');
	await expect(page.getByTestId('presentation-editor')).toBeFocused();
	await tabTo('slide-add-text');
	await page.keyboard.press('Enter');
	await tabTo('slide-edit-text');
	await page.keyboard.press('Enter');
	await expect(page.getByTestId('slide-text-editor')).toBeFocused();
	await page.keyboard.type('# Keyboard briefing');
	await tabTo('slide-text-done');
	await page.keyboard.press('Enter');
	await tabTo('slide-notes');
	await page.keyboard.type('Private speech');
	await page.keyboard.press('Tab');
	await page.keyboard.press('ControlOrMeta+Shift+l');
	await expect(page.getByTestId('presentation-editor')).toHaveAttribute('aria-modal', 'true');
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('slide-present')).toBeFocused();
	await tabTo('slide-export', true);
	await page.keyboard.press('Enter');
	await tabTo('slide-export-html');
	const download = page.waitForEvent('download');
	await page.keyboard.press('Enter');
	const file = await download;
	const path = info.outputPath('keyboard-deck.html');
	await file.saveAs(path);
	const html = await readFile(path, 'utf8');
	expect(html).toContain('Keyboard briefing');
	expect(html).not.toContain('Private speech');
	await info.attach('keyboard-deck.html', { path, contentType: 'text/html' });
});

test('exports the requested deck after a pending save and a file switch', async ({
	page
}, info) => {
	await importMarkdown(page, '# Other note', 'Other note.md');
	await importMarkdown(page, presentationFixture(['# Requested deck']), 'Requested deck.md');
	await expect(page.locator('.save-state')).toHaveText('saved');
	await page.evaluate(
		() =>
			new Promise<void>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const db = request.result;
					const transaction = db.transaction('drafts', 'readwrite');
					let hold = true;
					Object.assign(window, {
						releasePresentationLock: () => {
							hold = false;
						}
					});
					transaction.oncomplete = () => db.close();
					transaction.onerror = () => reject(transaction.error);
					const keepAlive = () => {
						const read = transaction.objectStore('drafts').get('export-lock');
						read.onsuccess = () => {
							resolve();
							if (hold) keepAlive();
						};
					};
					keepAlive();
				};
			})
	);
	try {
		await page.getByTestId('slide-notes').fill('Keep this private');
		await page.getByTestId('slide-export').click();
		const downloaded = page.waitForEvent('download');
		await page.getByTestId('slide-export-html').click();
		await page.keyboard.press('Control+Shift+Tab');
		await expect(page.getByTestId('document-kind')).toHaveText('Note', { timeout: 15_000 });
		await page.evaluate(() =>
			(window as unknown as { releasePresentationLock: () => void }).releasePresentationLock()
		);
		const download = await downloaded;
		expect(download.suggestedFilename()).toBe('requested-deck.html');
		const path = info.outputPath('requested-deck.html');
		await download.saveAs(path);
		const html = await readFile(path, 'utf8');
		expect(html).toContain('Requested deck');
		expect(html).not.toContain('Other note');
		expect(html).not.toContain('Keep this private');
		await info.attach('requested-deck.html', { path, contentType: 'text/html' });
	} finally {
		await page.evaluate(() =>
			(window as unknown as { releasePresentationLock: () => void }).releasePresentationLock()
		);
	}
});

test('keeps slide wiki text literal and out of note indices', async ({ page }) => {
	await importMarkdown(page, '# Target\n\nA note.', 'Target.md');
	const fixture =
		'---\ntags: [deck-only-tag]\n---\n' + presentationFixture(['# Slides\n\n[[Target]]']);
	await importMarkdown(page, fixture, 'Deck.md');
	const editor = page.getByTestId('presentation-editor');
	await expect(editor.getByTestId('slide-canvas')).toContainText('[[Target]]');
	await expect(editor.locator('a.wiki-link')).toHaveCount(0);
	await expect(page.locator('.mdsh-sidebar').getByText('deck-only-tag')).toHaveCount(0);
	await editor.focus();
	await page.keyboard.press('Control+Shift+Tab');
	await expect(page.getByTestId('document-kind')).toHaveText('Note', { timeout: 15_000 });
	await expect(page.locator('.mdsh-sidebar').locator('[aria-label="Presentation"]')).toBeVisible();
	await page.locator('#app-toolbar input').fill('Renamed target');
	await page.locator('#app-toolbar input').press('Enter');
	await page.keyboard.press('Control+Tab');
	await openPresentationSource(editor);
	await expect(editor.getByTestId('slide-source-editor')).toHaveValue(fixture);
});

for (const locale of ['en', 'fr']) {
	test(`responsive creation and inline editor in ${locale}`, async ({ page }, info) => {
		test.setTimeout(120_000);
		await page.evaluate((locale) => localStorage.setItem('mdsh:locale', locale), locale);
		await page.reload();
		await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
		await page.setViewportSize({ width: 320, height: 700 });
		await page.getByTestId('welcome-new').click();
		const dialog = page.getByRole('dialog');
		await expect(dialog.getByTestId('create-note')).toBeFocused();
		await page.keyboard.press('Shift+Tab');
		await expect(dialog.getByRole('button').last()).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(dialog.getByTestId('create-note')).toBeFocused();
		const cards = await dialog.getByRole('button').all();
		const first = await cards[0]!.boundingBox();
		const second = await cards[1]!.boundingBox();
		expect(second!.y).toBeGreaterThan(first!.y + first!.height);
		await info.attach(`creation-${locale}.png`, {
			body: await page.screenshot(),
			contentType: 'image/png'
		});
		await page.keyboard.press('Tab');
		await page.keyboard.press('Enter');
		const editor = page.getByTestId('presentation-editor');
		await expect(editor).toBeVisible();
		for (const width of [320, 360, 390, 768, 1024, 1280, 1440]) {
			for (const height of [900, 390]) {
				await page.setViewportSize({ width, height });
				await expect(editor.getByTestId('slide-present')).toBeVisible();
				await editor.getByTestId('slide-canvas').scrollIntoViewIfNeeded();
				await expect(editor.getByTestId('slide-canvas')).toBeInViewport();
				const geometry = await page.evaluate(() => ({
					width: innerWidth,
					scroll: document.documentElement.scrollWidth
				}));
				expect(geometry.scroll).toBeLessThanOrEqual(geometry.width);
				await info.attach(`editor-${locale}-${width}x${height}.png`, {
					body: await page.screenshot(),
					contentType: 'image/png'
				});
			}
		}
		await page.setViewportSize({ width: 320, height: 900 });
		const axe = await new AxeBuilder({ page }).analyze();
		await info.attach(`axe-${locale}.json`, {
			body: JSON.stringify(axe),
			contentType: 'application/json'
		});
		expect(
			axe.violations.filter((item) => item.impact === 'serious' || item.impact === 'critical')
		).toEqual([]);
	});
}

test('creates separate document types and rejects source conversion', async ({ page }, info) => {
	await page.getByTestId('welcome-new').click();
	const dialog = page.getByRole('dialog', { name: 'Create a document' });
	await expect(dialog).toBeVisible();
	await expect(dialog.getByTestId('create-note')).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(dialog).toHaveCount(0);
	await expect(page.getByTestId('welcome-new')).toBeFocused();
	await page.getByTestId('welcome-new').click();
	await dialog.getByTestId('create-presentation').click();
	const editor = page.getByTestId('presentation-editor');
	await expect(editor).toBeVisible();
	await expect(editor).toHaveAttribute('role', 'region');
	await expect(page.getByTestId('slides-open')).toHaveCount(0);
	await expect(page.getByTestId('document-kind')).toHaveText('Presentation');
	await editor.getByTestId('slide-advanced').click();
	await editor.getByTestId('slide-source').click();
	const source = editor.getByTestId('slide-source-editor');
	const initial = await source.inputValue();
	expect(initial).toContain('<!-- mdsh-presentation');
	await source.fill('# This is a note');
	await editor.getByTestId('slide-source-apply').click();
	await expect(editor.getByRole('alert')).toContainText('presentation data');
	await expect(source).toHaveValue('# This is a note');
	await editor.getByTestId('slide-source-cancel').click();
	await editor.getByTestId('slide-add').click();
	await expect(editor.getByTestId('slide-thumbnail')).toHaveCount(2);
	await expect(editor.locator('.save-state')).toHaveText('saved');
	await page.reload();
	await expect(editor.getByTestId('slide-thumbnail')).toHaveCount(2);
	await editor.getByTestId('slide-present').click();
	await expect(editor).toHaveAttribute('aria-modal', 'true');
	await page.keyboard.press('Escape');
	await expect(editor).toHaveAttribute('role', 'region');
	await expect(editor.getByTestId('slide-present')).toBeFocused();
	await info.attach('presentation-files.png', {
		body: await page.screenshot({ fullPage: true }),
		contentType: 'image/png'
	});
});

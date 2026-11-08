import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { resetAppState } from './helpers';
import {
	exportPresentation,
	importMarkdown,
	openPresentationSource,
	presentationFixture,
	waitForPresentation
} from './presentation-helpers';
import { readFile } from 'node:fs/promises';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

async function resetEnglishApp(page: Page): Promise<void> {
	await resetAppState(page);
	await page.evaluate(() => localStorage.setItem('mdsh:locale', 'en'));
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
}

test.beforeEach(async ({ page }) => {
	await resetEnglishApp(page);
});

test('keeps source comments, frontmatter and framing after idle text and notes edits', async ({
	page
}, info) => {
	const frontmatter = '\uFEFF---\r\ntitle: Keep exact frontmatter\r\ncustom: true\r\n---\r\n';
	const fixture =
		frontmatter + presentationFixture(['# Before\n\n<!-- Keep this comment -->\n\nLiteral body.']);
	await seed(page, fixture);
	const editor = await openSlides(page);
	await editor.getByTestId('slide-object').first().dblclick();
	const content =
		'# Edited\n\n<!-- Keep this comment -->\n\n<!-- mdsh-slide:literal -->\n---\n```md\nopen fence';
	await editor.getByTestId('slide-text-editor').fill(content);
	await expect(editor.locator('.save-state')).toHaveText('saved');
	await editor.getByTestId('slide-text-done').click();
	await editor.getByTestId('slide-notes').fill('Notes --> and --!> remain exact.');
	await expect(editor.locator('.save-state')).toHaveText('saved');
	const pending = page.waitForEvent('download');
	await exportPresentation(editor, 'md');
	const download = await pending;
	const path = info.outputPath('idle-format.md');
	await download.saveAs(path);
	const source = await readFile(path, 'utf8');
	expect(source.startsWith(frontmatter)).toBe(true);
	expect(source).toContain('<!-- Keep this comment -->');
	expect(source).toContain('<!-- mdsh-element:text-1 -->');
	expect(source).toContain('<!-- mdsh-slide:slide-1 -->');
	expect(source).toContain('<!-- mdsh-literal -->\n<!-- mdsh-slide:literal -->');
	await page.reload();
	await editor.getByTestId('slide-object').first().dblclick();
	await expect(editor.getByTestId('slide-text-editor')).toHaveValue(content);
	await editor.getByTestId('slide-text-done').click();
	await expect(editor.getByTestId('slide-notes')).toHaveValue('Notes --> and --!> remain exact.');
	await openPresentationSource(editor);
	await expect(editor.getByTestId('slide-source-editor')).toHaveValue(
		source.replace(/\r\n/g, '\n')
	);
	const stored = await persistenceSnapshot(page);
	expect(stored.drafts[0]?.content).toBe(source);
	await info.attach('idle-format.md', { path, contentType: 'text/markdown' });
});

const emptySlide = {
	id: 'slide-1',
	background: '#ffffff',
	notes: '',
	elements: []
};

function metadata(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		version: 1,
		width: 1280,
		height: 720,
		theme: 'light',
		slides: [emptySlide],
		...overrides
	});
}

function presentation(json: string, body = '# Keep this content'): string {
	return `${body}\n\n<!-- mdsh-presentation\n${json}\n-->\n`;
}

async function openSlides(page: Page) {
	return waitForPresentation(page);
}

async function seed(page: Page, content: string): Promise<void> {
	await importMarkdown(page, content);
}

async function persistenceSnapshot(page: Page) {
	return page.evaluate(async () => {
		const status = document.querySelector('.save-state, #app-statusbar')?.textContent?.trim();
		const capturedAt = performance.now();
		const drafts = await new Promise<{ id: string; content: string }[]>((resolve, reject) => {
			const request = indexedDB.open('mdsh');
			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				const database = request.result;
				const transaction = database.transaction('drafts', 'readonly');
				const rows = transaction.objectStore('drafts').getAll();
				transaction.oncomplete = () => {
					database.close();
					resolve(rows.result.map(({ id, content }) => ({ id, content })));
				};
				transaction.onabort = () => {
					database.close();
					reject(transaction.error);
				};
			};
		});
		return { status, capturedAt, completedAt: performance.now(), drafts };
	});
}

async function reloadSavedFixture(page: Page, testInfo: TestInfo, fixture: string): Promise<void> {
	const before = await persistenceSnapshot(page);
	let saved: Awaited<ReturnType<typeof persistenceSnapshot>> | undefined;
	let after: Awaited<ReturnType<typeof persistenceSnapshot>> | undefined;
	try {
		// Closing the import report does not wait for the 400 ms draft save.
		await expect(page.locator('#app-statusbar')).toContainText(/\bsaved\b/);
		await expect
			.poll(async () => {
				saved = await persistenceSnapshot(page);
				return saved.drafts.map((draft) => draft.content);
			})
			.toEqual([fixture]);
		await page.reload();
		await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
		after = await persistenceSnapshot(page);
		expect(after.drafts).toEqual(saved?.drafts);
	} finally {
		await testInfo.attach('reload-persistence.json', {
			body: JSON.stringify({ fixture, before, saved, after }, null, 2),
			contentType: 'application/json'
		});
	}
}

async function attachFailure(
	testInfo: TestInfo,
	name: string,
	fixture: string,
	expected: string
): Promise<void> {
	await testInfo.attach(`${name}.md`, { body: fixture, contentType: 'text/markdown' });
	await testInfo.attach(`${name}.json`, {
		body: JSON.stringify(
			{
				command: `npm run test:e2e -- presentation-format.spec.ts --project=${testInfo.project.name} --workers=1`,
				project: testInfo.project.name,
				expected,
				sourceUnchanged: true
			},
			null,
			2
		),
		contentType: 'application/json'
	});
}

test('rejects an unknown metadata version and keeps the file bytes', async ({ page }, testInfo) => {
	const fixture = presentation(metadata({ version: 2 }));
	await seed(page, fixture);
	const editor = await openSlides(page);
	await expect(editor.getByTestId('slide-source-error')).toBeVisible();
	await expect(editor.getByTestId('slide-source-error')).toHaveAttribute('role', 'alert');
	await expect(editor.getByTestId('slide-source-editor')).toHaveValue(fixture);
	await reloadSavedFixture(page, testInfo, fixture);
	const restored = await openSlides(page);
	await expect(restored.getByTestId('slide-source-error')).toBeVisible();
	await expect(restored.getByTestId('slide-source-editor')).toHaveValue(fixture);
	await expect(page.locator('.cm-content')).toHaveCount(0);
	await attachFailure(testInfo, 'unknown-version', fixture, 'unsupported version');
});

test('rejects malformed metadata without replacing the document', async ({ page }, testInfo) => {
	const fixture = presentation('{not valid json}');
	await seed(page, fixture);
	const editor = await openSlides(page);
	await expect(editor.getByTestId('slide-source-error')).toBeVisible();
	await expect(editor.getByTestId('slide-source-editor')).toHaveValue(fixture);
	await reloadSavedFixture(page, testInfo, fixture);
	const restored = await openSlides(page);
	await expect(restored.getByTestId('slide-source-error')).toBeVisible();
	await expect(restored.getByTestId('slide-source-editor')).toHaveValue(fixture);
	await expect(page.locator('.cm-content')).toHaveCount(0);
	await attachFailure(testInfo, 'malformed-json', fixture, 'invalid JSON');
});

test('ignores a metadata marker inside a code fence', async ({ page }, testInfo) => {
	const fixture = [
		'# Ordinary document',
		'',
		'```md',
		'<!-- mdsh-presentation',
		metadata(),
		'-->',
		'```'
	].join('\n');
	await seed(page, fixture);
	await expect(page.getByTestId('presentation-editor')).toHaveCount(0);
	await expect(page.getByTestId('slides-open')).toHaveCount(0);
	await expect(page.locator('.cm-content')).toBeVisible();
	await expect.poll(() => page.locator('.cm-line').allTextContents()).toEqual(fixture.split('\n'));
	await reloadSavedFixture(page, testInfo, fixture);
	await expect(page.locator('.cm-content')).toBeVisible();
	await expect.poll(() => page.locator('.cm-line').allTextContents()).toEqual(fixture.split('\n'));
	await expect(page.getByTestId('presentation-editor')).toHaveCount(0);
	await attachFailure(testInfo, 'marker-inside-fence', fixture, 'marker ignored');
});

test('rejects duplicate object identifiers', async ({ page }, testInfo) => {
	const fixture = presentation(
		metadata({
			slides: [
				{
					...emptySlide,
					elements: [
						{
							id: 'same',
							type: 'rectangle',
							x: 10,
							y: 10,
							width: 100,
							height: 100,
							rotation: 0,
							fill: '#ffffff',
							stroke: '#000000',
							strokeWidth: 1,
							color: '#000000',
							fontSize: 20,
							textAlign: 'left',
							content: ''
						},
						{
							id: 'same',
							type: 'ellipse',
							x: 200,
							y: 10,
							width: 100,
							height: 100,
							rotation: 0,
							fill: '#ffffff',
							stroke: '#000000',
							strokeWidth: 1,
							color: '#000000',
							fontSize: 20,
							textAlign: 'left',
							content: ''
						}
					]
				}
			]
		})
	);
	await seed(page, fixture);
	const editor = await openSlides(page);
	await expect(editor.getByTestId('slide-source-error')).toBeVisible();
	await expect(editor.getByTestId('slide-source-editor')).toHaveValue(fixture);
	await attachFailure(testInfo, 'duplicate-identifiers', fixture, 'duplicate identifiers');
});

test('rejects an element outside the slide bounds', async ({ page }, testInfo) => {
	const fixture = presentation(
		metadata({
			slides: [
				{
					...emptySlide,
					elements: [
						{
							id: 'outside',
							type: 'rectangle',
							x: 1200,
							y: 10,
							width: 400,
							height: 100,
							rotation: 0,
							fill: '#ffffff',
							stroke: '#000000',
							strokeWidth: 1,
							color: '#000000',
							fontSize: 20,
							textAlign: 'left',
							content: ''
						}
					]
				}
			]
		})
	);
	await seed(page, fixture);
	const editor = await openSlides(page);
	await expect(editor.getByTestId('slide-source-error')).toBeVisible();
	await expect(editor.getByTestId('slide-source-editor')).toHaveValue(fixture);
	await attachFailure(testInfo, 'outside-slide', fixture, 'invalid coordinates');
});

test('rejects a connector that refers to a missing object', async ({ page }, testInfo) => {
	const fixture = presentation(
		metadata({
			slides: [
				{
					...emptySlide,
					elements: [
						{
							id: 'arrow',
							type: 'arrow',
							x: 100,
							y: 100,
							width: 200,
							height: 0,
							rotation: 0,
							fill: 'transparent',
							stroke: '#000000',
							strokeWidth: 2,
							color: '#000000',
							fontSize: 20,
							textAlign: 'left',
							content: '',
							startId: 'missing'
						}
					]
				}
			]
		})
	);
	await seed(page, fixture);
	const editor = await openSlides(page);
	await expect(editor.getByTestId('slide-source-error')).toBeVisible();
	await expect(editor.getByTestId('slide-source-editor')).toHaveValue(fixture);
	await attachFailure(testInfo, 'missing-connector', fixture, 'invalid connector reference');
});

test('keeps a blank slide between consecutive separators', async ({ page }, testInfo) => {
	const fixture = presentationFixture(['# First', '', '# Last']);
	await seed(page, fixture);
	const editor = await openSlides(page);
	await expect(editor.getByTestId('slide-thumbnail')).toHaveCount(3);
	await editor.getByTestId('slide-thumbnail').nth(1).click();
	await expect(editor.locator('[data-testid="slide-object"]')).toHaveCount(0);
	await attachFailure(testInfo, 'blank-slide', fixture, 'three slides with one blank');
});

test('keeps a separator inside a fence in one slide', async ({ page }, testInfo) => {
	const fixture = presentationFixture(['# Opening\n\n~~~md\n---\n~~~', '# Closing']);
	await seed(page, fixture);
	const editor = await openSlides(page);
	await expect(editor.getByTestId('slide-thumbnail')).toHaveCount(2);
	await attachFailure(testInfo, 'separator-in-fence', fixture, 'two slides only');
});

test('edits a large deck source through the lazy CodeMirror path', async ({ page }, testInfo) => {
	// Above the plain-textarea threshold, the source surface must stay a native
	// CodeMirror document instead of a reactive full-string textarea value.
	const long = 'A'.repeat(600 * 1024);
	const fixture = presentationFixture([long]);
	await seed(page, fixture);
	const editor = await openSlides(page);
	await openPresentationSource(editor);
	const source = editor.getByTestId('slide-source-editor');
	await expect(source.locator('.cm-editor')).toBeVisible();
	await source.locator('.cm-content').focus();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.insertText('\n<!-- tail -->');
	await editor.getByTestId('slide-source-apply').click();
	await expect(editor.locator('.save-state')).toHaveText('saved');
	const stored = await persistenceSnapshot(page);
	expect(stored.drafts[0]?.content).toContain('<!-- tail -->');
	await attachFailure(
		testInfo,
		'large-source',
		'large deck source',
		'CodeMirror path applied a tail edit'
	);
});

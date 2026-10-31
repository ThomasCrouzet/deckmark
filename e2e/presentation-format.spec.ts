import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { resetAppState, writeSourceContent } from './helpers';

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
	await page.getByTestId('slides-open').click();
	const editor = page.getByTestId('presentation-editor');
	await expect(editor).toBeVisible({ timeout: 15_000 });
	return editor;
}

async function seed(page: Page, content: string): Promise<void> {
	await page.getByTestId('welcome-new').click();
	await writeSourceContent(page, content);
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
				command: 'npm run test:e2e -- presentation-format.spec.ts --project=chromium --workers=1',
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
	await editor.getByTestId('slide-close').click();
	await page.waitForTimeout(600);
	await page.reload();
	await expect(page.locator('.cm-content')).toContainText('Keep this content');
	await attachFailure(testInfo, 'unknown-version', fixture, 'unsupported version');
});

test('rejects malformed metadata without replacing the document', async ({ page }, testInfo) => {
	const fixture = presentation('{not valid json}');
	await seed(page, fixture);
	const editor = await openSlides(page);
	await expect(editor.getByTestId('slide-source-error')).toBeVisible();
	await expect(editor.getByTestId('slide-source-editor')).toHaveValue(fixture);
	await editor.getByTestId('slide-close').click();
	await page.waitForTimeout(600);
	await page.reload();
	await expect(page.locator('.cm-content')).toContainText('Keep this content');
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
	await expect(page.getByTestId('presentation-document')).toHaveCount(0);
	const editor = await openSlides(page);
	await expect(editor.getByTestId('slide-thumbnail')).toHaveCount(1);
	await editor.getByTestId('slide-source').click();
	await expect(editor.getByTestId('slide-source-editor')).toHaveValue(fixture);
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
	const fixture = ['# First', '', '---', '', '---', '', '# Last'].join('\n');
	await seed(page, fixture);
	const editor = await openSlides(page);
	await expect(editor.getByTestId('slide-thumbnail')).toHaveCount(3);
	await editor.getByTestId('slide-thumbnail').nth(1).click();
	await expect(editor.locator('[data-testid="slide-object"]')).toHaveCount(0);
	await attachFailure(testInfo, 'blank-slide', fixture, 'three slides with one blank');
});

test('keeps a separator inside a fence in one slide', async ({ page }, testInfo) => {
	const fixture = ['# Opening', '', '~~~md', '---', '~~~', '', '---', '', '# Closing'].join('\n');
	await seed(page, fixture);
	await expect(page.getByTestId('presentation-document')).toHaveCount(0);
	const editor = await openSlides(page);
	await expect(editor.getByTestId('slide-thumbnail')).toHaveCount(2);
	await attachFailure(testInfo, 'separator-in-fence', fixture, 'two slides only');
});

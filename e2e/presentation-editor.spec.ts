import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resetAppState, writeSourceContent } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

const imagePath = resolve('static/pwa-192x192.png');
const completeFixturePath = resolve('e2e/fixtures/presentation-complete.md');

async function resetEnglishApp(page: Page): Promise<void> {
	await resetAppState(page);
	await page.evaluate(() => localStorage.setItem('mdsh:locale', 'en'));
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
}

async function openPresentation(page: Page): Promise<Locator> {
	await page.getByTestId('slides-open').click();
	const editor = page.getByTestId('presentation-editor');
	await expect(editor).toBeVisible({ timeout: 15_000 });
	await expect(editor.getByTestId('slide-canvas')).toBeVisible();
	return editor;
}

function objects(editor: Locator, type?: string): Locator {
	const selector = type
		? `[data-testid="slide-object"][data-object-type="${type}"]`
		: '[data-testid="slide-object"]';
	return editor.locator(selector);
}

async function renderedObject(editor: Locator, object: Locator): Promise<Locator> {
	const id = await object.getAttribute('data-object-id');
	if (!id) throw new Error('The slide object identifier is missing.');
	return editor.getByTestId('slide-canvas').locator(`[data-element-id="${id}"]`);
}

async function expectSaved(editor: Locator): Promise<void> {
	await expect(editor.locator('.save-state')).toHaveText('saved', { timeout: 10_000 });
}

async function selectObject(editor: Locator, object: Locator, extend = false): Promise<void> {
	const id = await object.getAttribute('data-object-id');
	const ids = await objects(editor).evaluateAll((nodes) =>
		nodes.map((node) => node.getAttribute('data-object-id'))
	);
	const index = ids.indexOf(id);
	if (index < 0) throw new Error('The slide object is absent from the object list.');
	const listItem = editor.getByTestId('slide-object-list-item').nth(index);
	await listItem.click({ modifiers: extend ? ['Shift'] : [] });
	await expect(listItem).toBeFocused();
	await expect(object).toHaveAttribute('aria-pressed', 'true');
}

async function addObject(editor: Locator, type: string): Promise<Locator> {
	const before = await objects(editor, type).count();
	await editor.getByTestId(`slide-add-${type}`).click();
	await expect(objects(editor, type)).toHaveCount(before + 1);
	return objects(editor, type).last();
}

async function dragBy(page: Page, locator: Locator, dx: number, dy: number): Promise<void> {
	const box = await locator.boundingBox();
	if (!box) throw new Error('The object is not visible.');
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, {
		steps: 12
	});
	await page.mouse.up();
}

async function setProperty(editor: Locator, id: string, value: string): Promise<void> {
	const control = editor.getByTestId(id);
	await control.fill(value);
	await control.press('Tab');
}

async function attachWorkflow(
	testInfo: TestInfo,
	page: Page,
	editor: Locator,
	name: string,
	extra: Record<string, unknown> = {}
): Promise<void> {
	await testInfo.attach(`${name}.png`, {
		body: await page.screenshot({ fullPage: true }),
		contentType: 'image/png'
	});
	await editor.getByTestId('slide-source').click();
	const source = await editor.getByTestId('slide-source-editor').inputValue();
	await testInfo.attach(`${name}.md`, { body: source, contentType: 'text/markdown' });
	await testInfo.attach(`${name}.json`, {
		body: JSON.stringify(
			{
				command: 'npm run test:e2e -- presentation-editor.spec.ts --project=chromium --workers=1',
				project: testInfo.project.name,
				fixture: 'Presentation created through the visible editor',
				...extra
			},
			null,
			2
		),
		contentType: 'application/json'
	});
}

function violationSummary(
	violations: Array<{ impact: string | null; id: string; nodes: Array<{ target: unknown }> }>
): string {
	return violations
		.map(
			(violation) =>
				`${violation.impact}: ${violation.id} ${violation.nodes
					.map((node) => JSON.stringify(node.target))
					.join(', ')}`
		)
		.join('\n');
}

test.beforeEach(async ({ page }) => {
	await resetEnglishApp(page);
});

test('imports existing Markdown without splitting fenced separators', async ({
	page
}, testInfo) => {
	const fixture = [
		'# Existing opening',
		'',
		'````markdown',
		'```js',
		'---',
		'```',
		'Literal separator',
		'````',
		'',
		'---',
		'',
		'# Existing closing'
	].join('\n');
	await page.getByTestId('welcome-new').click();
	await writeSourceContent(page, fixture);
	const editor = await openPresentation(page);
	await expect(editor.getByTestId('slide-thumbnail')).toHaveCount(2);
	await expect(await renderedObject(editor, objects(editor, 'text').first())).toContainText(
		'Literal separator'
	);
	await editor.getByTestId('slide-source').click();
	await expect(editor.getByTestId('slide-source-editor')).toHaveValue(fixture);
	await editor.getByTestId('slide-source').click();
	await editor.getByTestId('slide-thumbnail').last().click();
	await expect(await renderedObject(editor, objects(editor, 'text').first())).toContainText(
		'Existing closing'
	);
	await objects(editor, 'text').first().dblclick();
	await editor.getByTestId('slide-text-editor').fill('# Edited closing');
	await editor.getByTestId('slide-text-done').click();
	await editor.getByTestId('slide-source').click();
	const source = await editor.getByTestId('slide-source-editor').inputValue();
	expect(source).toContain('---\n```\nLiteral separator');
	expect(source).toContain('# Edited closing');
	expect(source).toContain('<!-- mdsh-presentation');
	await testInfo.attach('presentation-import.md', { body: source, contentType: 'text/markdown' });
	await testInfo.attach('presentation-import.json', {
		body: JSON.stringify({ fixture, slideCount: 2, preservedFence: true }, null, 2),
		contentType: 'application/json'
	});
});

test('preserves a YAML literal that contains a false presentation marker', async ({
	page
}, testInfo) => {
	const frontmatter = [
		'---',
		'title: Ordinary Markdown',
		'description: |',
		'  Keep this literal.',
		'  <!-- mdsh-presentation',
		'  -->',
		'custom-key: keep me',
		'---',
		''
	].join('\n');
	const fixture = `${frontmatter}# Ordinary document\n\nVisible body.`;
	await page.getByTestId('welcome-new').click();
	await writeSourceContent(page, fixture);
	await expect(page.locator('.cm-content')).toContainText('Ordinary document');
	await expect(page.getByTestId('presentation-editor')).toHaveCount(0);

	const editor = await openPresentation(page);
	await expect(editor.getByTestId('slide-thumbnail')).toHaveCount(1);
	const text = objects(editor, 'text').first();
	await expect(await renderedObject(editor, text)).toContainText('Ordinary document');
	await text.dblclick();
	await editor.getByTestId('slide-text-editor').fill('# Edited ordinary document\n\nVisible body.');
	await editor.getByTestId('slide-text-done').click();
	await editor.getByTestId('slide-source').click();
	const source = await editor.getByTestId('slide-source-editor').inputValue();
	expect(source.slice(0, frontmatter.length)).toBe(frontmatter);
	expect(source).toContain('# Edited ordinary document');
	expect(source).toContain('<!-- mdsh-presentation\n');
	await testInfo.attach('presentation-yaml-literal.md', {
		body: source,
		contentType: 'text/markdown'
	});
	await testInfo.attach('presentation-yaml-literal.json', {
		body: JSON.stringify(
			{ ordinaryBeforeImport: true, frontmatterByteStable: true, slideCount: 1 },
			null,
			2
		),
		contentType: 'application/json'
	});
});

test('round-trips reserved framing lines and an unclosed fence', async ({ page }, testInfo) => {
	const editor = await openPresentation(page);
	const text = await addObject(editor, 'text');
	const textId = await text.getAttribute('data-object-id');
	if (!textId) throw new Error('The text object identifier is missing.');
	const content = [
		'# Framing collisions',
		'<!-- mdsh-slide:user-slide -->',
		'<!-- mdsh-element:user-element -->',
		`<!-- mdsh-end-element:${textId} gap=0 -->`,
		'<!-- mdsh-presentation',
		'-->',
		'<!-- mdsh-literal -->',
		'---',
		'```md',
		'<!-- mdsh-slide:fenced -->',
		'---',
		'```',
		'~~~js',
		'<!-- mdsh-element:fenced -->',
		'~~~',
		'```js',
		'const openFence = true;'
	].join('\n');
	await text.dblclick();
	await editor.getByTestId('slide-text-editor').fill(content);
	await editor.getByTestId('slide-text-done').click();
	await editor.getByTestId('slide-notes').fill('Speaker note --> and --!> remain exact.');
	const rectangle = await addObject(editor, 'rectangle');
	await rectangle.dblclick();
	await editor.getByTestId('slide-text-editor').fill('**Shape --> and --!> Markdown**');
	await editor.getByTestId('slide-text-done').click();
	await expectSaved(editor);

	await editor.getByTestId('slide-source').click();
	const canonical = await editor.getByTestId('slide-source-editor').inputValue();
	expect(canonical).toContain(`<!-- mdsh-element:${textId} -->`);
	expect(canonical).toContain(`<!-- mdsh-end-element:${textId} gap=1 fence=b3 -->`);
	expect(canonical).toContain('<!-- mdsh-literal -->\n<!-- mdsh-slide:user-slide -->');
	expect(canonical).toContain('<!-- mdsh-literal -->\n---');
	expect(canonical).toContain('<!-- mdsh-literal -->\n<!-- mdsh-literal -->');
	expect(canonical).toContain('Speaker note --\\u003e and --!\\u003e remain exact.');
	expect(canonical).toContain('**Shape --\\u003e and --!\\u003e Markdown**');
	await editor.getByTestId('slide-source').click();
	await editor.getByTestId('slide-close').click();
	await page.reload();
	const restored = await openPresentation(page);
	await expect(restored.getByTestId('slide-notes')).toHaveValue(
		'Speaker note --> and --!> remain exact.'
	);
	await expect(
		await renderedObject(restored, restored.locator(`[data-object-id="${textId}"]`))
	).toContainText('const openFence = true;');
	await expect(await renderedObject(restored, objects(restored, 'rectangle'))).toContainText(
		'Shape --> and --!> Markdown'
	);
	await restored.getByTestId('slide-source').click();
	await expect(restored.getByTestId('slide-source-editor')).toHaveValue(canonical);
	await restored
		.getByTestId('slide-source-editor')
		.fill(canonical.replace('# Framing collisions', '# Framing collisions edited'));
	await restored.getByTestId('slide-source').click();
	await expect(
		restored.getByTestId('slide-canvas').getByText('Framing collisions edited', { exact: true })
	).toBeVisible();
	await restored.getByTestId('slide-source').click();
	const editedCanonical = await restored.getByTestId('slide-source-editor').inputValue();
	const alternativeClose = editedCanonical.replace(/\n-->\s*$/, '\n--!>');
	expect(alternativeClose).not.toBe(editedCanonical);
	await restored.getByTestId('slide-source-editor').fill(alternativeClose);
	await restored.getByTestId('slide-source').click();
	await expect(restored.getByTestId('slide-source-error')).toHaveCount(0);
	await expect(restored.getByTestId('slide-notes')).toHaveValue(
		'Speaker note --> and --!> remain exact.'
	);
	await expect(await renderedObject(restored, objects(restored, 'rectangle'))).toContainText(
		'Shape --> and --!> Markdown'
	);
	const notes = restored.getByTestId('slide-notes');
	await notes.fill('Speaker note --> and --!> remain exact. Updated');
	await notes.press('Tab');
	await expectSaved(restored);
	await restored.getByTestId('slide-source').click();
	const roundTrip = await restored.getByTestId('slide-source-editor').inputValue();
	expect(roundTrip).toMatch(/\n-->\s*$/);
	expect(roundTrip).not.toContain('--!>');
	await restored.getByTestId('slide-source').click();

	const pending = page.waitForEvent('download');
	await restored.getByTestId('slide-export-html').click();
	const download = await pending;
	const output = testInfo.outputPath('framing-collisions.html');
	await download.saveAs(output);
	const html = await readFile(output, 'utf8');
	expect(html).toContain('Framing collisions edited');
	expect(html).toContain('openFence = ');
	expect(html).toContain('>true</span>');
	expect(html).toContain('Shape --&gt; and --!&gt; Markdown');
	await testInfo.attach('presentation-framing.md', {
		body: roundTrip,
		contentType: 'text/markdown'
	});
	await testInfo.attach('presentation-framing.html', { path: output, contentType: 'text/html' });
});

test('opens a complete visual deck without changing its Markdown bytes', async ({
	page
}, testInfo) => {
	const fixture = await readFile(completeFixturePath, 'utf8');
	await page.getByTestId('welcome-new').click();
	await writeSourceContent(page, fixture);
	const editor = await openPresentation(page);
	await expect(editor.getByTestId('slide-thumbnail')).toHaveCount(3);
	await expect(objects(editor)).toHaveCount(7);
	await expect(
		editor.getByTestId('slide-canvas').locator('[data-element-id="logo"] img')
	).toHaveJSProperty('naturalWidth', 1);
	await selectObject(editor, objects(editor, 'arrow'));
	await expect(editor.getByTestId('slide-prop-startId')).toHaveValue('card');
	await expect(editor.getByTestId('slide-prop-endId')).toHaveValue('goal');
	await expect(editor.getByTestId('slide-notes')).toHaveValue(
		'Introduce the offline slide editor.'
	);
	await editor.getByTestId('slide-source').click();
	await expect(editor.getByTestId('slide-source-editor')).toHaveValue(fixture);
	await editor.getByTestId('slide-source').click();
	await editor.getByTestId('slide-thumbnail').last().click();
	await expect(objects(editor)).toHaveCount(0);
	await editor.getByTestId('slide-close').click();
	await page.reload();
	const reloaded = await openPresentation(page);
	await expect(reloaded.getByTestId('slide-thumbnail')).toHaveCount(3);
	await reloaded.getByTestId('slide-source').click();
	await expect(reloaded.getByTestId('slide-source-editor')).toHaveValue(fixture);
	await testInfo.attach('presentation-complete.md', {
		path: completeFixturePath,
		contentType: 'text/markdown'
	});
	await testInfo.attach('presentation-complete.json', {
		body: JSON.stringify(
			{
				fixture: 'e2e/fixtures/presentation-complete.md',
				slides: 3,
				firstSlideObjects: 7,
				blankSlides: 1,
				byteStableAfterReload: true
			},
			null,
			2
		),
		contentType: 'application/json'
	});
});

test('manages slides and keeps deck settings after close and reload', async ({
	page
}, testInfo) => {
	const editor = await openPresentation(page);
	await expect(editor.getByTestId('slide-thumbnail')).toHaveCount(1);
	await editor.getByTestId('slide-title').fill('Quarterly plan');

	await editor.getByTestId('slide-add').click();
	await expect(editor.getByTestId('slide-thumbnail')).toHaveCount(2);
	await editor.getByTestId('slide-notes').fill('Private speaker note for slide two.');
	await editor.getByTestId('slide-background').fill('#123456');
	await editor.getByTestId('slide-aspect').selectOption('4:3');

	const secondId = await editor.getByTestId('slide-thumbnail').nth(1).getAttribute('data-slide-id');
	await editor.getByTestId('slide-duplicate-slide').click();
	await expect(editor.getByTestId('slide-thumbnail')).toHaveCount(3);
	const duplicateId = await editor
		.getByTestId('slide-thumbnail')
		.nth(2)
		.getAttribute('data-slide-id');
	expect(duplicateId).not.toBe(secondId);

	await editor.getByTestId('slide-move-prev').click();
	await expect(editor.getByTestId('slide-thumbnail').nth(1)).toHaveAttribute(
		'data-slide-id',
		duplicateId ?? ''
	);
	await editor.getByTestId('slide-delete-slide').click();
	await expect(editor.getByTestId('slide-thumbnail')).toHaveCount(2);
	await expectSaved(editor);

	await editor.getByTestId('slide-close').click();
	await expect(editor).toHaveCount(0);
	await expect(page.getByTestId('slides-open')).toBeFocused();

	const reopened = await openPresentation(page);
	await expect(reopened.getByTestId('slide-title')).toHaveValue('Quarterly plan.md');
	await expect(reopened.getByTestId('slide-thumbnail')).toHaveCount(2);
	await expect(reopened.getByTestId('slide-aspect')).toHaveValue('4:3');
	await reopened.getByTestId('slide-thumbnail').last().click();
	await expect(reopened.getByTestId('slide-notes')).toHaveValue(
		'Private speaker note for slide two.'
	);
	await expect(reopened.getByTestId('slide-background')).toHaveValue('#123456');

	await reopened.getByTestId('slide-close').click();
	await page.reload();
	const afterReload = await openPresentation(page);
	await expect(afterReload.getByTestId('slide-thumbnail')).toHaveCount(2);
	await expect(afterReload.getByTestId('slide-title')).toHaveValue('Quarterly plan.md');
	await attachWorkflow(testInfo, page, afterReload, 'presentation-slide-management', {
		slideCount: 2,
		aspect: '4:3'
	});
});

test('shows a real quota save failure and retries from the presentation', async ({
	page,
	context,
	browserName
}, testInfo) => {
	test.skip(browserName !== 'chromium', 'Chromium exposes the browser quota manager through CDP');
	test.setTimeout(90_000);
	const editor = await openPresentation(page);
	await addObject(editor, 'text');
	await expectSaved(editor);
	const cdp = await context.newCDPSession(page);
	const origin = new URL(page.url()).origin;
	const measurements: Array<{ stage: string; storage: unknown }> = [];
	const measure = async (stage: string) => {
		measurements.push({
			stage,
			storage: await cdp.send('Storage.getUsageAndQuota', { origin })
		});
	};

	try {
		await measure('saved');
		await cdp.send('Storage.overrideQuotaForOrigin', { origin, quotaSize: 1 });
		await measure('quota-constrained');
		// Chromium keeps available bucket space for 30 seconds.
		await page.waitForTimeout(32_000);
		await editor.getByTestId('slide-add-rectangle').click();
		await expect(editor.locator('.save-state')).toHaveText('Not saved locally', {
			timeout: 10_000
		});
		const retry = editor.getByTestId('slide-retry-save');
		await expect(retry).toBeVisible();
		await measure('failed-save');
		await testInfo.attach('presentation-save-failure.png', {
			body: await page.screenshot({ fullPage: true }),
			contentType: 'image/png'
		});

		await cdp.send('Storage.overrideQuotaForOrigin', { origin });
		await retry.click();
		await expectSaved(editor);
		await measure('retry-saved');
		await testInfo.attach('presentation-save-failure.json', {
			body: JSON.stringify(
				{
					command:
						'npm run test:e2e -- presentation-editor.spec.ts --project=chromium --grep "real quota" --workers=1',
					project: testInfo.project.name,
					fixture: { slides: 1, objectTypes: ['text', 'rectangle'], quotaBytes: 1 },
					measurements
				},
				null,
				2
			),
			contentType: 'application/json'
		});
	} finally {
		await cdp.send('Storage.overrideQuotaForOrigin', { origin }).catch(() => {});
	}
});

test('directly manipulates every object type and preserves Markdown text', async ({
	page
}, testInfo) => {
	test.setTimeout(60_000);
	const editor = await openPresentation(page);
	const text = await addObject(editor, 'text');
	const renderedText = await renderedObject(editor, text);
	await text.dblclick();
	await editor
		.getByTestId('slide-text-editor')
		.fill('## Delivery\n\n**Offline** on every platform.');
	await editor.getByTestId('slide-text-done').click();
	await expect(renderedText).toContainText('Delivery');
	await expect(renderedText).toContainText('Offline');

	const rectangle = await addObject(editor, 'rectangle');
	await addObject(editor, 'rounded-rectangle');
	await addObject(editor, 'ellipse');
	await addObject(editor, 'line');
	await addObject(editor, 'arrow');

	const chooser = page.waitForEvent('filechooser');
	await editor.getByTestId('slide-add-image').click();
	await (await chooser).setFiles(imagePath);
	await expect(objects(editor, 'image')).toHaveCount(1);
	await expect(
		(await renderedObject(editor, objects(editor, 'image'))).locator('img')
	).toHaveJSProperty('naturalWidth', 192);

	await selectObject(editor, rectangle);
	await editor.getByTestId('slide-front').click();
	const beforeDrag = await rectangle.boundingBox();
	await dragBy(page, rectangle, 90, 55);
	const afterDrag = await rectangle.boundingBox();
	expect(beforeDrag).not.toBeNull();
	expect(afterDrag).not.toBeNull();
	expect(afterDrag!.x - beforeDrag!.x).toBeGreaterThan(50);
	expect(afterDrag!.y - beforeDrag!.y).toBeGreaterThan(25);

	await rectangle.click();
	const beforeResize = await rectangle.boundingBox();
	await dragBy(page, editor.getByTestId('slide-resize-se'), 70, 45);
	const afterResize = await rectangle.boundingBox();
	expect(afterResize!.width - beforeResize!.width).toBeGreaterThan(35);
	expect(afterResize!.height - beforeResize!.height).toBeGreaterThan(20);

	const beforeTransform = await rectangle.evaluate((node) => getComputedStyle(node).transform);
	await dragBy(page, editor.getByTestId('slide-rotate'), 55, 15);
	await expect
		.poll(() => rectangle.evaluate((node) => getComputedStyle(node).transform))
		.not.toBe(beforeTransform);

	await setProperty(editor, 'slide-prop-x', '140');
	await setProperty(editor, 'slide-prop-y', '110');
	await setProperty(editor, 'slide-prop-width', '310');
	await setProperty(editor, 'slide-prop-height', '180');
	await setProperty(editor, 'slide-prop-rotation', '15');
	await expect(editor.getByTestId('slide-prop-x')).toHaveValue('140');
	await expect(editor.getByTestId('slide-prop-rotation')).toHaveValue('15');

	await editor.getByTestId('slide-source').click();
	const sourceEditor = editor.getByTestId('slide-source-editor');
	const originalSource = await sourceEditor.inputValue();
	expect(originalSource).toContain('## Delivery');
	expect(originalSource).toContain('**Offline**');
	expect(originalSource).toContain('data:image/png;base64,');
	await sourceEditor.fill(originalSource.replace('Offline', 'Private and offline'));
	await editor.getByTestId('slide-source').click();
	await expect(renderedText).toContainText('Private and offline');
	await expect(rectangle).toHaveAttribute('data-object-type', 'rectangle');
	await selectObject(editor, rectangle);
	await expect(editor.getByTestId('slide-prop-x')).toHaveValue('140');
	await expectSaved(editor);

	await editor.getByTestId('slide-close').click();
	await page.reload();
	const reloaded = await openPresentation(page);
	await expect(await renderedObject(reloaded, objects(reloaded, 'text'))).toContainText(
		'Private and offline'
	);
	await expect(
		(await renderedObject(reloaded, objects(reloaded, 'image'))).locator('img')
	).toHaveJSProperty('naturalWidth', 192);
	await attachWorkflow(testInfo, page, reloaded, 'presentation-object-manipulation', {
		objectTypes: ['text', 'image', 'rectangle', 'rounded-rectangle', 'ellipse', 'line', 'arrow'],
		imageShaFixtureBytes: (await readFile(imagePath)).byteLength
	});
});

test('aligns and distributes a negative line without losing its geometry', async ({
	page
}, testInfo) => {
	const pageErrors: string[] = [];
	page.on('pageerror', (error) => pageErrors.push(error.message));
	const fixture = await readFile(completeFixturePath, 'utf8');
	await page.getByTestId('welcome-new').click();
	await writeSourceContent(page, fixture);
	let editor = await openPresentation(page);
	let line = editor.locator(
		'[data-testid="slide-object"][data-object-type="line"][data-object-id="accent"]'
	);
	await selectObject(editor, line);
	await selectObject(editor, objects(editor, 'rectangle').first(), true);
	await selectObject(editor, objects(editor, 'rounded-rectangle').first(), true);
	for (const action of [
		'slide-align-left',
		'slide-align-right',
		'slide-align-center',
		'slide-distribute-horizontal'
	]) {
		await editor.getByTestId(action).click();
	}
	await editor.getByTestId('slide-undo').click();
	await editor.getByTestId('slide-redo').click();
	await selectObject(editor, line);
	const geometry = {
		x: Number(await editor.getByTestId('slide-prop-x').inputValue()),
		y: Number(await editor.getByTestId('slide-prop-y').inputValue()),
		width: Number(await editor.getByTestId('slide-prop-width').inputValue()),
		height: Number(await editor.getByTestId('slide-prop-height').inputValue())
	};
	expect(Math.min(geometry.x, geometry.x + geometry.width)).toBeGreaterThanOrEqual(0);
	expect(Math.max(geometry.x, geometry.x + geometry.width)).toBeLessThanOrEqual(960);
	expect(Math.min(geometry.y, geometry.y + geometry.height)).toBeGreaterThanOrEqual(0);
	expect(Math.max(geometry.y, geometry.y + geometry.height)).toBeLessThanOrEqual(720);
	await expectSaved(editor);
	await editor.getByTestId('slide-close').click();
	await page.reload();
	editor = await openPresentation(page);
	line = editor.locator(
		'[data-testid="slide-object"][data-object-type="line"][data-object-id="accent"]'
	);
	await selectObject(editor, line);
	await expect(editor.getByTestId('slide-prop-x')).toHaveValue(String(geometry.x));
	await expect(editor.getByTestId('slide-prop-y')).toHaveValue(String(geometry.y));
	await expect(editor.getByTestId('slide-prop-width')).toHaveValue(String(geometry.width));
	await expect(editor.getByTestId('slide-prop-height')).toHaveValue(String(geometry.height));
	expect(pageErrors).toEqual([]);
	await testInfo.attach('presentation-negative-line.json', {
		body: JSON.stringify(
			{
				fixture: 'e2e/fixtures/presentation-complete.md',
				actions: ['align-left', 'align-right', 'align-center', 'distribute-horizontal'],
				geometry,
				pageErrors
			},
			null,
			2
		),
		contentType: 'application/json'
	});
});

test('commits text once before applying the redo button', async ({ page }, testInfo) => {
	const editor = await openPresentation(page);
	let text = await addObject(editor, 'text');
	await text.dblclick();
	await editor.getByTestId('slide-text-editor').fill('Base text');
	await editor.getByTestId('slide-text-done').click();
	await text.dblclick();
	await editor.getByTestId('slide-text-editor').fill('Old redo candidate');
	await editor.getByTestId('slide-text-done').click();
	await editor.getByTestId('slide-undo').click();
	await expect(await renderedObject(editor, text)).toContainText('Base text');
	await expect(editor.getByTestId('slide-redo')).toBeEnabled();

	await text.dblclick();
	await editor.getByTestId('slide-text-editor').fill('Committed before redo');
	await editor.getByTestId('slide-redo').click();
	await expect(await renderedObject(editor, text)).toContainText('Committed before redo');
	await expect(await renderedObject(editor, text)).not.toContainText('Old redo candidate');
	await editor.getByTestId('slide-undo').click();
	await expect(await renderedObject(editor, text)).toContainText('Base text');
	await editor.getByTestId('slide-redo').click();
	await expect(await renderedObject(editor, text)).toContainText('Committed before redo');
	await expectSaved(editor);

	await editor.getByTestId('slide-close').click();
	await page.reload();
	const restored = await openPresentation(page);
	text = objects(restored, 'text');
	await expect(await renderedObject(restored, text)).toContainText('Committed before redo');
	await testInfo.attach('presentation-redo-text.json', {
		body: JSON.stringify(
			{
				action: 'slide-redo',
				finalText: 'Committed before redo',
				undoText: 'Base text',
				persistedAfterReload: true
			},
			null,
			2
		),
		contentType: 'application/json'
	});
});

test('applies selection, grouping, stacking, connector, and history commands', async ({
	page
}, testInfo) => {
	const editor = await openPresentation(page);
	const rectangle = await addObject(editor, 'rectangle');
	const ellipse = await addObject(editor, 'ellipse');
	const initialCount = await objects(editor).count();
	await selectObject(editor, rectangle);
	const beforeKeyboardMove = await rectangle.boundingBox();
	await page.keyboard.press('ArrowRight');
	await page.keyboard.press('ArrowDown');
	const afterKeyboardMove = await rectangle.boundingBox();
	expect(afterKeyboardMove!.x).toBeGreaterThan(beforeKeyboardMove!.x);
	expect(afterKeyboardMove!.y).toBeGreaterThan(beforeKeyboardMove!.y);

	await selectObject(editor, rectangle);
	await selectObject(editor, ellipse, true);
	await editor.getByTestId('slide-align-left').click();
	const aligned = await Promise.all([rectangle.boundingBox(), ellipse.boundingBox()]);
	expect(Math.abs(aligned[0]!.x - aligned[1]!.x)).toBeLessThanOrEqual(1);

	await editor.getByTestId('slide-connect').click();
	await expect(objects(editor, 'arrow')).toHaveCount(1);
	const detachedArrow = objects(editor, 'arrow').first();
	const rectangleId = await rectangle.getAttribute('data-object-id');
	const ellipseId = await ellipse.getAttribute('data-object-id');
	await selectObject(editor, detachedArrow);
	await expect(editor.getByTestId('slide-prop-startId')).toHaveValue(rectangleId ?? '');
	await expect(editor.getByTestId('slide-prop-endId')).toHaveValue(ellipseId ?? '');
	const detachedBefore = await detachedArrow.boundingBox();
	await page.keyboard.press('ArrowRight');
	await page.keyboard.press('ArrowDown');
	const detachedAfter = await detachedArrow.boundingBox();
	expect(detachedAfter!.x).toBeGreaterThan(detachedBefore!.x);
	expect(detachedAfter!.y).toBeGreaterThan(detachedBefore!.y);
	await expect(editor.getByTestId('slide-prop-startId')).toHaveValue('');
	await expect(editor.getByTestId('slide-prop-endId')).toHaveValue('');

	await selectObject(editor, rectangle);
	await selectObject(editor, ellipse, true);
	await editor.getByTestId('slide-connect').click();
	await expect(objects(editor, 'arrow')).toHaveCount(2);
	const arrow = objects(editor, 'arrow').last();
	await selectObject(editor, arrow);
	await expect(editor.getByTestId('slide-prop-startId')).toHaveValue(rectangleId ?? '');
	await expect(editor.getByTestId('slide-prop-endId')).toHaveValue(ellipseId ?? '');
	const arrowBefore = await arrow.boundingBox();
	await selectObject(editor, rectangle);
	await editor.getByTestId('slide-front').click();
	await dragBy(page, rectangle, 80, 30);
	const arrowAfter = await arrow.boundingBox();
	expect(arrowAfter).not.toEqual(arrowBefore);
	await selectObject(editor, arrow);
	await expect(editor.getByTestId('slide-prop-startId')).toHaveValue(rectangleId ?? '');
	await expect(editor.getByTestId('slide-prop-endId')).toHaveValue(ellipseId ?? '');
	await selectObject(editor, detachedArrow);
	await editor.getByTestId('slide-delete').click();
	await expect(objects(editor, 'arrow')).toHaveCount(1);

	await selectObject(editor, rectangle);
	await selectObject(editor, ellipse, true);
	await editor.getByTestId('slide-group').click();
	const groupedBefore = await Promise.all([rectangle.boundingBox(), ellipse.boundingBox()]);
	await dragBy(page, rectangle, 65, 40);
	const groupedAfter = await Promise.all([rectangle.boundingBox(), ellipse.boundingBox()]);
	for (let index = 0; index < 2; index++) {
		expect(groupedAfter[index]!.x - groupedBefore[index]!.x).toBeGreaterThan(35);
		expect(groupedAfter[index]!.y - groupedBefore[index]!.y).toBeGreaterThan(20);
	}
	await editor.getByTestId('slide-ungroup').click();
	const ellipseBeforeUngroupedDrag = await ellipse.boundingBox();
	await selectObject(editor, rectangle);
	await editor.getByTestId('slide-front').click();
	await dragBy(page, rectangle, 30, 18);
	const ellipseAfterUngroupedDrag = await ellipse.boundingBox();
	expect(ellipseAfterUngroupedDrag).toEqual(ellipseBeforeUngroupedDrag);

	await selectObject(editor, ellipse);
	await setProperty(editor, 'slide-prop-x', '200');
	await setProperty(editor, 'slide-prop-y', '150');
	await selectObject(editor, rectangle);
	await setProperty(editor, 'slide-prop-x', '200');
	await setProperty(editor, 'slide-prop-y', '150');
	await editor.getByTestId('slide-front').click();
	const overlap = await rectangle.boundingBox();
	const topId = await page.evaluate(
		({ x, y }) =>
			(
				document.elementsFromPoint(x, y).find((node) => node.hasAttribute('data-object-id')) as
					HTMLElement | undefined
			)?.dataset.objectId,
		{ x: overlap!.x + overlap!.width / 2, y: overlap!.y + overlap!.height / 2 }
	);
	expect(topId).toBe(rectangleId);
	await editor.getByTestId('slide-back').click();
	const topAfterBack = await page.evaluate(
		({ x, y, candidates }) =>
			(
				document
					.elementsFromPoint(x, y)
					.find((node) => candidates.includes((node as HTMLElement).dataset.objectId ?? '')) as
					HTMLElement | undefined
			)?.dataset.objectId,
		{
			x: overlap!.x + overlap!.width / 2,
			y: overlap!.y + overlap!.height / 2,
			candidates: [rectangleId, ellipseId]
		}
	);
	expect(topAfterBack).toBe(ellipseId);

	await selectObject(editor, rectangle);
	await page.keyboard.press('ControlOrMeta+c');
	await page.keyboard.press('ControlOrMeta+v');
	await expect(objects(editor)).toHaveCount(initialCount + 2);
	await expect(objects(editor, 'rectangle')).toHaveCount(2);
	await page.keyboard.press('ControlOrMeta+x');
	await expect(objects(editor)).toHaveCount(initialCount + 1);
	await expect(objects(editor, 'rectangle')).toHaveCount(1);
	await page.keyboard.press('ControlOrMeta+v');
	await expect(objects(editor)).toHaveCount(initialCount + 2);
	await expect(objects(editor, 'rectangle')).toHaveCount(2);
	await editor.getByTestId('slide-duplicate').click();
	await expect(objects(editor)).toHaveCount(initialCount + 3);
	await page.keyboard.press('Delete');
	await expect(objects(editor)).toHaveCount(initialCount + 2);
	await editor.getByTestId('slide-undo').click();
	await expect(objects(editor)).toHaveCount(initialCount + 3);
	await editor.getByTestId('slide-redo').click();
	await expect(objects(editor)).toHaveCount(initialCount + 2);

	await selectObject(editor, rectangle);
	await editor.getByTestId('slide-copy').click();
	await editor.getByTestId('slide-paste').click();
	await expect(objects(editor)).toHaveCount(initialCount + 3);
	await editor.getByTestId('slide-delete').click();
	await expect(objects(editor)).toHaveCount(initialCount + 2);

	await attachWorkflow(testInfo, page, editor, 'presentation-selection-commands', {
		connectedObjectIds: [rectangleId, ellipseId],
		finalObjectCount: initialCount + 2
	});
});

test('plays the deck with the keyboard and has no blocking accessibility violations', async ({
	page
}, testInfo) => {
	const editor = await openPresentation(page);
	let text = await addObject(editor, 'text');
	await text.dblclick();
	await editor
		.getByTestId('slide-text-editor')
		.fill('# Opening slide\n\n[Documentation](https://example.invalid/slides)');
	await editor.getByTestId('slide-text-done').click();
	await editor.getByTestId('slide-notes').fill('This note must stay private.');
	await editor.getByTestId('slide-add').click();
	text = await addObject(editor, 'text');
	await text.dblclick();
	await editor.getByTestId('slide-text-editor').fill('# Closing slide');
	await editor.getByTestId('slide-text-done').click();
	await editor.getByTestId('slide-thumbnail').first().click();

	const axe = await new AxeBuilder({ page })
		.include('[data-testid="presentation-editor"]')
		.analyze();
	await testInfo.attach('presentation-editor-axe.json', {
		body: JSON.stringify(axe, null, 2),
		contentType: 'application/json'
	});
	const blocking = axe.violations.filter(
		(violation) => violation.impact === 'critical' || violation.impact === 'serious'
	);
	expect(blocking, violationSummary(blocking)).toEqual([]);
	await expect(editor.getByRole('link', { name: 'Documentation' })).toHaveCount(1);

	await editor.getByTestId('slide-thumbnail').first().click();
	await editor.getByTestId('slide-present').click();
	await expect(page.getByText('Opening slide', { exact: true }).last()).toBeVisible();
	const presentationLink = page.getByRole('link', { name: 'Documentation' });
	await expect(presentationLink).toHaveCount(1);
	await presentationLink.focus();
	await expect(presentationLink).toBeFocused();
	await expect(page.getByText('This note must stay private.')).toBeHidden();
	await page.getByTestId('slide-present-notes').click();
	await expect(page.getByText('This note must stay private.', { exact: true })).toBeVisible();
	await page.getByTestId('slide-present-notes').click();
	await expect(page.getByText('This note must stay private.')).toBeHidden();
	await page.keyboard.press('ArrowRight');
	await expect(page.getByText('Closing slide', { exact: true }).last()).toBeVisible();
	await page.keyboard.press('Home');
	await expect(page.getByText('Opening slide', { exact: true }).last()).toBeVisible();
	await page.keyboard.press('End');
	await expect(page.getByText('Closing slide', { exact: true }).last()).toBeVisible();
	await page.getByTestId('slide-present-exit').click();
	await expect(editor.getByTestId('slide-canvas')).toBeVisible();
	await attachWorkflow(testInfo, page, editor, 'presentation-playback-accessibility', {
		slideCount: 2,
		blockingAxeViolations: 0
	});
});

test('announces selection changes and restores focus after close', async ({ page }, testInfo) => {
	const trigger = page.getByTestId('slides-open');
	await trigger.focus();
	await trigger.click();
	const editor = page.getByTestId('presentation-editor');
	await expect(editor).toBeVisible({ timeout: 15_000 });

	const text = await addObject(editor, 'text');
	await expect(editor.getByTestId('slide-selection-status')).toContainText('Text');
	const rectangle = await addObject(editor, 'rectangle');
	await expect(editor.getByTestId('slide-selection-status')).toContainText('Rectangle');
	await selectObject(editor, text, true);
	await expect(editor.getByTestId('slide-selection-status')).toContainText('2 object(s) selected');
	await expect(rectangle).toHaveAttribute('aria-pressed', 'true');

	await attachWorkflow(testInfo, page, editor, 'presentation-selection-announcement', {
		announcedTypes: ['Text', 'Rectangle'],
		multiSelectionCount: 2,
		focusRestored: true
	});
	await editor.getByTestId('slide-close').click();
	await expect(trigger).toBeFocused();
});

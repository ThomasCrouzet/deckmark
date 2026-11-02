import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resetAppState } from './helpers';
import {
	importMarkdown,
	openPresentationSource,
	presentationFixture,
	waitForPresentation
} from './presentation-helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

const imagePath = resolve('static/pwa-192x192.png');
const deckSource = presentationFixture(['# Review opening', '# Review closing']);
const imageObjects = (editor: Locator) =>
	editor.locator('[data-testid="slide-object"][data-object-type="image"]');

type DecodeGate = { entered: boolean; finished: boolean; release: () => void };

// Pause one real bitmap decode after it succeeds. This fixes the interleaving
// without replacing the image data, decoded dimensions, or editor operations.
async function holdImageDecode(page: Page): Promise<void> {
	await page.evaluate(() => {
		const target = window as typeof window & { reviewDecodeGate?: DecodeGate };
		const decode = window.createImageBitmap.bind(window);
		let release = () => {};
		const gate = new Promise<void>((resolve) => (release = resolve));
		const state: DecodeGate = { entered: false, finished: false, release };
		target.reviewDecodeGate = state;
		window.createImageBitmap = async (...args: Parameters<typeof createImageBitmap>) => {
			const bitmap = await decode(...args);
			window.createImageBitmap = decode;
			state.entered = true;
			await gate;
			state.finished = true;
			return bitmap;
		};
	});
}

async function startHeldImage(page: Page, editor: Locator): Promise<void> {
	await holdImageDecode(page);
	await editor.getByTestId('slide-image-input').setInputFiles(imagePath);
	await expect
		.poll(() =>
			page.evaluate(
				() => (window as typeof window & { reviewDecodeGate: DecodeGate }).reviewDecodeGate.entered
			)
		)
		.toBe(true);
}

async function releaseImage(page: Page): Promise<void> {
	await page.evaluate(async () => {
		const gate = (window as typeof window & { reviewDecodeGate: DecodeGate }).reviewDecodeGate;
		gate.release();
		// Let the decoded image reach the editor and let Svelte paint the result.
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
		);
	});
	await expect
		.poll(() =>
			page.evaluate(
				() => (window as typeof window & { reviewDecodeGate: DecodeGate }).reviewDecodeGate.finished
			)
		)
		.toBe(true);
}

async function source(editor: Locator): Promise<string> {
	await openPresentationSource(editor);
	const value = await editor.getByTestId('slide-source-editor').inputValue();
	await editor.getByTestId('slide-source-cancel').click();
	return value;
}

async function dropFiles(
	page: Page,
	files: Array<{ name: string; type: string; base64: string }>
): Promise<void> {
	const transfer = await page.evaluateHandle((entries) => {
		const data = new DataTransfer();
		for (const entry of entries) {
			const bytes = Uint8Array.from(atob(entry.base64), (character) => character.charCodeAt(0));
			data.items.add(new File([bytes], entry.name, { type: entry.type }));
		}
		return data;
	}, files);
	try {
		// An OS drag first crosses the toolbar, then ends on the slide canvas.
		await page.locator('#app-toolbar').dispatchEvent('dragover', { dataTransfer: transfer });
		await expect(page.locator('main .pointer-events-none.border-dashed')).toBeVisible();
		await page.locator('.slide-viewport').dispatchEvent('dragover', { dataTransfer: transfer });
		await page.locator('.slide-viewport').dispatchEvent('drop', { dataTransfer: transfer });
	} finally {
		await transfer.dispose();
	}
}

test.beforeEach(async ({ page }) => {
	await resetAppState(page);
	await page.evaluate(() => localStorage.setItem('mdsh:locale', 'en'));
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	await importMarkdown(page, deckSource, 'Review-A.md');
	await waitForPresentation(page);
});

test.afterEach(async ({ page }, testInfo) => {
	await testInfo.attach('review-state.png', {
		body: await page.screenshot({ fullPage: true }),
		contentType: 'image/png'
	});
	await testInfo.attach('review-result.json', {
		body: JSON.stringify({
			test: testInfo.title,
			status: testInfo.status,
			project: testInfo.project.name,
			command:
				process.env.REVIEW_COMMAND ??
				'npx playwright test e2e/presentation-review.spec.ts --project=chromium --workers=1',
			metadata: testInfo.config.metadata,
			fixtures: {
				deckSource,
				image: 'static/pwa-192x192.png',
				decodeGate: 'One real createImageBitmap result held until the specified UI action completes'
			}
		}),
		contentType: 'application/json'
	});
});

test('a disposed image request cannot replace newer edits after file navigation', async ({
	page
}, testInfo) => {
	let editor = await waitForPresentation(page);
	await startHeldImage(page, editor);
	await importMarkdown(page, presentationFixture(['# Other deck']), 'Review-B.md');
	await page.locator('#files-panel button[data-file-id]').filter({ hasText: 'Review-A' }).click();
	editor = await waitForPresentation(page);
	await editor.getByTestId('slide-notes').fill('New notes after returning to A');
	await editor.getByTestId('slide-notes').press('Tab');
	const latest = await source(editor);
	await releaseImage(page);
	await expect(editor.getByTestId('slide-notes')).toHaveValue('New notes after returning to A');
	await expect(imageObjects(editor)).toHaveCount(0);
	expect(await source(editor)).toBe(latest);
	await testInfo.attach('latest-deck.md', { body: latest, contentType: 'text/markdown' });
});

test('a delayed image cannot move to another slide', async ({ page }, testInfo) => {
	const editor = await waitForPresentation(page);
	await startHeldImage(page, editor);
	await editor.getByTestId('slide-thumbnail').last().click();
	await releaseImage(page);
	await expect(imageObjects(editor)).toHaveCount(0);
	await editor.getByTestId('slide-thumbnail').first().click();
	await expect(imageObjects(editor)).toHaveCount(0);
	const actual = await source(editor);
	expect(actual).toBe(deckSource);
	await testInfo.attach('unchanged-deck.md', { body: actual, contentType: 'text/markdown' });
});

test('a delayed image cannot modify a replaced source revision', async ({ page }, testInfo) => {
	const editor = await waitForPresentation(page);
	await startHeldImage(page, editor);
	const replacement = presentationFixture(['# Replacement source', '# Review closing']);
	await openPresentationSource(editor);
	await editor.getByTestId('slide-source-editor').fill(replacement);
	await editor.getByTestId('slide-source-apply').click();
	await releaseImage(page);
	await expect(imageObjects(editor)).toHaveCount(0);
	expect(await source(editor)).toBe(replacement);
	await testInfo.attach('replacement-deck.md', { body: replacement, contentType: 'text/markdown' });
});

test('an unchanged image batch inserts every image and survives reload', async ({
	page
}, testInfo) => {
	const editor = await waitForPresentation(page);
	await editor.getByTestId('slide-image-input').setInputFiles([imagePath, imagePath]);
	await expect(imageObjects(editor)).toHaveCount(2);
	await expect(editor.locator('.save-state')).toHaveText('saved');
	const actual = await source(editor);
	await page.reload();
	await expect(imageObjects(await waitForPresentation(page))).toHaveCount(2);
	expect(await source(editor)).toBe(actual);
	await testInfo.attach('image-batch.md', { body: actual, contentType: 'text/markdown' });
});

test('a Markdown drop on the slide canvas imports the note and clears the overlay', async ({
	page
}) => {
	await dropFiles(page, [
		{
			name: 'Dropped.md',
			type: 'text/markdown',
			base64: Buffer.from('# Dropped note').toString('base64')
		}
	]);
	await page.getByRole('button', { name: 'Close import report', exact: true }).click();
	await expect(page.locator('.cm-content')).toContainText('# Dropped note');
	await expect(page.locator('main .pointer-events-none.border-dashed')).toHaveCount(0);
	await page.locator('#files-panel button[data-file-id]').filter({ hasText: 'Review-A' }).click();
	expect(await source(await waitForPresentation(page))).toBe(deckSource);
});

test('an image drop inserts once and clears the toolbar-to-canvas overlay', async ({ page }) => {
	await dropFiles(page, [
		{
			name: 'Review.png',
			type: 'image/png',
			base64: (await readFile(imagePath)).toString('base64')
		}
	]);
	await expect(imageObjects(await waitForPresentation(page))).toHaveCount(1);
	await expect(page.locator('main .pointer-events-none.border-dashed')).toHaveCount(0);
	await expect(page.locator('#files-panel button[data-file-id]')).toHaveCount(1);
	await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a mixed canvas drop imports Markdown and appends its image without changing the deck', async ({
	page
}) => {
	await dropFiles(page, [
		{
			name: 'Mixed.md',
			type: 'text/markdown',
			base64: Buffer.from('# Mixed note').toString('base64')
		},
		{
			name: 'Review.png',
			type: 'image/png',
			base64: (await readFile(imagePath)).toString('base64')
		}
	]);
	await page.getByRole('button', { name: 'Close import report', exact: true }).click();
	await expect(page.locator('.cm-content')).toContainText('# Mixed note');
	await expect(page.locator('.cm-content')).toContainText('![Review](');
	await expect(page.locator('main .pointer-events-none.border-dashed')).toHaveCount(0);
	await page.locator('#files-panel button[data-file-id]').filter({ hasText: 'Review-A' }).click();
	expect(await source(await waitForPresentation(page))).toBe(deckSource);
});

test('slide text keeps Bold and Italic precedence and Sidebar works outside text', async ({
	page
}, testInfo) => {
	const editor = await waitForPresentation(page);
	await editor.getByTestId('slide-object').dblclick();
	const input = editor.getByTestId('slide-text-editor');
	await input.fill('Selected words');
	await input.selectText();
	await input.press('ControlOrMeta+b');
	await expect(input).toHaveValue('**Selected words**');
	await input.press('ControlOrMeta+i');
	await expect(input).toHaveValue('***Selected words***');
	await input.press('Escape');
	await expect(page.locator('#files-panel')).not.toHaveAttribute('inert');
	await editor.press('ControlOrMeta+b');
	await expect(page.locator('#files-panel')).toHaveAttribute('inert');
	await editor.press('ControlOrMeta+b');
	await expect(page.locator('#files-panel')).not.toHaveAttribute('inert');
	const actual = await source(editor);
	expect(actual).toContain('***Selected words***');
	await testInfo.attach('formatted-deck.md', { body: actual, contentType: 'text/markdown' });
});

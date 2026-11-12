import { expect, test, type Locator, type Page } from '@playwright/test';
import { resetAppState } from './helpers';
import { createPresentation } from './presentation-helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

async function resetEnglishApp(page: Page): Promise<void> {
	await resetAppState(page);
	await page.evaluate(() => localStorage.setItem('mdsh:locale', 'en'));
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
}

async function editorWidth(editor: Locator): Promise<number> {
	return editor.evaluate((element) => element.getBoundingClientRect().width);
}

async function state(editor: Locator, page: Page) {
	const inspector = editor.getByTestId('slide-inspector');
	const toggle = editor.getByTestId('slide-properties');
	return {
		width: Math.round(await editorWidth(editor)),
		viewport: await page.evaluate(() => window.innerWidth),
		inspector: await inspector.count(),
		pressed: await toggle.getAttribute('aria-pressed'),
		active: await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? '')
	};
}

test('reconciles the properties inspector with the editor width on live resize', async ({
	page
}, info) => {
	await page.setViewportSize({ width: 900, height: 800 });
	await resetEnglishApp(page);
	await expect(page.locator('#files-panel')).toBeVisible();
	const editor = await createPresentation(page);
	const inspector = editor.getByTestId('slide-inspector');
	const toggle = editor.getByTestId('slide-properties');
	const evidence = [await state(editor, page)];

	// The usable editor width is below the 800 px side-panel breakpoint, so the
	// inspector starts closed even though the outer window is wider than 768 px.
	await expect.poll(() => editorWidth(editor)).toBeLessThan(800);
	await expect(inspector).toHaveCount(0);
	await expect(toggle).toHaveAttribute('aria-pressed', 'false');

	// Widen the same open deck. No reload is involved.
	await page.setViewportSize({ width: 1500, height: 800 });
	await expect.poll(() => editorWidth(editor)).toBeGreaterThan(800);
	await expect(inspector).toBeVisible();
	await expect(toggle).toHaveAttribute('aria-pressed', 'true');
	evidence.push(await state(editor, page));

	// Narrow again: the automatic choice closes the side panel.
	await page.setViewportSize({ width: 900, height: 800 });
	await expect.poll(() => editorWidth(editor)).toBeLessThan(800);
	await expect(inspector).toHaveCount(0);
	await expect(toggle).toHaveAttribute('aria-pressed', 'false');
	evidence.push(await state(editor, page));

	// An explicit close on a wide editor survives later resizes.
	await page.setViewportSize({ width: 1500, height: 800 });
	await expect(inspector).toBeVisible();
	await toggle.click();
	await expect(inspector).toHaveCount(0);
	await page.setViewportSize({ width: 900, height: 800 });
	await expect(inspector).toHaveCount(0);
	await page.setViewportSize({ width: 1500, height: 800 });
	await expect(inspector).toHaveCount(0);
	await expect(toggle).toHaveAttribute('aria-pressed', 'false');

	// An explicit open on a narrow editor survives later resizes and stays
	// dismissable while it covers the canvas.
	await page.setViewportSize({ width: 900, height: 800 });
	await expect.poll(() => editorWidth(editor)).toBeLessThan(800);
	await toggle.click();
	await expect(inspector).toBeVisible();
	const close = inspector.getByRole('button', { name: 'Close', exact: true });
	await expect(close).toBeVisible();
	const overlay = await inspector.boundingBox();
	const root = await editor.boundingBox();
	expect(overlay).not.toBeNull();
	expect(root).not.toBeNull();
	expect(overlay!.y).toBeGreaterThanOrEqual(root!.y - 1);
	expect(overlay!.y + overlay!.height).toBeLessThanOrEqual(root!.y + root!.height + 1);
	await page.setViewportSize({ width: 1500, height: 800 });
	await expect(inspector).toBeVisible();
	await page.setViewportSize({ width: 900, height: 800 });
	await expect(inspector).toBeVisible();
	await expect(close).toBeVisible();
	evidence.push(await state(editor, page));

	// Focus stays in the open inspector across a resize.
	await close.focus();
	await page.setViewportSize({ width: 1500, height: 800 });
	await expect(close).toBeFocused();
	evidence.push(await state(editor, page));

	await info.attach('presentation-inspector-width.json', {
		body: JSON.stringify(
			{
				command:
					'npx playwright test e2e/presentation-inspector-width.spec.ts --project=chromium --workers=1 --retries=0',
				breakpoint: 800,
				sidebar: 'open',
				cases: evidence
			},
			null,
			2
		),
		contentType: 'application/json'
	});
	await info.attach('presentation-inspector-width.png', {
		body: await page.screenshot({ fullPage: true }),
		contentType: 'image/png'
	});
});

import { writeFile } from 'node:fs/promises';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { resetAppState } from './helpers';
import { createPresentation } from './presentation-helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

async function resetEnglishApp(page: Page, sidebar?: 'open' | 'closed'): Promise<void> {
	await resetAppState(page);
	await page.evaluate((savedSidebar) => {
		localStorage.setItem('mdsh:locale', 'en');
		if (savedSidebar) localStorage.setItem('mdsh:sidebar', savedSidebar);
	}, sidebar);
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

type Box = { x: number; y: number; width: number; height: number };

async function boxOf(locator: Locator): Promise<Box | null> {
	const box = await locator.boundingBox();
	return box
		? {
				x: Math.round(box.x),
				y: Math.round(box.y),
				width: Math.round(box.width),
				height: Math.round(box.height)
			}
		: null;
}

async function snapshot(editor: Locator, page: Page, step: string) {
	const inspector = editor.getByTestId('slide-inspector');
	const toggle = editor.getByTestId('slide-properties');
	const object = editor.getByTestId('slide-object').first();
	const hasInspector = (await inspector.count()) > 0;
	const hasObject = (await object.count()) > 0;
	return {
		step,
		viewport: await page.evaluate(() => ({
			width: window.innerWidth,
			height: window.innerHeight
		})),
		editor: await boxOf(editor),
		sidebarHidden: (await page.locator('#files-panel').getAttribute('aria-hidden')) === 'true',
		sidebarExpanded: await page
			.locator('#app-toolbar button[aria-controls="files-panel"]:visible')
			.getAttribute('aria-expanded'),
		inspector: hasInspector ? await boxOf(inspector) : null,
		togglePressed: await toggle.getAttribute('aria-pressed'),
		active: await page.evaluate(() => {
			const element = document.activeElement as HTMLElement | null;
			return (
				element?.getAttribute('data-testid') ??
				element?.getAttribute('aria-label') ??
				element?.textContent?.trim().slice(0, 40) ??
				element?.tagName ??
				null
			);
		}),
		selected: hasObject
			? {
					id: await object.getAttribute('data-object-id'),
					pressed: await object.getAttribute('aria-pressed')
				}
			: null,
		selectionStatus: await editor.getByTestId('slide-selection-status').textContent()
	};
}

async function assertReachable(control: Locator, label: string): Promise<void> {
	await expect(control, label).toBeVisible();
	await control.scrollIntoViewIfNeeded();
	const reachable = await control.evaluate((element) => {
		const rect = element.getBoundingClientRect();
		const x = rect.left + rect.width / 2;
		const y = rect.top + rect.height / 2;
		if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return false;
		const hit = document.elementFromPoint(x, y);
		return hit === element || element.contains(hit);
	});
	expect(reachable, `${label} must be the hit target at its centre`).toBe(true);
}

async function attachEvidence(
	info: TestInfo,
	name: string,
	payload: unknown,
	page: Page
): Promise<void> {
	const jsonPath = info.outputPath(`${name}.json`);
	await writeFile(jsonPath, JSON.stringify(payload, null, 2));
	await info.attach(`${name}.json`, { path: jsonPath, contentType: 'application/json' });
	const screenshotPath = info.outputPath(`${name}.png`);
	await page.screenshot({ path: screenshotPath, fullPage: true });
	await info.attach(`${name}.png`, { path: screenshotPath, contentType: 'image/png' });
}

async function capture(page: Page, info: TestInfo, name: string): Promise<void> {
	const path = info.outputPath(`${name}.png`);
	await page.screenshot({ path, fullPage: true });
	await info.attach(`${name}.png`, { path, contentType: 'image/png' });
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

test('chooses the inspector default from the usable editor width with the sidebar open or closed', async ({
	page
}, info) => {
	await page.setViewportSize({ width: 960, height: 800 });
	await resetEnglishApp(page, 'closed');
	const sidebar = page.locator('#files-panel');
	await expect(sidebar).toBeHidden();
	const editor = await createPresentation(page);
	const inspector = editor.getByTestId('slide-inspector');
	const toggle = editor.getByTestId('slide-properties');
	const sidebarToggle = page.locator('#app-toolbar button[aria-controls="files-panel"]:visible');
	const evidence = [await snapshot(editor, page, 'sidebar-closed')];

	// The window is wider than the 768 px window rule. The closed sidebar leaves
	// a usable editor width above 800 px, so the side inspector starts open.
	await expect.poll(() => editorWidth(editor)).toBeGreaterThan(800);
	await expect(inspector).toBeVisible();
	await expect(toggle).toHaveAttribute('aria-pressed', 'true');
	await expect(sidebarToggle).toHaveAttribute('aria-expanded', 'false');
	await capture(page, info, 'inspector-sidebar-closed');

	// Opening the sidebar narrows the editor below 800 px. The same window now
	// chooses the closed inspector even though its outer width did not change.
	await sidebarToggle.click();
	await expect(sidebar).toBeVisible();
	await expect(sidebarToggle).toHaveAttribute('aria-expanded', 'true');
	await expect.poll(() => editorWidth(editor)).toBeLessThan(800);
	await expect(inspector).toHaveCount(0);
	await expect(toggle).toHaveAttribute('aria-pressed', 'false');
	await expect(editor.getByTestId('slide-add-text')).toBeVisible();
	evidence.push(await snapshot(editor, page, 'sidebar-open'));
	await capture(page, info, 'inspector-sidebar-open');

	// Closing the sidebar restores the usable width and the automatic default.
	await sidebarToggle.click();
	await expect(sidebar).toBeHidden();
	await expect(sidebarToggle).toHaveAttribute('aria-expanded', 'false');
	await expect.poll(() => editorWidth(editor)).toBeGreaterThan(800);
	await expect(inspector).toBeVisible();
	await expect(toggle).toHaveAttribute('aria-pressed', 'true');
	evidence.push(await snapshot(editor, page, 'sidebar-closed-again'));
	await capture(page, info, 'inspector-sidebar-closed-again');

	await attachEvidence(
		info,
		'presentation-inspector-sidebar',
		{
			command:
				'npx playwright test e2e/presentation-inspector-width.spec.ts --project=chromium --workers=1 --retries=0',
			source: info.config.metadata.source,
			sourceTree: info.config.metadata.sourceTree,
			workingDiffSha256: info.config.metadata.workingDiffSha256,
			environment: info.config.metadata.environment,
			browser: `${info.project.name} ${page.context().browser()?.version() ?? ''}`.trim(),
			simulation: 'desktop Chromium viewport, not an iPad or a native window',
			breakpoint: 800,
			cases: evidence
		},
		page
	);
});

test('keeps the toolbar and the selected object usable while the inspector changes', async ({
	page
}, info) => {
	test.setTimeout(60_000);
	await page.setViewportSize({ width: 960, height: 800 });
	await resetEnglishApp(page, 'open');
	const editor = await createPresentation(page);
	const inspector = editor.getByTestId('slide-inspector');
	const toggle = editor.getByTestId('slide-properties');
	const close = inspector.getByRole('button', { name: 'Close', exact: true });
	const canvas = editor.getByTestId('slide-canvas');
	const object = editor.getByTestId('slide-object').first();
	const selectionStatus = editor.getByTestId('slide-selection-status');
	const toolbar: Array<[Locator, string]> = [
		[editor.getByTestId('slide-add-text'), 'add text'],
		[editor.getByTestId('slide-export'), 'export'],
		[editor.getByTestId('slide-notes-toggle'), 'notes'],
		[editor.getByTestId('slide-present'), 'present'],
		[editor.getByTestId('slide-properties'), 'properties']
	];
	const evidence = [];

	// The sidebar holds the editor below 800 px, so a deck starts with an
	// overlay-capable width and the automatic inspector closed.
	await expect.poll(() => editorWidth(editor)).toBeLessThan(800);
	await expect(inspector).toHaveCount(0);

	await editor.getByTestId('slide-add-text').click();
	await expect(object).toHaveCount(1);
	await expect(object).toHaveAttribute('aria-pressed', 'true');
	const objectId = await object.getAttribute('data-object-id');
	const selectedStatus = await selectionStatus.textContent();
	expect(selectedStatus).toContain('Slide 1');
	evidence.push(await snapshot(editor, page, 'narrow-inspector-closed'));
	await capture(page, info, 'inspector-narrow-closed');

	// The explicit overlay must stay inside the editor, keep a real dismiss
	// action and keep the toolbar hit targets. The overlay can cover the canvas
	// only because this reachable dismiss action exists.
	await toggle.click();
	await expect(inspector).toBeVisible();
	await expect(close).toBeVisible();
	await assertReachable(close, 'inspector close');
	for (const [control, label] of toolbar) await assertReachable(control, label);
	const overlay = await boxOf(inspector);
	const root = await boxOf(editor);
	const header = await boxOf(editor.locator('.presentation-header'));
	expect(overlay).not.toBeNull();
	expect(root).not.toBeNull();
	expect(header).not.toBeNull();
	expect(overlay!.y).toBeGreaterThanOrEqual(header!.y + header!.height - 1);
	expect(overlay!.y).toBeGreaterThanOrEqual(root!.y - 1);
	expect(overlay!.y + overlay!.height).toBeLessThanOrEqual(root!.y + root!.height + 1);
	await expect(object).toHaveAttribute('aria-pressed', 'true');
	expect(await selectionStatus.textContent()).toBe(selectedStatus);
	evidence.push(await snapshot(editor, page, 'narrow-overlay-open'));
	await capture(page, info, 'inspector-overlay-open');

	// A wide window turns the overlay into a side panel without a reload. The
	// focused control, the selected object and its status must stay stable.
	await close.focus();
	await expect(close).toBeFocused();
	await page.setViewportSize({ width: 1500, height: 800 });
	await expect.poll(() => editorWidth(editor)).toBeGreaterThan(800);
	await expect(inspector).toBeVisible();
	await expect(close).toBeFocused();
	await expect(object).toHaveAttribute('aria-pressed', 'true');
	expect(await selectionStatus.textContent()).toBe(selectedStatus);
	for (const [control, label] of toolbar) await assertReachable(control, label);
	evidence.push(await snapshot(editor, page, 'wide-side-panel-open'));
	await capture(page, info, 'inspector-side-panel-open');

	// A 720 px viewport stands in for a narrow window. The sidebar collapses to
	// a closed drawer. The explicit open preference must survive that change.
	await page.setViewportSize({ width: 720, height: 800 });
	await expect.poll(() => editorWidth(editor)).toBeLessThan(800);
	const drawer = page.locator('#files-panel');
	const drawerToggle = page.locator('#app-toolbar button[aria-controls="files-panel"]:visible');
	await expect(drawer).toHaveAttribute('aria-hidden', 'true');
	await expect(drawerToggle).toHaveAttribute('aria-expanded', 'false');
	await expect(inspector).toBeVisible();
	await expect(close).toBeVisible();
	await assertReachable(close, 'inspector close');
	for (const [control, label] of toolbar) await assertReachable(control, label);
	await expect(object).toHaveAttribute('aria-pressed', 'true');
	expect(await selectionStatus.textContent()).toBe(selectedStatus);
	evidence.push(await snapshot(editor, page, 'narrow-drawer-closed'));
	await capture(page, info, 'inspector-narrow-drawer-closed');

	// An explicit dismiss returns focus to the toggle and keeps the selection.
	await close.focus();
	await close.click();
	await expect(inspector).toHaveCount(0);
	await expect(toggle).toHaveAttribute('aria-pressed', 'false');
	await expect(toggle).toBeFocused();
	await assertReachable(canvas, 'canvas after dismiss');
	await expect(object).toHaveAttribute('aria-pressed', 'true');
	expect(await selectionStatus.textContent()).toBe(selectedStatus);
	evidence.push(await snapshot(editor, page, 'explicit-close'));
	await capture(page, info, 'inspector-explicit-close');

	// The explicit closed preference survives later wide and narrow resizes.
	await page.setViewportSize({ width: 1500, height: 800 });
	await expect(inspector).toHaveCount(0);
	await expect(toggle).toHaveAttribute('aria-pressed', 'false');
	await page.setViewportSize({ width: 900, height: 800 });
	await expect(inspector).toHaveCount(0);
	await expect(toggle).toHaveAttribute('aria-pressed', 'false');
	evidence.push(await snapshot(editor, page, 'closed-after-resizes'));

	expect(await object.getAttribute('data-object-id')).toBe(objectId);
	await attachEvidence(
		info,
		'presentation-inspector-toolbar-selection',
		{
			command:
				'npx playwright test e2e/presentation-inspector-width.spec.ts --project=chromium --workers=1 --retries=0',
			source: info.config.metadata.source,
			sourceTree: info.config.metadata.sourceTree,
			workingDiffSha256: info.config.metadata.workingDiffSha256,
			environment: info.config.metadata.environment,
			browser: `${info.project.name} ${page.context().browser()?.version() ?? ''}`.trim(),
			simulation: 'desktop Chromium viewport, not an iPad, a native window or platform zoom',
			breakpoint: 800,
			cases: evidence
		},
		page
	);
});

import { expect, test, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { resetAppState } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

async function resetEnglishApp(page: Page): Promise<void> {
	await resetAppState(page);
	await page.evaluate(() => localStorage.setItem('mdsh:locale', 'en'));
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
}

async function touchDrag(page: Page, locator: Locator, dx: number, dy: number): Promise<void> {
	const box = await locator.boundingBox();
	if (!box) throw new Error('The touch target is not visible.');
	await locator.evaluate(
		(target, movement) => {
			const startX = movement.x + movement.width / 2;
			const startY = movement.y + movement.height / 2;
			const event = (type: string, clientX: number, clientY: number) =>
				new PointerEvent(type, {
					bubbles: true,
					cancelable: true,
					pointerId: 19,
					pointerType: 'touch',
					isPrimary: true,
					buttons: type === 'pointerup' ? 0 : 1,
					clientX,
					clientY
				});
			target.dispatchEvent(event('pointerdown', startX, startY));
			for (let step = 1; step <= 8; step++) {
				const clientX = startX + (movement.dx * step) / 8;
				const clientY = startY + (movement.dy * step) / 8;
				window.dispatchEvent(event('pointermove', clientX, clientY));
			}
			window.dispatchEvent(event('pointerup', startX + movement.dx, startY + movement.dy));
		},
		{ x: box.x, y: box.y, width: box.width, height: box.height, dx, dy }
	);
}

async function settleLayout(page: Page): Promise<void> {
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() =>
					requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
				)
			)
	);
}

test.beforeEach(async ({ page }, testInfo) => {
	test.skip(!testInfo.project.name.startsWith('mobile-'), 'mobile-only');
	await resetEnglishApp(page);
});

test('edits and presents a deck with touch input on a mobile viewport', async ({
	page
}, testInfo) => {
	test.setTimeout(60_000);
	await page.getByTestId('slides-open').tap();
	const editor = page.getByTestId('presentation-editor');
	await expect(editor).toBeVisible({ timeout: 15_000 });
	await expect(editor.getByTestId('slide-canvas')).toBeInViewport();

	await editor.getByTestId('slide-add-rectangle').tap();
	const rectangle = editor.locator('[data-testid="slide-object"][data-object-type="rectangle"]');
	const beforeDrag = await rectangle.boundingBox();
	await touchDrag(page, rectangle, 42, 31);
	const afterDrag = await rectangle.boundingBox();
	expect(afterDrag!.x - beforeDrag!.x).toBeGreaterThan(15);
	expect(afterDrag!.y - beforeDrag!.y).toBeGreaterThan(10);

	await rectangle.tap();
	const beforeResize = await rectangle.boundingBox();
	await touchDrag(page, editor.getByTestId('slide-resize-se'), 38, 28);
	const afterResize = await rectangle.boundingBox();
	expect(afterResize!.width - beforeResize!.width).toBeGreaterThan(12);
	expect(afterResize!.height - beforeResize!.height).toBeGreaterThan(8);

	await editor.getByTestId('slide-add-ellipse').scrollIntoViewIfNeeded();
	await editor.getByTestId('slide-add-ellipse').tap();
	const ellipse = editor.locator('[data-testid="slide-object"][data-object-type="ellipse"]');
	await editor.getByTestId('slide-properties').scrollIntoViewIfNeeded();
	await editor.getByTestId('slide-properties').tap();
	const objectItems = editor.getByTestId('slide-object-list-item');
	await objectItems.nth(0).tap();
	await editor.getByTestId('slide-multiselect').scrollIntoViewIfNeeded();
	await editor.getByTestId('slide-multiselect').tap();
	await expect(editor.getByTestId('slide-multiselect')).toHaveAttribute('aria-pressed', 'true');
	await objectItems.nth(1).tap();
	await editor.getByTestId('slide-align-left').scrollIntoViewIfNeeded();
	await editor.getByTestId('slide-align-left').tap();
	const aligned = await Promise.all([rectangle.boundingBox(), ellipse.boundingBox()]);
	expect(Math.abs(aligned[0]!.x - aligned[1]!.x)).toBeLessThanOrEqual(1);
	await editor.getByTestId('slide-group').tap();
	await editor.getByTestId('slide-properties').scrollIntoViewIfNeeded();
	await editor.getByTestId('slide-properties').tap();
	await settleLayout(page);
	const groupedBefore = await Promise.all([rectangle.boundingBox(), ellipse.boundingBox()]);
	await touchDrag(page, rectangle, 34, 24);
	await settleLayout(page);
	const groupedAfter = await Promise.all([rectangle.boundingBox(), ellipse.boundingBox()]);
	for (let index = 0; index < 2; index++) {
		expect(groupedAfter[index]!.x - groupedBefore[index]!.x).toBeGreaterThan(10);
		expect(groupedAfter[index]!.y - groupedBefore[index]!.y).toBeGreaterThan(6);
	}

	await editor.getByTestId('slide-add-text').tap();
	await editor.getByTestId('slide-edit-text').tap();
	await editor.getByTestId('slide-text-editor').fill('## Mobile editing');
	await editor.getByTestId('slide-text-done').tap();
	await expect(
		editor.getByTestId('slide-canvas').getByText('Mobile editing', { exact: true })
	).toBeVisible();

	await editor.getByTestId('slide-add').tap();
	await expect(editor.getByTestId('slide-thumbnail')).toHaveCount(2);
	await editor.getByTestId('slide-add-text').tap();
	await editor.getByTestId('slide-edit-text').tap();
	await editor.getByTestId('slide-text-editor').fill('## Touch slide two');
	await editor.getByTestId('slide-text-done').tap();

	const overflow = await page.evaluate(() => ({
		documentWidth: document.documentElement.scrollWidth,
		viewportWidth: document.documentElement.clientWidth
	}));
	expect(overflow.documentWidth).toBeLessThanOrEqual(overflow.viewportWidth + 1);

	const axe = await new AxeBuilder({ page })
		.include('[data-testid="presentation-editor"]')
		.analyze();
	const blocking = axe.violations.filter(
		(violation) => violation.impact === 'critical' || violation.impact === 'serious'
	);
	expect(
		blocking,
		blocking.map((violation) => `${violation.impact}: ${violation.id}`).join('\n')
	).toEqual([]);

	await editor.getByTestId('slide-thumbnail').first().tap();
	await editor.getByTestId('slide-present').tap();
	await expect(page.getByText('Mobile editing', { exact: true }).last()).toBeVisible();
	await page.getByTestId('slide-present-next').tap();
	await expect(page.getByText('Touch slide two', { exact: true }).last()).toBeVisible();
	await page.getByTestId('slide-present-exit').tap();
	await expect(editor.getByTestId('slide-canvas')).toBeVisible();

	await testInfo.attach('presentation-mobile.png', {
		body: await page.screenshot({ fullPage: true }),
		contentType: 'image/png'
	});
	await testInfo.attach('presentation-mobile.json', {
		body: JSON.stringify(
			{
				command:
					'npm run test:e2e -- presentation-mobile.spec.ts --project=mobile-chromium --project=mobile-webkit --workers=1',
				project: testInfo.project.name,
				fixture: { slides: 2, objectTypes: ['rectangle', 'ellipse', 'text'] },
				touchMovement: {
					x: afterDrag!.x - beforeDrag!.x,
					y: afterDrag!.y - beforeDrag!.y,
					width: afterResize!.width - beforeResize!.width,
					height: afterResize!.height - beforeResize!.height
				},
				blockingAxeViolations: 0,
				overflow
			},
			null,
			2
		),
		contentType: 'application/json'
	});
});

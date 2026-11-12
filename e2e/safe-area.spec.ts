import { expect, test, type Page } from '@playwright/test';
import { resetAppState } from './helpers';

/**
 * Simulated safe-area geometry.
 *
 * Chromium cannot report the iOS `env(safe-area-inset-*)` values of an installed
 * Home Screen web app. The application resolves those values into custom
 * properties, so this spec overrides the properties and checks the shared shell
 * and the fixed mobile drawer against the simulated box. It proves the layout
 * policy, not the geometry of a physical device.
 */
const INSETS = { top: 44, right: 12, bottom: 34, left: 12 };

async function setInsets(
	page: Page,
	insets: { top: number; right: number; bottom: number; left: number }
): Promise<void> {
	await page.evaluate((values) => {
		for (const edge of ['top', 'right', 'bottom', 'left'] as const) {
			document.documentElement.style.setProperty(`--mdsh-safe-${edge}`, `${values[edge]}px`);
		}
	}, insets);
}

async function layoutEvidence(page: Page) {
	return page.evaluate(() => {
		const box = (selector: string) => {
			const element = document.querySelector(selector);
			if (!element) throw new Error(`Missing element: ${selector}`);
			const rect = element.getBoundingClientRect();
			const style = getComputedStyle(element);
			return {
				top: rect.top,
				right: rect.right,
				bottom: rect.bottom,
				left: rect.left,
				width: rect.width,
				height: rect.height,
				paddingTop: style.paddingTop,
				paddingRight: style.paddingRight,
				paddingBottom: style.paddingBottom,
				paddingLeft: style.paddingLeft
			};
		};
		const shell = document.querySelector('.mdsh-shell');
		if (!(shell instanceof HTMLElement)) throw new Error('Missing shell');
		const uncoveredButtons: string[] = [];
		for (const button of shell.querySelectorAll<HTMLElement>('#app-toolbar button')) {
			const rect = button.getBoundingClientRect();
			if (rect.width === 0 || rect.height === 0) continue;
			const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
			if (!(hit === button || button.contains(hit))) {
				uncoveredButtons.push(button.getAttribute('data-testid') ?? button.textContent ?? '');
			}
		}
		return {
			innerWidth: window.innerWidth,
			innerHeight: window.innerHeight,
			shell: box('.mdsh-shell'),
			toolbar: box('#app-toolbar'),
			statusBar: box('#app-statusbar'),
			uncoveredButtons
		};
	});
}

async function createNote(page: Page): Promise<void> {
	await page.getByTestId('welcome-new').click();
	await page.getByTestId('create-note').click();
	await expect(page.locator('#app-statusbar')).toBeVisible();
}

test('shared shell keeps persistent chrome inside simulated safe areas', async ({ page }) => {
	await resetAppState(page);
	await createNote(page);
	await setInsets(page, INSETS);
	const evidence = await layoutEvidence(page);

	expect(evidence.shell.paddingTop).toBe(`${INSETS.top}px`);
	expect(evidence.shell.paddingRight).toBe(`${INSETS.right}px`);
	expect(evidence.shell.paddingBottom).toBe(`${INSETS.bottom}px`);
	expect(evidence.shell.paddingLeft).toBe(`${INSETS.left}px`);
	expect(evidence.shell.height).toBeCloseTo(evidence.innerHeight, 0);

	expect(evidence.toolbar.top).toBeGreaterThanOrEqual(INSETS.top - 0.5);
	expect(evidence.toolbar.left).toBeGreaterThanOrEqual(INSETS.left - 0.5);
	expect(evidence.toolbar.right).toBeLessThanOrEqual(evidence.innerWidth - INSETS.right + 0.5);
	expect(evidence.uncoveredButtons).toEqual([]);

	expect(evidence.statusBar.bottom).toBeLessThanOrEqual(evidence.innerHeight - INSETS.bottom + 0.5);
	expect(evidence.statusBar.left).toBeGreaterThanOrEqual(INSETS.left - 0.5);
	expect(evidence.statusBar.right).toBeLessThanOrEqual(evidence.innerWidth - INSETS.right + 0.5);
});

test('mobile drawer stays inside simulated safe areas', async ({ page }, testInfo) => {
	test.skip(!testInfo.project.name.startsWith('mobile-'), 'mobile-only');
	await resetAppState(page);
	await setInsets(page, INSETS);
	await page.getByRole('button', { name: 'Menu' }).click();
	const drawer = page.locator('aside').first();
	await expect(drawer).toBeVisible();
	await expect
		.poll(() =>
			drawer.evaluate((element) => {
				const box = element.getBoundingClientRect();
				return {
					top: box.top,
					right: box.right,
					bottom: box.bottom,
					left: box.left,
					innerHeight: window.innerHeight
				};
			})
		)
		.toMatchObject({ left: INSETS.left });
	const evidence = await drawer.evaluate((element) => {
		const box = element.getBoundingClientRect();
		return {
			top: box.top,
			right: box.right,
			bottom: box.bottom,
			left: box.left,
			innerHeight: window.innerHeight
		};
	});

	expect(evidence.top).toBeGreaterThanOrEqual(INSETS.top - 0.5);
	expect(evidence.bottom).toBeLessThanOrEqual(evidence.innerHeight - INSETS.bottom + 0.5);
	expect(evidence.left).toBeGreaterThanOrEqual(INSETS.left - 0.5);
});

test('zero insets add no top or bottom gap', async ({ page }) => {
	await resetAppState(page);
	await createNote(page);
	await setInsets(page, { top: 0, right: 0, bottom: 0, left: 0 });
	const evidence = await layoutEvidence(page);

	for (const padding of [
		evidence.shell.paddingTop,
		evidence.shell.paddingRight,
		evidence.shell.paddingBottom,
		evidence.shell.paddingLeft
	]) {
		expect(padding).toBe('0px');
	}
	expect(evidence.toolbar.top).toBeLessThanOrEqual(0.5);
	expect(evidence.statusBar.bottom).toBeGreaterThanOrEqual(evidence.innerHeight - 0.5);
});

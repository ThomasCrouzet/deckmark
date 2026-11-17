import { expect, test, type Locator, type Page } from '@playwright/test';
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
const ZERO = { top: 0, right: 0, bottom: 0, left: 0 };

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

/**
 * Measure one fixed surface against the simulated safe box. A fixed surface
 * does not inherit the shell padding, so its own anchor edge must keep the
 * resolved inset. The hit test proves that the visible centre receives the
 * pointer event.
 */
async function fixedSurfaceEvidence(
	page: Page,
	selector: Locator,
	insets: { top: number; right: number; bottom: number; left: number }
) {
	const box = await selector.boundingBox();
	if (!box) throw new Error('Missing bounding box');
	const viewport = await page.evaluate(() => ({
		width: window.innerWidth,
		height: window.innerHeight
	}));
	return {
		box,
		viewport,
		insets,
		inside:
			box.x >= insets.left - 0.5 &&
			box.y >= insets.top - 0.5 &&
			box.x + box.width <= viewport.width - insets.right + 0.5 &&
			box.y + box.height <= viewport.height - insets.bottom + 0.5,
		hit:
			(await selector.evaluate((node) => {
				const rect = node.getBoundingClientRect();
				return node.contains(
					document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
				);
			})) === true
	};
}

async function expectInsideSafeBox(
	page: Page,
	surface: Locator,
	insets: { top: number; right: number; bottom: number; left: number }
) {
	const evidence = await fixedSurfaceEvidence(page, surface, insets);
	expect(evidence.inside).toBe(true);
	expect(evidence.hit).toBe(true);
	return evidence;
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
	await setInsets(page, ZERO);
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

/**
 * The shared shell does not move fixed surfaces: they render against the
 * viewport. These cases simulate the resolved box and check that each fixed
 * surface keeps its own anchor inside it. The zero-inset pass repeats the
 * earlier offsets, so an ordinary desktop or Android window gains no gap.
 */
test('storage recovery banner stays inside simulated safe areas', async ({ page }, info) => {
	await page.addInitScript(() => {
		if (sessionStorage.getItem('mdsh:test-allow-idb') === '1') return;
		indexedDB.open = (() => {
			throw new Error('Storage access denied by the test.');
		}) as IDBFactory['open'];
	});
	await page.goto('/');
	const banner = page.getByRole('alert').filter({ hasText: /stockage|storage/i });
	await expect(banner).toBeVisible({ timeout: 15_000 });
	await setInsets(page, INSETS);
	// The banner background may extend under the notch. Its text and the retry
	// control must stay inside the resolved box.
	const bannerEvidence = await fixedSurfaceEvidence(page, banner, INSETS);
	expect(bannerEvidence.box.y).toBeGreaterThanOrEqual(INSETS.top - 0.5);
	expect(bannerEvidence.hit).toBe(true);
	const retryEvidence = await expectInsideSafeBox(page, page.getByTestId('retry-storage'), INSETS);
	await info.attach('safe-area-storage-banner.json', {
		body: JSON.stringify({ insets: INSETS, banner: bannerEvidence, retry: retryEvidence }),
		contentType: 'application/json'
	});
	await info.attach('safe-area-storage-banner.png', {
		body: await page.screenshot({ animations: 'disabled' }),
		contentType: 'image/png'
	});

	await setInsets(page, ZERO);
	const zeroEvidence = await expectInsideSafeBox(page, banner, ZERO);
	expect(zeroEvidence.box.y).toBeLessThanOrEqual(0.5);
});

test('focus exit control stays inside simulated safe areas', async ({ page }, info) => {
	await resetAppState(page);
	await createNote(page);
	await page.locator('[data-mode="read"]').click();
	await page.getByTestId('focus-toggle').click();
	const exit = page.getByRole('button', { name: 'Quitter le mode focus' });
	await expect(exit).toBeVisible();
	await setInsets(page, INSETS);
	const insetEvidence = await expectInsideSafeBox(page, exit, INSETS);
	await info.attach('safe-area-focus-exit.json', {
		body: JSON.stringify({ insets: INSETS, exit: insetEvidence }),
		contentType: 'application/json'
	});
	await info.attach('safe-area-focus-exit.png', {
		body: await page.screenshot({ animations: 'disabled' }),
		contentType: 'image/png'
	});

	await setInsets(page, ZERO);
	const zeroEvidence = await expectInsideSafeBox(page, exit, ZERO);
	expect(zeroEvidence.box.y).toBeCloseTo(8, 1);
	expect(zeroEvidence.box.x + zeroEvidence.box.width).toBeCloseTo(
		zeroEvidence.viewport.width - 8,
		1
	);
});

test('undo toast stays inside simulated safe areas', async ({ page }, info) => {
	await resetAppState(page);
	await createNote(page);
	if (info.project.name.startsWith('mobile-')) {
		await page.getByRole('button', { name: 'Menu' }).click();
	}
	await setInsets(page, INSETS);
	await page.locator('aside summary').filter({ hasText: 'Actions du document' }).click();
	await page
		.locator('aside')
		.getByRole('button', { name: 'Déplacer le document dans la corbeille', exact: true })
		.click();
	await page
		.getByRole('dialog', { name: 'Déplacer ce document dans la corbeille ?', exact: true })
		.getByRole('button', { name: 'Confirmer', exact: true })
		.click();
	const toast = page.getByRole('status').filter({ hasText: 'Mis à la corbeille' });
	await expect(toast).toBeVisible();
	const container = toast.locator('..');
	const insetEvidence = await expectInsideSafeBox(page, container, INSETS);
	await info.attach('safe-area-undo-toast.json', {
		body: JSON.stringify({ insets: INSETS, toast: insetEvidence }),
		contentType: 'application/json'
	});
	await info.attach('safe-area-undo-toast.png', {
		body: await page.screenshot({ animations: 'disabled' }),
		contentType: 'image/png'
	});

	await setInsets(page, ZERO);
	const zeroEvidence = await expectInsideSafeBox(page, container, ZERO);
	expect(zeroEvidence.viewport.height - (zeroEvidence.box.y + zeroEvidence.box.height)).toBeCloseTo(
		16,
		1
	);
});

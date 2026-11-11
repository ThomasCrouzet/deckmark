import { expect, test, type Locator, type Page } from '@playwright/test';
import { resetAppState, writeSourceContent } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

type FakeViewport = { set: (height: number, offsetTop: number) => void };

declare global {
	interface Window {
		__mdshTestViewport?: FakeViewport;
	}
}

/**
 * Install a controllable visual viewport before the application starts. Mobile
 * WebKit and mobile Chromium move the visual viewport without changing the
 * layout viewport when the software keyboard opens; the simulation reproduces
 * that geometry without a physical keyboard. It is not device evidence.
 */
async function installVisualViewport(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const target = new EventTarget();
		const state = { height: window.innerHeight, offsetTop: 0 };
		Object.defineProperty(target, 'height', { get: () => state.height });
		Object.defineProperty(target, 'offsetTop', { get: () => state.offsetTop });
		Object.defineProperties(target, {
			width: { get: () => window.innerWidth },
			offsetLeft: { get: () => 0 },
			pageTop: { get: () => state.offsetTop },
			pageLeft: { get: () => 0 },
			scale: { get: () => 1 }
		});
		Object.defineProperty(window, 'visualViewport', {
			configurable: true,
			value: target
		});
		window.__mdshTestViewport = {
			set(height: number, offsetTop: number) {
				state.height = height;
				state.offsetTop = offsetTop;
				target.dispatchEvent(new Event('resize'));
				target.dispatchEvent(new Event('scroll'));
			}
		};
	});
}

async function shrinkVisualViewport(page: Page, height: number, offsetTop: number): Promise<void> {
	await page.evaluate(
		({ height, offsetTop }) => window.__mdshTestViewport?.set(height, offsetTop),
		{ height, offsetTop }
	);
}

async function restoreVisualViewport(page: Page): Promise<void> {
	await page.evaluate(() => window.__mdshTestViewport?.set(window.innerHeight, 0));
}

async function visibleRegion(page: Page): Promise<{ top: number; bottom: number }> {
	return page.evaluate(() => {
		const viewport = window.visualViewport;
		return {
			top: viewport?.offsetTop ?? 0,
			bottom: (viewport?.offsetTop ?? 0) + (viewport?.height ?? 0)
		};
	});
}

async function expectInsideVisibleRegion(page: Page, locator: Locator): Promise<void> {
	await expect
		.poll(
			async () => {
				const box = await locator.boundingBox();
				const region = await visibleRegion(page);
				if (!box) return false;
				return box.y >= region.top - 1 && box.y + box.height <= region.bottom + 1;
			},
			{ timeout: 5_000 }
		)
		.toBe(true);
}

async function dialogPanel(dialog: Locator): Promise<Locator> {
	return dialog.locator('.mdsh-dialog-panel');
}

async function openSettings(page: Page): Promise<Locator> {
	await page.keyboard.press('Control+,');
	const dialog = page.locator('[role="dialog"][aria-labelledby="settings-title"]');
	await expect(dialog).toBeVisible();
	return dialog;
}

async function openSearch(page: Page): Promise<Locator> {
	await page.keyboard.press('Control+Shift+F');
	const dialog = page.getByRole('dialog', { name: 'Cross-file search', exact: true });
	await expect(dialog).toBeVisible();
	return dialog;
}

async function openPalette(page: Page): Promise<Locator> {
	await page.keyboard.press('Control+Shift+P');
	const dialog = page.getByRole('dialog', { name: 'Command palette', exact: true });
	await expect(dialog).toBeVisible();
	return dialog;
}

test.beforeEach(async ({ page }) => {
	await installVisualViewport(page);
	await resetAppState(page);
	await page.evaluate(() => localStorage.setItem('mdsh:locale', 'en'));
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
});

test('keeps dialog controls inside a shrinking visual viewport', async ({ page }, info) => {
	await page.getByTestId('welcome-new').click();
	await page.getByTestId('create-note').click();
	await expect(page.getByTestId('document-kind')).toHaveText('Note', { timeout: 15_000 });
	await writeSourceContent(page, '# Review note\n\nA searchable review paragraph.\n');

	const evidence: Array<Record<string, unknown>> = [];

	// Settings: a lower field, the close control and dialog scroll stay usable.
	{
		const dialog = await openSettings(page);
		const panel = await dialogPanel(dialog);
		expect(await dialog.evaluate((element) => (element as HTMLElement).style.top)).toBe('');
		await shrinkVisualViewport(page, 380, 120);
		await expect
			.poll(() => dialog.evaluate((element) => (element as HTMLElement).style.top))
			.toBe('120px');
		await expect
			.poll(() => dialog.evaluate((element) => (element as HTMLElement).style.height))
			.toBe('380px');
		await expectInsideVisibleRegion(page, panel);
		await expectInsideVisibleRegion(
			page,
			dialog.getByRole('button', { name: 'Close', exact: true })
		);
		const scrolled = await dialog.evaluate((element) => {
			const content = element.querySelector<HTMLElement>('.mdsh-dialog-panel > div');
			if (!content) return null;
			const before = content.scrollTop;
			content.scrollTop = content.scrollHeight;
			return { before, after: content.scrollTop, scrollHeight: content.scrollHeight };
		});
		expect(scrolled).not.toBeNull();
		expect(scrolled!.scrollHeight).toBeGreaterThanOrEqual(scrolled!.after);
		await restoreVisualViewport(page);
		await expect
			.poll(() => dialog.evaluate((element) => (element as HTMLElement).style.top))
			.toBe('');
		evidence.push({ dialog: 'settings', scrolled });
		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();
	}

	// Search: query, selection and results survive the viewport change.
	{
		const dialog = await openSearch(page);
		const input = dialog.getByRole('combobox');
		await input.fill('Review');
		await input.evaluate((element: HTMLInputElement) => element.setSelectionRange(2, 4));
		await expect(dialog.getByRole('option').filter({ hasText: 'Review note' })).toBeVisible();
		await shrinkVisualViewport(page, 360, 160);
		await expectInsideVisibleRegion(page, await dialogPanel(dialog));
		await expectInsideVisibleRegion(page, input);
		await expectInsideVisibleRegion(
			page,
			dialog.getByRole('button', { name: 'Close', exact: true })
		);
		await expect(input).toHaveValue('Review');
		expect(
			await input.evaluate((element: HTMLInputElement) => [
				element.selectionStart,
				element.selectionEnd
			])
		).toEqual([2, 4]);
		await expect(dialog.getByRole('option').filter({ hasText: 'Review note' })).toBeVisible();
		await restoreVisualViewport(page);
		await expectInsideVisibleRegion(page, await dialogPanel(dialog));
		evidence.push({ dialog: 'search', value: 'Review', selection: [2, 4] });
		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();
		expect(await input.isVisible()).toBe(false);
	}

	// Command palette: the list and its close control stay reachable.
	{
		const dialog = await openPalette(page);
		await shrinkVisualViewport(page, 340, 200);
		await expectInsideVisibleRegion(page, await dialogPanel(dialog));
		await expectInsideVisibleRegion(
			page,
			dialog.getByRole('button', { name: 'Close', exact: true })
		);
		await restoreVisualViewport(page);
		evidence.push({ dialog: 'palette' });
		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();
	}

	// Document library: the filter field and the close control stay reachable.
	{
		await page
			.locator('aside')
			.getByRole('button', { name: /^Document library/ })
			.click();
		const dialog = page.getByRole('dialog', { name: /^Document library/, exact: false });
		await expect(dialog).toBeVisible();
		const filter = dialog.getByRole('textbox');
		await expect(filter).toBeFocused();
		await filter.fill('Review');
		await shrinkVisualViewport(page, 320, 240);
		await expectInsideVisibleRegion(page, await dialogPanel(dialog));
		await expectInsideVisibleRegion(page, filter);
		await expectInsideVisibleRegion(
			page,
			dialog.getByRole('button', { name: 'Close', exact: true })
		);
		await expect(filter).toHaveValue('Review');
		await restoreVisualViewport(page);
		evidence.push({ dialog: 'library', value: 'Review' });
		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();
	}

	await info.attach('visual-viewport-dialogs.json', {
		body: JSON.stringify(
			{
				command:
					'npx playwright test e2e/dialog-visual-viewport.spec.ts --project=chromium --workers=1 --retries=0',
				method: 'synthetic VisualViewport override, not a physical keyboard',
				sourceViewport: await page.evaluate(() => ({
					innerHeight: window.innerHeight,
					visualHeight: window.visualViewport?.height,
					visualOffsetTop: window.visualViewport?.offsetTop
				})),
				cases: evidence
			},
			null,
			2
		),
		contentType: 'application/json'
	});
});

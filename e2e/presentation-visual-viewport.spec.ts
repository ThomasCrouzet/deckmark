import { expect, test, type Page } from '@playwright/test';
import { resetAppState } from './helpers';

/**
 * The browser cannot change `visualViewport.offsetTop` or dispatch a native
 * visual-viewport scroll without an installed mobile browser. This spec installs
 * a test-only VisualViewport target before the application starts. It changes the
 * offset without changing the height, dispatches only `scroll`, and reads the
 * application result. This proves the event path and the geometry calculation,
 * not the behavior of a physical software keyboard.
 */

type FakeVisualViewport = {
	scale: number;
	width: number;
	height: number;
	offsetTop: number;
	offsetLeft: number;
	pageTop: number;
	pageLeft: number;
	dispatchEvent: (event: Event) => boolean;
	listenerCount: (type: string) => number;
};

async function installVisualViewport(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
		const target = new EventTarget();
		const viewport = {
			scale: 1,
			width: window.innerWidth,
			height: window.innerHeight,
			offsetTop: 0,
			offsetLeft: 0,
			pageTop: 0,
			pageLeft: 0,
			addEventListener(
				type: string,
				callback: EventListenerOrEventListenerObject | null,
				options?: boolean | AddEventListenerOptions
			) {
				if (!callback) return;
				const set = listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
				set.add(callback);
				listeners.set(type, set);
				target.addEventListener(type, callback, options);
			},
			removeEventListener(
				type: string,
				callback: EventListenerOrEventListenerObject | null,
				options?: boolean | EventListenerOptions
			) {
				if (!callback) return;
				listeners.get(type)?.delete(callback);
				target.removeEventListener(type, callback, options);
			},
			dispatchEvent(event: Event) {
				return target.dispatchEvent(event);
			},
			listenerCount(type: string) {
				return listeners.get(type)?.size ?? 0;
			}
		};
		Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
		(window as unknown as { __mdshVisualViewport: typeof viewport }).__mdshVisualViewport =
			viewport;
	});
}

async function setVisualViewport(
	page: Page,
	values: { height: number; offsetTop: number },
	event: 'resize' | 'scroll'
): Promise<void> {
	await page.evaluate(
		({ height, offsetTop, eventName }) => {
			const viewport = (window as unknown as { __mdshVisualViewport: FakeVisualViewport })
				.__mdshVisualViewport;
			viewport.height = height;
			viewport.offsetTop = offsetTop;
			viewport.dispatchEvent(new Event(eventName));
		},
		{ ...values, eventName: event }
	);
}

async function editorState(page: Page) {
	return page.evaluate(() => {
		const root = document.querySelector('.presentation-editor');
		const viewport = (window as unknown as { __mdshVisualViewport: FakeVisualViewport })
			.__mdshVisualViewport;
		const field = document.activeElement;
		const bounds = field?.getBoundingClientRect();
		const rootBounds = root?.getBoundingClientRect();
		return {
			maxHeight: root instanceof HTMLElement ? Number.parseFloat(root.style.maxHeight) : NaN,
			scrollTop: root instanceof HTMLElement ? root.scrollTop : NaN,
			rootTop: rootBounds?.top ?? NaN,
			rootBottom: rootBounds?.bottom ?? NaN,
			fieldTag: field?.tagName ?? '',
			fieldTop: bounds?.top ?? NaN,
			fieldBottom: bounds?.bottom ?? NaN,
			offsetTop: viewport.offsetTop,
			height: viewport.height,
			scrollListeners: viewport.listenerCount('scroll'),
			resizeListeners: viewport.listenerCount('resize')
		};
	});
}

async function settleFrames(page: Page): Promise<void> {
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() =>
					requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
				)
			)
	);
}

test('recomputes focused-control visibility on visual-viewport scroll without resize', async ({
	page
}) => {
	await installVisualViewport(page);
	await resetAppState(page);
	await page.getByTestId('welcome-new').click();
	await page.getByTestId('create-presentation').click();
	const editor = page.getByTestId('presentation-editor');
	await expect(editor).toBeVisible({ timeout: 15_000 });

	const notes = editor.getByTestId('slide-notes');
	await expect(notes).toBeVisible();
	await setVisualViewport(page, { height: 300, offsetTop: 0 }, 'resize');
	await notes.focus();
	await settleFrames(page);

	const before = await editorState(page);
	expect(before.fieldTag).toBe('TEXTAREA');
	expect(before.scrollListeners).toBe(1);
	expect(before.resizeListeners).toBe(1);
	expect(before.maxHeight).toBeGreaterThan(0);
	expect(before.fieldBottom).toBeLessThanOrEqual(before.offsetTop + before.height + 0.5);

	// Offset change only: the height and the focus identity stay the same.
	await setVisualViewport(page, { height: 300, offsetTop: 120 }, 'scroll');
	await settleFrames(page);
	const after = await editorState(page);

	expect(after.fieldTag).toBe('TEXTAREA');
	expect(after.maxHeight).toBeCloseTo(before.maxHeight + 120, 0);
	expect(after.offsetTop).toBe(120);
	expect(after.height).toBe(300);
	expect(after.fieldTop).toBeGreaterThanOrEqual(after.offsetTop - 0.5);
	expect(after.fieldBottom).toBeLessThanOrEqual(after.offsetTop + after.height + 0.5);

	// A second scroll event at the same offset must not move the editor again.
	const stableScrollTop = after.scrollTop;
	await setVisualViewport(page, { height: 300, offsetTop: 120 }, 'scroll');
	await settleFrames(page);
	expect((await editorState(page)).scrollTop).toBe(stableScrollTop);
});

test('removes the visual-viewport listeners when the presentation closes', async ({ page }) => {
	await installVisualViewport(page);
	await resetAppState(page);
	await page.getByTestId('welcome-new').click();
	await page.getByTestId('create-presentation').click();
	const editor = page.getByTestId('presentation-editor');
	await expect(editor).toBeVisible({ timeout: 15_000 });
	await expect.poll(async () => (await editorState(page)).scrollListeners).toBe(1);
	await expect.poll(async () => (await editorState(page)).resizeListeners).toBe(1);

	await page.keyboard.press('ControlOrMeta+n');
	await page.getByTestId('create-note').click();
	await expect(page.getByTestId('document-kind')).toHaveText('Note', { timeout: 15_000 });
	await expect.poll(async () => (await editorState(page)).scrollListeners).toBe(0);
	await expect.poll(async () => (await editorState(page)).resizeListeners).toBe(0);
});

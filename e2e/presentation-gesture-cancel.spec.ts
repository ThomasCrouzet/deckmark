import { expect, test, type Locator, type Page } from '@playwright/test';
import { resetAppState } from './helpers';
import { importMarkdown, presentationFixture, waitForPresentation } from './presentation-helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

async function slideIds(editor: Locator): Promise<string[]> {
	return editor
		.getByTestId('slide-thumbnail')
		.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-slide-id') ?? ''));
}

async function touchGesture(
	page: Page,
	options: {
		down: number;
		up?: number | null;
		cancel?: boolean;
		pointerId?: number;
	}
): Promise<void> {
	await page.evaluate(
		({ down, up, cancel, pointerId }) => {
			const thumbnails = Array.from(
				document.querySelectorAll<HTMLElement>('[data-testid="slide-thumbnail"]')
			);
			const source = thumbnails[down];
			if (!source) throw new Error('The source thumbnail is absent.');
			const sourceRect = source.getBoundingClientRect();
			const startX = sourceRect.left + sourceRect.width / 2;
			const startY = sourceRect.top + sourceRect.height / 2;
			const event = (type: string, clientX: number, clientY: number) =>
				new PointerEvent(type, {
					bubbles: true,
					cancelable: true,
					pointerId,
					pointerType: 'touch',
					isPrimary: true,
					buttons: type === 'pointerup' ? 0 : 1,
					clientX,
					clientY
				});
			source.dispatchEvent(event('pointerdown', startX, startY));
			if (cancel) {
				window.dispatchEvent(event('pointercancel', startX, startY));
				return;
			}
			if (up === null || up === undefined) return;
			const target = thumbnails[up];
			if (!target) throw new Error('The target thumbnail is absent.');
			const targetRect = target.getBoundingClientRect();
			const endX = targetRect.left + targetRect.width / 2;
			const endY = targetRect.top + targetRect.height / 2;
			for (let step = 1; step <= 8; step++) {
				window.dispatchEvent(
					event(
						'pointermove',
						startX + ((endX - startX) * step) / 8,
						startY + ((endY - startY) * step) / 8
					)
				);
			}
			window.dispatchEvent(event('pointerup', endX, endY));
		},
		{ pointerId: 19, cancel: false, up: null, ...options }
	);
}

async function touchRelease(page: Page, up: number, pointerId = 19): Promise<void> {
	await page.evaluate(
		({ up, pointerId }) => {
			const thumbnails = Array.from(
				document.querySelectorAll<HTMLElement>('[data-testid="slide-thumbnail"]')
			);
			const target = thumbnails[up];
			if (!target) throw new Error('The target thumbnail is absent.');
			const rect = target.getBoundingClientRect();
			const x = rect.left + rect.width / 2;
			const y = rect.top + rect.height / 2;
			const event = (type: string) =>
				new PointerEvent(type, {
					bubbles: true,
					cancelable: true,
					pointerId,
					pointerType: 'touch',
					isPrimary: true,
					buttons: 0,
					clientX: x,
					clientY: y
				});
			window.dispatchEvent(event('pointermove'));
			window.dispatchEvent(event('pointerup'));
		},
		{ up, pointerId }
	);
}

async function tapThumbnail(page: Page, index: number, pointerId = 21): Promise<void> {
	await page.evaluate(
		({ index, pointerId }) => {
			const target = Array.from(
				document.querySelectorAll<HTMLElement>('[data-testid="slide-thumbnail"]')
			)[index];
			if (!target) throw new Error('The target thumbnail is absent.');
			const rect = target.getBoundingClientRect();
			const x = rect.left + rect.width / 2;
			const y = rect.top + rect.height / 2;
			const event = (type: string) =>
				new PointerEvent(type, {
					bubbles: true,
					cancelable: true,
					pointerId,
					pointerType: 'touch',
					isPrimary: true,
					buttons: type === 'pointerup' ? 0 : 1,
					clientX: x,
					clientY: y
				});
			target.dispatchEvent(event('pointerdown'));
			window.dispatchEvent(event('pointerup'));
			target.dispatchEvent(
				new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y })
			);
		},
		{ index, pointerId }
	);
}

async function scrollFilmstrip(
	page: Page
): Promise<{ axis: string; before: number; after: number }> {
	return page.evaluate(() => {
		const filmstrip = document.querySelector<HTMLElement>('.thumbnails');
		if (!filmstrip) throw new Error('The filmstrip is absent.');
		// The filmstrip is a vertical list in a wide editor and a horizontal
		// list at compact width. Scroll along the axis that actually overflows.
		const vertical = filmstrip.scrollHeight > filmstrip.clientHeight + 1;
		const horizontal = !vertical && filmstrip.scrollWidth > filmstrip.clientWidth + 1;
		if (!vertical && !horizontal)
			throw new Error(
				`The filmstrip cannot scroll: ${JSON.stringify({
					scrollWidth: filmstrip.scrollWidth,
					clientWidth: filmstrip.clientWidth,
					scrollHeight: filmstrip.scrollHeight,
					clientHeight: filmstrip.clientHeight
				})}`
			);
		const before = horizontal ? filmstrip.scrollLeft : filmstrip.scrollTop;
		const reachable = horizontal
			? filmstrip.scrollWidth - filmstrip.clientWidth
			: filmstrip.scrollHeight - filmstrip.clientHeight;
		if (horizontal) filmstrip.scrollLeft = reachable;
		else filmstrip.scrollTop = reachable;
		return {
			axis: horizontal ? 'horizontal' : 'vertical',
			before,
			after: horizontal ? filmstrip.scrollLeft : filmstrip.scrollTop
		};
	});
}

async function dragGesture(
	page: Page,
	options: {
		start: number;
		drop?: number | null;
		end?: boolean;
		escape?: boolean;
		outside?: boolean;
	}
): Promise<void> {
	await page.evaluate(
		({ start, drop, end, escape, outside }) => {
			const thumbnails = Array.from(
				document.querySelectorAll<HTMLElement>('[data-testid="slide-thumbnail"]')
			);
			const source = thumbnails[start];
			if (!source) throw new Error('The source thumbnail is absent.');
			const transfer = new DataTransfer();
			source.dispatchEvent(
				new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer })
			);
			if (escape)
				window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
			if (outside) {
				// Release the drag over the canvas, which is not a drop target.
				const canvas = document.querySelector<HTMLElement>('[data-testid="slide-canvas"]');
				if (!canvas) throw new Error('The slide canvas is absent.');
				canvas.dispatchEvent(
					new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })
				);
			}
			if (drop !== null && drop !== undefined) {
				const target = thumbnails[drop];
				if (!target) throw new Error('The target thumbnail is absent.');
				target.dispatchEvent(
					new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer })
				);
				target.dispatchEvent(
					new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })
				);
			}
			if (end)
				source.dispatchEvent(
					new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: transfer })
				);
		},
		{ drop: null, end: false, escape: false, ...options }
	);
}

async function unrelatedDrop(page: Page, index: number): Promise<void> {
	await page.evaluate((targetIndex) => {
		const target = Array.from(
			document.querySelectorAll<HTMLElement>('[data-testid="slide-thumbnail"]')
		)[targetIndex];
		if (!target) throw new Error('The target thumbnail is absent.');
		target.dispatchEvent(
			new DragEvent('drop', {
				bubbles: true,
				cancelable: true,
				dataTransfer: new DataTransfer()
			})
		);
	}, index);
}

test.beforeEach(async ({ page }) => {
	await resetAppState(page);
	await page.evaluate(() => localStorage.setItem('mdsh:locale', 'en'));
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
});

test('drops a cancelled touch or native drag before unrelated input reorders slides', async ({
	page
}, info) => {
	const fixture = presentationFixture(['# Alpha', '# Beta', '# Gamma']);
	await importMarkdown(page, fixture);
	const editor = await waitForPresentation(page);
	await expect(editor.getByTestId('slide-thumbnail')).toHaveCount(3);
	const original = await slideIds(editor);
	expect(original).toHaveLength(3);

	// A scroll takeover cancels the touch gesture. The pending origin must not
	// survive into a later event that reuses the pointer identifier.
	await touchGesture(page, { down: 0, cancel: true });
	await touchRelease(page, 1, 19);
	expect(await slideIds(editor)).toEqual(original);

	// The same rule applies to a native HTML drag without a drop.
	await dragGesture(page, { start: 0, end: true });
	await unrelatedDrop(page, 1);
	expect(await slideIds(editor)).toEqual(original);

	// Releasing the drag outside every drop target ends it without a reorder.
	await dragGesture(page, { start: 0, outside: true, end: true });
	await unrelatedDrop(page, 1);
	expect(await slideIds(editor)).toEqual(original);

	// Escape during a native drag cancels it.
	await dragGesture(page, { start: 0, escape: true, end: true });
	await unrelatedDrop(page, 1);
	expect(await slideIds(editor)).toEqual(original);

	// A real touch reorder still moves one slide exactly once and is undoable.
	await touchGesture(page, { down: 0, up: 1 });
	await expect
		.poll(async () => await slideIds(editor), { timeout: 5_000 })
		.toEqual([original[1], original[0], original[2]]);
	await editor.getByTestId('slide-undo').click();
	await expect.poll(async () => await slideIds(editor)).toEqual(original);

	// The same positive sequence works for a native drag.
	await dragGesture(page, { start: 0, drop: 1 });
	await expect
		.poll(async () => await slideIds(editor), { timeout: 5_000 })
		.toEqual([original[1], original[0], original[2]]);
	await editor.getByTestId('slide-undo').click();
	await expect.poll(async () => await slideIds(editor)).toEqual(original);

	// A committed reorder stays in the saved source after reload, and the
	// reopened deck keeps the persisted order.
	await touchGesture(page, { down: 0, up: 1 });
	await expect
		.poll(async () => await slideIds(editor))
		.toEqual([original[1], original[0], original[2]]);
	await expect(editor.locator('.save-state')).toHaveText('saved', { timeout: 10_000 });
	await page.reload();
	const reopened = await waitForPresentation(page);
	expect(await slideIds(reopened)).toEqual([original[1], original[0], original[2]]);

	await info.attach('presentation-gesture-cancel.json', {
		body: JSON.stringify(
			{
				command:
					'npx playwright test e2e/presentation-gesture-cancel.spec.ts --project=chromium --workers=1 --retries=0',
				fixture: 'presentationFixture with three slides',
				original,
				project: info.project.name
			},
			null,
			2
		),
		contentType: 'application/json'
	});
});

test('keeps the slide order on a tap and a filmstrip scroll', async ({ page }) => {
	const fixture = presentationFixture(
		Array.from({ length: 12 }, (_, index) => `# Slide ${index + 1}`)
	);
	await importMarkdown(page, fixture);
	const editor = await waitForPresentation(page);
	await expect(editor.getByTestId('slide-thumbnail')).toHaveCount(12);
	const original = await slideIds(editor);

	// A touch tap selects a slide. The pointer moves less than the reorder
	// threshold, so it must not change the order.
	await tapThumbnail(page, 2);
	await expect(editor.getByTestId('slide-thumbnail').nth(2)).toHaveAttribute(
		'aria-current',
		'true'
	);
	expect(await slideIds(editor)).toEqual(original);

	// Scrolling the filmstrip in either layout changes only its own offset.
	const scroll = await scrollFilmstrip(page);
	await expect
		.poll(() =>
			page.evaluate(() => {
				const filmstrip = document.querySelector<HTMLElement>('.thumbnails');
				if (!filmstrip) return 0;
				return Math.max(filmstrip.scrollTop, filmstrip.scrollLeft);
			})
		)
		.toBeGreaterThan(0);
	expect(scroll.after).toBeGreaterThan(scroll.before);
	expect(await slideIds(editor)).toEqual(original);
	await expect(editor.getByTestId('slide-thumbnail').nth(2)).toHaveAttribute(
		'aria-current',
		'true'
	);

	// A compact editor uses the horizontal filmstrip. Its scroll must also
	// leave the order and the active slide unchanged.
	await page.setViewportSize({ width: 900, height: 800 });
	await expect
		.poll(() => editor.evaluate((element) => element.getBoundingClientRect().width))
		.toBeLessThan(800);
	const compactScroll = await scrollFilmstrip(page);
	expect(compactScroll.axis).toBe('horizontal');
	expect(compactScroll.after).toBeGreaterThan(0);
	expect(await slideIds(editor)).toEqual(original);
	await expect(editor.getByTestId('slide-thumbnail').nth(2)).toHaveAttribute(
		'aria-current',
		'true'
	);

	// The same order survives a reload.
	await expect(editor.locator('.save-state')).toHaveText('saved', { timeout: 10_000 });
	await page.reload();
	const reopened = await waitForPresentation(page);
	expect(await slideIds(reopened)).toEqual(original);
});

test('discards a pending thumbnail touch when the active slide changes', async ({ page }) => {
	const fixture = presentationFixture(['# Alpha', '# Beta', '# Gamma']);
	await importMarkdown(page, fixture);
	const editor = await waitForPresentation(page);
	await expect(editor.getByTestId('slide-thumbnail')).toHaveCount(3);
	const original = await slideIds(editor);

	// Leave a touch origin pending, then switch the active slide with another
	// input. The pending origin belongs to the previous slide context.
	await touchGesture(page, { down: 0 });
	await editor.getByTestId('slide-thumbnail').nth(2).click();
	await expect(editor.getByTestId('slide-thumbnail').nth(2)).toHaveAttribute(
		'aria-current',
		'true'
	);

	// A later terminal event for the old pointer identifier must not reorder.
	await touchRelease(page, 1, 19);
	expect(await slideIds(editor)).toEqual(original);
	await expect(editor.getByTestId('slide-thumbnail').nth(2)).toHaveAttribute(
		'aria-current',
		'true'
	);

	// A new touch drag still reorders the intended slide once.
	await touchGesture(page, { down: 0, up: 1 });
	await expect
		.poll(async () => await slideIds(editor), { timeout: 5_000 })
		.toEqual([original[1], original[0], original[2]]);
	await editor.getByTestId('slide-undo').click();
	await expect.poll(async () => await slideIds(editor)).toEqual(original);
});

test('drops a pending thumbnail touch when the editor unmounts', async ({ page }) => {
	const fixture = presentationFixture(['# Alpha', '# Beta', '# Gamma']);
	await importMarkdown(page, fixture);
	const editor = await waitForPresentation(page);
	await expect(editor.getByTestId('slide-thumbnail')).toHaveCount(3);
	const original = await slideIds(editor);

	await touchGesture(page, { down: 0, cancel: false });
	await page
		.locator('aside')
		.getByRole('button', { name: /^New file/ })
		.click();
	await page.getByTestId('create-note').click();
	await expect(page.getByTestId('document-kind')).toHaveText('Note', { timeout: 15_000 });
	await page
		.locator('aside')
		.getByRole('button', { name: /^Presentation/ })
		.click();
	const reopened = await waitForPresentation(page);
	await expect(reopened.getByTestId('slide-thumbnail')).toHaveCount(3);
	await touchRelease(page, 1, 19);
	expect(await slideIds(reopened)).toEqual(original);
});

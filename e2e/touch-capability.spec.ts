import { expect, test, type Page } from '@playwright/test';
import { resetAppState } from './helpers';

// Playwright can emulate a coarse touch device, but not a hybrid device with a
// fine primary pointer and an available coarse pointer. The application reads
// `(any-pointer: coarse)`, so this init script replaces only the pointer media
// queries and keeps every other media query native.
type PointerState = { coarsePrimary: boolean; coarseAny: boolean };

const HYBRID_POINTER: PointerState = { coarsePrimary: false, coarseAny: true };
const COARSE_POINTER: PointerState = { coarsePrimary: true, coarseAny: true };
const FINE_POINTER: PointerState = { coarsePrimary: false, coarseAny: false };

async function installPointerState(page: Page, initial: PointerState): Promise<void> {
	await page.addInitScript((initial) => {
		type MockPointerState = { coarsePrimary: boolean; coarseAny: boolean };
		type PointerListener = (event: MediaQueryListEvent) => void;
		const native = window.matchMedia.bind(window);
		const state: MockPointerState = { ...initial };
		const registrations: Array<{
			mql: MediaQueryList;
			listeners: Set<PointerListener>;
		}> = [];
		const matchesFor = (query: string): boolean => {
			if (/any-pointer:\s*coarse/.test(query)) return state.coarseAny;
			if (/pointer:\s*coarse/.test(query)) return state.coarsePrimary;
			if (/any-pointer:\s*fine/.test(query)) return !state.coarsePrimary;
			if (/pointer:\s*fine/.test(query)) return !state.coarsePrimary;
			return native(query).matches;
		};
		window.matchMedia = ((query: string) => {
			if (!/pointer/.test(query)) return native(query);
			const listeners = new Set<PointerListener>();
			const mql = {
				media: query,
				get matches() {
					return matchesFor(query);
				},
				onchange: null,
				addEventListener(type: string, listener: EventListener) {
					if (type === 'change') listeners.add(listener as PointerListener);
				},
				removeEventListener(type: string, listener: EventListener) {
					if (type === 'change') listeners.delete(listener as PointerListener);
				},
				addListener(listener: PointerListener) {
					listeners.add(listener);
				},
				removeListener(listener: PointerListener) {
					listeners.delete(listener);
				},
				dispatchEvent() {
					return true;
				}
			} as unknown as MediaQueryList;
			registrations.push({ mql, listeners });
			return mql;
		}) as typeof window.matchMedia;
		(window as unknown as { __setPointerCapability: (next: Partial<PointerState>) => void })[
			'__setPointerCapability'
		] = (next) => {
			Object.assign(state, next);
			for (const { mql, listeners } of registrations) {
				const event = { matches: mql.matches, media: mql.media } as MediaQueryListEvent;
				for (const listener of listeners) listener(event);
			}
		};
	}, initial);
}

async function installHybridPointer(page: Page): Promise<void> {
	await installPointerState(page, HYBRID_POINTER);
}

async function setPointerCapability(page: Page, next: PointerState): Promise<void> {
	await page.evaluate(
		(state) =>
			(
				window as unknown as {
					__setPointerCapability: (value: PointerState) => void;
				}
			).__setPointerCapability(state),
		next
	);
}

async function seedLibrary(page: Page, plain: number, withPath: number): Promise<void> {
	await page.evaluate(
		({ plainCount, pathCount }) => {
			return new Promise<void>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const transaction = database.transaction('drafts', 'readwrite');
					const store = transaction.objectStore('drafts');
					const now = Date.now();
					let order = 0;
					for (let index = 0; index < plainCount; index += 1) {
						store.put({
							id: `plain-${index}`,
							name: `plain-${index}.md`,
							content:
								index === 0
									? `# Plain 0\n\n${Array.from(
											{ length: 240 },
											(_, line) => `Paragraph ${line} has enough text to scroll the note.`
										).join('\n\n')}\n`
									: `# Plain ${index}\n`,
							createdAt: now + order,
							updatedAt: now + order,
							order,
							open: true
						});
						order += 1;
					}
					for (let index = 0; index < pathCount; index += 1) {
						store.put({
							id: `path-${index}`,
							name: `path-${index}.md`,
							relativePath: `folder/path-${index}.md`,
							content: `# Path ${index}\n`,
							createdAt: now + order,
							updatedAt: now + order,
							order,
							open: true
						});
						order += 1;
					}
					transaction.oncomplete = () => {
						database.close();
						localStorage.setItem('mdsh:activeId', 'plain-0');
						resolve();
					};
					transaction.onerror = () => reject(transaction.error);
				};
			});
		},
		{ plainCount: plain, pathCount: withPath }
	);
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor({
		state: 'visible',
		timeout: 15_000
	});
}

interface RenderedRow {
	top: number;
	bottom: number;
	height: number;
	posinset: number;
	hasPath: boolean;
}

async function renderedRows(page: Page): Promise<RenderedRow[]> {
	return page.evaluate(() => {
		const list = document.querySelector<HTMLElement>(
			'#files-panel ul[aria-label^="Fichiers ouverts"]'
		);
		if (!list) return [];
		return Array.from(list.children).map((element) => {
			const row = element as HTMLElement;
			const rect = row.getBoundingClientRect();
			const button = row.querySelector<HTMLElement>('button[data-file-id]');
			return {
				top: rect.top,
				bottom: rect.bottom,
				height: rect.height,
				posinset: Number(row.getAttribute('aria-posinset')),
				hasPath: Boolean(button?.innerText.includes('/'))
			};
		});
	});
}

async function rowAtTop(page: Page): Promise<{ id: string | null; offset: number }> {
	return page.evaluate(() => {
		const container = document.querySelector<HTMLElement>('#files-panel .overflow-y-auto');
		if (!container) return { id: null, offset: 0 };
		const rect = container.getBoundingClientRect();
		const element = document.elementFromPoint(rect.left + rect.width / 2, rect.top + 4);
		const row = element?.closest<HTMLElement>('button[data-file-id]');
		return {
			id: row?.getAttribute('data-file-id') ?? null,
			offset: row ? row.getBoundingClientRect().top - rect.top : 0
		};
	});
}

function expectAligned(rows: RenderedRow[], coarse: boolean): void {
	expect(rows.length).toBeGreaterThan(0);
	for (const row of rows) {
		const expected = coarse || row.hasPath ? 52 : 36;
		expect(Math.abs(row.height - expected)).toBeLessThanOrEqual(1);
	}
	for (let index = 1; index < rows.length; index += 1) {
		const gap = rows[index]!.top - rows[index - 1]!.bottom;
		expect(Math.abs(gap)).toBeLessThanOrEqual(1);
		expect(rows[index]!.posinset).toBe(rows[index - 1]!.posinset + 1);
	}
}

async function scrollAndCollect(page: Page, scrollTop: number): Promise<RenderedRow[]> {
	await page.evaluate(async (top) => {
		const container = document.querySelector<HTMLElement>('#files-panel .overflow-y-auto');
		if (!container) throw new Error('sidebar scroll container is missing');
		container.scrollTop = top;
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
		);
	}, scrollTop);
	return renderedRows(page);
}

async function expectTouchTarget(
	page: Page,
	selector: string
): Promise<{ width: number; height: number }> {
	const box = await page.locator(selector).first().boundingBox();
	expect(box, `${selector} has no box`).not.toBeNull();
	expect(box!.width, `${selector} width`).toBeGreaterThanOrEqual(44);
	expect(box!.height, `${selector} height`).toBeGreaterThanOrEqual(44);
	return { width: box!.width, height: box!.height };
}

interface TouchTargetBox {
	label: string;
	width: number;
	height: number;
}

// The criterion names every applicable target, not one representative. Collect
// each rendered button and summary in a region and apply the same 44 px rule.
async function expectTouchTargets(page: Page, scope: string): Promise<TouchTargetBox[]> {
	const boxes = await page
		.locator(`${scope} button:visible, ${scope} summary:visible`)
		.evaluateAll((elements) =>
			elements.map((element) => {
				const rect = element.getBoundingClientRect();
				const label =
					element.getAttribute('aria-label') ??
					element.textContent?.trim().replace(/\s+/g, ' ').slice(0, 40) ??
					element.tagName;
				return { label, width: rect.width, height: rect.height };
			})
		);
	expect(boxes.length, `${scope} has no touch target`).toBeGreaterThan(0);
	for (const box of boxes) {
		expect(box.width, `${scope} ${box.label} width`).toBeGreaterThanOrEqual(44);
		expect(box.height, `${scope} ${box.label} height`).toBeGreaterThanOrEqual(44);
	}
	return boxes;
}

function pointerMedia(page: Page) {
	return page.evaluate(() => ({
		pointerCoarse: window.matchMedia('(pointer: coarse)').matches,
		anyPointerCoarse: window.matchMedia('(any-pointer: coarse)').matches,
		pointerFine: window.matchMedia('(pointer: fine)').matches,
		anyPointerFine: window.matchMedia('(any-pointer: fine)').matches
	}));
}

test('hybrid pointer keeps touch targets and virtual rows in agreement', async ({ page }, info) => {
	test.setTimeout(120_000);
	await installHybridPointer(page);
	await resetAppState(page);
	await seedLibrary(page, 180, 40);

	const hybridMedia = await pointerMedia(page);
	// The audit needs the exact emulated media values next to the results.
	expect(hybridMedia).toEqual({
		pointerCoarse: false,
		anyPointerCoarse: true,
		pointerFine: true,
		anyPointerFine: true
	});
	await expect(page.locator('html')).toHaveAttribute('data-touch-capable', 'true');

	// Toolbar, scroll navigation and dialog targets follow the available touch
	// capability, not the fine primary pointer.
	await expectTouchTarget(page, '#app-toolbar button:visible');
	const toolbarTargets = await expectTouchTargets(page, '#app-toolbar');
	const titleTarget = await expectTouchTarget(page, '#app-toolbar .document-title input');
	const scrollNavTarget = await expectTouchTarget(page, '.mdsh-scroll-nav button');
	await page.getByRole('button', { name: 'Palette de commandes' }).click();
	const palette = page.getByRole('dialog', { name: 'Palette de commandes' });
	await expect(palette).toBeVisible();
	const dialogTarget = await expectTouchTarget(page, '[role="dialog"] button');
	const dialogTargets = await expectTouchTargets(page, '[role="dialog"]');
	await page.keyboard.press('Escape');
	const sidebarTarget = await expectTouchTarget(page, '#files-panel ul button[data-file-id]');
	const sidebarTargets = await expectTouchTargets(page, '#files-panel');

	const scroll = page.locator('#files-panel .overflow-y-auto').first();
	await scroll.evaluate((element) => {
		element.scrollTop = 600;
	});
	await expect
		.poll(() => page.locator('aside [aria-posinset]').first().getAttribute('aria-posinset'))
		.not.toBe('1');

	const coarseRows = await renderedRows(page);
	expectAligned(coarseRows, true);

	// Walk the whole virtual list. Every index must appear, each rendered row
	// must match the modeled 52 px height, and adjacent rows must not overlap.
	const seen = new Set<number>();
	const total = 180 + 40;
	for (let top = 0; ; top += 480) {
		const rows = await scrollAndCollect(page, top);
		expectAligned(rows, true);
		for (const row of rows) seen.add(row.posinset);
		const reachedBottom = await scroll.evaluate(
			(element) => element.scrollTop + element.clientHeight >= element.scrollHeight - 1
		);
		if (reachedBottom) break;
	}
	expect(seen.size).toBe(total);
	for (let index = 1; index <= total; index += 1) expect(seen.has(index)).toBe(true);
	const lastRow = (await renderedRows(page)).at(-1)!;
	expect(lastRow.posinset).toBe(total);
	const bottomGap = await scroll.evaluate(async (element) => {
		element.scrollTop = element.scrollHeight;
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
		);
		const rows = document.querySelectorAll<HTMLElement>('#files-panel ul > li');
		const last = rows[rows.length - 1];
		return last ? element.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom : -1;
	});
	expect(Math.abs(bottomGap)).toBeLessThanOrEqual(10);

	// Build a selection through the touch mode, then keep it across the change.
	await scroll.evaluate((element) => {
		element.scrollTop = 0;
	});
	await expect
		.poll(() => page.locator('aside [aria-posinset]').first().getAttribute('aria-posinset'))
		.toBe('1');
	const toggle = page.getByTestId('selection-mode-toggle');
	await toggle.click();
	const rowButtons = page.locator(
		'#files-panel ul[aria-label^="Fichiers ouverts"] button[data-file-id]'
	);
	await rowButtons.nth(0).click();
	await rowButtons.nth(1).click();
	await expect(page.getByTestId('selection-count')).toHaveText('2 sélectionnés');
	const activeBefore = await page.locator('#app-toolbar input').inputValue();
	await scroll.evaluate((element) => {
		element.scrollTop = 600;
	});
	await expect
		.poll(() => page.locator('aside [aria-posinset]').first().getAttribute('aria-posinset'))
		.not.toBe('1');
	const scrollBefore = await scroll.evaluate((element) => element.scrollTop);
	const anchorBefore = await rowAtTop(page);

	await setPointerCapability(page, FINE_POINTER);
	await expect(page.locator('html')).not.toHaveAttribute('data-touch-capable', 'true');
	expect(await pointerMedia(page)).toEqual({
		pointerCoarse: false,
		anyPointerCoarse: false,
		pointerFine: true,
		anyPointerFine: true
	});
	await expect
		.poll(async () => {
			const rows = await renderedRows(page);
			return (
				rows.length > 0 && rows.every((row) => Math.abs(row.height - (row.hasPath ? 52 : 36)) <= 1)
			);
		})
		.toBe(true);

	const fineRows = await renderedRows(page);
	expectAligned(fineRows, false);
	// A fine-only pointer restores the desktop density of the same controls.
	expect(
		(await page.locator('#app-toolbar .document-title input').boundingBox())!.height
	).toBeLessThan(44);
	expect(
		(await page.locator('.mdsh-scroll-nav button').first().boundingBox())!.height
	).toBeLessThan(44);
	const scrollAfter = await scroll.evaluate((element) => element.scrollTop);
	// Row heights change, so the numeric offset moves. The file at the top of
	// the viewport must stay the same and the list must not reset to the top.
	expect(scrollAfter).toBeGreaterThan(0);
	const anchorAfter = await rowAtTop(page);
	expect(anchorAfter.id).toBe(anchorBefore.id);
	expect(Math.abs(anchorAfter.offset - anchorBefore.offset)).toBeLessThanOrEqual(24);
	await expect(page.locator('#app-toolbar input')).toHaveValue(activeBefore);
	await expect(page.locator('aside [aria-label="Actions sur la sélection"]')).toContainText(
		'2 sélectionnés'
	);

	await setPointerCapability(page, HYBRID_POINTER);
	await expect(page.locator('html')).toHaveAttribute('data-touch-capable', 'true');
	await expect
		.poll(async () => (await renderedRows(page)).every((row) => row.height >= 51))
		.toBe(true);
	expectAligned(await renderedRows(page), true);
	await expect(toggle).toHaveAttribute('aria-pressed', 'false');
	await expect(page.getByTestId('selection-count')).toHaveText('2 sélectionnés');

	await info.attach('hybrid-pointer.json', {
		body: JSON.stringify(
			{
				media: hybridMedia,
				fixtures: { plainFiles: 180, pathFiles: 40, activeNoteLines: 240 },
				targets: {
					title: titleTarget,
					scrollNav: scrollNavTarget,
					dialog: dialogTarget,
					sidebar: sidebarTarget
				},
				targetSweep: {
					toolbar: toolbarTargets,
					dialog: dialogTargets,
					sidebar: sidebarTargets
				},
				indexesCovered: seen.size,
				total,
				bottomGap,
				coarseRows: coarseRows.length,
				fineRows: fineRows.length,
				scrollBefore,
				scrollAfter,
				anchorBefore,
				anchorAfter,
				selectionRetained: true
			},
			null,
			2
		),
		contentType: 'application/json'
	});
});

test('hybrid pointer keeps the sidebar out of a permanent drawer across breakpoints', async ({
	page
}) => {
	await installHybridPointer(page);
	await page.setViewportSize({ width: 1280, height: 800 });
	await resetAppState(page);
	await seedLibrary(page, 3, 2);

	const sidebar = page.locator('#files-panel');
	const overlay = page.locator('button.z-30');
	const toggle = page.locator('#app-toolbar button[aria-controls="files-panel"]:visible');
	await expect(page.locator('html')).toHaveAttribute('data-touch-capable', 'true');
	await expect(sidebar).toBeVisible();
	expect(await sidebar.evaluate((element) => getComputedStyle(element).position)).toBe('static');
	await expect(overlay).toBeHidden();
	const activeBefore = await page.locator('#app-toolbar .document-title input').inputValue();

	await page.setViewportSize({ width: 640, height: 800 });
	await expect(sidebar).toHaveAttribute('aria-hidden', 'true');
	expect(await sidebar.evaluate((element) => getComputedStyle(element).position)).toBe('fixed');
	await toggle.click();
	await expect(overlay).toBeVisible();
	await expect(sidebar).not.toHaveAttribute('aria-hidden', 'true');
	expect(await sidebar.evaluate((element) => getComputedStyle(element).transform)).not.toContain(
		'-256'
	);

	// Returning to a wide window restores the static column, not an open drawer.
	await page.setViewportSize({ width: 1280, height: 800 });
	await expect(overlay).toBeHidden();
	await expect(sidebar).not.toHaveAttribute('aria-hidden', 'true');
	expect(await sidebar.evaluate((element) => getComputedStyle(element).position)).toBe('static');
	await expect(page.locator('#app-toolbar .document-title input')).toHaveValue(activeBefore);
});

test('coarse-only pointer switches to hybrid and fine without losing state', async ({
	page
}, info) => {
	test.setTimeout(120_000);
	await installPointerState(page, COARSE_POINTER);
	await resetAppState(page);
	await seedLibrary(page, 180, 40);

	// Start on a touch-only layout: the primary pointer is coarse.
	expect(await pointerMedia(page)).toEqual({
		pointerCoarse: true,
		anyPointerCoarse: true,
		pointerFine: false,
		anyPointerFine: false
	});
	await expect(page.locator('html')).toHaveAttribute('data-touch-capable', 'true');
	await expectTouchTargets(page, '#app-toolbar');
	await expectTouchTargets(page, '#files-panel');

	const scroll = page.locator('#files-panel .overflow-y-auto').first();
	await scroll.evaluate((element) => {
		element.scrollTop = 600;
	});
	await expect
		.poll(() => page.locator('aside [aria-posinset]').first().getAttribute('aria-posinset'))
		.not.toBe('1');

	const toggle = page.getByTestId('selection-mode-toggle');
	await toggle.click();
	const rowButtons = page.locator(
		'#files-panel ul[aria-label^="Fichiers ouverts"] button[data-file-id]'
	);
	const firstId = (await rowButtons.nth(0).getAttribute('data-file-id'))!;
	const secondId = (await rowButtons.nth(1).getAttribute('data-file-id'))!;
	await page.locator(`button[data-file-id="${firstId}"]`).click();
	await page.locator(`button[data-file-id="${secondId}"]`).click();
	await expect(page.getByTestId('selection-count')).toHaveText('2 sélectionnés');
	const activeBefore = await page.locator('#app-toolbar .document-title input').inputValue();
	await scroll.evaluate((element) => {
		element.scrollTop = 600;
	});
	await expect
		.poll(() => page.locator('aside [aria-posinset]').first().getAttribute('aria-posinset'))
		.not.toBe('1');
	const anchorBefore = await rowAtTop(page);

	// A trackpad becomes the primary pointer while the touch screen stays
	// available. The 44 px policy and the 52 px row model must not change.
	await setPointerCapability(page, HYBRID_POINTER);
	expect(await pointerMedia(page)).toEqual({
		pointerCoarse: false,
		anyPointerCoarse: true,
		pointerFine: true,
		anyPointerFine: true
	});
	await expect(page.locator('html')).toHaveAttribute('data-touch-capable', 'true');
	await expectTouchTargets(page, '#app-toolbar');
	await expectTouchTargets(page, '#files-panel');
	await expect(toggle).toHaveAttribute('aria-pressed', 'true');
	await expect(page.locator('#app-toolbar .document-title input')).toHaveValue(activeBefore);
	expectAligned(await renderedRows(page), true);
	const anchorHybrid = await rowAtTop(page);
	expect(anchorHybrid.id).toBe(anchorBefore.id);
	expect(Math.abs(anchorHybrid.offset - anchorBefore.offset)).toBeLessThanOrEqual(1);

	// The touch screen detaches. Desktop density returns while the selection
	// and the viewed file stay.
	await setPointerCapability(page, FINE_POINTER);
	await expect(page.locator('html')).not.toHaveAttribute('data-touch-capable', 'true');
	expect(await pointerMedia(page)).toEqual({
		pointerCoarse: false,
		anyPointerCoarse: false,
		pointerFine: true,
		anyPointerFine: true
	});
	await expect
		.poll(async () => {
			const rows = await renderedRows(page);
			return (
				rows.length > 0 && rows.every((row) => Math.abs(row.height - (row.hasPath ? 52 : 36)) <= 1)
			);
		})
		.toBe(true);
	expectAligned(await renderedRows(page), false);
	await expect(page.locator('#app-toolbar .document-title input')).toHaveValue(activeBefore);
	await expect(page.locator('aside [aria-label="Actions sur la sélection"]')).toContainText(
		'2 sélectionnés'
	);
	const anchorFine = await rowAtTop(page);
	expect(anchorFine.id).toBe(anchorBefore.id);
	expect(Math.abs(anchorFine.offset - anchorBefore.offset)).toBeLessThanOrEqual(24);

	// Reattaching the touch screen restores the touch toolbar without a reload.
	await setPointerCapability(page, COARSE_POINTER);
	await expect(page.locator('html')).toHaveAttribute('data-touch-capable', 'true');
	await expect(toggle).toHaveAttribute('aria-pressed', 'false');
	await expect(page.getByTestId('selection-count')).toHaveText('2 sélectionnés');
	await expect(page.locator('#app-toolbar .document-title input')).toHaveValue(activeBefore);

	await info.attach('pointer-transition.json', {
		body: JSON.stringify(
			{
				transitions: ['coarse-only', 'hybrid', 'fine-only', 'coarse-only'],
				fixtures: { plainFiles: 180, pathFiles: 40 },
				activeFile: activeBefore,
				anchorBefore,
				anchorHybrid,
				anchorFine,
				selectionRetained: true
			},
			null,
			2
		),
		contentType: 'application/json'
	});
});

test('fine-only desktop pointer keeps density, focus and click navigation', async ({
	page
}, info) => {
	test.setTimeout(120_000);
	await installPointerState(page, FINE_POINTER);
	await resetAppState(page);
	await seedLibrary(page, 180, 40);

	expect(await pointerMedia(page)).toEqual({
		pointerCoarse: false,
		anyPointerCoarse: false,
		pointerFine: true,
		anyPointerFine: true
	});
	await expect(page.locator('html')).not.toHaveAttribute('data-touch-capable', 'true');

	const scroll = page.locator('#files-panel .overflow-y-auto').first();
	await scroll.evaluate((element) => {
		element.scrollTop = 600;
	});
	await expect
		.poll(() => page.locator('aside [aria-posinset]').first().getAttribute('aria-posinset'))
		.not.toBe('1');
	expectAligned(await renderedRows(page), false);

	// A desktop pointer keeps the compact density of the same controls.
	expect(
		(await page.locator('#app-toolbar button:visible').first().boundingBox())!.height
	).toBeLessThan(44);
	expect(
		(await page.locator('#app-toolbar .document-title input').boundingBox())!.height
	).toBeLessThan(44);
	expect(
		(await page.locator('.mdsh-scroll-nav button').first().boundingBox())!.height
	).toBeLessThan(44);
	await expect(page.getByTestId('selection-mode-toggle')).toHaveCount(0);

	// A plain click still opens the file, moves focus to the row and starts no
	// touch selection.
	const row = page
		.locator('#files-panel ul[aria-label^="Fichiers ouverts"] button[data-file-id]')
		.nth(2);
	const targetId = (await row.getAttribute('data-file-id'))!;
	const openedRow = page.locator(`button[data-file-id="${targetId}"]`);
	// The row is keyboard reachable before the click.
	await openedRow.focus();
	await expect(openedRow).toBeFocused();
	await openedRow.click();
	await expect(openedRow).toHaveAttribute('aria-current', 'true');
	await expect(openedRow).toBeFocused();
	await expect(page.locator('#app-toolbar .document-title input')).toHaveValue(
		targetId.replace(/\.md$/, '')
	);
	await expect(page.getByTestId('selection-count')).toHaveCount(0);
	await expect(page.locator('aside [aria-label="Actions sur la sélection"]')).toHaveCount(0);

	await info.attach('fine-pointer-desktop.json', {
		body: JSON.stringify(
			{
				media: await pointerMedia(page),
				rows: (await renderedRows(page)).map((row) => ({
					posinset: row.posinset,
					height: row.height,
					hasPath: row.hasPath
				})),
				openedFile: targetId,
				keyboardFocusBeforeClick: true,
				activeElementAfterClick: await page.evaluate(() => document.activeElement?.tagName ?? null)
			},
			null,
			2
		),
		contentType: 'application/json'
	});
});

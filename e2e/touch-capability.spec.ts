import { expect, test, type Page } from '@playwright/test';
import { resetAppState } from './helpers';

// Playwright can emulate a coarse touch device, but not a hybrid device with a
// fine primary pointer and an available coarse pointer. The application reads
// `(any-pointer: coarse)`, so this init script replaces only the pointer media
// queries and keeps every other media query native.
const POINTER_STATE = { coarsePrimary: false, coarseAny: true } as const;

async function installHybridPointer(page: Page): Promise<void> {
	await page.addInitScript((initial) => {
		type PointerState = { coarsePrimary: boolean; coarseAny: boolean };
		type PointerListener = (event: MediaQueryListEvent) => void;
		const native = window.matchMedia.bind(window);
		const state: PointerState = { ...initial };
		const registrations: Array<{
			mql: MediaQueryList;
			listeners: Set<PointerListener>;
		}> = [];
		const matchesFor = (query: string): boolean => {
			if (/any-pointer:\s*coarse/.test(query)) return state.coarseAny;
			if (/pointer:\s*coarse/.test(query)) return state.coarsePrimary;
			if (/any-pointer:\s*fine/.test(query)) return true;
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
	}, POINTER_STATE);
}

async function setPointerCapability(page: Page, next: { coarseAny: boolean }): Promise<void> {
	await page.evaluate(
		(state) =>
			(
				window as unknown as { __setPointerCapability: (value: typeof state) => void }
			).__setPointerCapability(state),
		{ coarsePrimary: false, coarseAny: next.coarseAny }
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

function pointerMedia(page: Page) {
	return page.evaluate(() => ({
		pointerCoarse: window.matchMedia('(pointer: coarse)').matches,
		anyPointerCoarse: window.matchMedia('(any-pointer: coarse)').matches,
		pointerFine: window.matchMedia('(pointer: fine)').matches,
		anyPointerFine: window.matchMedia('(any-pointer: fine)').matches
	}));
}

test('hybrid pointer keeps touch targets and virtual rows in agreement', async ({ page }, info) => {
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
	const titleTarget = await expectTouchTarget(page, '#app-toolbar .document-title input');
	const scrollNavTarget = await expectTouchTarget(page, '.mdsh-scroll-nav button');
	await page.getByRole('button', { name: 'Palette de commandes' }).click();
	const palette = page.getByRole('dialog', { name: 'Palette de commandes' });
	await expect(palette).toBeVisible();
	const dialogTarget = await expectTouchTarget(page, '[role="dialog"] button');
	await page.keyboard.press('Escape');
	const sidebarTarget = await expectTouchTarget(page, '#files-panel ul button[data-file-id]');

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

	await setPointerCapability(page, { coarseAny: false });
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

	await setPointerCapability(page, { coarseAny: true });
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
	const toggle = page.locator('#app-toolbar button[aria-controls="files-panel"]');
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

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
							content: `# Plain ${index}\n`,
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

test('hybrid pointer keeps touch targets and virtual rows in agreement', async ({ page }, info) => {
	await installHybridPointer(page);
	await resetAppState(page);
	await seedLibrary(page, 120, 40);

	await expect(page.locator('html')).toHaveAttribute('data-touch-capable', 'true');

	// Toolbar and dialog targets follow the available touch capability.
	const toolbarBox = await page.locator('#app-toolbar button:visible').first().boundingBox();
	expect(toolbarBox?.height ?? 0).toBeGreaterThanOrEqual(44);
	await page.getByRole('button', { name: 'Palette de commandes' }).click();
	const palette = page.getByRole('dialog', { name: 'Palette de commandes' });
	await expect(palette).toBeVisible();
	const dialogBox = await palette.locator('button').first().boundingBox();
	expect(dialogBox?.width ?? 0).toBeGreaterThanOrEqual(44);
	expect(dialogBox?.height ?? 0).toBeGreaterThanOrEqual(44);
	await page.keyboard.press('Escape');

	const scroll = page.locator('#files-panel .overflow-y-auto').first();
	await scroll.evaluate((element) => {
		element.scrollTop = 600;
	});
	await expect
		.poll(() => page.locator('aside [aria-posinset]').first().getAttribute('aria-posinset'))
		.not.toBe('1');

	const coarseRows = await renderedRows(page);
	expectAligned(coarseRows, true);

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
				pointer: { primary: 'fine', anyCoarse: true },
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

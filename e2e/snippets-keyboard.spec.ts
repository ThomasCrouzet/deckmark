import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { resetAppState } from './helpers';

// Snippets active-descendant keyboard coverage for Chromium, Firefox and WebKit.
//
// The legacy snippets suite stays Chromium-only because it also reads the OS
// clipboard. These layout cases stay independent of that suite. Chromium keeps
// the real clipboard readback. Firefox and WebKit do not support the
// clipboard-read permission, so they record the text passed to the real
// clipboard.writeText call and require that the real write resolves. They do
// not prove OS clipboard readback.

interface SnippetFixture {
	id: string;
	title: string;
	code: string;
	language: string;
	tags: string[];
	favorite: boolean;
	createdAt: number;
	updatedAt: number;
}

type ClipboardWrite = { text: string; ok: boolean; error?: string };
type ClipboardProbeWindow = Window & { __snippetClipboardWrites?: ClipboardWrite[] };

async function openSnippets(page: Page) {
	await page.keyboard.press('ControlOrMeta+Shift+P');
	const palette = page.getByRole('dialog', { name: 'Palette de commandes' });
	await expect(palette).toBeVisible();
	await palette.locator('input[type="text"]').fill('extraits');
	await expect(palette.getByRole('option').first()).toContainText('Extraits de code');
	await page.keyboard.press('Enter');
	await expect(page.getByTestId('snippets-dialog')).toBeVisible({ timeout: 20_000 });
}

async function seedSnippets(page: Page, rows: SnippetFixture[]) {
	await page.evaluate(
		(values) =>
			new Promise<void>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const tx = database.transaction('snippets', 'readwrite');
					const store = tx.objectStore('snippets');
					for (const value of values) store.put(value);
					tx.oncomplete = () => {
						database.close();
						resolve();
					};
					tx.onerror = () => {
						database.close();
						reject(tx.error);
					};
				};
			}),
		rows
	);
}

async function seedNavigationSnippets(page: Page) {
	const rows: SnippetFixture[] = Array.from({ length: 120 }, (_, index) => ({
		id: `nav-${String(index).padStart(3, '0')}`,
		title: `Navigation ${String(index).padStart(3, '0')}`,
		code: `const navigation${index} = ${index};\n`,
		language: 'javascript',
		tags: index % 3 === 0 ? ['navigation', 'favorite'] : ['navigation'],
		favorite: index % 3 === 0,
		createdAt: 1_700_000_000_000 + index,
		updatedAt: 1_700_000_000_000 + index
	}));
	await seedSnippets(page, rows);
	return rows;
}

async function activeSnippet(page: Page) {
	return page.evaluate(() => {
		const input = document.querySelector<HTMLInputElement>('[data-testid="snippet-search"]');
		const listbox = document.getElementById('snippet-listbox');
		const scroller = listbox?.parentElement ?? null;
		const activeId = input?.getAttribute('aria-activedescendant') ?? null;
		const row = activeId ? document.getElementById(activeId) : null;
		const rowRect = row?.getBoundingClientRect() ?? null;
		const boxRect = scroller?.getBoundingClientRect() ?? null;
		return {
			activeId,
			activeTitle: row?.querySelector('span span')?.textContent?.trim() ?? null,
			rowTop: rowRect?.top ?? null,
			rowBottom: rowRect?.bottom ?? null,
			boxTop: boxRect?.top ?? null,
			boxBottom: boxRect?.bottom ?? null,
			scrollTop: scroller?.scrollTop ?? null,
			scrollHeight: scroller?.scrollHeight ?? null,
			clientHeight: scroller?.clientHeight ?? null,
			focusIsSearch: document.activeElement === input,
			windowScrollY: window.scrollY,
			optionCount: listbox?.querySelectorAll('[role="option"]').length ?? 0
		};
	});
}

async function nextFrames(page: Page) {
	await page.evaluate(
		() =>
			new Promise<void>((resolve) => {
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
			})
	);
}

function expectFullyVisible(measurement: Awaited<ReturnType<typeof activeSnippet>>, label: string) {
	expect(measurement.activeId, label).not.toBeNull();
	expect(measurement.rowTop, label).not.toBeNull();
	expect(measurement.boxTop, label).not.toBeNull();
	expect(measurement.rowTop!, `${label}: row top`).toBeGreaterThanOrEqual(measurement.boxTop! - 1);
	expect(measurement.rowBottom!, `${label}: row bottom`).toBeLessThanOrEqual(
		measurement.boxBottom! + 1
	);
	expect(measurement.focusIsSearch, `${label}: focus`).toBe(true);
	expect(measurement.windowScrollY, `${label}: window scroll`).toBe(0);
}

async function installClipboardWriteRecorder(page: Page) {
	await page.evaluate(() => {
		const clipboard = navigator.clipboard;
		if (!clipboard?.writeText) throw new Error('The real clipboard.writeText API is absent');
		const original = clipboard.writeText.bind(clipboard);
		const writes: ClipboardWrite[] = [];
		(window as ClipboardProbeWindow).__snippetClipboardWrites = writes;
		const wrapper = async (text: string) => {
			try {
				await original(text);
				writes.push({ text, ok: true });
			} catch (error) {
				writes.push({ text, ok: false, error: String(error) });
				throw error;
			}
		};
		Object.defineProperty(clipboard, 'writeText', { value: wrapper, configurable: true });
	});
}

async function attach(info: TestInfo, name: string, value: unknown) {
	await info.attach(name, {
		body: JSON.stringify(value, null, 2),
		contentType: 'application/json'
	});
}

for (const layout of [
	{ name: '375px', width: 375, height: 812, zoom: null },
	{ name: 'zoomed-desktop', width: 1280, height: 900, zoom: '200%' }
] as const) {
	test(`keeps the active snippet visible at ${layout.name}`, async ({
		page,
		context,
		browserName
	}, info) => {
		if (browserName === 'chromium') {
			await context.grantPermissions(['clipboard-read', 'clipboard-write']);
		}
		await page.setViewportSize({ width: layout.width, height: layout.height });
		await resetAppState(page);
		await seedNavigationSnippets(page);
		if (layout.zoom) {
			await page.evaluate((zoom) => {
				document.body.style.zoom = zoom;
			}, layout.zoom);
		}
		await openSnippets(page);
		const search = page.getByTestId('snippet-search');
		await search.fill('Navigation');
		await expect(page.getByTestId('snippet-row')).toHaveCount(100, { timeout: 10_000 });
		await search.focus();

		for (let press = 0; press < 60; press += 1) await page.keyboard.press('ArrowDown');
		await nextFrames(page);
		const down = await activeSnippet(page);
		expectFullyVisible(down, 'after ArrowDown');
		expect(down.scrollTop!, 'scroller moved').toBeGreaterThan(0);
		expect(down.activeTitle).toBe('Navigation 059');

		for (let press = 0; press < 60; press += 1) await page.keyboard.press('ArrowUp');
		await nextFrames(page);
		const up = await activeSnippet(page);
		expectFullyVisible(up, 'after ArrowUp');
		expect(up.scrollTop, 'scroller returned').toBe(0);
		expect(up.activeTitle).toBe('Navigation 119');

		if (browserName !== 'chromium') await installClipboardWriteRecorder(page);
		await page.keyboard.press('Enter');
		await expect(page.getByTestId('snippet-status')).toContainText('Extrait copié');
		const copiedCode = 'const navigation119 = 119;\n';
		let clipboardEvidence: Record<string, unknown>;
		if (browserName === 'chromium') {
			await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(copiedCode);
			clipboardEvidence = { engine: browserName, proof: 'os-readback', text: copiedCode };
		} else {
			await expect
				.poll(
					async () =>
						(
							await page.evaluate(
								() => (window as ClipboardProbeWindow).__snippetClipboardWrites ?? []
							)
						).length
				)
				.toBe(1);
			const writes = await page.evaluate(
				() => (window as ClipboardProbeWindow).__snippetClipboardWrites ?? []
			);
			expect(writes).toHaveLength(1);
			expect(writes[0].ok, 'the real clipboard.writeText must resolve').toBe(true);
			expect(writes[0].text).toBe(copiedCode);
			clipboardEvidence = {
				engine: browserName,
				proof: 'instrumented real write, no OS readback',
				text: writes[0].text,
				resolved: writes[0].ok
			};
		}

		for (let press = 0; press < 5; press += 1) await page.keyboard.press('ArrowDown');
		await nextFrames(page);
		const beforeEdit = await activeSnippet(page);
		expectFullyVisible(beforeEdit, 'before Shift+Enter');
		await page.keyboard.press('Shift+Enter');
		await expect(page.getByTestId('snippet-title')).toHaveValue(beforeEdit.activeTitle ?? '');
		await page.keyboard.press('Escape');
		await expect(page.getByTestId('snippet-form')).toHaveCount(0);

		await page.getByTestId('snippet-favorites-filter').click();
		await expect(page.getByTestId('snippet-row').first()).toBeVisible();
		await search.focus();
		await expect.poll(async () => (await activeSnippet(page)).optionCount).toBeGreaterThan(0);
		await nextFrames(page);
		const filtered = await activeSnippet(page);
		expectFullyVisible(filtered, 'after favorites filter');
		expect(filtered.activeTitle, 'filter selects a visible favorite').toMatch(/^Navigation /);

		await attach(info, 'snippets-active-visibility.json', {
			layout,
			down,
			up,
			beforeEdit,
			filtered,
			clipboard: copiedCode,
			clipboardEvidence
		});
		await info.attach(`snippets-active-${layout.name}.png`, { body: await page.screenshot() });
	});
}

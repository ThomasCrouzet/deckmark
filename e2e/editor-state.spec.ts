import { createHash } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import {
	createFirstFile,
	renameActiveFile,
	resetAppState,
	seedFiles,
	switchToSource,
	writeSourceContent
} from './helpers';

async function sourceText(page: Page): Promise<string> {
	return page
		.locator('.cm-content')
		.first()
		.evaluate((element) =>
			Array.from(element.querySelectorAll('.cm-line'))
				.map((line) => line.textContent ?? '')
				.join('\n')
		);
}

async function savedPositionContent(page: Page): Promise<string> {
	return page.evaluate(
		() =>
			new Promise<string>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const rows = database.transaction('drafts').objectStore('drafts').getAll();
					rows.onerror = () => {
						database.close();
						reject(rows.error);
					};
					rows.onsuccess = () => {
						database.close();
						resolve(
							rows.result.find((row: { name: string }) => row.name === 'Position.md')?.content ?? ''
						);
					};
				};
			})
	);
}

async function openDraft(page: Page, name: string): Promise<void> {
	await page
		.locator('button[data-file-id]')
		.filter({ hasText: name.replace(/\.[a-z0-9]{1,10}$/i, '') })
		.click();
}

async function openSettings(page: Page): Promise<void> {
	await page.keyboard.press('ControlOrMeta+,');
	await expect(page.getByRole('dialog', { name: 'Réglages' })).toBeVisible();
}

async function boundedCapture<T>(capture: () => Promise<T>, milliseconds = 2000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			capture(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error('capture timed out')), milliseconds);
			})
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** Read-only boundary state for a failed selection poll. Missing fields stay null. */
async function selectionBoundary(page: Page): Promise<Record<string, unknown>> {
	return page.evaluate(() => {
		type ViewShape = {
			hasFocus: boolean;
			dom: HTMLElement;
			contentDOM: HTMLElement;
			scrollDOM: HTMLElement;
			viewport: { from: number; to: number };
			viewportHeight: number;
			visibleRanges: { from: number; to: number }[];
			state: {
				doc: { length: number };
				selection: { main: { anchor: number; head: number; empty: boolean }; ranges: unknown[] };
			};
			measureScheduled: number;
			measureRequests?: unknown[];
			viewState?: { scrollTarget?: { from?: number; y?: number; x?: number } | null };
		};
		const describeNode = (node: Node | null) => {
			if (!node) return null;
			const element = node instanceof Element ? node : node.parentElement;
			return {
				nodeType: node.nodeType,
				nodeName: node.nodeName,
				tag: element?.tagName ?? null,
				className: element?.className ?? null,
				text: (node.textContent ?? '').slice(0, 60)
			};
		};
		const selection = window.getSelection();
		const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
		const active = document.activeElement as HTMLElement | null;
		const content = document.querySelector<HTMLElement>('.cm-content');
		const view = (content as (HTMLElement & { cmTile?: { root?: { view?: ViewShape } } }) | null)
			?.cmTile?.root?.view;
		const activeFileId =
			document
				.querySelector('aside button[data-file-id][aria-current="true"]')
				?.getAttribute('data-file-id') ?? null;
		let cache: { fileId: string | null; source: unknown; read: unknown } = {
			fileId: activeFileId,
			source: null,
			read: null
		};
		try {
			const raw = sessionStorage.getItem('mdsh:editor-view-state');
			if (raw) {
				const entries = JSON.parse(raw) as {
					fileId: string;
					positions?: { source?: Record<string, unknown>; read?: Record<string, unknown> };
				}[];
				const entry = entries.find((value) => value.fileId === activeFileId);
				const bounded = (position: Record<string, unknown> | undefined) =>
					position
						? {
								anchor: typeof position.anchor === 'number' ? position.anchor : null,
								head: typeof position.head === 'number' ? position.head : null,
								scrollTop: typeof position.scrollTop === 'number' ? position.scrollTop : null
							}
						: null;
				cache = {
					fileId: activeFileId,
					source: bounded(entry?.positions?.source),
					read: bounded(entry?.positions?.read)
				};
			}
		} catch {
			cache = { fileId: activeFileId, source: 'unreadable', read: 'unreadable' };
		}
		const scrollTarget = view?.viewState?.scrollTarget
			? {
					from: view.viewState.scrollTarget.from ?? null,
					y: view.viewState.scrollTarget.y ?? null,
					x: view.viewState.scrollTarget.x ?? null
				}
			: null;
		return {
			selectionText: selection?.toString() ?? null,
			rangeCount: selection?.rangeCount ?? 0,
			collapsed: selection?.isCollapsed ?? null,
			rangeStart: describeNode(range?.startContainer ?? null),
			rangeStartOffset: range?.startOffset ?? null,
			rangeEnd: describeNode(range?.endContainer ?? null),
			rangeEndOffset: range?.endOffset ?? null,
			documentHasFocus: document.hasFocus(),
			active: active
				? {
						tag: active.tagName,
						id: active.id,
						className: active.className,
						connected: active.isConnected,
						fileId: active.getAttribute('data-file-id'),
						current: active.getAttribute('aria-current'),
						text: (active.textContent ?? '').slice(0, 50)
					}
				: null,
			cmContentCount: document.querySelectorAll('.cm-content').length,
			cache,
			view: view
				? {
						hasFocus: view.hasFocus,
						docLength: view.state.doc.length,
						anchor: view.state.selection.main.anchor,
						head: view.state.selection.main.head,
						empty: view.state.selection.main.empty,
						ranges: view.state.selection.ranges.length,
						domConnected: view.dom.isConnected,
						contentConnected: view.contentDOM.isConnected,
						scrollTop: view.scrollDOM.scrollTop,
						scrollHeight: view.scrollDOM.scrollHeight,
						clientHeight: view.scrollDOM.clientHeight,
						viewportFrom: view.viewport.from,
						viewportTo: view.viewport.to,
						viewportHeight: view.viewportHeight,
						visibleRanges: view.visibleRanges.map((entry) => [entry.from, entry.to]),
						measureScheduled: view.measureScheduled,
						measureRequests: Array.isArray(view.measureRequests)
							? view.measureRequests.length
							: null,
						scrollTarget
					}
				: null
		};
	});
}

test.describe('Editor state isolation and restoration', () => {
	test('source typing keeps undo and the caret after the store publishes its echo', async ({
		page
	}) => {
		await resetAppState(page);
		await seedFiles(page, [{ name: 'Echo.md', content: 'start' }]);
		const editor = page.locator('.cm-content').first();
		await expect(editor).toBeVisible({ timeout: 20_000 });
		await editor.click();
		await page.keyboard.press('ControlOrMeta+End');
		await page.keyboard.insertText('abc');
		await page.waitForTimeout(700);
		await expect.poll(() => sourceText(page)).toBe('startabc');
		// An own echo must not rebuild the document: the caret stays at the end.
		await page.keyboard.insertText('d');
		await expect.poll(() => sourceText(page)).toBe('startabcd');
		await page.waitForTimeout(700);
		await expect.poll(() => sourceText(page)).toBe('startabcd');
		// Undo still walks the native history instead of a rebuilt document.
		// Firefox can group the seeded text and both insertions into one undo
		// event. A single undo must remove typed text and keep a proper prefix.
		await page.keyboard.press('ControlOrMeta+z');
		await expect
			.poll(async () => {
				const text = await sourceText(page);
				return text.length < 'startabcd'.length && 'startabcd'.startsWith(text);
			})
			.toBe(true);
		await page.waitForTimeout(700);
		const undone = await sourceText(page);
		expect(undone.length).toBeLessThan('startabcd'.length);
		expect('startabcd'.startsWith(undone)).toBe(true);
	});

	for (const extension of ['md', 'txt']) {
		test(`history pressure preserves lightweight navigation in ${extension}`, async ({
			page,
			browserName
		}, info) => {
			test.skip(
				browserName !== 'chromium',
				'Firefox and WebKit do not sync the DOM selection after a deferred body mount; the cache unit tests and Chromium cover the retained coordinates.'
			);
			test.setTimeout(120_000);
			await resetAppState(page);
			const content = Array.from({ length: 400 }, (_, i) => `line ${i} navigation`).join('\n');
			const files = Array.from({ length: 35 }, (_, i) => ({
				name: `cache-${String(i).padStart(2, '0')}.${extension}`,
				mimeType: 'text/plain',
				buffer: Buffer.from(content)
			}));
			await page.locator('input[type="file"][accept*="text/markdown"]').setInputFiles(files);
			await expect(page.locator('.cm-content').first()).toBeVisible();
			// The input handler starts an asynchronous import, and every imported
			// file becomes active. Wait for the last file so a later activation
			// cannot replace the file that receives the first selection.
			await expect(page.locator('aside li[aria-setsize]').first()).toHaveAttribute(
				'aria-setsize',
				String(files.length)
			);
			await openDraft(page, files[0].name);
			await page.locator('.cm-content').first().focus();
			await page.keyboard.press('ControlOrMeta+End');
			for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowLeft');
			const selected = await page.evaluate(() => window.getSelection()?.toString());
			expect(selected).toBe('ation');
			const scroller = page.locator('.cm-scroller').first();
			await expect
				.poll(() => scroller.evaluate((element) => element.scrollTop))
				.toBeGreaterThan(100);
			for (const file of files.slice(1)) {
				await openDraft(page, file.name);
				await expect(page.locator('.cm-content').first()).toBeVisible();
			}
			await openDraft(page, files[0].name);
			await page.locator('.cm-content').first().focus();
			try {
				await expect
					.poll(() => page.evaluate(() => window.getSelection()?.toString()))
					.toBe(selected);
			} catch (error) {
				try {
					const boundary = await boundedCapture(() => selectionBoundary(page));
					console.log(`[selection-boundary] ${JSON.stringify(boundary)}`);
					await info.attach('selection-boundary.json', {
						body: JSON.stringify(boundary, null, 2),
						contentType: 'application/json'
					});
				} catch (captureError) {
					console.log(`[selection-boundary] capture unavailable: ${String(captureError)}`);
				}
				throw error;
			}
			await expect
				.poll(() => scroller.evaluate((element) => element.scrollTop))
				.toBeGreaterThan(100);
			await page.keyboard.insertText('X');
			await expect.poll(() => storedByName(page, files[0].name)).toBe(content.slice(0, -5) + 'X');
			await info.attach('navigation.json', {
				body: JSON.stringify({
					files: files.length,
					selected,
					expected: content.slice(0, -5) + 'X'
				}),
				contentType: 'application/json'
			});
		});

		test(`resident undo and immediate unsaved switch stay file-local in ${extension}`, async ({
			page
		}, info) => {
			await resetAppState(page);
			const original = '\uFEFFalpha\r\nbeta\ngamma\r\n';
			const a = `resident-a.${extension}`;
			const b = `resident-b.${extension}`;
			await page.locator('input[type="file"][accept*="text/markdown"]').setInputFiles([
				{ name: a, mimeType: 'text/plain', buffer: Buffer.from(original) },
				{ name: b, mimeType: 'text/plain', buffer: Buffer.from('OTHER_FILE\n') }
			]);
			await openDraft(page, a);
			await page.locator('.cm-content').first().focus();
			await page.keyboard.press('ControlOrMeta+End');
			await page.keyboard.insertText('TAIL');
			await openDraft(page, b);
			await page.locator('.cm-content').first().focus();
			await page.keyboard.press('ControlOrMeta+z');
			await expect.poll(() => storedByName(page, b)).toBe('OTHER_FILE\n');
			await openDraft(page, a);
			await page.locator('.cm-content').first().focus();
			await page.keyboard.press('ControlOrMeta+z');
			await expect.poll(() => storedByName(page, a)).toBe(original);
			await page.keyboard.press('ControlOrMeta+Shift+z');
			await expect.poll(() => storedByName(page, a)).toBe(original + 'TAIL');
			await info.attach('resident-text.txt', {
				body: await storedByName(page, a),
				contentType: 'text/plain'
			});
		});
	}

	test('history eviction keeps failed-save content available for retry', async ({ page }, info) => {
		await resetAppState(page);
		const original = '\uFEFFone\r\ntwo\n';
		await page.locator('input[type="file"][accept*="text/markdown"]').setInputFiles([
			{ name: 'failure-a.txt', mimeType: 'text/plain', buffer: Buffer.from(original) },
			{ name: 'failure-b.txt', mimeType: 'text/plain', buffer: Buffer.from('B') }
		]);
		await openDraft(page, 'failure-a.txt');
		await page.evaluate(() => {
			const originalPut = IDBObjectStore.prototype.put;
			IDBObjectStore.prototype.put = function (...args: Parameters<typeof originalPut>) {
				if (this.name === 'drafts' && !sessionStorage.getItem('cache-allow-save')) {
					throw new DOMException('History pressure write failure', 'QuotaExceededError');
				}
				return originalPut.apply(this, args);
			};
		});
		await page.locator('.cm-content').first().focus();
		await page.keyboard.press('ControlOrMeta+End');
		await page.keyboard.insertText('UNSAVED');
		await openDraft(page, 'failure-b.txt');
		const warning = page.getByRole('alert').filter({ hasText: 'failure-a.txt' });
		await expect(warning).toBeVisible({ timeout: 10_000 });
		await openDraft(page, 'failure-a.txt');
		await expect(page.locator('.cm-content')).toContainText('UNSAVED');
		await page.evaluate(() => sessionStorage.setItem('cache-allow-save', '1'));
		await warning.getByRole('button', { name: "Réessayer l'enregistrement" }).click();
		await expect.poll(() => storedByName(page, 'failure-a.txt')).toBe(original + 'UNSAVED');
		await info.attach('retry-text.txt', {
			body: await storedByName(page, 'failure-a.txt'),
			contentType: 'text/plain'
		});
	});

	test('large native histories switch without full state serialization', async ({ page }, info) => {
		test.setTimeout(180_000);
		await resetAppState(page);
		const files = [1_000_000, 5_000_000].map((bytes) => ({
			name: `native-${bytes}.txt`,
			mimeType: 'text/plain',
			buffer: Buffer.from(
				'line abcdefghijklmnopqrstuvwxyz\n'.repeat(Math.ceil(bytes / 32)).slice(0, bytes)
			)
		}));
		await page.locator('input[type="file"][accept*="text/markdown"]').setInputFiles(files);
		await expect(page.locator('.cm-content').first()).toBeVisible();
		const samples: unknown[] = [];
		for (const file of files) {
			await openDraft(page, file.name);
			const sample = await page.locator('.cm-editor').evaluate((root) => {
				const dom = root.querySelector('.cm-content') as HTMLElement & {
					cmTile: { root: { view: unknown } };
				};
				const view = dom.cmTile.root.view as {
					state: {
						constructor: { prototype: { toJSON: (...args: unknown[]) => unknown } };
						update: (spec: unknown) => unknown;
						doc: { length: number };
					};
					update: (transactions: unknown[]) => void;
				};
				const prototype = view.state.constructor.prototype;
				if (!sessionStorage.getItem('cache-serialization-installed')) {
					const original = prototype.toJSON;
					prototype.toJSON = function (...args: unknown[]) {
						const start = performance.now();
						const value = original.apply(this, args);
						const calls = JSON.parse(sessionStorage.getItem('cache-serialization') ?? '[]');
						calls.push({ ms: performance.now() - start });
						sessionStorage.setItem('cache-serialization', JSON.stringify(calls));
						return value;
					};
					sessionStorage.setItem('cache-serialization-installed', '1');
				}
				const transactions: unknown[] = [];
				let state = view.state;
				const start = performance.now();
				for (let i = 0; i < 2000; i++) {
					const transaction = state.update({
						changes: { from: state.doc.length, insert: 'x' },
						time: 1000 + i * 1000
					}) as { state: typeof state };
					transactions.push(transaction);
					state = transaction.state;
				}
				view.update(transactions);
				return {
					edits: transactions.length,
					ms: performance.now() - start,
					length: state.doc.length
				};
			});
			samples.push({
				file: file.name,
				sha256: createHash('sha256').update(file.buffer).digest('hex'),
				bytes: file.buffer.length,
				editBatch: sample
			});
		}
		for (let i = 0; i < 10; i++) {
			const start = performance.now();
			await openDraft(page, files[i % 2].name);
			await expect(page.locator('.cm-content').first()).toBeVisible();
			samples.push({ switch: i, wallMs: performance.now() - start });
		}
		const serialization = await page.evaluate(() =>
			JSON.parse(sessionStorage.getItem('cache-serialization') ?? '[]')
		);
		await info.attach('native-history-samples.json', {
			body: JSON.stringify({
				samples,
				serialization,
				method:
					'2000 native transactions per batch, one view update; switch wall includes browser driver and mount'
			}),
			contentType: 'application/json'
		});
		expect(serialization, 'detach must not call EditorState.toJSON').toHaveLength(0);
	});

	test('forty large files retain text through repeated history pressure', async ({
		page,
		browserName
	}, info) => {
		test.skip(
			browserName !== 'chromium',
			'Deferred bodies make the non-Chromium editor report a stale selection before hydration; the byte and history checks run on Chromium.'
		);
		test.setTimeout(180_000);
		await resetAppState(page);
		const fixture = '0123456789abcdef0123456789abcde\n'.repeat(33_334).slice(0, 1_000_000);
		const files = Array.from({ length: 40 }, (_, i) => ({
			name: `pressure-${String(i).padStart(2, '0')}.txt`,
			mimeType: 'text/plain',
			buffer: Buffer.from(fixture)
		}));
		await page.locator('input[type="file"][accept*="text/markdown"]').setInputFiles(files);
		await expect(page.locator('.cm-content').first()).toBeVisible();
		const cdp = browserName === 'chromium' ? await page.context().newCDPSession(page) : null;
		await cdp?.send('Performance.enable');
		const samples: unknown[] = [];
		for (let round = 0; round < 2; round++) {
			for (let i = 0; i < files.length; i++) {
				const start = performance.now();
				await openDraft(page, files[i].name);
				await expect(page.locator('.cm-content').first()).toBeVisible();
				const wallMs = performance.now() - start;
				if (round === 0) {
					await page.locator('.cm-content').first().focus();
					await page.keyboard.press('ControlOrMeta+End');
					await page.keyboard.insertText(`TAIL_${i}`);
				} else {
					await expect.poll(() => storedByName(page, files[i].name)).toBe(fixture + `TAIL_${i}`);
				}
				let heap = null;
				if (cdp && i % 10 === 9) {
					await cdp.send('HeapProfiler.collectGarbage');
					heap = (await cdp.send('Performance.getMetrics')).metrics.filter((metric) =>
						/JSHeap|Documents|Nodes/.test(metric.name)
					);
				}
				samples.push({ round, file: i, wallMs, heap });
			}
		}
		await cdp?.detach();
		await info.attach('pressure-samples.json', {
			body: JSON.stringify({
				fixtureBytes: Buffer.byteLength(fixture),
				fixtureSha256: createHash('sha256').update(fixture).digest('hex'),
				files: 40,
				samples,
				method:
					'switch wall includes driver/mount; forced GC before heap samples; no latency gate change'
			}),
			contentType: 'application/json'
		});
	});

	test('keeps source undo inside its draft and persists the safe result', async ({ page }) => {
		await resetAppState(page);
		await seedFiles(page, [
			{ name: 'Draft A.md', content: 'CONTENT_FROM_DRAFT_A' },
			{ name: 'Draft B.md', content: 'CONTENT_FROM_DRAFT_B' }
		]);

		const editor = page.locator('.cm-content').first();
		await editor.click();
		await page.keyboard.press('ControlOrMeta+z');
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(() => sourceText(page)).not.toContain('CONTENT_FROM_DRAFT_A');

		await page.waitForTimeout(700);
		await page.reload();
		await switchToSource(page);
		await expect.poll(() => sourceText(page)).not.toContain('CONTENT_FROM_DRAFT_A');

		const savedB = await page.evaluate(
			() =>
				new Promise<string>((resolve, reject) => {
					const request = indexedDB.open('mdsh');
					request.onerror = () => reject(request.error);
					request.onsuccess = () => {
						const database = request.result;
						const rows = database.transaction('drafts').objectStore('drafts').getAll();
						rows.onerror = () => reject(rows.error);
						rows.onsuccess = () => {
							const draft = rows.result.find((row: { name: string }) => row.name === 'Draft B.md');
							database.close();
							resolve(draft?.content ?? '');
						};
					};
				})
		);
		expect(savedB).not.toContain('CONTENT_FROM_DRAFT_A');
	});

	test('localizes source search without losing undo, selection, or scroll', async ({ page }) => {
		await resetAppState(page);
		await createFirstFile(page);
		await renameActiveFile(page, 'Position.md');
		const content = Array.from({ length: 400 }, (_, index) =>
			index === 0 ? 'ALPHA omega' : `line ${index}`
		).join('\n');
		await writeSourceContent(page, content);

		const scroller = page.locator('.cm-scroller');
		await scroller.hover();
		await page.mouse.wheel(0, 600);
		await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
		await scroller.click({ position: { x: 120, y: 120 } });
		await page.keyboard.insertText('POSITIONTOKEN');
		await expect.poll(() => savedPositionContent(page)).toContain('POSITIONTOKEN');
		await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);

		await page.reload();
		await switchToSource(page);
		await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
		const savedBeforeEdit = await savedPositionContent(page);
		await page.locator('.cm-content').first().focus();
		await page.keyboard.insertText('X');
		await expect.poll(() => savedPositionContent(page)).toContain('POSITIONTOKENX');

		await page.keyboard.press('ControlOrMeta+f');
		await expect(page.locator('.cm-search input[name="search"]')).toHaveAttribute(
			'placeholder',
			'Rechercher'
		);
		const searchInput = page.locator('.cm-search input[name="search"]');
		const replaceInput = page.locator('.cm-search input[name="replace"]');
		await searchInput.fill('line');
		await replaceInput.fill('row');
		await page.locator('.cm-search input[name="case"]').check();
		await searchInput.click();
		await openSettings(page);
		await page
			.getByRole('group', { name: 'Langue' })
			.getByRole('button', { name: 'English' })
			.click();
		await page
			.getByRole('dialog', { name: 'Settings' })
			.getByRole('button', { name: 'Close', exact: true })
			.click();

		await expect(page.locator('.cm-content').first()).toHaveAttribute(
			'aria-label',
			'Markdown document editor'
		);
		await expect(page.locator('.cm-search input[name="search"]')).toHaveAttribute(
			'placeholder',
			'Find'
		);
		await expect(page.locator('.cm-search button[name="next"]')).toHaveText('next');
		await expect(searchInput).toHaveValue('line');
		await expect(replaceInput).toHaveValue('row');
		await expect(replaceInput).toHaveAttribute('placeholder', 'Replace');
		await expect(page.locator('.cm-search input[name="case"]')).toBeChecked();
		await expect(searchInput).toBeFocused();

		await page.keyboard.press('Escape');
		await expect(page.locator('.cm-search')).toBeHidden();
		await expect(page.locator('.cm-content').first()).toBeFocused();
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(() => savedPositionContent(page)).not.toContain('POSITIONTOKENX');
		await expect.poll(() => savedPositionContent(page)).toContain('POSITIONTOKEN');
		await expect.poll(() => savedPositionContent(page)).toBe(savedBeforeEdit);
		await page.reload();
		await expect.poll(() => savedPositionContent(page)).toBe(savedBeforeEdit);
	});

	test('restores the Replace button after a locale change and keeps keyboard replacement durable', async ({
		page
	}) => {
		await resetAppState(page);
		await createFirstFile(page);
		await renameActiveFile(page, 'Position.md');
		const content = 'ALPHA omega\nALPHA end';
		await writeSourceContent(page, content);
		await expect.poll(() => savedPositionContent(page)).toBe(content);
		await page.keyboard.press('ControlOrMeta+f');
		const searchInput = page.locator('.cm-search input[name="search"]');
		const replaceInput = page.locator('.cm-search input[name="replace"]');
		const replaceButton = page.locator('.cm-search button[name="replace"]');
		await searchInput.fill('ALPHA');
		await replaceInput.fill('BETA');
		await page.keyboard.press('Tab');
		await expect(replaceButton).toBeFocused();
		await openSettings(page);
		await page
			.getByRole('group', { name: 'Langue' })
			.getByRole('button', { name: 'English' })
			.click();
		await page
			.getByRole('dialog', { name: 'Settings' })
			.getByRole('button', { name: 'Close', exact: true })
			.click();
		await expect(replaceButton).toHaveText('replace');
		await expect(replaceButton).toBeFocused();
		await expect(replaceInput).toHaveValue('BETA');
		await page.keyboard.press('Space');
		await expect(page.locator('.cm-searchMatch-selected')).toHaveText('ALPHA');
		await expect(replaceButton).toBeFocused();
		await page.keyboard.press('Space');
		await expect.poll(() => savedPositionContent(page)).toBe('BETA omega\nALPHA end');
		await expect(replaceInput).toHaveValue('BETA');
		await page.keyboard.press('Escape');
		await expect(page.locator('.cm-search')).toBeHidden();
		await expect(page.locator('.cm-content').first()).toBeFocused();
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(() => savedPositionContent(page)).toBe(content);
		await page.reload();
		await expect.poll(() => savedPositionContent(page)).toBe(content);
	});

	test('keeps the WYSIWYG instance and restores positions in visual and reading modes', async ({
		page
	}) => {
		await resetAppState(page, { mode: 'wysiwyg' });
		await createFirstFile(page);
		await renameActiveFile(page, 'Visual A.md');
		const proseMirror = page.locator('.ProseMirror');
		await expect(proseMirror).toBeVisible({ timeout: 20_000 });
		await proseMirror.fill('Base locale');
		await page.waitForTimeout(600);
		await proseMirror.click();
		await page.keyboard.press('End');
		await page.keyboard.insertText(' TAIL');
		await proseMirror.evaluate((element) => element.setAttribute('data-editor-token', 'same'));

		await openSettings(page);
		await page
			.getByRole('group', { name: 'Langue' })
			.getByRole('button', { name: 'English' })
			.click();
		await page
			.getByRole('dialog', { name: 'Settings' })
			.getByRole('button', { name: 'Close', exact: true })
			.click();
		await expect(proseMirror).toHaveAttribute('data-editor-token', 'same');
		await expect(proseMirror).toHaveAttribute('aria-label', 'Markdown document editor');
		await proseMirror.click();
		await page.keyboard.press('ControlOrMeta+z');
		await expect(proseMirror).not.toContainText('TAIL');
		await expect(proseMirror).toContainText('Base locale');
		await page.keyboard.press('End');
		await page.keyboard.press('Enter');
		await page.keyboard.insertText('/');
		const slashMenu = page.locator('.milkdown-slash-menu');
		await expect(slashMenu).toBeVisible();
		await expect(slashMenu.locator('.tab-group li')).toHaveText(['Text', 'Lists', 'Advanced']);
		await page.keyboard.press('Escape');
		await proseMirror.fill('Base locale');

		await page.keyboard.press('ControlOrMeta+a');
		await page.keyboard.press('ArrowLeft');
		for (let index = 0; index < 4; index++) await page.keyboard.press('ArrowRight');
		await page.keyboard.press('ControlOrMeta+n');
		await page.getByTestId('create-note').click();
		await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 20_000 });
		const fileName = page.locator('input[aria-label^="File name"]');
		await fileName.fill('Visual B.md');
		await fileName.press('Enter');
		await openDraft(page, 'Visual A');
		await expect(page.locator('.ProseMirror')).toContainText('Base locale');
		await page.locator('.ProseMirror').focus();
		await page.keyboard.insertText('X');
		await expect(page.locator('.ProseMirror')).toContainText('BaseX locale');

		await switchToSource(page);
		await writeSourceContent(
			page,
			Array.from({ length: 120 }, (_, index) => `Reading line ${index}`).join('\n')
		);
		await page.locator('button[data-mode="read"]').click();
		await expect(page.locator('.mdsh-preview')).toContainText('Reading line 119');
		await page.locator('.mdsh-read').evaluate((element) => (element.scrollTop = 500));
		await openDraft(page, 'Visual B');
		await openDraft(page, 'Visual A');
		await expect
			.poll(() => page.locator('.mdsh-read').evaluate((element) => element.scrollTop))
			.toBeGreaterThan(100);
	});
});

async function storedByName(page: Page, name: string): Promise<string> {
	return page.evaluate(
		(fileName) =>
			new Promise<string>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const rows = database.transaction('drafts').objectStore('drafts').getAll();
					rows.onerror = () => {
						database.close();
						reject(rows.error);
					};
					rows.onsuccess = () => {
						database.close();
						resolve(rows.result.find((row) => row.name === fileName)?.content ?? '');
					};
				};
			}),
		name
	);
}

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { chromium, firefox, webkit } from '@playwright/test';
import { stressFixture, stressLibrary } from './benchmark-fixtures/stress.mjs';

const root = resolve(import.meta.dirname, '..', 'build');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const types = {
	'.html': 'text/html',
	'.js': 'application/javascript',
	'.css': 'text/css',
	'.json': 'application/json',
	'.svg': 'image/svg+xml',
	'.webmanifest': 'application/manifest+json',
	'.woff2': 'font/woff2'
};
const mainId = 'stress-main';
const sentinelId = 'stress-sentinel';

async function serve(port) {
	const server = createServer(async (request, response) => {
		try {
			const name = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname).replace(
				/^\/+/,
				''
			);
			const path = resolve(root, name || 'index.html');
			const from = relative(root, path);
			if (from.startsWith(`..${sep}`) || isAbsolute(from)) throw new Error('Path outside build.');
			const target = (await stat(path)).isFile() ? path : resolve(root, 'index.html');
			response.writeHead(200, {
				'Content-Type': types[extname(target)] ?? 'application/octet-stream',
				'Cache-Control': 'no-store'
			});
			response.end(await readFile(target));
		} catch {
			response.writeHead(404);
			response.end();
		}
	});
	await new Promise((resolvePromise, reject) => {
		server.once('error', reject);
		server.listen(port, '127.0.0.1', resolvePromise);
	});
	return server;
}

async function shell(page) {
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor({ timeout: 30_000 });
}

async function seed(page, fixture, entry) {
	const sentinelContent =
		entry.mode === 'json' ? '{"payload":"sentinel"}' : 'Stable sentinel content.\n';
	const extension = fixture.name.split('.').at(-1);
	const rows = [
		{ id: mainId, name: fixture.name, content: fixture.content },
		{ id: sentinelId, name: `sentinel.${extension}`, content: sentinelContent },
		...stressLibrary(entry.library)
	].map((row, order) => ({
		...row,
		order,
		open: order < 2,
		createdAt: 1_700_000_000_000,
		updatedAt: 1_700_000_000_000
	}));
	await page.evaluate(
		async ({ rows, mode }) => {
			if (!globalThis.indexedDB || !globalThis.localStorage)
				throw new Error('Browser storage is unavailable.');
			await new Promise((resolvePromise, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const db = request.result;
					const tx = db.transaction('drafts', 'readwrite');
					tx.objectStore('drafts').clear();
					for (const row of rows) tx.objectStore('drafts').put(row);
					tx.oncomplete = () => {
						db.close();
						resolvePromise();
					};
					tx.onabort = () => {
						db.close();
						reject(tx.error);
					};
				};
			});
			localStorage.setItem('mdsh:activeId', 'stress-main');
			localStorage.setItem('mdsh:mode', 'source');
			localStorage.setItem('mdsh:locale', 'en');
			localStorage.setItem('mdsh:split-view', mode === 'split' ? '1' : '0');
		},
		{ rows, mode: entry.mode }
	);
	return sentinelContent;
}

async function stored(page, id = mainId) {
	return page.evaluate(
		(id) =>
			new Promise((resolvePromise, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const db = request.result;
					const row = db.transaction('drafts').objectStore('drafts').get(id);
					row.onsuccess = () => {
						db.close();
						resolvePromise(row.result?.content);
					};
					row.onerror = () => {
						db.close();
						reject(row.error);
					};
				};
			}),
		id
	);
}

async function waitStored(page, expected, id = mainId) {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if ((await stored(page, id)) === expected) return;
		await page.waitForTimeout(50);
	}
	assert.equal(await stored(page, id), expected, `Stored bytes did not match for ${id}`);
}

async function editorState(page, offset) {
	return page
		.locator('.cm-content')
		.first()
		.evaluate((element, offset) => {
			const view = element.cmView?.view ?? element.cmTile?.root?.view;
			if (!view?.state?.doc) throw new Error('The full CodeMirror document is unavailable.');
			if (offset !== undefined) {
				view.dispatch({ selection: { anchor: offset }, scrollIntoView: true });
				view.focus();
			}
			return view.state.doc.toString();
		}, offset);
}

async function waitEditor(page, expected) {
	await page.waitForFunction((expected) => {
		const element = document.querySelector('.cm-content');
		const view = element?.cmView?.view ?? element?.cmTile?.root?.view;
		return view?.state?.doc?.toString() === expected;
	}, expected);
}

async function arm(page, delay) {
	await page.evaluate((delay) => {
		const element = document.querySelector('.cm-content');
		if (!element) throw new Error('Missing input target.');
		const state = {
			started: null,
			dispatch: null,
			frame: null,
			trusted: false,
			longTasks: []
		};
		window.__stressInput = state;
		const listener = (event) => {
			state.started = performance.now();
			state.trusted = event.isTrusted;
			state.inputType = event.inputType;
			while (performance.now() - state.started < delay) {
				/* Explicit browser-local negative control. */
			}
			queueMicrotask(() => {
				state.dispatch = performance.now() - state.started;
			});
			requestAnimationFrame(() =>
				requestAnimationFrame(() => {
					state.frame = performance.now() - state.started;
				})
			);
		};
		element.addEventListener('beforeinput', listener, { capture: true, once: true });
		const supported = PerformanceObserver.supportedEntryTypes.includes('longtask');
		state.longTasksSupported = supported;
		if (supported) {
			state.observer = new PerformanceObserver((list) =>
				state.longTasks.push(...list.getEntries().map((entry) => entry.duration))
			);
			state.observer.observe({ entryTypes: ['longtask'] });
		}
	}, delay);
}

async function sample(page, expected, index, mode, delay) {
	const ratios = [0.02, 0.5, 0.98];
	const offset = Math.round(expected.length * ratios[index % 3]);
	assert.equal(await editorState(page, offset), expected);
	await page.evaluate(
		() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
	);
	await arm(page, delay);
	const insertion = 'x';
	const next = expected.slice(0, offset) + insertion + expected.slice(offset);
	const result = {
		index,
		status: 'started',
		position: ['start', 'middle', 'end'][index % 3],
		operation: 'insert',
		offset,
		metrics: {},
		fidelity: {},
		optional: {}
	};
	try {
		await page.keyboard.insertText(insertion);
		await page.waitForFunction(
			() => window.__stressInput?.frame !== null && window.__stressInput?.frame !== undefined
		);
		const value = await page.evaluate(() => ({
			started: window.__stressInput.started,
			frame: window.__stressInput.frame,
			dispatch: window.__stressInput.dispatch,
			trusted: window.__stressInput.trusted,
			inputType: window.__stressInput.inputType
		}));
		assert.equal(value.trusted, true, 'No trusted beforeinput event was observed.');
		assert.equal(value.inputType, 'insertText');
		result.input = { trusted: value.trusted, type: value.inputType };
		assert.equal(
			await editorState(page),
			next,
			'The measured input did not produce the expected bytes.'
		);
		if (mode === 'json') JSON.parse(next);
		await waitStored(page, next);
		result.metrics = {
			inputToFrameMs: value.frame,
			inputDispatchMs: value.dispatch,
			saveObservedMs: await page.evaluate((started) => performance.now() - started, value.started)
		};
		result.fidelity = {
			expectedSha256: hash(next),
			editorSha256: hash(await editorState(page)),
			storedSha256: hash(await stored(page))
		};
		result.optional = await page.evaluate(() => {
			const state = window.__stressInput;
			state.observer?.disconnect();
			return {
				longTasks: state.longTasksSupported
					? { supported: true, unit: 'ms', values: state.longTasks }
					: {
							supported: false,
							reason: 'This engine does not expose the longtask PerformanceObserver entry type.'
						},
				heap: performance.memory
					? {
							supported: true,
							unit: 'bytes',
							value: performance.memory.usedJSHeapSize,
							note: 'Engine estimate. Not process RSS.'
						}
					: { supported: false, reason: 'This engine does not expose performance.memory.' },
				transactionCpu: {
					supported: false,
					reason:
						'No pure transaction CPU boundary is exposed. inputDispatchMs measures the event task.'
				},
				preview: {
					supported: false,
					reason: 'A verified preview-completion boundary is not implemented in this adapter.'
				},
				validation: {
					supported: false,
					reason: 'A verified validation-completion boundary is not implemented in this adapter.'
				},
				postIdleCpu: {
					supported: false,
					reason: 'The browser transport does not expose a portable post-idle CPU counter.'
				},
				rss: {
					supported: false,
					reason: 'The browser transport does not expose attributable process-tree RSS.'
				}
			};
		});
		result.resources = await page.evaluate(() => ({
			domNodes: document.querySelectorAll('*').length,
			canvases: [...document.querySelectorAll('canvas')].map((canvas) => ({
				width: canvas.width,
				height: canvas.height
			}))
		}));
		result.status = 'passed';
		return { result, next };
	} catch (error) {
		result.status = 'failed';
		result.error = String(error.stack ?? error);
		return { result, next: expected };
	}
}

async function runCase(browser, url, entry, report, options) {
	const fixture = stressFixture(entry.fixture);
	const artifactPrefix = `${options.output}.${entry.id.replaceAll('/', '_')}`;
	const fixturePath = `${artifactPrefix}.fixture.${fixture.name.split('.').at(-1)}`;
	await writeFile(fixturePath, fixture.content, { flag: 'wx' });
	const result = {
		id: entry.id,
		status: 'running',
		fixture: { ...fixture, content: undefined, path: fixturePath },
		samples: [],
		fidelity: {},
		errors: []
	};
	report.cases.push(result);
	if (entry.adapter !== 'web') {
		result.status = 'unavailable';
		result.reason = entry.reason;
		return;
	}
	const context = await browser.newContext({
		locale: 'en-US',
		acceptDownloads: true,
		serviceWorkers: 'block'
	});
	const deadline = setTimeout(() => void context.close(), 180_000);
	const page = await context.newPage();
	page.setDefaultTimeout(20_000);
	page.on('pageerror', (error) => result.errors.push(String(error)));
	try {
		await page.goto(url);
		await shell(page);
		const sentinel = await seed(page, fixture, entry);
		await page.reload();
		await shell(page);
		await page.locator('.cm-content').first().waitFor();
		if (entry.mode === 'split') await page.getByTestId('split-view').waitFor();
		else if (entry.mode === 'code' || entry.mode === 'json')
			await page.getByTestId('code-editor').waitFor();
		assert.equal(await editorState(page), fixture.content);
		let expected = fixture.content;
		let previous = expected;
		for (let index = 0; index < options.runs; index++) {
			previous = expected;
			const measured = await sample(page, expected, index, entry.mode, options.injectedDelayMs);
			result.samples.push(measured.result);
			if (measured.result.status !== 'passed') throw new Error(measured.result.error);
			expected = measured.next;
			await page.waitForTimeout(550);
		}
		result.fidelity.saved = true;
		const mainButton = page.locator(`aside button[data-file-id="${mainId}"]`);
		const otherButton = page.locator(`aside button[data-file-id="${sentinelId}"]`);
		await otherButton.click();
		await waitEditor(page, sentinel);
		const sentinelOffset = entry.mode === 'json' ? sentinel.length - 2 : sentinel.length;
		await editorState(page, sentinelOffset);
		await page.keyboard.insertText('x');
		const sentinelEdited = sentinel.slice(0, sentinelOffset) + 'x' + sentinel.slice(sentinelOffset);
		assert.equal(
			await editorState(page),
			sentinelEdited,
			'The second file must accept its edit before undo.'
		);
		await waitStored(page, sentinelEdited, sentinelId);
		await page.keyboard.press('ControlOrMeta+z');
		assert.equal(await editorState(page), sentinel);
		await waitStored(page, sentinel, sentinelId);
		await mainButton.click();
		await waitEditor(page, expected);
		await editorState(page, 0);
		await page.keyboard.press('ControlOrMeta+z');
		assert.equal(
			await editorState(page),
			previous,
			'Undo must affect the last edit in this file only.'
		);
		await waitStored(page, previous);
		result.fidelity.perFileUndo = true;
		const redoShortcut = await page.evaluate(() =>
			/Mac/.test(navigator.platform) ? 'Meta+Shift+Z' : 'Control+y'
		);
		await page.evaluate(() => {
			window.__stressRedoKeys = [];
			const listener = (event) => {
				window.__stressRedoKeys.push({
					key: event.key,
					code: event.code,
					ctrl: event.ctrlKey,
					meta: event.metaKey,
					shift: event.shiftKey,
					trusted: event.isTrusted,
					targetIsEditor: event.target instanceof Element && !!event.target.closest('.cm-content')
				});
			};
			window.__stressRedoListener = listener;
			document.addEventListener('keydown', listener, true);
		});
		await page.keyboard.press(redoShortcut);
		const redoKeys = await page.evaluate(() => {
			document.removeEventListener('keydown', window.__stressRedoListener, true);
			return window.__stressRedoKeys;
		});
		const redoKey = redoShortcut === 'Control+y' ? 'y' : 'Z';
		assert.ok(
			redoKeys.some(
				(event) =>
					event.key === redoKey &&
					event.trusted &&
					event.targetIsEditor &&
					(redoShortcut === 'Control+y' ? event.ctrl && !event.shift : event.meta && event.shift)
			)
		);
		result.history = { undoShortcut: 'ControlOrMeta+z', redoShortcut, redoKeys };
		assert.equal(await editorState(page), expected);
		result.fidelity.redo = true;
		await waitStored(page, expected);
		const pending = page.waitForEvent('download');
		await page.keyboard.press('ControlOrMeta+Shift+e');
		const download = await pending;
		const bytes = await readFile(await download.path());
		assert.deepEqual(bytes, Buffer.from(expected));
		assert.equal(download.suggestedFilename(), fixture.name);
		const exportPath = `${artifactPrefix}.export.${fixture.name.split('.').at(-1)}`;
		await writeFile(exportPath, bytes, { flag: 'wx' });
		result.export = {
			path: exportPath,
			name: download.suggestedFilename(),
			bytes: bytes.length,
			sha256: hash(bytes)
		};
		result.fidelity.exported = true;
		await page.reload();
		await shell(page);
		await page.locator('.cm-content').first().waitFor();
		assert.equal(await editorState(page), expected);
		assert.equal(await stored(page, sentinelId), sentinel);
		result.fidelity.recovered = true;
		assert.deepEqual(result.errors, []);
		result.status = 'passed';
	} catch (error) {
		result.status = 'failed';
		result.reason = String(error.stack ?? error);
		result.screenshot = await page
			.screenshot({ path: `${artifactPrefix}.failure.png` })
			.then(() => `${artifactPrefix}.failure.png`)
			.catch(String);
		result.page = await page
			.evaluate(() => ({
				url: location.href,
				active: document.activeElement?.outerHTML,
				alerts: [...document.querySelectorAll('[role="alert"]')].map(
					(element) => element.textContent
				)
			}))
			.catch(String);
	} finally {
		clearTimeout(deadline);
		await context.close();
	}
}

export async function runStressWeb({ report, selected, options }) {
	const edition = JSON.parse(await readFile(resolve(root, 'edition.json'), 'utf8'));
	assert.equal(edition.edition, 'web');
	assert.equal(edition.basePath, '', 'Stress runner requires a root production build.');
	const server = await serve(options.port);
	let browser;
	try {
		browser = await { chromium, firefox, webkit }[report.renderer.name].launch();
		report.renderer.version = browser.version();
		for (const entry of selected)
			await runCase(browser, `http://127.0.0.1:${options.port}/`, entry, report, options);
	} finally {
		await browser?.close();
		server.closeAllConnections();
		await new Promise((done) => server.close(done));
	}
}

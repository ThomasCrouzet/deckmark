import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { chromium, firefox, webkit } from '@playwright/test';
import { modeFixture } from './benchmark-fixtures/modes.mjs';
import { sentinelText } from './benchmark-stress-contract.mjs';

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
const mainId = 'mode-main';
const sentinelId = 'mode-sentinel';

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

async function seed(page, fixture) {
	const sentinelContent = sentinelText('read');
	const extension = fixture.name.split('.').at(-1);
	const rows = [
		{ id: mainId, name: fixture.name, content: fixture.content },
		{ id: sentinelId, name: `sentinel.${extension}`, content: sentinelContent }
	].map((row, order) => ({
		...row,
		order,
		open: order < 2,
		createdAt: 1_700_000_000_000,
		updatedAt: 1_700_000_000_000
	}));
	const observed = await page.evaluate(
		async ({ rows }) => {
			const saved = await new Promise((resolvePromise, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const db = request.result;
					const tx = db.transaction('drafts', 'readwrite');
					tx.objectStore('drafts').clear();
					for (const row of rows) tx.objectStore('drafts').put(row);
					const read = tx.objectStore('drafts').getAll();
					tx.oncomplete = () => {
						db.close();
						resolvePromise(read.result);
					};
					tx.onabort = () => {
						db.close();
						reject(tx.error);
					};
				};
			});
			localStorage.setItem('mdsh:activeId', 'mode-main');
			localStorage.setItem('mdsh:mode', 'source');
			localStorage.setItem('mdsh:locale', 'en');
			localStorage.setItem('mdsh:split-view', '0');
			return saved;
		},
		{ rows }
	);
	const background = observed
		.filter((row) => row.id !== mainId && row.id !== sentinelId)
		.sort((a, b) => a.id.localeCompare(b.id));
	return {
		sentinelContent,
		library: {
			count: background.length,
			totalRows: observed.length,
			idsSha256: hash(JSON.stringify(background.map((row) => row.id))),
			rowsSha256: hash(JSON.stringify(background))
		}
	};
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

async function waitStored(page, predicate, label, timeout = 30_000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const content = await stored(page);
		if (predicate(content)) return content;
		await page.waitForTimeout(50);
	}
	assert.fail(`Stored source did not match ${label}`);
}

async function optional(page) {
	return page.evaluate(() => {
		const supported = PerformanceObserver.supportedEntryTypes.includes('longtask');
		let longTasks = { supported: false, reason: 'No longtask entry type.' };
		if (supported) {
			const values = [];
			const observer = new PerformanceObserver((list) =>
				values.push(...list.getEntries().map((entry) => entry.duration))
			);
			observer.observe({ entryTypes: ['longtask'] });
			longTasks = { supported: true, unit: 'ms', values };
			setTimeout(() => observer.disconnect(), 0);
		}
		const heap = performance.memory
			? {
					supported: true,
					unit: 'bytes',
					origin: 'performance.memory-estimate',
					value: performance.memory.usedJSHeapSize,
					note: 'Engine estimate. Not process RSS.'
				}
			: { supported: false, reason: 'This engine does not expose performance.memory.' };
		return {
			longTasks,
			heap,
			transactionCpu: {
				supported: false,
				reason: 'No pure transaction CPU boundary is exposed.'
			},
			preview: { supported: false, reason: 'Not instrumented in this adapter.' },
			validation: { supported: false, reason: 'Not instrumented in this adapter.' },
			postIdleCpu: {
				supported: false,
				reason: 'The browser transport exposes no portable post-idle CPU counter.'
			},
			rss: {
				supported: false,
				reason: 'The browser transport exposes no attributable process-tree RSS.'
			}
		};
	});
}

async function resources(page) {
	return page.evaluate(() => ({
		units: { domNodes: 'count', canvasDimensions: 'backing-pixels' },
		domNodes: document.querySelectorAll('*').length,
		canvases: [...document.querySelectorAll('canvas')].map((canvas) => ({
			width: canvas.width,
			height: canvas.height
		}))
	}));
}

async function readSample(page, entry, index) {
	const fixture = modeFixture(entry.fixture);
	const expected = entry.fixture === 'read-rich-30' ? 30 : 0;
	await page.evaluate(() => localStorage.setItem('mdsh:mode', 'source'));
	await page.reload();
	await shell(page);
	await page.evaluate(() => {
		window.__modeRead = { started: performance.now(), first: null, full: null };
	});
	await page.locator('[data-mode=read]').click();
	await page.waitForFunction(
		() => document.querySelector('.mdsh-preview')?.textContent?.includes('Read tail sentinel'),
		undefined,
		{ timeout: 120_000 }
	);
	const first = await page.evaluate(() => {
		const state = window.__modeRead;
		state.first = performance.now() - state.started;
		return state.first;
	});
	await page.waitForFunction(
		(count) => document.querySelectorAll('.mdsh-preview .mermaid-block svg').length >= count,
		expected,
		{ timeout: 120_000 }
	);
	const full = await page.evaluate(() => {
		const state = window.__modeRead;
		state.full = performance.now() - state.started;
		return state.full;
	});
	const article = await page.locator('.mdsh-preview').innerText();
	const diagrams = await page.locator('.mdsh-preview .mermaid-block svg').count();
	const source = await stored(page);
	return {
		result: {
			index,
			status: 'passed',
			metrics: {
				firstContentMs: first,
				fullRenderMs: full,
				diagramCount: diagrams
			},
			fidelity: {
				tail: article.includes('Read tail sentinel'),
				diagramCount: diagrams === expected,
				sourceSha256: hash(source),
				fixtureSha256: fixture.sha256
			},
			optional: await optional(page),
			resources: await resources(page)
		}
	};
}

async function openTextEditor(page) {
	await page.locator('[data-testid="slide-object"][data-object-type="text"]').first().dblclick();
	const field = page.locator('[data-testid="slide-text-editor"]');
	await field.waitFor({ timeout: 10_000 });
	return field;
}

async function slideField(page, mode) {
	if (mode === 'slide-text') {
		const field = await openTextEditor(page);
		return {
			field,
			value: await field.inputValue(),
			finish: async () => page.locator('[data-testid="slide-text-done"]').click()
		};
	}
	const field = page.locator('[data-testid="slide-notes"]');
	await field.waitFor({ timeout: 10_000 });
	return {
		field,
		value: await field.inputValue(),
		finish: async () => page.keyboard.press('Tab')
	};
}

async function slideSample(page, entry, index, fieldValue, delay) {
	const ratios = [0.02, 0.5, 0.98];
	const offset = Math.round(fieldValue.length * ratios[index % 3]);
	await page.evaluate(
		({ selector, offset }) => {
			const field = document.querySelector(selector);
			if (!(field instanceof HTMLTextAreaElement)) throw new Error('Missing textarea.');
			field.focus();
			field.setSelectionRange(offset, offset);
		},
		{
			selector:
				entry.mode === 'slide-text'
					? '[data-testid="slide-text-editor"]'
					: '[data-testid="slide-notes"]',
			offset
		}
	);
	await page.evaluate((delay) => {
		const field = document.querySelector(
			'[data-testid="slide-text-editor"], [data-testid="slide-notes"]'
		);
		if (!(field instanceof HTMLTextAreaElement)) throw new Error('Missing textarea.');
		const state = { started: null, dispatch: null, frame: null, trusted: false };
		window.__modeInput = state;
		field.addEventListener(
			'beforeinput',
			(event) => {
				state.started = performance.now();
				state.trusted = event.isTrusted;
				while (performance.now() - state.started < delay) {
					/* Explicit local negative control. */
				}
				queueMicrotask(() => {
					state.dispatch = performance.now() - state.started;
				});
				requestAnimationFrame(() =>
					requestAnimationFrame(() => {
						state.frame = performance.now() - state.started;
					})
				);
			},
			{ capture: true, once: true }
		);
	}, delay);
	const measured = await page.evaluate(() => window.__modeInput.started);
	await page.keyboard.insertText('x');
	await page.waitForFunction(
		() => window.__modeInput?.frame !== null && window.__modeInput?.frame !== undefined
	);
	const observed = await page.evaluate(() => ({
		frame: window.__modeInput.frame,
		dispatch: window.__modeInput.dispatch,
		trusted: window.__modeInput.trusted
	}));
	const next = fieldValue.slice(0, offset) + 'x' + fieldValue.slice(offset);
	const finish = page.locator('[data-testid="slide-text-done"]');
	if (entry.mode === 'slide-text') await finish.click();
	else await page.keyboard.press('Tab');
	const content = await waitStored(page, (source) => source.includes(next), `sample ${index}`);
	const saveObservedMs = await page.evaluate((started) => performance.now() - started, measured);
	return {
		result: {
			index,
			status: 'passed',
			position: ['start', 'middle', 'end'][index % 3],
			operation: 'insert',
			insertedText: 'x',
			offset,
			sourceLength: fieldValue.length,
			input: { trusted: observed.trusted, type: 'insertText', targetIsEditor: true },
			metrics: {
				inputToFrameMs: observed.frame,
				inputDispatchMs: observed.dispatch,
				saveObservedMs
			},
			fidelity: {
				expectedFieldSha256: hash(next),
				storedSha256: hash(content),
				storedOrigin: 'indexeddb-drafts-row'
			},
			optional: await optional(page),
			resources: await resources(page)
		},
		next
	};
}

async function runReadCase(browser, url, entry, report, options) {
	const fixture = modeFixture(entry.fixture);
	const artifactPrefix = `${options.output}.${entry.id.replaceAll('/', '_')}`;
	await writeFile(`${artifactPrefix}.fixture.md`, fixture.content, { flag: 'wx' });
	const result = {
		id: entry.id,
		status: 'running',
		fixture: { ...fixture, content: undefined, path: `${artifactPrefix}.fixture.md` },
		samples: [],
		fidelity: {},
		errors: []
	};
	report.cases.push(result);
	const context = await browser.newContext({
		locale: 'en-US',
		acceptDownloads: true,
		serviceWorkers: 'block'
	});
	const page = await context.newPage();
	page.setDefaultTimeout(30_000);
	page.on('pageerror', (error) => result.errors.push(String(error)));
	try {
		await page.goto(url);
		await shell(page);
		const seeded = await seed(page, fixture);
		result.workload = { mode: entry.mode, library: seeded.library };
		for (let index = 0; index < options.runs; index++) {
			const sample = await readSample(page, entry, index);
			result.samples.push(sample.result);
		}
		result.fidelity.saved = true;
		const source = await stored(page);
		assert.equal(hash(source), fixture.sha256, 'Read must not change stored bytes.');
		const pending = page.waitForEvent('download');
		await page.keyboard.press('ControlOrMeta+Shift+e');
		const download = await pending;
		const bytes = await readFile(await download.path());
		assert.deepEqual(bytes, Buffer.from(fixture.content));
		const exportPath = `${artifactPrefix}.export.md`;
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
		await page.locator('[data-mode=read]').click();
		await page.waitForFunction(
			() => document.querySelector('.mdsh-preview')?.textContent?.includes('Read tail sentinel'),
			undefined,
			{ timeout: 120_000 }
		);
		result.reload = {
			articleSha256: hash(await page.locator('.mdsh-preview').innerText()),
			storedSha256: hash(await stored(page)),
			storedOrigin: 'indexeddb-drafts-row'
		};
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
	} finally {
		await context.close();
	}
}

async function runSlideCase(browser, url, entry, report, options) {
	const fixture = modeFixture(entry.fixture);
	const artifactPrefix = `${options.output}.${entry.id.replaceAll('/', '_')}`;
	await writeFile(`${artifactPrefix}.fixture.md`, fixture.content, { flag: 'wx' });
	const result = {
		id: entry.id,
		status: 'running',
		fixture: { ...fixture, content: undefined, path: `${artifactPrefix}.fixture.md` },
		samples: [],
		fidelity: {},
		errors: []
	};
	report.cases.push(result);
	const context = await browser.newContext({
		locale: 'en-US',
		acceptDownloads: true,
		serviceWorkers: 'block'
	});
	const page = await context.newPage();
	page.setDefaultTimeout(30_000);
	page.on('pageerror', (error) => result.errors.push(String(error)));
	try {
		await page.goto(url);
		await shell(page);
		const seeded = await seed(page, fixture);
		await page.reload();
		await shell(page);
		await page.locator('[data-testid="presentation-editor"]').waitFor({ timeout: 30_000 });
		result.workload = { mode: entry.mode, library: seeded.library };
		const initial = await slideField(page, entry.mode);
		let fieldValue = initial.value;
		let previousField = fieldValue;
		await initial.finish();
		for (let index = 0; index < options.runs; index++) {
			const current = await slideField(page, entry.mode);
			if (index === 0) fieldValue = current.value;
			previousField = fieldValue;
			const sample = await slideSample(page, entry, index, fieldValue, options.injectedDelayMs);
			result.samples.push(sample.result);
			fieldValue = sample.next;
			if (index < options.runs - 1) {
				// Reload between samples so each save starts from a clean queue.
				await page.reload();
				await shell(page);
				await page.locator('[data-testid="presentation-editor"]').waitFor({ timeout: 30_000 });
			}
		}
		const finalField = fieldValue;
		const finalContent = await stored(page);
		result.finalExpected = { bytes: Buffer.byteLength(finalContent), sha256: hash(finalContent) };
		result.fidelity.saved = true;
		await page.getByTestId('slide-undo').click();
		await waitStored(
			page,
			(source) => source.includes(previousField) && !source.includes(finalField),
			'undo'
		);
		result.fidelity.undo = true;
		await page.getByTestId('slide-redo').click();
		await waitStored(page, (source) => source.includes(finalField), 'redo');
		result.fidelity.redo = true;
		const pending = page.waitForEvent('download');
		await page.getByTestId('slide-export').click();
		await page.getByTestId('slide-export-md').click();
		const download = await pending;
		const bytes = await readFile(await download.path());
		assert.deepEqual(bytes, Buffer.from(await stored(page)));
		const exportPath = `${artifactPrefix}.export.md`;
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
		await page.locator('[data-testid="presentation-editor"]').waitFor({ timeout: 30_000 });
		const restored = await slideField(page, entry.mode);
		assert.equal(restored.value, finalField);
		await restored.finish();
		result.reload = {
			fieldSha256: hash(restored.value),
			storedSha256: hash(await stored(page)),
			storedOrigin: 'indexeddb-drafts-row'
		};
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
	} finally {
		await context.close();
	}
}

export async function runModesWeb({ report, selected, options }) {
	const edition = JSON.parse(await readFile(resolve(root, 'edition.json'), 'utf8'));
	assert.equal(edition.edition, 'web');
	assert.equal(edition.basePath, '', 'Mode runner requires a root production build.');
	const server = await serve(options.port);
	let browser;
	try {
		browser = await { chromium, firefox, webkit }[report.renderer.name].launch();
		report.renderer.version = browser.version();
		for (const entry of selected)
			if (entry.mode === 'read')
				await runReadCase(browser, `http://127.0.0.1:${options.port}/`, entry, report, options);
			else await runSlideCase(browser, `http://127.0.0.1:${options.port}/`, entry, report, options);
	} finally {
		await browser?.close();
		server.closeAllConnections();
		await new Promise((done) => server.close(done));
	}
}

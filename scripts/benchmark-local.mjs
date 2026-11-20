// Measure product performance through a real browser or a real native WebView.
// The command reads local fixtures, writes one raw JSON report, and sends no
// telemetry. Run it in two modes: --target web and --target native.
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { chromium, firefox, webkit } from '@playwright/test';
import {
	budgetGateFailed,
	budgetReport,
	environmentIdentity,
	gitRevision,
	loadBudgets,
	loadFixtures,
	megabytes,
	platformKeyForWeb,
	round,
	summarize,
	summarizePasses
} from './benchmark-shared.mjs';
import { largeNote, libraryRows, projectRows } from './benchmark-fixtures/corpus.mjs';
import { MIXED_MARKERS, removeTables } from './benchmark-fixtures/mixed.mjs';

const projectRoot = resolve(import.meta.dirname, '..');
const defaultPort = 4183;
const browserTypes = { chromium, firefox, webkit };
const contentTypes = {
	'.css': 'text/css; charset=utf-8',
	'.html': 'text/html; charset=utf-8',
	'.ico': 'image/x-icon',
	'.js': 'application/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.png': 'image/png',
	'.svg': 'image/svg+xml',
	'.webmanifest': 'application/manifest+json',
	'.webp': 'image/webp',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2'
};
const libraryFixture = libraryRows();
const projectFixture = projectRows();
const largeFixture = largeNote();

function parseArguments(args) {
	const options = {
		target: 'web',
		browser: 'chromium',
		runs: 9,
		output: null,
		url: null,
		budgets: join(projectRoot, 'scripts/benchmark-budgets.json'),
		fixtures: join(projectRoot, 'scripts/benchmark-fixtures'),
		buildMode: process.env.BENCHMARK_BUILD_MODE ?? 'production-static',
		enforceBudgets: false,
		prebuilt: false,
		skipNavigation: false
	};
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === '--target') options.target = args[++index];
		else if (arg === '--browser') options.browser = args[++index];
		else if (arg === '--runs') options.runs = Number(args[++index]);
		else if (arg === '--output') options.output = args[++index] ?? null;
		else if (arg === '--url') options.url = args[++index] ?? null;
		else if (arg === '--budgets') options.budgets = resolve(args[++index] ?? '');
		else if (arg === '--fixtures') options.fixtures = resolve(args[++index] ?? '');
		else if (arg === '--build-mode') options.buildMode = args[++index] ?? options.buildMode;
		else if (arg === '--enforce-budgets') options.enforceBudgets = true;
		else if (arg === '--skip-navigation') options.skipNavigation = true;
		else if (arg === '--prebuilt') options.prebuilt = true;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	if (!['web', 'native'].includes(options.target)) {
		throw new Error('--target must be web or native.');
	}
	if (options.prebuilt && options.target !== 'web') {
		throw new Error('--prebuilt applies to the web target only.');
	}
	if (!browserTypes[options.browser]) {
		throw new Error('--browser must be chromium, firefox, or webkit.');
	}
	if (!Number.isInteger(options.runs) || options.runs < 3 || options.runs > 50) {
		throw new Error('--runs must be an integer from 3 through 50.');
	}
	if (options.output) {
		if (!isAbsolute(options.output)) throw new Error('--output must be an absolute path.');
		const fromProject = relative(projectRoot, resolve(options.output));
		if (!fromProject.startsWith(`..${sep}`) && fromProject !== '..') {
			throw new Error('--output must be outside the repository.');
		}
	}
	return options;
}

async function waitForServer(url) {
	for (let attempt = 0; attempt < 120; attempt += 1) {
		try {
			const response = await fetch(url);
			if (response.ok) return;
		} catch {
			// The preview server is still starting.
		}
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
	}
	throw new Error(`Preview server did not start: ${url}`);
}

async function startStaticServer() {
	const buildRoot = resolve(projectRoot, 'build');
	const indexHtml = await readFile(resolve(buildRoot, 'index.html'));
	const htmlText = indexHtml.toString('utf8');
	const manifestHref = htmlText.match(/href="([^"]*manifest\.webmanifest)"/)?.[1] ?? '';
	const basePath = manifestHref.startsWith('/')
		? manifestHref.slice(0, manifestHref.lastIndexOf('/'))
		: '';
	const port = Number(process.env.BENCHMARK_PORT ?? defaultPort);
	const server = createServer(async (request, response) => {
		try {
			const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
			if (basePath && !requestUrl.pathname.startsWith(`${basePath}/`)) {
				response.writeHead(302, { Location: `${basePath}/` });
				response.end();
				return;
			}
			let relativePath = requestUrl.pathname.slice(basePath.length).replace(/^\/+/, '');
			if (!relativePath) relativePath = 'index.html';
			let path = resolve(buildRoot, decodeURIComponent(relativePath));
			const fromBuild = relative(buildRoot, path);
			if (!fromBuild || fromBuild.startsWith(`..${sep}`) || isAbsolute(fromBuild)) {
				throw new Error('Request path is outside build/.');
			}
			try {
				if (!(await stat(path)).isFile()) throw new Error('Not a file.');
			} catch {
				path = resolve(buildRoot, 'index.html');
			}
			const body = path.endsWith('index.html') ? indexHtml : await readFile(path);
			response.writeHead(200, {
				'Cache-Control': 'no-store',
				'Content-Type': contentTypes[extname(path)] ?? 'application/octet-stream'
			});
			response.end(body);
		} catch (error) {
			response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
			console.error('Benchmark request failed.', error);
			response.end('The benchmark request failed.');
		}
	});
	await new Promise((resolvePromise, reject) => {
		server.once('error', reject);
		server.listen(port, '127.0.0.1', resolvePromise);
	});
	const url = `http://127.0.0.1:${port}${basePath}/`;
	await waitForServer(url);
	return { server, url };
}

async function waitForShell(page) {
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor({
		state: 'visible',
		timeout: 30_000
	});
}

/** Dispatch a DOM click so Playwright actionability retries do not inflate the sample. */
async function domClick(page, selector) {
	await page.evaluate((target) => {
		const element = document.querySelector(target);
		if (!element) throw new Error(`Missing click target: ${target}`);
		element.click();
	}, selector);
}

/**
 * Wait for a quiet main thread before an input sample. Background indexing after
 * a large seed can otherwise dominate the first frames and hide steady state.
 */
async function waitForIdle(page, timeout = 20_000) {
	await page.evaluate(
		(limit) =>
			new Promise((resolvePromise) => {
				let settled = false;
				const finish = () => {
					if (settled) return;
					settled = true;
					resolvePromise(true);
				};
				const fallback = setTimeout(finish, limit);
				if (typeof requestIdleCallback !== 'function') {
					setTimeout(finish, 1_500);
					return;
				}
				requestIdleCallback(
					() =>
						setTimeout(() => {
							clearTimeout(fallback);
							finish();
						}, 250),
					{ timeout: limit }
				);
			}),
		timeout
	);
}

async function measureStartup(browser, url, runs) {
	const coldStart = [];
	const cachedRestart = [];
	const firstContentfulPaint = [];
	const fcpSources = [];
	const domContentLoaded = [];
	const domInteractive = [];
	for (let run = 0; run < runs; run += 1) {
		const context = await browser.newContext({ locale: 'en-US' });
		const page = await context.newPage();
		// Headless engines do not always keep the paint entry in the buffer.
		// Observe it before navigation and keep the first value.
		await page.addInitScript(() => {
			window.__mdshFcp = null;
			try {
				new PerformanceObserver((list) => {
					for (const entry of list.getEntries()) {
						if (entry.name === 'first-contentful-paint') {
							window.__mdshFcp = entry.startTime;
						}
					}
				}).observe({ type: 'paint', buffered: true });
			} catch {
				// The engine does not expose paint timing.
			}
		});
		const coldStartAt = performance.now();
		await page.goto(url);
		await waitForShell(page);
		coldStart.push(performance.now() - coldStartAt);
		// A paint entry can arrive after the shell is visible. Wait a bounded
		// time for either source, then record which one supplied the value.
		await page
			.waitForFunction(
				() =>
					window.__mdshFcp !== null ||
					performance.getEntriesByName('first-contentful-paint').length > 0,
				undefined,
				{ timeout: 5_000 }
			)
			.catch(() => undefined);
		const navigations = await page.evaluate(() => {
			const navigation = performance.getEntriesByType('navigation')[0];
			const paint = performance.getEntriesByName('first-contentful-paint')[0];
			return {
				fcp: paint?.startTime ?? window.__mdshFcp ?? null,
				fcpSource: paint ? 'timeline' : window.__mdshFcp !== null ? 'observer' : 'missing',
				domInteractive: navigation?.domInteractive ?? null,
				domContentLoaded: navigation?.domContentLoadedEventEnd ?? null
			};
		});
		firstContentfulPaint.push(navigations.fcp);
		fcpSources.push(navigations.fcpSource);
		domInteractive.push(navigations.domInteractive);
		domContentLoaded.push(navigations.domContentLoaded);

		await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
		for (let attempt = 0; attempt < 3; attempt += 1) {
			if (await page.evaluate(() => Boolean(navigator.serviceWorker.controller))) break;
			await page.reload();
			await waitForShell(page);
		}
		const cachedStartAt = performance.now();
		await page.reload();
		await waitForShell(page);
		cachedRestart.push(performance.now() - cachedStartAt);
		await context.close();
	}
	return {
		coldStart,
		cachedRestart,
		firstContentfulPaint,
		fcpSources,
		domInteractive,
		domContentLoaded
	};
}

async function seedDatabase(page) {
	const rows = [
		{
			...libraryFixture[0],
			id: 'bench-presentation',
			name: 'bench-presentation.md',
			content: (
				await readFile(join(projectRoot, 'scripts/benchmark-fixtures/presentation.md'))
			).toString('utf8'),
			order: -2,
			open: true
		},
		{
			id: 'bench-large',
			name: 'bench-large.md',
			content: largeFixture,
			createdAt: 1_700_000_000_000,
			updatedAt: 1_700_000_000_000,
			order: -1,
			open: true
		},
		...libraryFixture,
		...projectFixture.documents
	];
	await page.evaluate(
		async ({ rows: draftRows, project }) => {
			await new Promise((resolvePromise, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const names = [...database.objectStoreNames];
					const stores = ['drafts', ...(names.includes('projects') ? ['projects'] : [])];
					const transaction = database.transaction(stores, 'readwrite');
					const drafts = transaction.objectStore('drafts');
					drafts.clear();
					for (const row of draftRows) drafts.put(row);
					if (names.includes('projects')) {
						const projects = transaction.objectStore('projects');
						projects.clear();
						projects.put(project);
					}
					transaction.oncomplete = () => {
						database.close();
						resolvePromise(undefined);
					};
					transaction.onerror = () => reject(transaction.error);
				};
			});
			localStorage.setItem('mdsh:activeId', 'bench-000');
			localStorage.setItem('mdsh:mode', 'source');
			localStorage.setItem('mdsh:locale', 'en');
		},
		{ rows, project: projectFixture.project }
	);
}

async function installInputProbe(page) {
	await page.evaluate(() => {
		const benchmark = (window.__benchmark = window.__benchmark ?? {});
		benchmark.input = (selector, text) => {
			const editor = document.querySelector(selector);
			if (!editor) return Promise.resolve({ supported: false, reason: 'missing-editor' });
			editor.focus();
			const range = document.createRange();
			range.selectNodeContents(editor);
			range.collapse(false);
			const selection = window.getSelection();
			selection.removeAllRanges();
			selection.addRange(range);
			const before = editor.textContent ?? '';
			const startedAt = performance.now();
			// A parallel timeout separates a blocked main thread from throttled
			// animation frames. Both late means the main thread was blocked.
			let timerAt = null;
			setTimeout(() => {
				timerAt = performance.now();
			}, 0);
			let supported = true;
			try {
				supported = document.execCommand('insertText', false, text);
			} catch {
				supported = false;
			}
			const updatedAt = performance.now();
			return new Promise((resolvePromise) =>
				requestAnimationFrame(() => {
					const after = editor.textContent ?? '';
					// Keep the reviewed frame timestamp after the text read.
					const frameMs = performance.now() - startedAt;
					resolvePromise({
						supported,
						changed: after !== before,
						syncMs: updatedAt - startedAt,
						frameMs,
						timerMs: timerAt === null ? null : timerAt - startedAt,
						visibilityState: document.visibilityState,
						nodeCount: editor.querySelectorAll('*').length
					});
				})
			);
		};
	});
}

/**
 * Attribute one delayed input sample to the path that delayed it. The three
 * thresholds are diagnostics, not budgets. A late zero-delay timer means the
 * main thread was busy after the input handler returned. A timely timer with a
 * late animation frame means the browser did not produce the next frame.
 * @param {number} syncMs
 * @param {number | null} timerMs
 * @param {number} frameMs
 */
function classifyInputStall(syncMs, timerMs, frameMs) {
	if (syncMs >= 50) return 'app-work';
	if (timerMs === null) return frameMs >= 100 ? 'main-thread-block' : 'none';
	if (timerMs >= 50) return 'main-thread-block';
	if (frameMs >= 100) return 'frame-delay';
	return 'none';
}

async function measureInput(page, selector, runs, label) {
	const values = [];
	const sync = [];
	const diagnostics = [];
	let supported = true;
	for (let run = 0; run < runs; run += 1) {
		const result = await page.evaluate(
			([target, text]) => window.__benchmark.input(target, text),
			[selector, ` ${label}${run}`]
		);
		if (!result?.supported || !result.changed) {
			supported = false;
			values.push(null);
			sync.push(null);
			diagnostics.push(null);
			if (run >= 1) break;
			continue;
		}
		const frameMs = round(result.frameMs);
		const timerMs = Number.isFinite(result.timerMs) ? round(result.timerMs) : null;
		values.push(frameMs);
		sync.push(round(result.syncMs));
		diagnostics.push({
			frameMs,
			timerMs,
			frameOverTimerMs: timerMs === null ? null : round(frameMs - timerMs),
			visibilityState: result.visibilityState ?? null,
			nodeCount: result.nodeCount ?? null,
			stall: classifyInputStall(round(result.syncMs), timerMs, frameMs)
		});
	}
	while (values.length < runs) {
		values.push(null);
		sync.push(null);
		diagnostics.push(null);
	}
	return { values, sync, diagnostics, supported };
}

async function measureDriverTyping(page, runs, label) {
	const values = [];
	for (let run = 0; run < runs; run += 1) {
		const startedAt = performance.now();
		await page.keyboard.insertText(` ${label}${run}`);
		values.push(performance.now() - startedAt);
	}
	return values;
}

async function measureDocumentSwitch(page, runs) {
	await domClick(page, 'button[data-mode="source"]');
	await page.locator('.cm-content').first().waitFor({ state: 'visible', timeout: 30_000 });
	const values = [];
	for (let run = 0; run < runs; run += 1) {
		const id = `bench-${String((run % 6) + 1).padStart(3, '0')}`;
		await waitForIdle(page);
		const startedAt = performance.now();
		await domClick(page, `button[data-file-id="${id}"]`);
		await page.waitForFunction(
			(expected) => document.querySelector('header input')?.value === expected,
			id,
			{ timeout: 30_000 }
		);
		values.push(performance.now() - startedAt);
	}
	return values;
}

async function measureLargeDocumentOpen(page, runs) {
	const values = [];
	for (let run = 0; run < runs; run += 1) {
		await domClick(page, 'button[data-file-id="bench-000"]');
		await page.waitForFunction(
			() => document.querySelector('header input')?.value === 'bench-000',
			undefined,
			{ timeout: 30_000 }
		);
		await waitForIdle(page);
		const startedAt = performance.now();
		await domClick(page, 'button[data-file-id="bench-large"]');
		await page.waitForFunction(
			() => document.querySelector('header input')?.value === 'bench-large',
			undefined,
			{ timeout: 60_000 }
		);
		values.push(performance.now() - startedAt);
	}
	return values;
}

async function measureReadMode(page, runs) {
	const values = [];
	for (let run = 0; run < runs; run += 1) {
		const startedAt = performance.now();
		await domClick(page, 'button[data-mode="read"]');
		await page.locator('.mdsh-read .mdsh-preview').waitFor({ state: 'visible', timeout: 60_000 });
		await page.waitForFunction(
			() => {
				const preview = document.querySelector('.mdsh-preview');
				return (
					!!preview &&
					preview.getAttribute('aria-busy') === 'false' &&
					(preview.textContent?.length ?? 0) > 100_000
				);
			},
			undefined,
			{ timeout: 60_000 }
		);
		values.push(performance.now() - startedAt);
		await domClick(page, 'button[data-mode="source"]');
		await page.locator('.cm-content').first().waitFor({ state: 'visible', timeout: 30_000 });
	}
	return values;
}

async function measureScroll(page, runs) {
	const values = [];
	const diagnostics = [];
	/** @type {string | undefined} */
	let longTaskSupport;
	/** @type {Array<{ start: number, duration: number }> | undefined} */
	let longTasks;
	try {
		// The observer is installed once for the scroll samples. Its callback only
		// pushes a bounded entry when the engine reports a long task. It reads no
		// DOM, layout or paint data. It is disconnected in the finally block.
		longTaskSupport = await page.evaluate(() => {
			window.__scrollLongTaskEntries = [];
			window.__scrollLongTaskObserver = null;
			const supported =
				typeof PerformanceObserver === 'function' &&
				Array.isArray(PerformanceObserver.supportedEntryTypes) &&
				PerformanceObserver.supportedEntryTypes.includes('longtask');
			if (!supported) return 'unavailable';
			try {
				const observer = new PerformanceObserver((list) => {
					for (const entry of list.getEntries()) {
						if (window.__scrollLongTaskEntries.length < 32) {
							window.__scrollLongTaskEntries.push({
								start: entry.startTime,
								duration: entry.duration
							});
						}
					}
				});
				observer.observe({ type: 'longtask', buffered: false });
				window.__scrollLongTaskObserver = observer;
				return 'available';
			} catch {
				window.__scrollLongTaskObserver = null;
				return 'unavailable';
			}
		});
		for (let run = 0; run < runs; run += 1) {
			const ratio = ((run % 8) + 1) / 9;
			const ratioLabel = `${(run % 8) + 1}/9`;
			const result = await page.evaluate(
				(ratio) =>
					new Promise((resolvePromise) => {
						const scroller = document.querySelector('.mdsh-read');
						if (!scroller) {
							resolvePromise(null);
							return;
						}
						const room = scroller.scrollHeight - scroller.clientHeight;
						const startedAt = performance.now();
						const requested = Math.round(room * ratio);
						scroller.scrollTop = requested;
						requestAnimationFrame(() => {
							const frame1 = performance.now();
							requestAnimationFrame(() => {
								const frame2 = performance.now();
								resolvePromise({
									ms: frame2 - startedAt,
									start: startedAt,
									frame1,
									frame2,
									requested,
									applied: scroller.scrollTop,
									room
								});
							});
						});
					}),
				ratio
			);
			if (result && result.room > 0) {
				const ms = round(result.ms);
				values.push(ms);
				diagnostics.push({
					run,
					ratio: ratioLabel,
					ms,
					start: round(result.start),
					frame1: round(result.frame1),
					frame2: round(result.frame2),
					frame1Gap: round(result.frame1 - result.start),
					frame2Gap: round(result.frame2 - result.frame1),
					requested: result.requested,
					applied: result.applied,
					room: result.room
				});
			} else {
				values.push(null);
			}
		}
	} finally {
		// Flush queued observer callbacks outside the measured windows, then
		// disconnect. A missing page keeps the support value and returns no entries.
		await page
			.evaluate(() => new Promise((resolvePromise) => setTimeout(resolvePromise, 0)))
			.catch(() => {});
		const entries = await page
			.evaluate(() => {
				const observer = window.__scrollLongTaskObserver;
				const observed = window.__scrollLongTaskEntries ?? [];
				if (observer) observer.disconnect();
				window.__scrollLongTaskObserver = null;
				return observed;
			})
			.catch(() => []);
		longTasks = entries.map((entry) => ({
			start: round(entry.start),
			duration: round(entry.duration)
		}));
	}
	return { values, diagnostics, longTaskSupport, longTasks };
}

async function measureModeSwitch(page, runs) {
	const wysiwygLoad = [];
	const typing = [];
	const typingSync = [];
	const diagnostics = [];
	for (let run = 0; run < runs; run += 1) {
		const startedAt = performance.now();
		await domClick(page, 'button[data-mode="wysiwyg"]');
		await page.locator('.milkdown .ProseMirror').waitFor({ state: 'visible', timeout: 60_000 });
		wysiwygLoad.push(performance.now() - startedAt);
		await waitForIdle(page);
		await installInputProbe(page);
		const result = await measureInput(page, '.milkdown .ProseMirror', 1, `visual${run}`);
		typing.push(result.values[0]);
		typingSync.push(result.sync[0]);
		diagnostics.push(result.diagnostics[0] ?? null);
		await domClick(page, 'button[data-mode="source"]');
		await page.locator('.cm-content').first().waitFor({ state: 'visible', timeout: 30_000 });
	}
	return { wysiwygLoad, typing, typingSync, diagnostics };
}

// Mixed typing suite. The measured window covers the animation frame after the
// input and the publication that follows it. The gate value is the longest
// engine-reported long task that starts after that frame and before the next
// key. Route counters name the source-fidelity path that the edit took.
const mixedPasses = 3;
const mixedKeysPerPass = 20;
const mixedWarmupPerPass = 1;
const mixedPublishTimeoutMs = 6_000;
const mixedSourceSettleMs = 1_200;
const mixedKeyCharacters = 'abcdefghijklmnopqrstuvwxyz';

/** @typedef {'prose' | 'table' | 'list' | 'image'} MixedPosition */

const mixedPositionLabels = {
	prose: 'Prose',
	table: 'Table',
	list: 'List',
	image: 'Image'
};

/** @param {string} size @param {MixedPosition} position @param {'InputToFrame' | 'PublishBlock'} part */
function mixedEditMetric(size, position, part) {
	return `edit${size}${mixedPositionLabels[position]}${part}`;
}

/** @param {string} size @param {'InputToFrame' | 'PublishBlock'} part */
function mixedSourceMetric(size, part) {
	return `source${size}${part}`;
}

/**
 * The full mixed suite runs on Chromium. Firefox and WebKit keep a short
 * diagnostic probe so the job stays inside its time limit, and their budget
 * entries stay optional.
 */
const mixedEditPlan = [
	{ fixture: 'note-200k-mixed', size: '200k', positions: ['prose', 'table', 'list', 'image'] },
	{ fixture: 'note-600k-mixed', size: '600k', positions: ['prose', 'table', 'list', 'image'] },
	{ fixture: 'note-1mb-mixed', size: '1mb', positions: ['prose', 'table'] }
];
const mixedSourcePlan = ['200k', '600k', '1mb'];
const mixedDiagnosticPlan = [
	{ fixture: 'note-600k-mixed', size: '600k', positions: ['prose', 'table'] }
];

async function seedMixedDatabase(page, rows, activeId, mode) {
	await page.evaluate(
		async ({ rows: draftRows, activeId: id, mode: editorMode }) => {
			await new Promise((resolvePromise, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const transaction = database.transaction('drafts', 'readwrite');
					const drafts = transaction.objectStore('drafts');
					drafts.clear();
					for (const row of draftRows) drafts.put(row);
					transaction.oncomplete = () => {
						database.close();
						resolvePromise(undefined);
					};
					transaction.onerror = () => reject(transaction.error);
				};
			});
			localStorage.setItem('mdsh:activeId', id);
			localStorage.setItem('mdsh:mode', editorMode);
			localStorage.setItem('mdsh:locale', 'en');
		},
		{ rows, activeId, mode }
	);
}

async function installMixedProbe(page) {
	await page.evaluate(() => {
		const benchmark = (window.__benchmark = window.__benchmark ?? {});
		benchmark.keyEvents = [];
		benchmark.longTasks = [];
		if (!benchmark.mixedListener) {
			benchmark.mixedListener = true;
			window.addEventListener('deckmark:editor-perf', (event) => {
				if (benchmark.keyEvents.length < 2_000) benchmark.keyEvents.push(event.detail);
			});
			if (
				typeof PerformanceObserver === 'function' &&
				Array.isArray(PerformanceObserver.supportedEntryTypes) &&
				PerformanceObserver.supportedEntryTypes.includes('longtask')
			) {
				try {
					new PerformanceObserver((list) => {
						for (const entry of list.getEntries()) {
							if (benchmark.longTasks.length < 4_000) {
								benchmark.longTasks.push({ start: entry.startTime, duration: entry.duration });
							}
						}
					}).observe({ type: 'longtask', buffered: false });
					benchmark.longTaskSupport = 'available';
				} catch {
					benchmark.longTaskSupport = 'unavailable';
				}
			} else {
				benchmark.longTaskSupport = 'unavailable';
			}
		}
		benchmark.nextFrames = () =>
			new Promise((resolvePromise) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolvePromise(undefined)))
			);
		benchmark.placeCaret = (marker) => {
			const root = document.querySelector('.milkdown .ProseMirror');
			if (!root) return { ok: false, reason: 'missing-root' };
			const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
			/** @type {Node | null} */
			let found = null;
			let node;
			while ((node = walker.nextNode())) {
				if (node.textContent?.includes(marker)) {
					found = node;
					break;
				}
			}
			if (!found?.textContent) return { ok: false, reason: 'missing-marker' };
			const offset = found.textContent.indexOf(marker) + marker.length;
			const range = document.createRange();
			range.setStart(found, offset);
			range.collapse(true);
			const element = found.parentElement;
			element?.scrollIntoView({ block: 'center' });
			root.focus();
			const selection = window.getSelection();
			if (!selection) return { ok: false, reason: 'missing-selection' };
			selection.removeAllRanges();
			selection.addRange(range);
			return {
				ok: true,
				tag: element?.tagName ?? null,
				inCell: Boolean(element?.closest('td')),
				inItem: Boolean(element?.closest('li'))
			};
		};
		benchmark.setSourceCaret = (ratio) => {
			const root = document.querySelector('.cm-content');
			const view = root?.cmView?.view ?? root?.cmTile?.root?.view;
			if (!view?.state?.doc) return { ok: false, reason: 'missing-codemirror' };
			const length = view.state.doc.length;
			const target = Math.max(0, Math.min(length, Math.round(length * ratio)));
			view.dispatch({ selection: { anchor: target }, scrollIntoView: true });
			view.focus();
			return { ok: true, length, target, actual: view.state.selection.main.head };
		};
		benchmark.mixedKey = (text, options) =>
			new Promise((resolvePromise) => {
				const editor = document.querySelector(options.selector);
				if (!editor) {
					resolvePromise({ supported: false, reason: 'missing-editor' });
					return;
				}
				const cmView = editor.cmView?.view ?? editor.cmTile?.root?.view;
				const lengthBefore = options.mode === 'source' ? (cmView?.state.doc.length ?? null) : null;
				// Keep only this key's events. A growing buffer would stop
				// recording after a few hundred keys.
				benchmark.keyEvents.length = 0;
				benchmark.longTasks.length = 0;
				const eventStart = 0;
				const taskStart = 0;
				const heartbeats = [];
				const heartbeat = setInterval(() => {
					if (heartbeats.length < 400) heartbeats.push(performance.now());
				}, 50);
				const startedAt = performance.now();
				let supported = true;
				try {
					supported = document.execCommand('insertText', false, text);
				} catch {
					supported = false;
				}
				requestAnimationFrame(() => {
					const frameAt = performance.now();
					const frameMs = frameAt - startedAt;
					const finish = () => {
						clearInterval(heartbeat);
						// PerformanceObserver callbacks are queued tasks. Let them run
						// before the window is read, then stop the window.
						setTimeout(() => {
							const events = benchmark.keyEvents.slice(eventStart);
							const tasks = benchmark.longTasks.slice(taskStart);
							const publish = events.find(
								/** @param {{ kind?: string, name?: string }} event */
								(event) => event.kind === 'duration' && event.name === 'markdownPublish'
							);
							const windowEnd = publish
								? Math.max(publish.end ?? publish.start, frameAt)
								: performance.now();
							const blockTasks = tasks.filter(
								(task) => task.start + task.duration > frameAt && task.start <= windowEnd + 100
							);
							const gaps = [];
							for (let index = 1; index < heartbeats.length; index += 1) {
								const gap = heartbeats[index] - heartbeats[index - 1];
								if (gap > 100) gaps.push(Math.round(gap));
							}
							// A blocked thread defers the final interval tick past the
							// window end, so record that last gap from the window itself.
							const lastTick = heartbeats.at(-1);
							if (lastTick !== undefined && windowEnd - lastTick > 100) {
								gaps.push(Math.round(windowEnd - lastTick));
							}
							const counters = events
								.filter((event) => event.kind === 'counter')
								.map((event) => event.name);
							const stages = {};
							for (const event of events) {
								if (event.kind !== 'duration') continue;
								stages[event.name] = (stages[event.name] ?? 0) + event.value;
							}
							const lengthAfter =
								options.mode === 'source' ? (cmView?.state.doc.length ?? null) : null;
							resolvePromise({
								supported,
								changed:
									publish !== undefined
										? counters.includes('markdownUpdated')
										: lengthBefore !== null && lengthAfter !== null
											? lengthAfter > lengthBefore
											: null,
								frameMs,
								publishMs: publish ? publish.value : null,
								publishBlockMs: blockTasks.length
									? Math.max(...blockTasks.map((task) => task.duration))
									: 0,
								longTaskCount: blockTasks.length,
								waitMs: windowEnd - frameAt,
								heartbeatCount: heartbeats.length,
								heartbeatMaxGapMs: gaps.length ? Math.max(...gaps) : 0,
								heartbeatGaps: gaps.slice(0, 12),
								counters: counters.filter(
									(name) => name.includes('Fidelity') || name.includes('imageMarkdown')
								),
								stages
							});
						}, 40);
					};
					if (options.mode === 'source') {
						setTimeout(finish, options.settleMs ?? mixedSourceSettleMs);
						return;
					}
					const deadline = frameAt + (options.timeoutMs ?? mixedPublishTimeoutMs);
					const poll = () => {
						const events = benchmark.keyEvents.slice(eventStart);
						if (
							events.some(
								(event) =>
									event.kind === 'duration' &&
									event.name === 'markdownPublish' &&
									event.start >= startedAt - 50
							)
						) {
							finish();
							return;
						}
						if (performance.now() > deadline) {
							finish();
							return;
						}
						setTimeout(poll, 20);
					};
					poll();
				});
			});
	});
}

async function openVisualNote(page, bytes) {
	const visual = page.locator('.milkdown .ProseMirror');
	if (!(await visual.isVisible().catch(() => false))) {
		const wysiwyg = page.locator('button[data-mode="wysiwyg"]');
		if (await wysiwyg.count()) await domClick(page, 'button[data-mode="wysiwyg"]');
		const dialog = page.getByRole('dialog', { name: 'Render this large document?' });
		if (await dialog.isVisible().catch(() => false)) {
			await dialog.getByRole('button', { name: 'Render document' }).click();
		}
	}
	await visual.waitFor({ state: 'visible', timeout: bytes >= 256 * 1024 ? 180_000 : 120_000 });
	await waitForIdle(page, 30_000);
}

async function placeMixedCaret(page, marker, position) {
	const placed = await page.evaluate((value) => window.__benchmark.placeCaret(value), marker);
	if (!placed?.ok) throw new Error(`Cannot place the mixed caret at ${marker}: ${placed?.reason}`);
	if (position === 'table' && !placed.inCell)
		throw new Error('The table caret did not land inside a table cell.');
	if (position === 'list' && !placed.inItem)
		throw new Error('The list caret did not land inside a list item.');
	if ((position === 'prose' || position === 'image') && (placed.inCell || placed.inItem))
		throw new Error(`The ${position} caret landed inside a container.`);
	await page.evaluate(() => window.__benchmark.nextFrames());
	return placed;
}

/** @param {number} key */
function mixedKeyText(key) {
	return mixedKeyCharacters[key % mixedKeyCharacters.length];
}

/**
 * Measure one scenario: one fixture, one caret position, three passes of one
 * declared warmup key and twenty measured keys.
 */
async function measureMixedScenario(page, scenario) {
	const { passes, keysPerPass, mode } = scenario;
	const inputToFrame = [];
	const publishBlock = [];
	const diagnostics = [];
	for (let pass = 0; pass < passes; pass += 1) {
		if (mode === 'source') {
			const caret = await page.evaluate(() => window.__benchmark.setSourceCaret(0.5));
			if (!caret?.ok) throw new Error(`Cannot place the source caret: ${caret?.reason}`);
			await page.evaluate(() => window.__benchmark.nextFrames());
		} else {
			await placeMixedCaret(page, scenario.marker, scenario.position);
		}
		await waitForIdle(page, 10_000);
		// One declared warmup key per pass. It is not measured and it lets the
		// publish, save and layout settle before the measured keys.
		await page.evaluate(
			([text, options]) => window.__benchmark.mixedKey(text, options),
			['w', scenario.keyOptions]
		);
		const passInput = [];
		const passBlock = [];
		for (let key = 0; key < keysPerPass; key += 1) {
			const sample = await page.evaluate(
				([text, options]) => window.__benchmark.mixedKey(text, options),
				[mixedKeyText(key), scenario.keyOptions]
			);
			if (sample?.supported !== true || sample.changed !== true) {
				passInput.push(null);
				passBlock.push(null);
				diagnostics.push({
					pass,
					key,
					status: 'rejected',
					supported: sample?.supported ?? null,
					changed: sample?.changed ?? null,
					reason: sample?.reason ?? null
				});
				continue;
			}
			if (mode === 'wysiwyg' && sample.publishMs === null) {
				passInput.push(null);
				passBlock.push(null);
				diagnostics.push({ pass, key, status: 'no-publish', waitMs: round(sample.waitMs) });
				continue;
			}
			passInput.push(round(sample.frameMs));
			passBlock.push(round(sample.publishBlockMs));
			diagnostics.push({
				pass,
				key,
				frameMs: round(sample.frameMs),
				publishMs: sample.publishMs === null ? null : round(sample.publishMs),
				publishBlockMs: round(sample.publishBlockMs),
				longTaskCount: sample.longTaskCount,
				waitMs: round(sample.waitMs),
				heartbeatCount: sample.heartbeatCount,
				heartbeatMaxGapMs: sample.heartbeatMaxGapMs,
				heartbeatGaps: sample.heartbeatGaps,
				routeReasons: sample.counters.filter((name) => name.includes('FullReason')),
				imagePaths: sample.counters.filter((name) => name.includes('imageMarkdown'))
			});
		}
		inputToFrame.push(passInput);
		publishBlock.push(passBlock);
	}
	const routeReasons = {};
	for (const entry of diagnostics) {
		for (const reason of entry.routeReasons ?? []) {
			routeReasons[reason] = (routeReasons[reason] ?? 0) + 1;
		}
	}
	return {
		id: scenario.id,
		fixture: scenario.fixture,
		fixtureId: scenario.fixtureId,
		mode: scenario.mode,
		position: scenario.position,
		passes,
		keysPerPass,
		warmupPerPass: mixedWarmupPerPass,
		inputToFrame,
		publishBlock,
		routeReasons,
		diagnostics
	};
}

/**
 * Measure the mixed fixtures. Chromium runs the full gated plan. The other
 * engines run one diagnostic probe per listed position; their budget entries
 * are optional and the job keeps its time limit.
 */
async function runMixedSuite(browser, url, fixtures, full) {
	const editPlan = full ? mixedEditPlan : mixedDiagnosticPlan;
	const passes = full ? mixedPasses : 1;
	const keysPerPass = full ? mixedKeysPerPass : 5;
	const scenarios = [];
	const metrics = { samples: {}, summaries: {} };
	const fixtureTextById = {};
	for (const descriptor of fixtures.descriptors) {
		if (!descriptor.path) continue;
		fixtureTextById[descriptor.id] = await readFile(descriptor.path, 'utf8');
	}

	const record = (scenario, size) => {
		const inputMetric = mixedEditMetric(size, scenario.position, 'InputToFrame');
		const blockMetric = mixedEditMetric(size, scenario.position, 'PublishBlock');
		metrics.samples[inputMetric] = scenario.inputToFrame.flat();
		metrics.samples[blockMetric] = scenario.publishBlock.flat();
		metrics.summaries[inputMetric] = summarizePasses(scenario.inputToFrame);
		metrics.summaries[blockMetric] = summarizePasses(scenario.publishBlock);
		scenario.metrics = { inputToFrame: inputMetric, publishBlock: blockMetric };
	};

	for (const entry of editPlan) {
		const content = fixtureTextById[entry.fixture];
		if (!content) throw new Error(`Missing mixed fixture content: ${entry.fixture}`);
		const context = await browser.newContext({ locale: 'en-US' });
		await context.addInitScript(() => {
			window.__MDSH_EDITOR_PERF__ = true;
		});
		const page = await context.newPage();
		try {
			await page.goto(url);
			await waitForShell(page);
			await seedMixedDatabase(
				page,
				[
					{
						id: entry.fixture,
						name: `${entry.fixture}.md`,
						content,
						createdAt: 1_700_000_000_000,
						updatedAt: 1_700_000_000_000,
						order: 0,
						open: true
					}
				],
				entry.fixture,
				'wysiwyg'
			);
			await page.reload();
			await waitForShell(page);
			await openVisualNote(page, Buffer.byteLength(content));
			await installMixedProbe(page);
			for (const position of entry.positions) {
				console.error(`Mixed edit ${entry.size} ${position}.`);
				const scenario = await measureMixedScenario(page, {
					id: `mixed-edit-${entry.size}-${position}`,
					fixture: entry.fixture,
					fixtureId: entry.fixture,
					mode: 'wysiwyg',
					position,
					marker: MIXED_MARKERS[position],
					passes,
					keysPerPass,
					keyOptions: {
						selector: '.milkdown .ProseMirror',
						mode: 'wysiwyg',
						timeoutMs: mixedPublishTimeoutMs
					}
				});
				scenarios.push(scenario);
				if (full) record(scenario, entry.size);
			}
			metrics.longTaskSupport = await page.evaluate(
				() => window.__benchmark.longTaskSupport ?? 'unavailable'
			);
		} finally {
			await context.close();
		}
	}

	// Source mode: one page, three documents, one caret at the middle.
	if (full && mixedSourcePlan.length > 0) {
		const context = await browser.newContext({ locale: 'en-US' });
		await context.addInitScript(() => {
			window.__MDSH_EDITOR_PERF__ = true;
		});
		const page = await context.newPage();
		try {
			await page.goto(url);
			await waitForShell(page);
			const rows = mixedSourcePlan.map((size) => {
				const id = `note-${size}-mixed`;
				const content = fixtureTextById[id];
				if (!content) throw new Error(`Missing mixed fixture content: ${id}`);
				return {
					id,
					name: `${id}.md`,
					content,
					createdAt: 1_700_000_000_000,
					updatedAt: 1_700_000_000_000,
					order: mixedSourcePlan.indexOf(size),
					open: true
				};
			});
			await seedMixedDatabase(page, rows, rows[0].id, 'source');
			await page.reload();
			await waitForShell(page);
			await page.locator('.cm-content').first().waitFor({ state: 'visible', timeout: 60_000 });
			await installMixedProbe(page);
			for (const [index, size] of mixedSourcePlan.entries()) {
				const row = rows[index];
				console.error(`Mixed source ${size}.`);
				if (index > 0) {
					await domClick(page, `button[data-file-id="${row.id}"]`);
					await page.waitForFunction(
						(expected) => document.querySelector('header input')?.value === expected,
						row.name.replace(/\.md$/, ''),
						{ timeout: 60_000 }
					);
				}
				await waitForIdle(page, 20_000);
				const scenario = await measureMixedScenario(page, {
					id: `mixed-source-${size}`,
					fixture: row.id,
					fixtureId: row.id,
					mode: 'source',
					position: 'prose',
					passes: mixedPasses,
					keysPerPass: mixedKeysPerPass,
					keyOptions: {
						selector: '.cm-content',
						mode: 'source',
						settleMs: mixedSourceSettleMs
					}
				});
				scenarios.push(scenario);
				const inputMetric = mixedSourceMetric(size, 'InputToFrame');
				const blockMetric = mixedSourceMetric(size, 'PublishBlock');
				metrics.samples[inputMetric] = scenario.inputToFrame.flat();
				metrics.samples[blockMetric] = scenario.publishBlock.flat();
				metrics.summaries[inputMetric] = summarizePasses(scenario.inputToFrame);
				metrics.summaries[blockMetric] = summarizePasses(scenario.publishBlock);
				scenario.metrics = { inputToFrame: inputMetric, publishBlock: blockMetric };
			}
		} finally {
			await context.close();
		}

		// Tables-removed diagnostic: the same note and caret with no table line.
		{
			const base = fixtureTextById['note-600k-mixed'];
			if (!base) throw new Error('Missing mixed fixture content: note-600k-mixed');
			const content = removeTables(base);
			const context = await browser.newContext({ locale: 'en-US' });
			await context.addInitScript(() => {
				window.__MDSH_EDITOR_PERF__ = true;
			});
			const page = await context.newPage();
			try {
				await page.goto(url);
				await waitForShell(page);
				await seedMixedDatabase(
					page,
					[
						{
							id: 'mixed-600k-notables',
							name: 'mixed-600k-notables.md',
							content,
							createdAt: 1_700_000_000_000,
							updatedAt: 1_700_000_000_000,
							order: 0,
							open: true
						}
					],
					'mixed-600k-notables',
					'wysiwyg'
				);
				await page.reload();
				await waitForShell(page);
				await openVisualNote(page, Buffer.byteLength(content));
				await installMixedProbe(page);
				console.error('Mixed edit 600k table-removed.');
				const scenario = await measureMixedScenario(page, {
					id: 'mixed-edit-600k-table-removed',
					fixture: 'note-600k-mixed without table lines',
					fixtureId: 'mixed-600k-notables',
					mode: 'wysiwyg',
					position: 'prose',
					marker: MIXED_MARKERS.prose,
					passes: mixedPasses,
					keysPerPass: mixedKeysPerPass,
					keyOptions: {
						selector: '.milkdown .ProseMirror',
						mode: 'wysiwyg',
						timeoutMs: mixedPublishTimeoutMs
					}
				});
				scenarios.push(scenario);
				metrics.samples.edit600kTableRemovedInputToFrame = scenario.inputToFrame.flat();
				metrics.samples.edit600kTableRemovedPublishBlock = scenario.publishBlock.flat();
				metrics.summaries.edit600kTableRemovedInputToFrame = summarizePasses(scenario.inputToFrame);
				metrics.summaries.edit600kTableRemovedPublishBlock = summarizePasses(scenario.publishBlock);
				scenario.metrics = {
					inputToFrame: 'edit600kTableRemovedInputToFrame',
					publishBlock: 'edit600kTableRemovedPublishBlock'
				};
			} finally {
				await context.close();
			}
		}
	}

	return { scenarios, metrics };
}

async function measureProjectTree(page, runs) {
	const panel = page.locator('[role="dialog"][aria-labelledby="projects-title"]');
	const values = [];

	async function openPanel() {
		await domClick(page, '[data-testid="projects-open"]');
		await panel.waitFor({ state: 'visible', timeout: 30_000 });
		await page.waitForFunction(
			(expected) =>
				document.querySelectorAll('[role="dialog"] [data-project-document]').length === expected,
			projectFixture.documents.length,
			{ timeout: 60_000 }
		);
	}

	async function closePanel() {
		// The close control stays disabled while the panel is busy. Wait for the
		// idle state before the close click, otherwise slower engines drop it.
		await page.waitForFunction(
			() => {
				const button = document.querySelector(
					'[role="dialog"][aria-labelledby="projects-title"] header button'
				);
				return !!button && !(/** @type {HTMLButtonElement} */ (button).disabled);
			},
			null,
			{ timeout: 60_000 }
		);
		await domClick(page, '[role="dialog"][aria-labelledby="projects-title"] header button');
		await panel.waitFor({ state: 'hidden', timeout: 30_000 });
	}

	// Warm up the lazy panel chunk and the first render before the measured
	// samples. Cold startup is measured separately. Idle waits keep a pending
	// save or export from inflating one render sample.
	await openPanel();
	await closePanel();
	for (let run = 0; run < runs; run += 1) {
		await waitForIdle(page);
		const startedAt = performance.now();
		await openPanel();
		values.push(performance.now() - startedAt);
		await closePanel();
	}
	return values;
}

async function measurePresentation(page, runs, loadRuns = Math.min(runs, 3)) {
	const loadSamples = [];
	for (let run = 0; run < loadRuns; run += 1) {
		if (run > 0) {
			await domClick(page, 'button[data-file-id="bench-000"]');
			await page.waitForFunction(
				() => document.querySelector('header input')?.value === 'bench-000',
				undefined,
				{ timeout: 30_000 }
			);
			await waitForIdle(page);
		}
		const loadStartedAt = performance.now();
		await domClick(page, 'button[data-file-id="bench-presentation"]');
		await page.locator('[data-testid="presentation-editor"]').waitFor({
			state: 'visible',
			timeout: 60_000
		});
		await page
			.locator('[data-testid="slide-thumbnail"]')
			.first()
			.waitFor({ state: 'visible', timeout: 60_000 });
		loadSamples.push(performance.now() - loadStartedAt);
	}
	const slideSwitch = [];
	for (let run = 0; run < runs; run += 1) {
		const index = (run % 2) + 1;
		const startedAt = performance.now();
		await domClick(page, `[data-testid="slide-thumbnail"][data-slide-index="${index}"]`);
		await page.waitForFunction(
			(expected) =>
				document
					.querySelector(`[data-testid="slide-thumbnail"][data-slide-index="${expected}"]`)
					?.getAttribute('aria-current') === 'true',
			index,
			{ timeout: 30_000 }
		);
		slideSwitch.push(performance.now() - startedAt);
	}
	const present = [];
	for (let run = 0; run < runs; run += 1) {
		const startedAt = performance.now();
		await domClick(page, '[data-testid="slide-present"]');
		await page.locator('[data-testid="slide-present-exit"]').waitFor({
			state: 'visible',
			timeout: 30_000
		});
		present.push(performance.now() - startedAt);
		await domClick(page, '[data-testid="slide-present-exit"]');
		await page.locator('[data-testid="slide-present"]').waitFor({
			state: 'visible',
			timeout: 30_000
		});
	}
	return { load: loadSamples, slideSwitch, present };
}

async function measureExport(page, runs) {
	const values = [];
	const downloads = [];
	for (let run = 0; run < runs; run += 1) {
		await domClick(page, 'button[aria-label="Command palette"]');
		await page.getByRole('dialog', { name: 'Command palette' }).waitFor({ state: 'visible' });
		const selector = '#cmd-palette-opt-export-html:not([aria-disabled="true"])';
		await page.locator(selector).waitFor({ state: 'visible' });
		// Measure export after the named command is ready.
		const startedAt = performance.now();
		const [result] = await Promise.all([page.waitForEvent('download'), domClick(page, selector)]);
		values.push(performance.now() - startedAt);
		const path = await result.path();
		if (!path) throw new Error('HTML export did not produce a local download.');
		const bytes = await readFile(path);
		const html = bytes.toString('utf8');
		if (
			result.suggestedFilename() !== 'bench-000.html' ||
			!html.includes('<title>Benchmark note 000</title>') ||
			!html.includes('Paragraph 1 with a') ||
			!html.trimEnd().endsWith('</html>')
		) {
			throw new Error('HTML export does not contain the expected benchmark note.');
		}
		downloads.push({
			filename: result.suggestedFilename(),
			bytes: bytes.byteLength,
			sha256: createHash('sha256').update(bytes).digest('hex')
		});
		await page
			.getByRole('dialog', { name: 'Command palette' })
			.waitFor({ state: 'hidden', timeout: 30_000 });
	}
	return { values, downloads };
}

async function measureHeap(page, browserName) {
	if (browserName !== 'chromium') {
		const value = await page.evaluate(() => {
			const memory = /** @type {{ usedJSHeapSize?: number } | undefined} */ (performance.memory);
			return memory?.usedJSHeapSize ?? null;
		});
		return value === null ? null : megabytes(value);
	}
	const session = await page.context().newCDPSession(page);
	try {
		await session.send('Performance.enable');
		const { metrics } = await session.send('Performance.getMetrics');
		const heap = metrics.find((metric) => metric.name === 'JSHeapUsedSize')?.value;
		return heap === undefined ? null : megabytes(heap);
	} finally {
		await session.detach();
	}
}

async function runWebBenchmark(options, fixtures) {
	const { server, url } = options.url
		? { server: null, url: options.url }
		: await startStaticServer();
	const browserType = browserTypes[options.browser];
	const browser = await browserType.launch();
	const failures = [];
	const browserErrors = [];
	let page;
	// A p95 over five samples is the maximum, so one browser stall fails the
	// gate. Twenty samples make p95 the second-worst value: a systematic slowdown
	// still fails, and the report keeps every sample and the maximum. Every
	// five-sample metric now uses the same standard count.
	const standardRuns = Math.max(options.runs, 20);
	const projectTreeRuns = standardRuns;
	// Startup and cached restart also need enough samples for a meaningful p95.
	const startupRuns = standardRuns;
	try {
		// A local typing profile skips the cold and cached navigation samples. The
		// runner-specific FCP and cold-start limits then do not decide a typing
		// change. Use a local budget file that omits those metrics.
		const startup = options.skipNavigation ? null : await measureStartup(browser, url, startupRuns);
		const context = await browser.newContext({ locale: 'en-US', acceptDownloads: true });
		page = await context.newPage();
		page.on('pageerror', (error) => browserErrors.push(error.stack ?? error.message));
		page.on('console', (message) => {
			if (message.type() === 'error') browserErrors.push(message.text());
		});
		await page.goto(url);
		await waitForShell(page);
		await seedDatabase(page);
		const libraryReload = [];
		for (let run = 0; !options.skipNavigation && run < Math.min(options.runs, 3); run += 1) {
			const libraryReloadAt = performance.now();
			await page.reload();
			await waitForShell(page);
			await page.locator('.cm-content').first().waitFor({ state: 'visible', timeout: 30_000 });
			libraryReload.push(performance.now() - libraryReloadAt);
		}

		await waitForIdle(page);
		await installInputProbe(page);
		// Five samples make p95 the maximum, so one browser stall fails a 200 ms
		// budget while the median stays near 20 ms. Twenty samples make p95 the
		// second-worst value, which keeps a systematic slowdown failing and drops
		// a single scheduler hiccup. Same rule as the visual typing metrics below.
		const inputRuns = Math.max(options.runs, 20);
		const typingSource = await measureInput(page, '.cm-content', inputRuns, 'source');
		const typingSourceDriver = await measureDriverTyping(page, standardRuns, 'driver');
		const documentSwitch = await measureDocumentSwitch(page, standardRuns);
		const largeDocumentOpen = await measureLargeDocumentOpen(page, standardRuns);
		await waitForIdle(page);
		const typingLarge = await measureInput(page, '.cm-content', inputRuns, 'large');
		// Twenty samples make p95 the second-worst value instead of the maximum of five.
		const readMode = await measureReadMode(page, standardRuns);
		await domClick(page, 'button[data-mode="read"]');
		await page.locator('.mdsh-read .mdsh-preview').waitFor({ state: 'visible', timeout: 60_000 });
		await page.waitForFunction(
			() => {
				const preview = document.querySelector('.mdsh-preview');
				return (
					!!preview &&
					preview.getAttribute('aria-busy') === 'false' &&
					(preview.textContent?.length ?? 0) > 100_000
				);
			},
			undefined,
			{ timeout: 60_000 }
		);
		// The read preview can still be laying out and painting after its text is
		// present. Let that work settle before the two-frame scroll sample, or a
		// single first-paint stall becomes the p95 of five samples.
		await waitForIdle(page);
		const scroll = await measureScroll(page, standardRuns);
		await domClick(page, 'button[data-mode="source"]');
		await page.locator('.cm-content').first().waitFor({ state: 'visible', timeout: 30_000 });
		// Twenty samples make p95 the second-worst value for the visual typing
		// metrics, which have a noisy tail on shared runners.
		const modeSwitch = await measureModeSwitch(page, standardRuns);
		const heapSamples = [await measureHeap(page, options.browser)];
		await domClick(page, 'button[data-mode="source"]');
		await page.locator('.cm-content').first().waitFor({ state: 'visible', timeout: 30_000 });
		await page.locator('button[data-file-id="bench-000"]').click();
		await page.waitForFunction(() => document.querySelector('header input')?.value === 'bench-000');
		const exportHtml = await measureExport(page, standardRuns);
		heapSamples.push(await measureHeap(page, options.browser));
		const projectTree = await measureProjectTree(page, projectTreeRuns);
		heapSamples.push(await measureHeap(page, options.browser));
		const presentation = await measurePresentation(page, standardRuns, 20);
		heapSamples.push(await measureHeap(page, options.browser));
		const identityContext = await browser.newContext();
		const identityPage = await identityContext.newPage();
		const userAgent = await identityPage.evaluate(() => navigator.userAgent);
		await identityContext.close();
		await context.close();

		// Mixed fixtures run last. They use their own contexts so the library and
		// project corpus above cannot change a typing sample.
		const mixed = await runMixedSuite(browser, url, fixtures, options.browser === 'chromium');

		const samples = {
			...(startup
				? {
						coldStart: startup.coldStart,
						cachedRestart: startup.cachedRestart,
						firstContentfulPaint: startup.firstContentfulPaint,
						domInteractive: startup.domInteractive,
						domContentLoaded: startup.domContentLoaded
					}
				: {}),
			...(options.skipNavigation ? {} : { libraryReload }),
			documentSwitch,
			largeDocumentOpen,
			typingSource: typingSource.values,
			typingSourceSync: typingSource.sync,
			typingSourceDriver,
			typingLarge: typingLarge.values,
			typingLargeSync: typingLarge.sync,
			readModeSwitch: readMode,
			scrollFrame: scroll.values,
			wysiwygLoad: modeSwitch.wysiwygLoad,
			typingWysiwyg: modeSwitch.typing,
			typingWysiwygSync: modeSwitch.typingSync,
			projectTreeRender: projectTree,
			presentationLoad: presentation.load,
			presentationSlideSwitch: presentation.slideSwitch,
			presentationPresent: presentation.present,
			exportHtml: exportHtml.values,
			heapUsedMb: heapSamples,
			...mixed.metrics.samples
		};
		const startupDiagnostics = startup ? { firstContentfulPaintSource: startup.fcpSources } : null;
		const summary = {
			...Object.fromEntries(
				Object.entries(samples)
					.filter(([name]) => !(name in mixed.metrics.summaries))
					.map(([name, values]) => [name, summarize(values, name === 'heapUsedMb' ? 'MB' : 'ms')])
			),
			...mixed.metrics.summaries
		};
		const budgets = await loadBudgets(options.budgets);
		const platformKey = platformKeyForWeb(options.browser);
		const budget = budgetReport({ platformKey, summary, budgets });
		return {
			schemaVersion: 2,
			generatedAt: new Date().toISOString(),
			target: 'web',
			browser: {
				name: options.browser,
				version: browser.version(),
				engine: browserType.name(),
				userAgent
			},
			buildMode: options.buildMode,
			url,
			source: gitRevision(projectRoot),
			environment: environmentIdentity(),
			fixtures: fixtures.descriptors,
			corpus: {
				libraryDocuments: libraryFixture.length,
				largeNoteBytes: Buffer.byteLength(largeFixture),
				projectDocuments: projectFixture.documents.length
			},
			method: {
				startup:
					'Harness wall clock from page.goto to the shell visible state. Includes Playwright command overhead.',
				firstContentfulPaint: 'Browser paint entry startTime for the cold navigation.',
				inputLatency:
					'In-page time from a focused execCommand insertText call to the next animation frame. Excludes driver round trip. Unsupported editors report null.',
				inputDiagnostics:
					'Per-sample syncMs, frameMs, timerMs, frameOverTimerMs, visibilityState, nodeCount and stall. stall is app-work for a 50 ms or longer handler, main-thread-block for a late or missing zero-delay timer, frame-delay for a timely timer with a 100 ms or longer frame, and none otherwise. The thresholds classify evidence; they are not budgets.',
				scrollFrame: 'In-page time to set scrollTop and observe two animation frames.',
				documentSwitch: 'Wall clock from a sidebar click to the matching editor content.',
				modeSwitch: 'Wall clock from a mode button click to the visible target editor.',
				projectTree: 'Wall clock from the Projects panel click to the expected project row count.',
				presentation:
					'Wall clock from the document click or slide action to the visible slide state.',
				export:
					'Wall clock from a DOM click on the named palette option to the browser download event. Readiness checks precede the sample. Download byte checks follow it.',
				heap: 'Chromium CDP JSHeapUsedSize. Other engines report performance.memory when present.',
				mixedInputToFrame:
					'Mixed note, caret placed by text target inside a table cell, a list item, a paragraph near the middle or a paragraph after a chart image. In-page time from execCommand insertText to the next animation frame.',
				mixedPublishBlock:
					'The longest engine-reported long task that starts after the gated frame and before the next key. Three passes of one declared warmup key and twenty measured keys; the reported p95 is the median of the three pass p95 values.',
				mixedSource:
					'Source editor at the document middle. The same protocol with a 1200 ms settle window for the 150 ms publish throttle and the 400 ms save delay.',
				mixedDiagnostic:
					'The tables-removed case deletes every table line at load time and edits the same prose caret. It shows whether the table container is the cost.',
				mixedRoute:
					'routeReasons counts the sourceFidelityFullReason counters per scenario. A table-cell edit must name container-table on the pre-fix build.'
			},
			limits: [
				'Headless browser timings do not prove native WebView timings. Run --target native separately.',
				'A shared CI runner has unequal hardware. Treat the budget as a baseline for this platform.',
				'Input latency uses a synthetic execCommand path, not a physical keyboard driver.',
				'--skip-navigation omits the cold, cached, paint and library reload samples. Use it with a local budget file that omits those metrics so a typing change is gated without the runner-specific navigation limits. CI never passes this flag.',
				'The 16 ms and 33 ms keystroke targets in docs/PERFORMANCE.md are product targets, not gate limits.',
				'The mixed suite runs the full plan on Chromium. Firefox and WebKit keep a five-key diagnostic probe and their mixed budget entries are optional.'
			],
			budget,
			budgetEnforced: options.enforceBudgets,
			forcedBudgetFailure: budgetGateFailed(budget, options.enforceBudgets),
			summary,
			samples,
			scrollDiagnostics: {
				support: scroll.longTaskSupport,
				runs: scroll.diagnostics,
				longTasks: scroll.longTasks
			},
			startupDiagnostics,
			diagnostics: {
				typingSource: typingSource.diagnostics,
				typingLarge: typingLarge.diagnostics,
				typingWysiwyg: modeSwitch.diagnostics
			},
			mixed: {
				passes: mixedPasses,
				keysPerPass: mixedKeysPerPass,
				warmupPerPass: mixedWarmupPerPass,
				fullPlan: options.browser === 'chromium',
				longTaskSupport: mixed.metrics.longTaskSupport ?? null,
				scenarios: mixed.scenarios
			},
			exportDownloads: exportHtml.downloads,
			failures
		};
	} catch (error) {
		if (options.output) {
			const browserState = page
				? await page
						.evaluate(() => ({
							url: location.href,
							title: document.title,
							activeElement: document.activeElement?.outerHTML,
							documentName: document.querySelector('header input')?.value,
							paletteQuery: document.querySelector('[role="combobox"]')?.value,
							selectedCommand: document.querySelector('[role="option"][aria-selected="true"]')
								?.outerHTML,
							dialogs: [...document.querySelectorAll('[role="dialog"]')].map(
								(element) => element.outerHTML
							),
							messages: [...document.querySelectorAll('[role="alert"], [role="status"]')].map(
								(element) => element.textContent
							)
						}))
						.catch((captureError) => ({ captureError: String(captureError) }))
				: null;
			await writeFile(
				options.output,
				`${JSON.stringify(
					{
						schemaVersion: 2,
						status: 'failed',
						generatedAt: new Date().toISOString(),
						target: 'web',
						command: [process.execPath, ...process.argv.slice(1)],
						browser: { name: options.browser, version: browser.version() },
						buildMode: options.buildMode,
						source: gitRevision(projectRoot),
						environment: environmentIdentity(),
						fixtures: fixtures.descriptors,
						failures: [{ message: error.message, stack: error.stack, browserState, browserErrors }]
					},
					null,
					2
				)}\n`,
				'utf8'
			);
		}
		throw error;
	} finally {
		await browser.close();
		server?.closeAllConnections();
		server?.close();
	}
}

const failureSampleLimit = 64;

/**
 * Print bounded numeric evidence for every failed budget metric.
 *
 * The gate exit code and the failure message keep their current behavior. These
 * lines appear only after a failure. Each line uses fixed labels, a metric name
 * from the budget file, numbers and a short sample list in run order. It does
 * not print notes, paths, capabilities or the complete report.
 * @param {Record<string, any>} result
 */
function printBudgetFailureDiagnostics(result) {
	const failures = result?.budget?.failures;
	if (!Array.isArray(failures) || failures.length === 0) return;
	/** @type {Set<string>} */
	const failedMetrics = new Set();
	for (const failure of failures) {
		if (typeof failure !== 'string') continue;
		const separator = failure.lastIndexOf(':');
		if (separator > 0) failedMetrics.add(failure.slice(0, separator));
	}
	for (const metric of failedMetrics) {
		const summary = result.summary?.[metric];
		const raw = result.samples?.[metric];
		const values = Array.isArray(raw)
			? raw.filter((value) => typeof value === 'number' && Number.isFinite(value))
			: [];
		if (!Array.isArray(raw) && !summary) continue;
		const shown = values.slice(0, failureSampleLimit);
		const measured = summary?.measured === true;
		console.log(
			`Budget failure samples: metric=${metric} count=${
				measured ? summary.runs : values.length
			} min=${measured ? summary.min : 'na'} max=${measured ? summary.max : 'na'} p50=${
				measured ? summary.p50 : 'na'
			} p95=${measured ? summary.p95 : 'na'} printed=${shown.length} samples=${
				shown.length > 0 ? shown.join(',') : 'none'
			}`
		);
		if (metric === 'scrollFrame') printScrollFailureTimeline(result);
	}
}

/**
 * Count long-task entries that overlap one scroll sample interval.
 * A zero count is a bounded observation, not proof that no stall occurred.
 * @param {{ start: number, frame2: number }} run
 * @param {Array<{ start: number, duration: number }>} longTasks
 */
function scrollLongTaskOverlaps(run, longTasks) {
	return longTasks.filter(
		(task) => task.start < run.frame2 && task.start + task.duration > run.start
	).length;
}

/**
 * Print bounded per-run scroll evidence only after a scrollFrame budget failure.
 * The diagnostics are separate from the numeric samples and never enter the
 * summary, budget, exit code or thrown error.
 * @param {Record<string, any>} result
 */
function printScrollFailureTimeline(result) {
	const diagnostics = result?.scrollDiagnostics;
	const runs = diagnostics?.runs;
	if (!Array.isArray(runs) || runs.length === 0) return;
	const support = diagnostics.support === 'available' ? 'available' : 'unavailable';
	const longTasks = Array.isArray(diagnostics.longTasks) ? diagnostics.longTasks : [];
	for (const run of runs.slice(0, failureSampleLimit)) {
		const overlap =
			support === 'available' ? scrollLongTaskOverlaps(run, longTasks) : 'unavailable';
		console.log(
			`Scroll sample timeline: run=${run.run} ratio=${run.ratio} ms=${run.ms} start=${run.start} frame1=${run.frame1} frame2=${run.frame2} requested=${run.requested} applied=${run.applied} room=${run.room} longtask=${overlap}`
		);
	}
	if (support === 'unavailable') {
		console.log('Scroll long tasks: support=unavailable');
		return;
	}
	const bounded = longTasks.slice(0, 8);
	console.log(
		`Scroll long tasks: support=available count=${longTasks.length} samples=${
			bounded.length > 0
				? bounded.map((task) => `${task.start}:${task.duration}`).join(',')
				: 'none'
		}`
	);
}

async function main() {
	if (process.argv[2] === '--suite' && process.argv[3] === 'stress') {
		const { stressMain } = await import('./benchmark-stress.mjs');
		return stressMain(process.argv.slice(4));
	}
	const options = parseArguments(process.argv.slice(2));
	if (options.prebuilt) {
		execFileSync(
			process.execPath,
			[
				'scripts/build-provenance.mjs',
				'verify',
				'--kind',
				'web-benchmark',
				'--instrumentation',
				'none'
			],
			{ cwd: projectRoot, stdio: 'inherit' }
		);
	}
	const fixtures = await loadFixtures(options.fixtures);
	let result;
	if (options.target === 'native') {
		const { runNativeBenchmark } = await import('./benchmark-native.mjs');
		result = await runNativeBenchmark({ options, fixtures, projectRoot });
	} else {
		result = await runWebBenchmark(options, fixtures);
	}
	console.table(
		Object.fromEntries(
			Object.entries(result.summary).map(([name, summary]) => [
				name,
				summary.measured
					? { runs: summary.runs, p50: summary.p50, p95: summary.p95, unit: summary.unit }
					: { runs: 0, unit: summary.unit }
			])
		)
	);
	console.log(`Budget status for ${result.budget.platformKey}: ${result.budget.status}`);
	printBudgetFailureDiagnostics(result);
	if (options.output) {
		await writeFile(options.output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
		console.log(`Wrote benchmark data to ${options.output}.`);
	}
	if (result.forcedBudgetFailure) {
		throw new Error(
			`Benchmark budget gate failed for ${result.budget.platformKey}: ${result.budget.failures.join(', ')}`
		);
	}
}

await main();

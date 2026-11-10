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
	summarize
} from './benchmark-shared.mjs';
import { largeNote, libraryRows, projectRows } from './benchmark-fixtures/corpus.mjs';

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
		prebuilt: false
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
		values.push(round(result.frameMs));
		sync.push(round(result.syncMs));
		diagnostics.push({
			frameMs: round(result.frameMs),
			timerMs: Number.isFinite(result.timerMs) ? round(result.timerMs) : null,
			visibilityState: result.visibilityState ?? null,
			nodeCount: result.nodeCount ?? null
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
			() => (document.querySelector('.mdsh-preview')?.textContent?.length ?? 0) > 100_000,
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
	for (let run = 0; run < runs; run += 1) {
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
					scroller.scrollTop = Math.round(room * ratio);
					requestAnimationFrame(() => {
						requestAnimationFrame(() => {
							resolvePromise({
								ms: performance.now() - startedAt,
								applied: scroller.scrollTop,
								room
							});
						});
					});
				}),
			((run % 8) + 1) / 9
		);
		values.push(result && result.room > 0 ? round(result.ms) : null);
	}
	return values;
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
	const expensiveRuns = Math.min(options.runs, 5);
	// A p95 over five samples is the maximum, so one browser stall fails the
	// gate. Twenty samples make p95 the second-worst value: a systematic slowdown
	// still fails, and the report keeps every sample and the maximum.
	const projectTreeRuns = Math.max(options.runs, 20);
	// Startup and cached restart also need enough samples for a meaningful p95.
	const startupRuns = Math.max(options.runs, 20);
	try {
		const startup = await measureStartup(browser, url, startupRuns);
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
		for (let run = 0; run < Math.min(options.runs, 3); run += 1) {
			const libraryReloadAt = performance.now();
			await page.reload();
			await waitForShell(page);
			await page.locator('.cm-content').first().waitFor({ state: 'visible', timeout: 30_000 });
			libraryReload.push(performance.now() - libraryReloadAt);
		}

		await waitForIdle(page);
		await installInputProbe(page);
		const typingSource = await measureInput(page, '.cm-content', options.runs, 'source');
		const typingSourceDriver = await measureDriverTyping(page, options.runs, 'driver');
		const documentSwitch = await measureDocumentSwitch(page, options.runs);
		const largeDocumentOpen = await measureLargeDocumentOpen(page, options.runs);
		await waitForIdle(page);
		const typingLarge = await measureInput(page, '.cm-content', options.runs, 'large');
		// Twenty samples make p95 the second-worst value instead of the maximum of five.
		const readMode = await measureReadMode(page, Math.max(expensiveRuns, 20));
		await domClick(page, 'button[data-mode="read"]');
		await page.locator('.mdsh-read .mdsh-preview').waitFor({ state: 'visible', timeout: 60_000 });
		await page.waitForFunction(
			() => (document.querySelector('.mdsh-preview')?.textContent?.length ?? 0) > 100_000,
			undefined,
			{ timeout: 60_000 }
		);
		// The read preview can still be laying out and painting after its text is
		// present. Let that work settle before the two-frame scroll sample, or a
		// single first-paint stall becomes the p95 of five samples.
		await waitForIdle(page);
		const scrollFrame = await measureScroll(page, options.runs);
		await domClick(page, 'button[data-mode="source"]');
		await page.locator('.cm-content').first().waitFor({ state: 'visible', timeout: 30_000 });
		// Twenty samples make p95 the second-worst value for the visual typing
		// metrics, which have a noisy tail on shared runners.
		const modeSwitch = await measureModeSwitch(page, Math.max(expensiveRuns, 20));
		const heapSamples = [await measureHeap(page, options.browser)];
		await domClick(page, 'button[data-mode="source"]');
		await page.locator('.cm-content').first().waitFor({ state: 'visible', timeout: 30_000 });
		await page.locator('button[data-file-id="bench-000"]').click();
		await page.waitForFunction(() => document.querySelector('header input')?.value === 'bench-000');
		const exportHtml = await measureExport(page, expensiveRuns);
		heapSamples.push(await measureHeap(page, options.browser));
		const projectTree = await measureProjectTree(page, projectTreeRuns);
		heapSamples.push(await measureHeap(page, options.browser));
		const presentation = await measurePresentation(page, expensiveRuns, 20);
		heapSamples.push(await measureHeap(page, options.browser));
		const identityContext = await browser.newContext();
		const identityPage = await identityContext.newPage();
		const userAgent = await identityPage.evaluate(() => navigator.userAgent);
		await identityContext.close();
		await context.close();

		const samples = {
			coldStart: startup.coldStart,
			cachedRestart: startup.cachedRestart,
			firstContentfulPaint: startup.firstContentfulPaint,
			domInteractive: startup.domInteractive,
			domContentLoaded: startup.domContentLoaded,
			libraryReload,
			documentSwitch,
			largeDocumentOpen,
			typingSource: typingSource.values,
			typingSourceSync: typingSource.sync,
			typingSourceDriver,
			typingLarge: typingLarge.values,
			typingLargeSync: typingLarge.sync,
			readModeSwitch: readMode,
			scrollFrame,
			wysiwygLoad: modeSwitch.wysiwygLoad,
			typingWysiwyg: modeSwitch.typing,
			typingWysiwygSync: modeSwitch.typingSync,
			projectTreeRender: projectTree,
			presentationLoad: presentation.load,
			presentationSlideSwitch: presentation.slideSwitch,
			presentationPresent: presentation.present,
			exportHtml: exportHtml.values,
			heapUsedMb: heapSamples
		};
		const startupDiagnostics = { firstContentfulPaintSource: startup.fcpSources };
		const summary = Object.fromEntries(
			Object.entries(samples).map(([name, values]) => [
				name,
				summarize(values, name === 'heapUsedMb' ? 'MB' : 'ms')
			])
		);
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
				scrollFrame: 'In-page time to set scrollTop and observe two animation frames.',
				documentSwitch: 'Wall clock from a sidebar click to the matching editor content.',
				modeSwitch: 'Wall clock from a mode button click to the visible target editor.',
				projectTree: 'Wall clock from the Projects panel click to the expected project row count.',
				presentation:
					'Wall clock from the document click or slide action to the visible slide state.',
				export:
					'Wall clock from a DOM click on the named palette option to the browser download event. Readiness checks precede the sample. Download byte checks follow it.',
				heap: 'Chromium CDP JSHeapUsedSize. Other engines report performance.memory when present.'
			},
			limits: [
				'Headless browser timings do not prove native WebView timings. Run --target native separately.',
				'A shared CI runner has unequal hardware. Treat the budget as a baseline for this platform.',
				'Input latency uses a synthetic execCommand path, not a physical keyboard driver.'
			],
			budget,
			budgetEnforced: options.enforceBudgets,
			forcedBudgetFailure: budgetGateFailed(budget, options.enforceBudgets),
			summary,
			samples,
			startupDiagnostics,
			diagnostics: {
				typingWysiwyg: modeSwitch.diagnostics
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

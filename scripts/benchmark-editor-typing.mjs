// Measure realistic visual and source typing over several document sizes.
//
// The command serves the local production build, seeds deterministic notes,
// dispatches in-page input events, and writes one raw JSON report. It sends no
// telemetry. Run the same command and fixture set before and after a change.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { chromium, firefox, webkit } from '@playwright/test';
import { environmentIdentity, gitRevision, summarize } from './benchmark-shared.mjs';
import { noteContent } from './benchmark-fixtures/corpus.mjs';

const projectRoot = resolve(import.meta.dirname, '..');
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

function parseArguments(args) {
	const options = {
		browser: 'chromium',
		runs: 5,
		sizes: [50_000, 240_000, 1_000_000, 5_000_000],
		libraries: 'both',
		modes: ['visual', 'source'],
		output: null,
		port: Number(process.env.BENCHMARK_PORT ?? 4184),
		buildMode: process.env.BENCHMARK_BUILD_MODE ?? 'production-static'
	};
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === '--browser') options.browser = args[++index];
		else if (arg === '--runs') options.runs = Number(args[++index]);
		else if (arg === '--sizes') options.sizes = args[++index].split(',').map(Number);
		else if (arg === '--libraries') options.libraries = args[++index];
		else if (arg === '--modes') options.modes = args[++index].split(',');
		else if (arg === '--output') options.output = args[++index] ?? null;
		else if (arg === '--port') options.port = Number(args[++index]);
		else if (arg === '--build-mode') options.buildMode = args[++index];
		else throw new Error(`Unknown argument: ${arg}`);
	}
	if (!browserTypes[options.browser]) throw new Error('Unknown browser.');
	if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 30)
		throw new Error('--runs must be 1 through 30.');
	if (!['small', 'large', 'both'].includes(options.libraries))
		throw new Error('--libraries must be small, large, or both.');
	if (!options.modes.length || options.modes.some((mode) => !['visual', 'source'].includes(mode)))
		throw new Error('--modes must list visual, source, or both.');
	if (options.output) {
		if (!isAbsolute(options.output)) throw new Error('--output must be an absolute path.');
		const fromProject = relative(projectRoot, resolve(options.output));
		if (!fromProject.startsWith(`..${sep}`) && fromProject !== '..')
			throw new Error('--output must be outside the repository.');
	}
	return options;
}

async function startStaticServer(port) {
	const buildRoot = resolve(projectRoot, 'build');
	const indexHtml = await readFile(resolve(buildRoot, 'index.html'));
	const htmlText = indexHtml.toString('utf8');
	const manifestHref = htmlText.match(/href="([^"]*manifest\.webmanifest)"/)?.[1] ?? '';
	const basePath = manifestHref.startsWith('/')
		? manifestHref.slice(0, manifestHref.lastIndexOf('/'))
		: '';
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
			const path = resolve(buildRoot, decodeURIComponent(relativePath));
			const fromBuild = relative(buildRoot, path);
			if (!fromBuild || fromBuild.startsWith(`..${sep}`) || isAbsolute(fromBuild))
				throw new Error('Request path is outside build/.');
			let target = path;
			try {
				if (!(await stat(target)).isFile()) throw new Error('Not a file.');
			} catch {
				target = resolve(buildRoot, 'index.html');
			}
			response.writeHead(200, {
				'Cache-Control': 'no-store',
				'Content-Type': contentTypes[extname(target)] ?? 'application/octet-stream'
			});
			response.end(target.endsWith('index.html') ? indexHtml : await readFile(target));
		} catch (error) {
			response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
			response.end(String(error));
		}
	});
	await new Promise((resolvePromise, reject) => {
		server.once('error', reject);
		server.listen(port, '127.0.0.1', resolvePromise);
	});
	const url = `http://127.0.0.1:${port}${basePath}/`;
	for (let attempt = 0; attempt < 120; attempt += 1) {
		try {
			if ((await fetch(url)).ok) return { server, url };
		} catch {
			// The server is still starting.
		}
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
	}
	throw new Error(`Static server did not start: ${url}`);
}

function sha256(value) {
	return createHash('sha256').update(value).digest('hex');
}

async function treeSha256(root) {
	const entries = [];
	const visit = async (directory) => {
		const items = await readdir(directory, { withFileTypes: true });
		for (const item of items.toSorted((a, b) => a.name.localeCompare(b.name))) {
			const path = join(directory, item.name);
			if (item.isDirectory()) await visit(path);
			else if (item.isFile()) entries.push([relative(root, path), sha256(await readFile(path))]);
		}
	};
	await visit(root);
	return sha256(entries.map(([path, digest]) => `${path}\0${digest}`).join('\n'));
}

function gitText(args) {
	try {
		return execFileSync('git', ['-C', projectRoot, ...args], { encoding: 'utf8' });
	} catch {
		return '';
	}
}

async function workingTreeIdentity() {
	const status = gitText(['status', '--porcelain=v1']);
	const untracked = [];
	for (const line of status.split('\n')) {
		if (!line.startsWith('?? ')) continue;
		const path = line.slice(3);
		try {
			untracked.push({ path, sha256: sha256(await readFile(join(projectRoot, path))) });
		} catch {
			// A directory entry is recorded without a file hash.
			untracked.push({ path, sha256: null });
		}
	}
	return {
		status,
		diffSha256: sha256(gitText(['diff', '--binary'])),
		stagedDiffSha256: sha256(gitText(['diff', '--cached', '--binary'])),
		untracked
	};
}

function fixtureFor(bytes) {
	return {
		id: `typing-${bytes}`,
		name: `typing-${bytes}.md`,
		content: noteContent(777, bytes)
	};
}

function libraryRows(count) {
	return Array.from({ length: count }, (_, index) => {
		const id = `library-${String(index).padStart(3, '0')}`;
		return {
			id,
			name: `${id}.md`,
			content: noteContent(index, 16_000),
			createdAt: 1_700_000_000_000 + index,
			updatedAt: 1_700_000_000_000 + index,
			order: index + 1,
			open: true
		};
	});
}

async function seed(page, fixture, libraryCount) {
	const rows = [
		{
			id: fixture.id,
			name: fixture.name,
			content: fixture.content,
			createdAt: 1_700_000_000_000,
			updatedAt: 1_700_000_000_000,
			order: 0,
			open: true
		},
		...libraryRows(libraryCount)
	];
	await page.evaluate(
		async ({ rows: draftRows, activeId }) => {
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
			localStorage.setItem('mdsh:activeId', activeId);
			localStorage.setItem('mdsh:mode', 'wysiwyg');
			localStorage.setItem('mdsh:locale', 'en');
		},
		{ rows, activeId: fixture.id }
	);
}

async function waitForShell(page) {
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor({
		state: 'visible',
		timeout: 60_000
	});
}

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

async function installProbe(page) {
	await page.evaluate(() => {
		const benchmark = (window.__benchmark = window.__benchmark ?? {});
		benchmark.events = [];
		window.addEventListener('deckmark:editor-perf', (event) => {
			benchmark.events.push(event.detail);
		});
		benchmark.setCaret = (selector, ratio) => {
			const root = document.querySelector(selector);
			if (!root) return { ok: false, reason: 'missing-root' };
			// CodeMirror renders only the viewport. Use its document model so the
			// recorded position is a full-document offset, not rendered text.
			const view = root.cmView?.view ?? root.cmTile?.root?.view;
			if (view?.state?.doc) {
				const length = view.state.doc.length;
				const target = Math.max(0, Math.min(length, Math.round(length * ratio)));
				view.dispatch({ selection: { anchor: target }, scrollIntoView: true });
				view.focus();
				return {
					ok: true,
					editor: 'codemirror',
					length,
					target,
					actual: view.state.selection.main.head
				};
			}
			root.focus();
			const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
			const nodes = [];
			let length = 0;
			let node;
			while ((node = walker.nextNode())) {
				nodes.push({ node, from: length, to: length + (node.textContent?.length ?? 0) });
				length += node.textContent?.length ?? 0;
			}
			if (!length) return { ok: false, reason: 'no-text' };
			const target = Math.max(0, Math.min(length, Math.round(length * ratio)));
			const entry = nodes.find((item) => item.from <= target && item.to >= target) ?? nodes.at(-1);
			const range = document.createRange();
			range.setStart(entry.node, Math.max(0, Math.min(entry.to - entry.from, target - entry.from)));
			range.collapse(true);
			const selection = window.getSelection();
			selection.removeAllRanges();
			selection.addRange(range);
			return { ok: true, editor: 'dom', length, target, actual: target };
		};
		benchmark.nextFrames = () =>
			new Promise((resolvePromise) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolvePromise(undefined)))
			);
		benchmark.insertOnce = (selector, text) =>
			new Promise((resolvePromise) => {
				const editor = document.querySelector(selector);
				if (!editor) {
					resolvePromise({ supported: false, reason: 'missing-editor' });
					return;
				}
				benchmark.events = [];
				performance.clearMarks();
				performance.clearMeasures();
				const before = editor.textContent ?? '';
				const startedAt = performance.now();
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
				const returnedAt = performance.now();
				requestAnimationFrame(() => {
					// Read the text before the frame timestamp, as the existing probe does.
					const after = editor.textContent ?? '';
					const frameMs = performance.now() - startedAt;
					const events = benchmark.events.splice(0);
					const stages = {};
					const counters = {};
					for (const event of events) {
						if (event.kind === 'counter') counters[event.name] = (counters[event.name] ?? 0) + 1;
						else if (event.kind === 'duration') {
							stages[event.name] = (stages[event.name] ?? 0) + event.value;
						}
					}
					for (const entry of performance.getEntriesByType('measure')) {
						if (!entry.name.startsWith('mdsh:')) continue;
						const name = entry.name.slice(5);
						stages[name] = (stages[name] ?? 0) + entry.duration;
					}
					for (const entry of performance.getEntriesByType('mark')) {
						if (!entry.name.startsWith('mdsh:')) continue;
						const name = entry.name.slice(5);
						counters[name] = (counters[name] ?? 0) + 1;
					}
					resolvePromise({
						supported,
						changed: after !== before,
						frameMs,
						syncMs: returnedAt - startedAt,
						timerMs: timerAt === null ? null : timerAt - startedAt,
						stages,
						counters,
						visibilityState: document.visibilityState,
						nodeCount: editor.querySelectorAll('*').length
					});
				});
			});
		benchmark.insertBurst = async (selector, characters) => {
			const caret = benchmark.setCaret(selector, 0.5);
			if (!caret.ok) return { caret, samples: [] };
			await benchmark.nextFrames();
			const samples = [];
			for (const character of characters)
				samples.push(await benchmark.insertOnce(selector, character));
			return { caret, samples };
		};
	});
}

async function positionCaret(page, selector, ratio) {
	const placed = await page.evaluate(
		([target, value]) => window.__benchmark.setCaret(target, value),
		[selector, ratio]
	);
	if (!placed?.ok) throw new Error(`Cannot place the caret in ${selector}: ${placed?.reason}`);
	if (placed.actual !== placed.target)
		throw new Error(
			`Caret placement missed its full-document offset: target ${placed.target}, actual ${placed.actual}`
		);
	await page.evaluate(() => window.__benchmark.nextFrames());
	return placed;
}

function summarizeSamples(samples) {
	const successful = samples.filter(
		(sample) => sample?.supported === true && sample?.changed === true
	);
	const failed = samples.filter((sample) => sample?.supported !== true || sample?.changed !== true);
	const frames = successful.map((sample) => sample.frameMs);
	const sync = successful.map((sample) => sample.syncMs);
	const stages = {};
	for (const sample of successful) {
		for (const [name, value] of Object.entries(sample.stages ?? {})) {
			(stages[name] ??= []).push(value);
		}
	}
	return {
		complete: samples.length > 0 && failed.length === 0,
		successfulSamples: successful.length,
		failedSamples: failed.length,
		failureDetails: failed.map((sample, index) => ({
			index: samples.indexOf(sample),
			supported: sample?.supported ?? null,
			changed: sample?.changed ?? null,
			reason: sample?.reason ?? null,
			originalIndex: index
		})),
		frame: frames.length ? summarize(frames) : null,
		sync: sync.length ? summarize(sync) : null,
		stages: Object.fromEntries(
			Object.entries(stages).map(([name, values]) => [name, summarize(values)])
		),
		counters: successful.reduce((total, sample) => {
			for (const [name, value] of Object.entries(sample.counters ?? {}))
				total[name] = (total[name] ?? 0) + value;
			return total;
		}, {})
	};
}

async function runEditor(browser, url, fixture, libraryCount, runs) {
	const context = await browser.newContext({ locale: 'en-US', acceptDownloads: false });
	await context.addInitScript(() => {
		window.__MDSH_EDITOR_PERF__ = true;
	});
	const page = await context.newPage();
	page.on('pageerror', (error) => console.error('Page error:', error.message));
	await page.goto(url);
	await waitForShell(page);
	await seed(page, fixture, libraryCount);
	await page.reload();
	await waitForShell(page);
	const visual = page.locator('.milkdown .ProseMirror');
	let confirmation = 'not-required';
	if (!(await visual.isVisible().catch(() => false))) {
		const wysiwyg = page.locator('button[data-mode="wysiwyg"]');
		if (await wysiwyg.count()) await wysiwyg.click();
		const dialog = page.getByRole('dialog', { name: 'Render this large document?' });
		if (await dialog.isVisible().catch(() => false)) {
			confirmation = 'accepted';
			await dialog.getByRole('button', { name: 'Render document' }).click();
		} else {
			confirmation = 'not-offered';
		}
	}
	try {
		await visual.waitFor({
			state: 'visible',
			timeout: fixture.content.length >= 256 * 1024 ? 180_000 : 120_000
		});
	} catch (error) {
		await context.close();
		return {
			scenarios: [
				{
					id: `wysiwyg-${fixture.id}-unavailable-small`,
					mode: 'wysiwyg',
					library: libraryCount,
					confirmation,
					unavailable: `The visual editor did not become visible after confirmation=${confirmation}: ${error.message}`
				}
			]
		};
	}
	await waitForIdle(page);
	await installProbe(page);
	const selector = '.milkdown .ProseMirror';
	const libraryLabel = libraryCount ? 'lib300' : 'lib0';
	const scenarios = [];
	const positions = [
		{ id: 'start', ratio: 0.02 },
		{ id: 'middle', ratio: 0.5 },
		{ id: 'end', ratio: 0.98 }
	];
	for (const position of positions) {
		const samples = [];
		const positionRuns = fixture.content.length >= 5_000_000 ? 1 : runs;
		const carets = [];
		for (let run = 0; run < positionRuns; run += 1) {
			await page.evaluate(() => {
				window.__benchmark.events = [];
			});
			carets.push(await positionCaret(page, selector, position.ratio));
			const sample = await page.evaluate(
				([target, text]) => window.__benchmark.insertOnce(target, text),
				[selector, `x${run}`]
			);
			samples.push(sample);
			await waitForIdle(page, 5_000);
		}
		const summary = summarizeSamples(samples);
		scenarios.push({
			id: `wysiwyg-${fixture.id}-${position.id}-${libraryLabel}`,
			mode: 'wysiwyg',
			position: position.id,
			library: libraryCount,
			carets,
			complete: summary.complete,
			sampleCount: samples.length,
			samples,
			summary
		});
	}
	const burstCharacters = 'abcdefghijklmnopqrst';
	const burst = await page.evaluate(
		([target, text]) => window.__benchmark.insertBurst(target, text),
		[selector, burstCharacters]
	);
	await waitForIdle(page, 10_000);
	const burstSummary = summarizeSamples(burst.samples);
	scenarios.push({
		id: `wysiwyg-${fixture.id}-burst-${libraryLabel}`,
		mode: 'wysiwyg',
		position: 'middle-burst',
		library: libraryCount,
		carets: [burst.caret],
		complete: burstSummary.complete,
		sampleCount: burst.samples.length,
		samples: burst.samples,
		summary: burstSummary
	});
	const pasteCaret = await positionCaret(page, selector, 0.5);
	const pasteText = 'Paste text '.repeat(20);
	const paste = await page.evaluate(
		([target, text]) => window.__benchmark.insertOnce(target, text),
		[selector, pasteText]
	);
	await waitForIdle(page, 10_000);
	const pasteSummary = summarizeSamples([paste]);
	scenarios.push({
		id: `wysiwyg-${fixture.id}-paste-${libraryLabel}`,
		mode: 'wysiwyg',
		position: 'middle-paste',
		library: libraryCount,
		carets: [pasteCaret],
		complete: pasteSummary.complete,
		sampleCount: 1,
		samples: [paste],
		summary: pasteSummary
	});
	await context.close();
	return { scenarios };
}

async function runSource(browser, url, fixture, runs) {
	const context = await browser.newContext({ locale: 'en-US' });
	await context.addInitScript(() => {
		window.__MDSH_EDITOR_PERF__ = true;
	});
	const page = await context.newPage();
	await page.goto(url);
	await waitForShell(page);
	await seed(page, fixture, 0);
	await page.evaluate(() => localStorage.setItem('mdsh:mode', 'source'));
	await page.reload();
	await waitForShell(page);
	const source = page.locator('.cm-content');
	try {
		await source.waitFor({ state: 'visible', timeout: 120_000 });
	} catch (error) {
		await context.close();
		return [
			{
				id: `source-${fixture.id}-unavailable-small`,
				mode: 'source',
				library: 0,
				unavailable: `The source editor did not become visible: ${error.message}`
			}
		];
	}
	await waitForIdle(page);
	await installProbe(page);
	const selector = '.cm-content';
	const scenarios = [];
	const positions = [
		{ id: 'start', ratio: 0.02 },
		{ id: 'middle', ratio: 0.5 },
		{ id: 'end', ratio: 0.98 }
	];
	const positionRuns = fixture.content.length >= 5_000_000 ? 1 : runs;
	for (const position of positions) {
		const samples = [];
		const carets = [];
		for (let run = 0; run < positionRuns; run += 1) {
			carets.push(await positionCaret(page, selector, position.ratio));
			samples.push(
				await page.evaluate(
					([target, text]) => window.__benchmark.insertOnce(target, text),
					[selector, `y${position.id}${run}`]
				)
			);
			await waitForIdle(page, 5_000);
		}
		const summary = summarizeSamples(samples);
		scenarios.push({
			id: `source-${fixture.id}-${position.id}-small`,
			mode: 'source',
			position: position.id,
			library: 0,
			carets,
			complete: summary.complete,
			sampleCount: samples.length,
			samples,
			summary
		});
	}
	const burstCharacters = 'abcdefghijklmnopqrst';
	const burst = await page.evaluate(
		([target, text]) => window.__benchmark.insertBurst(target, text),
		[selector, burstCharacters]
	);
	await waitForIdle(page, 5_000);
	const burstSummary = summarizeSamples(burst.samples);
	scenarios.push({
		id: `source-${fixture.id}-burst-small`,
		mode: 'source',
		position: 'middle-burst',
		library: 0,
		carets: [burst.caret],
		complete: burstSummary.complete,
		sampleCount: burst.samples.length,
		samples: burst.samples,
		summary: burstSummary
	});
	const pasteCaret = await positionCaret(page, selector, 0.5);
	const pasteText = 'Paste text '.repeat(20);
	const paste = await page.evaluate(
		([target, text]) => window.__benchmark.insertOnce(target, text),
		[selector, pasteText]
	);
	await waitForIdle(page, 5_000);
	const pasteSummary = summarizeSamples([paste]);
	scenarios.push({
		id: `source-${fixture.id}-paste-small`,
		mode: 'source',
		position: 'middle-paste',
		library: 0,
		carets: [pasteCaret],
		complete: pasteSummary.complete,
		sampleCount: 1,
		samples: [paste],
		summary: pasteSummary
	});
	await context.close();
	return scenarios;
}

async function main() {
	if (process.argv[2] === '--suite' && process.argv[3] === 'stress') {
		const { stressMain } = await import('./benchmark-stress.mjs');
		return stressMain(process.argv.slice(4));
	}
	const options = parseArguments(process.argv.slice(2));
	const { server, url } = await startStaticServer(options.port);
	const browserType = browserTypes[options.browser];
	const browser = await browserType.launch();
	const scenarios = [];
	const fixtures = [];
	try {
		for (const bytes of options.sizes) {
			const fixture = fixtureFor(bytes);
			fixtures.push({
				id: fixture.id,
				bytes: Buffer.byteLength(fixture.content),
				sha256: sha256(fixture.content),
				generator: 'noteContent(777, bytes)'
			});
			const libraryCounts =
				options.libraries === 'both' ? [0, 300] : [options.libraries === 'large' ? 300 : 0];
			if (options.modes.includes('visual')) {
				for (const libraryCount of libraryCounts) {
					console.error(`Visual ${bytes} bytes, library ${libraryCount}.`);
					const visual = await runEditor(browser, url, fixture, libraryCount, options.runs);
					scenarios.push(...visual.scenarios);
				}
			}
			if (options.modes.includes('source')) {
				console.error(`Source ${bytes} bytes.`);
				scenarios.push(...(await runSource(browser, url, fixture, options.runs)));
			}
		}
		const harnessPath = new URL(import.meta.url).pathname;
		const report = {
			schemaVersion: 2,
			generatedAt: new Date().toISOString(),
			target: 'web',
			browser: {
				name: options.browser,
				version: browser.version(),
				engine: browserType.name()
			},
			buildMode: options.buildMode,
			url,
			source: {
				revision: gitRevision(projectRoot),
				harnessPath,
				harnessSha256: sha256(await readFile(harnessPath)),
				buildTreeSha256: await treeSha256(resolve(projectRoot, 'build')),
				buildIndexSha256: sha256(await readFile(resolve(projectRoot, 'build/index.html'))),
				workingTree: await workingTreeIdentity()
			},
			environment: environmentIdentity(),
			fixtures,
			method: {
				visual:
					'In-page execCommand insertText from a text-offset caret, then one animation frame. The frame timestamp follows the textContent read. Includes product work triggered by the input.',
				burst:
					'Twenty single-character transactions at the document middle, each sampled to the next frame.',
				paste: 'One 220-character insertText call at the document middle.',
				source:
					'One single-character insertText call in CodeMirror at the document middle, then one animation frame.',
				stages:
					'Product events from deckmark:editor-perf, summed per sample. filterTransaction is the visual note guard; restoreMarkdown is source fidelity; sourceGuardConversion and sourceChangeConversion are CodeMirror snapshots.'
			},
			limits: [
				'Headless browser timings do not prove native WebView timings.',
				'A single local host and browser instance do not establish a cross-platform distribution.',
				'The 5 MB cases use one sample per position and are stress observations, not a precise percentile.',
				'Commands run sequentially with one browser. Do not start competing heavy workloads.',
				'Five samples make p95 equal to the maximum. Read the raw samples with the summary.'
			],
			scenarios
		};
		const incomplete = scenarios.filter(
			(scenario) => !scenario.unavailable && scenario.complete === false
		);
		if (incomplete.length) {
			console.error(
				`Incomplete scenarios: ${incomplete.map((scenario) => scenario.id).join(', ')}`
			);
			process.exitCode = 1;
		}
		if (options.output) await writeFile(options.output, JSON.stringify(report, null, 2) + '\n');
		console.log(
			JSON.stringify(
				{
					output: options.output,
					scenarios: scenarios.length,
					incomplete: incomplete.map((scenario) => scenario.id)
				},
				null,
				2
			)
		);
	} finally {
		await browser.close();
		await new Promise((resolvePromise) => server.close(resolvePromise));
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});

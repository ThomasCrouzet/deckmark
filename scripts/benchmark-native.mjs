// Native WebView benchmark. It launches the built Tauri binary through the
// embedded test WebDriver, measures the real platform WebView, and writes local
// evidence only. Build with --features native-smoke before use.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
	budgetGateFailed,
	budgetReport,
	environmentIdentity,
	gitRevision,
	loadBudgets,
	platformKeyForNative,
	round,
	summarize
} from './benchmark-shared.mjs';
import { largeNote, libraryRows, projectRows } from './benchmark-fixtures/corpus.mjs';
import { processTreeMemory } from './native-process-memory.mjs';
import { testSource } from './test-source.mjs';

const libraryFixture = libraryRows();
const projectFixture = projectRows();
const largeFixture = largeNote();
const binaryName = process.platform === 'win32' ? 'deckmark.exe' : 'deckmark';

function binaryPath(projectRoot, options) {
	const configured = process.env.NATIVE_BINARY;
	if (configured) return resolve(configured);
	const mode = options.buildMode === 'debug' ? 'debug' : 'release';
	const candidate = resolve(projectRoot, 'src-tauri/target', mode, binaryName);
	if (!existsSync(candidate)) {
		throw new Error(
			`Native benchmark requires a built binary at ${candidate}. Build with --features native-smoke --no-bundle first, or set NATIVE_BINARY.`
		);
	}
	return candidate;
}

function smokeEnvironment(home, dataStoreId, port, pdfPath) {
	return {
		...process.env,
		HOME: home,
		CFFIXED_USER_HOME: home,
		XDG_CONFIG_HOME: join(home, '.config'),
		XDG_DATA_HOME: join(home, '.local', 'share'),
		XDG_CACHE_HOME: join(home, '.cache'),
		APPDATA: join(home, 'AppData', 'Roaming'),
		LOCALAPPDATA: join(home, 'AppData', 'Local'),
		MDSH_SMOKE_DATA_STORE_ID: dataStoreId,
		MDSH_SMOKE_PDF: pdfPath,
		TAURI_WEBDRIVER_PORT: String(port)
	};
}

export async function runNativeBenchmark({ options, fixtures, projectRoot }) {
	const binary = binaryPath(projectRoot, options);
	const bytes = readFileSync(binary);
	assert.ok(
		bytes.includes(Buffer.from('[mdsh-native-startup]')),
		'Build with --features native-smoke before the native benchmark'
	);
	assert.ok(
		bytes.includes(Buffer.from('io.github.thomascrouzet.deckmark.smoke')),
		'Use tauri.smoke.conf.json for isolated native benchmark data'
	);
	const presentationFixture = fixtures.descriptors.find((entry) => entry.id === 'presentation');
	if (!presentationFixture?.path) throw new Error('The presentation fixture is missing.');
	const presentationText = await readFile(presentationFixture.path, 'utf8');
	const outputDirectory = options.output
		? join(resolve(options.output), '..')
		: resolve(process.env.NATIVE_BENCHMARK_DIR ?? 'native-test-results/benchmark-native');
	mkdirSync(outputDirectory, { recursive: true });
	const home = join(tmpdir(), `mdsh-benchmark-${randomBytes(8).toString('hex')}`);
	mkdirSync(home, { recursive: true });
	const dataStoreId = randomBytes(16).toString('hex');
	const pdfPath = join(outputDirectory, 'benchmark-native.pdf');
	const logPath = join(outputDirectory, 'application.log');
	const log = openSync(logPath, 'w');
	const port = Number(process.env.TAURI_WEBDRIVER_PORT ?? 4457);
	const endpoint = `http://127.0.0.1:${port}`;
	/** @type {import('node:child_process').ChildProcess | undefined} */
	let app;
	let session = '';
	const failures = [];
	const memory = [];
	const screenshots = [];
	const runMemory = (label) => {
		if (!app?.pid) return null;
		try {
			const value = processTreeMemory(app.pid);
			const sample = { label, ...value };
			memory.push(sample);
			return sample;
		} catch (error) {
			failures.push({ stage: `memory:${label}`, error: String(error) });
			return null;
		}
	};

	/** @param {string} path @param {unknown} [body] @param {string} [method] */
	async function request(path, body, method = 'POST') {
		const response = await fetch(`${endpoint}${path}`, {
			method,
			headers: { 'content-type': 'application/json' },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: AbortSignal.timeout(60_000)
		});
		const data = await response.json();
		if (!response.ok || data.value?.error) {
			throw Object.assign(new Error(`${method} ${path}: ${JSON.stringify(data)}`), {
				webdriverError: data.value?.error
			});
		}
		return data.value;
	}
	/** @param {string} script @param {unknown[]} [args] */
	const execute = (script, args = []) =>
		request(`/session/${session}/execute/sync`, { script, args });
	/** @param {string} script @param {unknown[]} [args] */
	const executeAsync = (script, args = []) =>
		request(`/session/${session}/execute/async`, { script, args });

	/** @param {() => Promise<unknown>} check @param {string} label @param {number} [timeout] */
	async function until(check, label, timeout = 60_000) {
		const deadline = Date.now() + timeout;
		let last;
		while (Date.now() < deadline) {
			try {
				const value = await check();
				if (value) return value;
			} catch (error) {
				last = error;
			}
			await delay(100);
		}
		throw new Error(`Timeout ${label}: ${last ? String(last) : 'condition false'}`);
	}

	async function appReady() {
		await until(
			() =>
				execute(
					'return document.querySelector(".mdsh-shell")?.getAttribute("aria-busy") === "false";'
				),
			'native shell ready',
			90_000
		);
	}

	async function launch() {
		const startedAt = performance.now();
		app = spawn(binary, [], {
			stdio: ['ignore', log, log],
			env: smokeEnvironment(home, dataStoreId, port, pdfPath)
		});
		const launched = app;
		launched.once('error', (error) => failures.push({ stage: 'launch', error: String(error) }));
		await until(
			async () => (await request('/status', undefined, 'GET')).ready === true,
			'WebDriver ready',
			process.platform === 'win32' ? 120_000 : 45_000
		);
		const driverReady = performance.now();
		const created = await request('/session', {
			capabilities: { alwaysMatch: { 'wdio:tauriServiceOptions': { windowLabel: 'main' } } }
		});
		session = created.sessionId;
		await appReady();
		return {
			spawnToDriverMs: round(driverReady - startedAt),
			spawnToShellMs: round(performance.now() - startedAt),
			capabilities: created.capabilities
		};
	}

	async function closeApp() {
		if (!app) return null;
		const startedAt = performance.now();
		// Capture the process: the fallback timer below must never act on a later
		// launch that reuses the shared `app` variable.
		const target = app;
		const exited = new Promise((resolvePromise) => target.once('exit', resolvePromise));
		const invoked = await executeAsync(
			`const done = arguments[arguments.length - 1]; window.__TAURI__.core.invoke('desktop_smoke_request_close').then(() => done(true), error => done({ error: String(error) }));`
		).catch(() => null);
		if (!invoked || invoked.error) target.kill();
		await Promise.race([
			exited,
			delay(20_000).then(() => {
				target.kill();
				return undefined;
			})
		]);
		const elapsed = performance.now() - startedAt;
		if (app && app.exitCode === null && app.signalCode === null) {
			app.kill('SIGKILL');
			await Promise.race([
				new Promise((resolvePromise) => app?.once('exit', resolvePromise)),
				delay(5_000)
			]);
		}
		app = undefined;
		session = '';
		return round(elapsed);
	}

	async function screenshot(name) {
		if (!options.output || !session) return;
		try {
			const base64 = await request(`/session/${session}/screenshot`, undefined, 'GET');
			const directory = join(outputDirectory, 'screenshots');
			mkdirSync(directory, { recursive: true });
			writeFileSync(join(directory, `${name}.png`), Buffer.from(base64, 'base64'));
			screenshots.push(join('screenshots', `${name}.png`));
		} catch (error) {
			failures.push({ stage: `screenshot:${name}`, error: String(error) });
		}
	}

	async function seedDatabase() {
		const rows = [
			{
				id: 'bench-presentation',
				name: 'bench-presentation.md',
				content: presentationText,
				createdAt: 1_700_000_000_000,
				updatedAt: 1_700_000_000_000,
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
		// The WebDriver server rejects oversized request bodies, so the corpus is
		// written in bounded batches instead of one multi-megabyte call.
		await executeAsync(
			`const [project] = arguments; const done = arguments[arguments.length - 1];
			const request = indexedDB.open('mdsh');
			request.onerror = () => done({ error: String(request.error) });
			request.onsuccess = () => {
				const database = request.result;
				const names = [...database.objectStoreNames];
				const stores = ['drafts', ...(names.includes('projects') ? ['projects'] : [])];
				const transaction = database.transaction(stores, 'readwrite');
				transaction.objectStore('drafts').clear();
				if (names.includes('projects')) {
					const projects = transaction.objectStore('projects');
					projects.clear();
					projects.put(project);
				}
				transaction.oncomplete = () => { database.close(); done(true); };
				transaction.onerror = () => { database.close(); done({ error: String(transaction.error) }); };
			};`,
			[projectFixture.project]
		);
		const batchSize = 20;
		for (let offset = 0; offset < rows.length; offset += batchSize) {
			await executeAsync(
				`const [rows] = arguments; const done = arguments[arguments.length - 1];
				const request = indexedDB.open('mdsh');
				request.onerror = () => done({ error: String(request.error) });
				request.onsuccess = () => {
					const database = request.result;
					const transaction = database.transaction('drafts', 'readwrite');
					const drafts = transaction.objectStore('drafts');
					for (const row of rows) drafts.put(row);
					transaction.oncomplete = () => { database.close(); done(true); };
					transaction.onerror = () => { database.close(); done({ error: String(transaction.error) }); };
				};`,
				[rows.slice(offset, offset + batchSize)]
			);
		}
		await execute(
			`localStorage.setItem('mdsh:activeId', 'bench-000'); localStorage.setItem('mdsh:mode', 'source'); localStorage.setItem('mdsh:locale', 'en');`
		);
	}

	async function refresh() {
		const timeouts = await request(`/session/${session}/timeouts`, undefined, 'GET');
		await request(`/session/${session}/timeouts`, { script: 2_000 });
		try {
			await execute('window.__mdshBenchmarkBeforeReload = true;');
			await request(`/session/${session}/refresh`, {}).catch((error) => {
				if (!['script timeout', 'javascript error'].includes(error.webdriverError)) throw error;
			});
			await until(
				() =>
					execute(
						'return window.__mdshBenchmarkBeforeReload !== true && document.querySelector(".mdsh-shell")?.getAttribute("aria-busy") === "false" && !!document.querySelector("button[data-mode=source]");'
					),
				'native refresh ready',
				90_000
			);
		} finally {
			await request(`/session/${session}/timeouts`, { script: timeouts.script });
		}
	}

	async function click(selector) {
		await until(
			() =>
				execute(
					`const element = document.querySelector(arguments[0]);
					if (!element || !element.getClientRects().length) return false;
					element.click(); return true;`,
					[selector]
				),
			`click ${selector}`,
			45_000
		);
	}

	async function waitForContent(predicate, label, timeout = 60_000) {
		await until(() => execute(`return (${predicate});`), label, timeout);
	}

	async function waitForIdle(timeout = 20_000) {
		await executeAsync(
			`const done = arguments[arguments.length - 1]; const limit = arguments[0];
			let settled = false;
			const finish = () => { if (!settled) { settled = true; done(true); } };
			const fallback = setTimeout(finish, limit);
			if (typeof requestIdleCallback !== 'function') { setTimeout(finish, 1500); return; }
			requestIdleCallback(() => setTimeout(() => { clearTimeout(fallback); finish(); }, 250), { timeout: limit });`,
			[timeout]
		);
	}

	async function installInputProbe() {
		await execute(`
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
				let supported = true;
				try { supported = document.execCommand('insertText', false, text); }
				catch { supported = false; }
				const updatedAt = performance.now();
				return new Promise(resolvePromise => requestAnimationFrame(() => {
					resolvePromise({
						supported,
						changed: (editor.textContent ?? '') !== before,
						syncMs: updatedAt - startedAt,
						frameMs: performance.now() - startedAt
					});
				}));
			};
		`);
	}

	async function inputProbe(selector, runs, label) {
		const values = [];
		const sync = [];
		for (let run = 0; run < runs; run += 1) {
			const result = await execute('return window.__benchmark.input(arguments[0], arguments[1]);', [
				selector,
				` ${label}${run}`
			]);
			if (!result?.supported || !result.changed) {
				values.push(null);
				sync.push(null);
				if (run >= 1) break;
				continue;
			}
			values.push(round(result.frameMs));
			sync.push(round(result.syncMs));
		}
		while (values.length < runs) {
			values.push(null);
			sync.push(null);
		}
		return { values, sync };
	}

	async function driverTyping(selector, runs, label) {
		const element = await request(`/session/${session}/element`, {
			using: 'css selector',
			value: selector
		});
		const elementId = element['element-6066-11e4-a52e-4f735466cecf'];
		const values = [];
		for (let run = 0; run < runs; run += 1) {
			const startedAt = performance.now();
			await request(`/session/${session}/element/${elementId}/value`, {
				text: ` ${label}${run}`,
				value: [...` ${label}${run}`]
			});
			values.push(performance.now() - startedAt);
		}
		return values;
	}

	async function documentSwitch(runs) {
		const values = [];
		for (let run = 0; run < runs; run += 1) {
			const id = `bench-${String((run % 6) + 1).padStart(3, '0')}`;
			const startedAt = performance.now();
			await click(`button[data-file-id="${id}"]`);
			await waitForContent(
				`document.querySelector('header input')?.value === ${JSON.stringify(id)}`,
				`switch to ${id}`,
				30_000
			);
			values.push(performance.now() - startedAt);
		}
		return values;
	}

	async function largeDocumentOpen(runs) {
		const values = [];
		for (let run = 0; run < runs; run += 1) {
			await click('button[data-file-id="bench-000"]');
			await waitForContent(
				`document.querySelector('header input')?.value === 'bench-000'`,
				'return to small note',
				30_000
			);
			const startedAt = performance.now();
			await click('button[data-file-id="bench-large"]');
			await waitForContent(
				`document.querySelector('header input')?.value === 'bench-large'`,
				'open large note',
				90_000
			);
			values.push(performance.now() - startedAt);
		}
		return values;
	}

	async function readMode(runs) {
		const values = [];
		result.samples.readModeSwitch = values;
		for (let run = 0; run < runs; run += 1) {
			result.readModeProgress = { iteration: run + 1, phase: 'click-read' };
			const startedAt = performance.now();
			await click('button[data-mode="read"]');
			result.readModeProgress.phase = 'wait-preview';
			await waitForContent(
				`!!document.querySelector('.mdsh-read .mdsh-preview') && (document.querySelector('.mdsh-preview')?.textContent?.length ?? 0) > 100000`,
				'render large note in read mode',
				90_000
			);
			values.push(performance.now() - startedAt);
			runMemory(`read-mode-${run + 1}`);
			result.readModeCanvas = await execute(
				'return [...document.querySelectorAll("canvas")].map(canvas => ({ width: canvas.width, height: canvas.height, annotation: canvas.dataset.testid === "annotation-canvas" }));'
			);
			result.readModeProgress.phase = 'click-source';
			await click('button[data-mode="source"]');
		}
	}

	async function scroll(runs) {
		const values = [];
		for (let run = 0; run < runs; run += 1) {
			const result = await execute(
				`return new Promise(resolvePromise => {
					const scroller = document.querySelector('.mdsh-read');
					if (!scroller) { resolvePromise(null); return; }
					const room = scroller.scrollHeight - scroller.clientHeight;
					const startedAt = performance.now();
					scroller.scrollTop = Math.round(room * arguments[0]);
					requestAnimationFrame(() => requestAnimationFrame(() => resolvePromise({ ms: performance.now() - startedAt, room })));
				});`,
				[((run % 8) + 1) / 9]
			);
			values.push(result && result.room > 0 ? round(result.ms) : null);
		}
		return values;
	}

	async function modeSwitch(runs) {
		const wysiwygLoad = [];
		const typing = [];
		const typingSync = [];
		for (let run = 0; run < runs; run += 1) {
			const startedAt = performance.now();
			await click('button[data-mode="wysiwyg"]');
			await until(
				() => execute('return !!document.querySelector(".milkdown .ProseMirror")'),
				'native WYSIWYG ready',
				90_000
			);
			wysiwygLoad.push(performance.now() - startedAt);
			await waitForIdle();
			await installInputProbe();
			const result = await inputProbe('.milkdown .ProseMirror', 1, `visual${run}`);
			typing.push(result.values[0]);
			typingSync.push(result.sync[0]);
			await click('button[data-mode="source"]');
			await until(
				() => execute('return !!document.querySelector(".cm-content")'),
				'native source editor',
				45_000
			);
		}
		return { wysiwygLoad, typing, typingSync };
	}

	async function projectTree(runs) {
		const values = [];
		for (let run = 0; run < runs; run += 1) {
			const startedAt = performance.now();
			await click('[data-testid="projects-open"]');
			await until(
				() => execute('return !!document.getElementById("projects-title")'),
				'Projects panel',
				45_000
			);
			await waitForContent(
				`document.querySelectorAll('[role="dialog"] [data-project-document]').length === ${projectFixture.documents.length}`,
				'project tree rows',
				90_000
			);
			values.push(performance.now() - startedAt);
			// The close control is disabled while the panel is busy.
			await waitForContent(
				`!document.querySelector('[role="dialog"][aria-labelledby="projects-title"] header button')?.disabled`,
				'Projects panel idle',
				60_000
			);
			await click('[role="dialog"][aria-labelledby="projects-title"] header button');
			await until(
				() => execute('return !document.getElementById("projects-title")'),
				'Projects panel closed',
				30_000
			);
		}
		return values;
	}

	async function presentation(actionRuns) {
		await click('button[data-file-id="bench-presentation"]');
		const startedAt = performance.now();
		await until(
			() => execute('return !!document.querySelector(`[data-testid="presentation-editor"]`)'),
			'presentation editor',
			90_000
		);
		await until(
			() =>
				execute('return document.querySelectorAll(`[data-testid="slide-thumbnail"]`).length === 3'),
			'presentation slides',
			90_000
		);
		const load = round(performance.now() - startedAt);
		const slideSwitch = [];
		for (let run = 0; run < actionRuns; run += 1) {
			const index = (run % 2) + 1;
			const switchAt = performance.now();
			await click(`[data-testid="slide-thumbnail"][data-slide-index="${index}"]`);
			await until(
				() =>
					execute(
						`return document.querySelector(arguments[0])?.getAttribute('aria-current') === 'true';`,
						[`[data-testid="slide-thumbnail"][data-slide-index="${index}"]`]
					),
				'slide switched',
				30_000
			);
			slideSwitch.push(performance.now() - switchAt);
		}
		const present = [];
		for (let run = 0; run < actionRuns; run += 1) {
			const presentAt = performance.now();
			await click('[data-testid="slide-present"]');
			await until(
				() => execute('return !!document.querySelector(`[data-testid="slide-present-exit"]`)'),
				'present mode',
				30_000
			);
			present.push(performance.now() - presentAt);
			await click('[data-testid="slide-present-exit"]');
			await until(
				() => execute('return !!document.querySelector(`[data-testid="slide-present"]`)'),
				'present mode exit',
				30_000
			);
		}
		return { load: [load], slideSwitch, present };
	}

	async function exportPrepare(runs) {
		await click('button[data-file-id="bench-000"]');
		await until(
			() => execute('return !!document.querySelector("button[data-mode=source]")'),
			'source note for export',
			30_000
		);
		const values = [];
		for (let run = 0; run < runs; run += 1) {
			await click('button[aria-label="Command palette"]');
			if (process.platform === 'darwin') {
				if (existsSync(pdfPath)) rmSync(pdfPath, { force: true });
				const startedAt = performance.now();
				await click('#cmd-palette-opt-export-pdf');
				await until(
					() => existsSync(pdfPath) && readFileSync(pdfPath).length > 1_000,
					'native PDF export',
					90_000
				);
				values.push(performance.now() - startedAt);
				return values;
			}
			await execute(
				'window.__benchmarkPrintCalled = false; window.__benchmarkOriginalPrint = window.print; window.print = () => { window.__benchmarkPrintCalled = true; };'
			);
			const startedAt = performance.now();
			await click('#cmd-palette-opt-export-pdf');
			await until(
				() => execute('return window.__benchmarkPrintCalled === true;'),
				'native print prepared',
				90_000
			);
			values.push(performance.now() - startedAt);
			await execute(
				`document.getElementById('mdsh-native-print')?.remove(); window.print = window.__benchmarkOriginalPrint; delete window.__benchmarkOriginalPrint; window.dispatchEvent(new Event('afterprint'));`
			);
		}
		return values;
	}

	const result = {
		schemaVersion: 2,
		target: 'native',
		buildMode: options.buildMode,
		source: gitRevision(projectRoot),
		environment: environmentIdentity({
			binary,
			binarySha256: createHash('sha256').update(bytes).digest('hex'),
			appVersion: JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8')).version
		}),
		sourceSnapshot: testSource(join(outputDirectory, 'source-runtime')),
		fixtures: fixtures.descriptors,
		corpus: {
			libraryDocuments: libraryFixture.length,
			largeNoteBytes: Buffer.byteLength(largeFixture),
			projectDocuments: projectFixture.documents.length
		},
		method: {
			startup:
				'Wall clock from process spawn to the embedded WebDriver ready endpoint and to the shell ready state.',
			inputLatency:
				'In-page time from a focused execCommand insertText call to the next animation frame. Excludes driver round trip.',
			driverTyping: 'Wall clock for the WebDriver element value command. Includes driver IPC.',
			scrollFrame: 'In-page time to set scrollTop and observe two animation frames.',
			projectTree: 'Wall clock from the Projects panel click to the expected project row count.',
			export:
				'Wall clock from the PDF command click to the prepared print document. Opening the command palette is excluded. macOS writes the real PDF; Linux and Windows replace only the final OS print dialog call.',
			memory:
				'Sum of resident bytes or working set for the application process tree. WebView helper processes are included when the platform reports them.'
		},
		limits: [
			'The binary contains the native-smoke test WebDriver. Use the same feature and configuration for every run of one baseline.',
			'A debug build is slower than a release build. Record buildMode and compare equal modes only.',
			'Linux and Windows export measurements stop before the operating system print dialog.'
		],
		checks: [],
		failures,
		memory,
		screenshots,
		log: logPath,
		samples: {},
		summary: {},
		features: {
			ai: {
				present: false,
				reason:
					'The product has no AI feature or AI setting. Startup checks do not claim AI-disabled coverage.'
			},
			annotations: {
				present: false,
				reason:
					'The product has no annotation workflow. The native suite does not claim annotation coverage.'
			},
			snippets: {
				present: false,
				reason:
					'The product has no reusable snippet feature. The suite checks built-in templates instead.'
			}
		}
	};

	let finalizationError;
	try {
		result.stage = 'cold-startup';
		const cold = await launch();
		result.samples.startupCold = [cold.spawnToShellMs];
		result.runtime = cold.capabilities;
		result.checks.push('native cold startup');
		await screenshot('01-startup');
		runMemory('startup');
		result.stage = 'library-reload';
		await seedDatabase();
		// Warm up the reload path, then collect enough samples for p95 to be
		// meaningful. Cold startup is measured separately.
		const reloadSamples = [];
		for (let run = 0; run < 21; run += 1) {
			const reloadStartedAt = performance.now();
			await refresh();
			// A reload replaces the window, so the probe must be installed after it.
			await installInputProbe();
			await waitForContent(
				`document.querySelector('header input')?.value === 'bench-000'`,
				'library reload editor',
				90_000
			);
			if (run > 0) reloadSamples.push(round(performance.now() - reloadStartedAt));
		}
		result.samples.libraryReload = reloadSamples;
		runMemory('library');
		await screenshot('02-library');
		result.checks.push('native library reload');

		result.stage = 'source-typing';
		await waitForIdle();
		const sourceTyping = await inputProbe('.cm-content', options.runs, 'source');
		result.samples.typingSource = sourceTyping.values;
		result.samples.typingSourceSync = sourceTyping.sync;
		result.samples.typingSourceDriver = await driverTyping('.cm-content', options.runs, 'driver');
		result.checks.push('native source typing');
		result.stage = 'document-switch';
		result.samples.documentSwitch = await documentSwitch(options.runs);
		result.checks.push('native document switch');
		result.stage = 'large-document';
		result.samples.largeDocumentOpen = await largeDocumentOpen(Math.min(options.runs, 5));
		await waitForIdle();
		const largeTyping = await inputProbe('.cm-content', Math.min(options.runs, 5), 'large');
		result.samples.typingLarge = largeTyping.values;
		result.samples.typingLargeSync = largeTyping.sync;
		runMemory('large-document');
		result.stage = 'read-mode';
		await readMode(Math.min(options.runs, 5));
		result.readModeProgress = { iteration: null, phase: 'click-read-for-scroll' };
		await click('button[data-mode="read"]');
		result.readModeProgress.phase = 'wait-preview-for-scroll';
		await waitForContent(
			`(document.querySelector('.mdsh-preview')?.textContent?.length ?? 0) > 100000`,
			'read mode for scroll',
			90_000
		);
		result.readModeProgress.phase = 'scroll';
		result.samples.scrollFrame = await scroll(options.runs);
		result.readModeProgress.phase = 'screenshot';
		await screenshot('03-read-mode');
		result.readModeProgress.phase = 'click-source-after-scroll';
		await click('button[data-mode="source"]');
		result.readModeProgress.phase = 'complete';
		result.stage = 'wysiwyg';
		const visual = await modeSwitch(Math.max(options.runs, 20));
		result.samples.wysiwygLoad = visual.wysiwygLoad;
		result.samples.typingWysiwyg = visual.typing;
		result.samples.typingWysiwygSync = visual.typingSync;
		runMemory('wysiwyg');
		result.checks.push('native WYSIWYG load');
		result.stage = 'project-tree';
		result.samples.projectTreeRender = await projectTree(Math.min(options.runs, 5));
		result.checks.push('native project tree');
		result.stage = 'presentation';
		const deck = await presentation(20);
		result.samples.presentationLoad = deck.load;
		result.samples.presentationSlideSwitch = deck.slideSwitch;
		result.samples.presentationPresent = deck.present;
		await screenshot('04-presentation');
		runMemory('presentation');
		result.checks.push('native presentation');
		result.stage = 'export';
		result.samples.exportPrepare = await exportPrepare(Math.min(options.runs, 3));
		runMemory('export');
		result.checks.push('native export preparation');
		result.stage = 'close';
		const warm = await closeApp();
		result.samples.closeMs = [warm];
		result.stage = 'warm-startup';
		// A single warm start cannot separate a runner stall from a regression.
		// Collect three starts and gate on the median, with the p95 and max kept.
		const warmSamples = [];
		for (let run = 0; run < 3; run += 1) {
			const restarted = await launch();
			warmSamples.push(restarted.spawnToShellMs);
			if (run < 2) await closeApp();
		}
		result.samples.startupWarm = warmSamples;
		runMemory('warm-startup');
		await screenshot('05-warm-startup');
		result.checks.push('native warm startup');
	} catch (error) {
		result.error = String(error);
		result.passed = false;
		runMemory('failure');
		if (session) {
			try {
				result.page = await execute(
					'return { title: document.title, text: document.body?.innerText.slice(0, 2000), dialogs: [...document.querySelectorAll("[role=dialog]")].map(node => node.getAttribute("aria-label")) };'
				);
			} catch (pageError) {
				failures.push({ stage: 'page:failure', error: String(pageError) });
			}
			await screenshot('failure');
		}
		throw error;
	} finally {
		result.passed = result.passed !== false;
		try {
			result.summary = Object.fromEntries(
				Object.entries(result.samples)
					.filter(([, values]) => Array.isArray(values))
					.map(([name, values]) => [name, summarize(values)])
			);
			if (memory.length > 0) {
				const rss = memory.map((sample) => sample.mb);
				result.samples.rssMb = rss;
				result.summary.rssMb = summarize(rss, 'MB');
			}
			result.maxMemoryMb = memory.reduce((peak, sample) => Math.max(peak, sample.mb), 0);
			result.budget = budgetReport({
				platformKey: platformKeyForNative(),
				summary: result.summary,
				budgets: await loadBudgets(options.budgets)
			});
			result.budgetEnforced = options.enforceBudgets;
			if (result.passed && budgetGateFailed(result.budget, options.enforceBudgets)) {
				result.forcedBudgetFailure = true;
			}
		} catch (error) {
			failures.push({ stage: 'finalize', error: String(error) });
			result.passed = false;
			finalizationError = error;
		}
		result.application = {
			pid: app?.pid ?? null,
			exitCode: app?.exitCode ?? null,
			signalCode: app?.signalCode ?? null
		};
		try {
			if (app?.pid) app.kill();
		} catch (error) {
			failures.push({ stage: 'cleanup', error: String(error) });
			result.passed = false;
			finalizationError ??= error;
		}
		try {
			await writeFile(
				options.output ? resolve(options.output) : join(outputDirectory, 'results.json'),
				`${JSON.stringify(result, null, 2)}\n`
			);
		} catch (error) {
			failures.push({ stage: 'write-result', error: String(error) });
			console.error('Could not write native benchmark results:', error);
			finalizationError ??= error;
		}
	}
	if (finalizationError) throw finalizationError;
	if (result.forcedBudgetFailure) {
		throw new Error(
			`Benchmark budget gate failed for ${result.budget.platformKey}: ${result.budget.failures.join(', ')}`
		);
	}
	return result;
}

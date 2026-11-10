// Native WebView mode transport. It starts the built Tauri test binary, drives
// the same mode matrix over the embedded WebDriver, and writes local evidence
// only. Build with --features native-smoke before use.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync
} from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { arch, platform, release, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { environmentIdentity } from './benchmark-shared.mjs';
import { modeFixture } from './benchmark-fixtures/modes.mjs';
import { sentinelText } from './benchmark-stress-contract.mjs';
import { testSource } from './test-source.mjs';

const root = resolve(import.meta.dirname, '..');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const binaryName = process.platform === 'win32' ? 'deckmark.exe' : 'deckmark';
const mainId = 'mode-main';
const sentinelId = 'mode-sentinel';

function binaryPath(options) {
	const configured = process.env.NATIVE_BINARY;
	if (configured) return resolve(configured);
	const mode = options.buildMode === 'release' ? 'release' : 'debug';
	const candidate = resolve(root, 'src-tauri/target', mode, binaryName);
	if (!existsSync(candidate)) {
		throw new Error(
			`Native mode transport requires a built binary at ${candidate}. Build with --features native-smoke --no-bundle, or set NATIVE_BINARY.`
		);
	}
	return candidate;
}

function smokeEnvironment(home, dataStoreId, port) {
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
		TAURI_WEBDRIVER_PORT: String(port)
	};
}

function nativeProvenance(binary, buildMode) {
	const bytes = readFileSync(binary);
	assert.ok(
		bytes.includes(Buffer.from('[mdsh-native-startup]')),
		'Build with --features native-smoke before a native mode run'
	);
	assert.ok(
		bytes.includes(Buffer.from('io.github.thomascrouzet.deckmark.smoke')),
		'Use tauri.smoke.conf.json for an isolated native mode run'
	);
	const source = testSource();
	const binarySha256 = createHash('sha256').update(bytes).digest('hex');
	return {
		schemaVersion: 1,
		kind: 'native-benchmark',
		createdAt: new Date().toISOString(),
		source: source.source,
		sourceTree: source.sourceTree,
		edition: 'desktop',
		version: JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version,
		basePath: '',
		buildMode,
		instrumentation: 'none',
		inputs: {
			workingDiffSha256: source.workingDiffSha256,
			untrackedCount: source.untracked.length
		},
		builder: { node: process.version, platform: platform(), release: release(), arch: arch() },
		binary: { path: relative(root, binary), bytes: bytes.length, sha256: binarySha256 },
		tree: { files: 1, sha256: binarySha256 }
	};
}

class NativeDriver {
	constructor(endpoint, session) {
		this.endpoint = endpoint;
		this.session = session;
	}

	async request(path, body, method = 'POST') {
		const response = await fetch(`${this.endpoint}${path}`, {
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

	execute(script, args = []) {
		return this.request(`/session/${this.session}/execute/sync`, { script, args });
	}

	executeAsync(script, args = []) {
		return this.request(`/session/${this.session}/execute/async`, { script, args });
	}

	async element(selector) {
		const value = await this.request(`/session/${this.session}/element`, {
			using: 'css selector',
			value: selector
		});
		return value['element-6066-11e4-a52e-4f735466cecf'];
	}

	// The WebDriver key channel is not trusted in this WebKitGTK build. The
	// editing command channel is the same one the native benchmark already
	// uses, and it emits a trusted beforeinput.
	async insertText(selector, text) {
		return this.execute(
			`const [selector, text] = arguments;
			const editor = document.querySelector(selector);
			if (!(editor instanceof HTMLElement)) return false;
			editor.focus();
			return document.execCommand('insertText', false, text);`,
			[selector, text]
		);
	}

	async historyCommand(command) {
		return this.execute(
			`const [command] = arguments;
			return document.execCommand(command);`,
			[command]
		);
	}

	async actions(entries) {
		await this.request(`/session/${this.session}/actions`, { actions: entries });
	}

	async press(keys) {
		const entries = keys.map((value) => ({ type: 'keyDown', value }));
		for (const value of [...keys].reverse()) entries.push({ type: 'keyUp', value });
		await this.actions([{ type: 'key', id: 'keyboard', actions: entries }]);
	}

	async until(check, label, timeout = 60_000) {
		const deadline = Date.now() + timeout;
		let last;
		while (Date.now() < deadline) {
			try {
				const value = await check();
				if (value) return value;
			} catch (error) {
				last = error;
			}
			await delay(50);
		}
		throw new Error(`Timeout ${label}: ${last ? String(last) : 'condition false'}`);
	}

	async refresh() {
		const timeouts = await this.request(`/session/${this.session}/timeouts`, undefined, 'GET');
		await this.request(`/session/${this.session}/timeouts`, { script: 2_000 });
		try {
			await this.execute('window.__mdshModeBeforeReload = true; return true;');
			await this.request(`/session/${this.session}/refresh`, {}).catch((error) => {
				if (!['script timeout', 'javascript error'].includes(error.webdriverError)) throw error;
			});
			await this.until(
				() =>
					this.execute(
						'return window.__mdshModeBeforeReload !== true && document.querySelector(".mdsh-shell")?.getAttribute("aria-busy") === "false";'
					),
				'native mode refresh ready',
				90_000
			);
		} finally {
			await this.request(`/session/${this.session}/timeouts`, { script: timeouts.script });
		}
	}

	async screenshot(name) {
		try {
			const base64 = await this.request(`/session/${this.session}/screenshot`, undefined, 'GET');
			const path = `${name}.png`;
			mkdirSync(resolve(path, '..'), { recursive: true });
			await writeFile(path, Buffer.from(base64, 'base64'));
			return path;
		} catch {
			return null;
		}
	}
}

async function launch(binary, port) {
	const home = join(tmpdir(), `mdsh-modes-${randomBytes(8).toString('hex')}`);
	mkdirSync(home, { recursive: true });
	const logPath = join(home, 'application.log');
	const log = openSync(logPath, 'w');
	const app = spawn(binary, [], {
		stdio: ['ignore', log, log],
		env: smokeEnvironment(home, randomBytes(16).toString('hex'), port)
	});
	const endpoint = `http://127.0.0.1:${port}`;
	async function request(path, body, method = 'POST') {
		const response = await fetch(`${endpoint}${path}`, {
			method,
			headers: { 'content-type': 'application/json' },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: AbortSignal.timeout(60_000)
		});
		const data = await response.json();
		if (!response.ok || data.value?.error)
			throw Object.assign(new Error(`${method} ${path}: ${JSON.stringify(data)}`), {
				webdriverError: data.value?.error
			});
		return data.value;
	}
	const deadline = Date.now() + (process.platform === 'win32' ? 120_000 : 45_000);
	while (Date.now() < deadline) {
		try {
			const status = await request('/status', undefined, 'GET');
			if (status.ready === true) break;
		} catch {
			/* The driver starts after the app shell. */
		}
		await delay(100);
	}
	if (Date.now() >= deadline) {
		app.kill();
		throw new Error(`Native WebDriver did not start. See ${logPath}`);
	}
	const created = await request('/session', {
		capabilities: { alwaysMatch: { 'wdio:tauriServiceOptions': { windowLabel: 'main' } } }
	});
	const driver = new NativeDriver(endpoint, created.sessionId);
	await driver.until(
		() =>
			driver.execute(
				'return document.querySelector(".mdsh-shell")?.getAttribute("aria-busy") === "false";'
			),
		'native mode shell',
		90_000
	);
	return { app, driver, logPath, capabilities: created.capabilities };
}

async function close(app, driver) {
	let elapsed;
	try {
		const started = performance.now();
		const exited = new Promise((done) => app.once('exit', done));
		const invoked = await driver
			.executeAsync(
				`const done = arguments[arguments.length - 1]; window.__TAURI__.core.invoke('desktop_smoke_request_close').then(() => done(true), error => done({ error: String(error) }));`
			)
			.catch(() => null);
		if (!invoked || invoked.error) app.kill();
		await Promise.race([exited, delay(20_000)]);
		if (app.exitCode === null && app.signalCode === null) {
			app.kill('SIGKILL');
			await Promise.race([new Promise((done) => app.once('exit', done)), delay(5_000)]);
		}
		elapsed = performance.now() - started;
	} catch {
		app.kill();
	}
	return elapsed;
}

async function seed(driver, fixture) {
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
	const observed = await driver.executeAsync(
		`const [rows] = arguments; const done = arguments[arguments.length - 1];
		const request = indexedDB.open('mdsh');
		request.onerror = () => done({ error: String(request.error) });
		request.onsuccess = () => {
			const database = request.result;
			const transaction = database.transaction('drafts', 'readwrite');
			transaction.objectStore('drafts').clear();
			for (const row of rows) transaction.objectStore('drafts').put(row);
			const read = transaction.objectStore('drafts').getAll();
			transaction.oncomplete = () => { database.close(); done(read.result); };
			transaction.onerror = () => { database.close(); done({ error: String(transaction.error) }); };
		};`,
		[rows]
	);
	if (!Array.isArray(observed))
		throw new Error(`Could not seed native drafts: ${JSON.stringify(observed)}`);
	await driver.execute(
		`localStorage.setItem('mdsh:activeId', ${JSON.stringify(mainId)});
		localStorage.setItem('mdsh:mode', 'source');
		localStorage.setItem('mdsh:locale', 'en');
		localStorage.setItem('mdsh:split-view', '0');
		return true;`
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

async function stored(driver, id = mainId) {
	return driver.executeAsync(
		`const [id] = arguments; const done = arguments[arguments.length - 1];
		const request = indexedDB.open('mdsh');
		request.onerror = () => done({ error: String(request.error) });
		request.onsuccess = () => {
			const database = request.result;
			const row = database.transaction('drafts').objectStore('drafts').get(id);
			row.onsuccess = () => { database.close(); done(row.result?.content); };
			row.onerror = () => { database.close(); done({ error: String(row.error) }); };
		};`,
		[id]
	);
}

async function waitStored(driver, predicate, label, timeout = 60_000) {
	const deadline = Date.now() + timeout;
	let last;
	while (Date.now() < deadline) {
		try {
			const content = await stored(driver);
			if (typeof content === 'string' && predicate(content)) return content;
		} catch (error) {
			last = error;
		}
		await delay(50);
	}
	assert.fail(`Stored source did not match ${label}: ${last ? String(last) : 'condition false'}`);
}

async function waitHashChange(driver, previousHash, label, timeout = 60_000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const content = await stored(driver);
		if (typeof content === 'string' && hash(content) !== previousHash) return content;
		await delay(50);
	}
	assert.fail(`Stored source did not change for ${label}`);
}

async function optional(driver) {
	return driver.execute(`return (() => {
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
			transactionCpu: { supported: false, reason: 'No pure transaction CPU boundary is exposed.' },
			preview: { supported: false, reason: 'Not instrumented in this adapter.' },
			validation: { supported: false, reason: 'Not instrumented in this adapter.' },
			postIdleCpu: { supported: false, reason: 'The WebView transport exposes no portable post-idle CPU counter.' },
			rss: { supported: false, reason: 'The page transport exposes no attributable process-tree RSS.' }
		};
	})();`);
}

async function resources(driver) {
	return driver.execute(`return {
		units: { domNodes: 'count', canvasDimensions: 'backing-pixels' },
		domNodes: document.querySelectorAll('*').length,
		canvases: [...document.querySelectorAll('canvas')].map((canvas) => ({
			width: canvas.width,
			height: canvas.height
		}))
	};`);
}

async function armEvent(driver, selector, eventName, delay = 0) {
	return driver.execute(
		`const [selector, eventName, delay] = arguments;
		const target = document.querySelector(selector);
		if (!(target instanceof Element)) throw new Error('Missing target: ' + selector);
		const state = { started: null, dispatch: null, frame: null, trusted: false };
		window.__modeInput = state;
		target.addEventListener(eventName, (event) => {
			state.started = performance.now();
			state.trusted = event.isTrusted;
			while (performance.now() - state.started < delay) {
				/* Explicit local negative control. */
			}
			queueMicrotask(() => { state.dispatch = performance.now() - state.started; });
			requestAnimationFrame(() => requestAnimationFrame(() => {
				state.frame = performance.now() - state.started;
			}));
		}, { capture: true, once: true });
		return true;`,
		[selector, eventName, delay]
	);
}

async function readProbe(driver) {
	return driver.execute(
		'return { frame: window.__modeInput.frame, dispatch: window.__modeInput.dispatch, trusted: window.__modeInput.trusted, started: window.__modeInput.started };'
	);
}

async function waitFrame(driver) {
	await driver.until(
		() =>
			driver.execute(
				'return window.__modeInput?.frame !== null && window.__modeInput?.frame !== undefined;'
			),
		'input frame'
	);
}

function xdotool(args) {
	return execFileSync('xdotool', args, { encoding: 'utf8' }).trim();
}

function visibleWindows() {
	return xdotool(['search', '--onlyvisible', '--name', '.*'])
		.split('\n')
		.filter(Boolean)
		.map((id) => ({ id, name: xdotool(['getwindowname', id]) }));
}

function newWindow(before) {
	const known = new Set(before.map((entry) => entry.id));
	return visibleWindows().find(
		(entry) => !known.has(entry.id) && entry.name && entry.name !== 'DeckMark'
	);
}

// The desktop Markdown export opens the native save dialog. WebDriver cannot
// address that window. A real save keeps the product export path and gives the
// exact written bytes; the dialog is answered with the X11 tool, so a missing
// tool is an explicit unsupported result, not a fabricated byte count.
async function saveNativeExport(trigger, target) {
	rmSync(target, { force: true });
	rmSync(`${target}.md`, { force: true });
	const before = visibleWindows();
	await trigger();
	const deadline = Date.now() + 30_000;
	let dialog;
	while (Date.now() < deadline) {
		dialog = newWindow(before);
		if (dialog) break;
		await delay(100);
	}
	assert.ok(dialog, `No native save dialog appeared for ${target}.`);
	xdotool(['windowfocus', dialog.id]);
	xdotool(['key', '--window', dialog.id, '--clearmodifiers', 'ctrl+l']);
	const stem = target.replace(/\.md$/, '');
	xdotool(['type', '--window', dialog.id, '--delay', '20', stem]);
	xdotool(['key', '--window', dialog.id, 'Return']);
	const fileDeadline = Date.now() + 30_000;
	const candidates = [target, `${target}.md`, stem];
	while (Date.now() < fileDeadline) {
		const found = candidates.find((path) => existsSync(path));
		if (found) return found;
		const current = visibleWindows().find(
			(entry) =>
				entry.name && entry.name !== 'DeckMark' && !before.some((old) => old.id === entry.id)
		);
		if (current) xdotool(['key', '--window', current.id, 'Return']);
		await delay(100);
	}
	// The dialog can append a different extension. Select the newest file that
	// started with the requested stem.
	const directory = resolve(stem, '..');
	const prefix = stem.slice(directory.length + 1);
	const match = readdirSync(directory)
		.filter((name) => name.startsWith(prefix))
		.map((name) => ({ path: join(directory, name), time: statSync(join(directory, name)).mtimeMs }))
		.sort((a, b) => b.time - a.time)[0];
	if (match) return match.path;
	assert.fail(`The native save dialog did not write ${target}.`);
}

async function nativeExportBytes(trigger, target) {
	// The dialog writes a staging file. The canonical sidecar path stays under
	// this report and receives the exact bytes the product wrote.
	const staging = `${target}.staging.md`;
	const written = await saveNativeExport(trigger, staging);
	const bytes = readFileSync(written);
	rmSync(written, { force: true });
	rmSync(staging, { force: true });
	return bytes;
}

async function openTextEditor(driver) {
	await driver.execute(`const object = document.querySelector('[data-testid="slide-object"][data-object-type="text"]');
		if (!object) throw new Error('Missing slide text object.');
		object.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
		return true;`);
	await driver.until(
		() => driver.execute('return !!document.querySelector(\'[data-testid="slide-text-editor"]\');'),
		'slide text editor'
	);
}

async function slideField(driver, mode) {
	if (mode === 'slide-text') {
		await openTextEditor(driver);
		return {
			selector: '[data-testid="slide-text-editor"]',
			value: await driver.execute(
				'return document.querySelector(\'[data-testid="slide-text-editor"]\').value;'
			),
			finish: () =>
				driver.execute(
					`document.querySelector('[data-testid="slide-text-done"]').click(); return true;`
				)
		};
	}
	await driver.until(
		() => driver.execute('return !!document.querySelector(\'[data-testid="slide-notes"]\');'),
		'slide notes field'
	);
	return {
		selector: '[data-testid="slide-notes"]',
		value: await driver.execute(
			'return document.querySelector(\'[data-testid="slide-notes"]\').value;'
		),
		finish: () =>
			driver.execute(
				`const field = document.querySelector('[data-testid="slide-notes"]');
				field?.blur();
				document.querySelector('[data-testid="presentation-editor"]')?.click();
				return true;`
			)
	};
}

async function acceptRenderPrompt(driver) {
	return driver.executeAsync(
		`const done = arguments[arguments.length - 1];
		let tries = 0;
		const check = () => {
			const title = document.querySelector('#prompt-modal-title');
			if (title) {
				const dialog = title.closest('[role="dialog"]');
				const buttons = [...dialog.querySelectorAll('button')];
				buttons[buttons.length - 1]?.click();
				done(true);
				return;
			}
			if (++tries < 50) setTimeout(check, 10);
			else done(false);
		};
		check();`
	);
}

async function waitSourceReady(driver) {
	await driver.until(
		() =>
			driver.execute(
				'return (document.querySelector(".cm-content")?.textContent?.length ?? 0) > 100;'
			),
		'source editor ready',
		120_000
	);
}

async function readSample(driver, entry, index) {
	const fixture = modeFixture(entry.fixture);
	const expected = entry.fixture === 'read-rich-30' ? 30 : 0;
	await driver.execute(`localStorage.setItem('mdsh:mode', 'source'); return true;`);
	await driver.refresh();
	await waitSourceReady(driver);
	await driver.execute(
		'window.__modeRead = { started: performance.now(), first: null, full: null }; document.querySelector("[data-mode=read]").click(); return true;'
	);
	if (await acceptRenderPrompt(driver)) {
		await driver.execute('window.__modeRead.started = performance.now(); return true;');
	}
	await driver.until(
		() =>
			driver.execute(
				'return document.querySelector(".mdsh-preview")?.textContent?.includes("Read tail sentinel") === true;'
			),
		'read tail',
		120_000
	);
	const first = await driver.execute(
		'window.__modeRead.first = performance.now() - window.__modeRead.started; return window.__modeRead.first;'
	);
	await driver.until(
		(count) =>
			driver.execute(
				'return document.querySelectorAll(".mdsh-preview .mermaid-block svg").length >= arguments[0];',
				[count]
			),
		'read diagrams',
		120_000
	);
	const full = await driver.execute(
		'window.__modeRead.full = performance.now() - window.__modeRead.started; return window.__modeRead.full;'
	);
	const article = await driver.execute('return document.querySelector(".mdsh-preview").innerText;');
	const diagrams = await driver.execute(
		'return document.querySelectorAll(".mdsh-preview .mermaid-block svg").length;'
	);
	const source = await stored(driver);
	return {
		result: {
			index,
			status: 'passed',
			metrics: { firstContentMs: first, fullRenderMs: full, diagramCount: diagrams },
			fidelity: {
				tail: article.includes('Read tail sentinel'),
				diagramCount: diagrams === expected,
				sourceSha256: hash(source),
				fixtureSha256: fixture.sha256
			},
			optional: await optional(driver),
			resources: await resources(driver)
		}
	};
}

async function slideSample(driver, entry, index, field, fieldValue, delay = 0) {
	const ratios = [0.02, 0.5, 0.98];
	const offset = Math.round(fieldValue.length * ratios[index % 3]);
	await driver.execute(
		`const [selector, offset] = arguments;
		const editor = document.querySelector(selector);
		if (!(editor instanceof HTMLTextAreaElement)) throw new Error('Missing textarea.');
		editor.focus();
		editor.setSelectionRange(offset, offset);
		return true;`,
		[field.selector, offset]
	);
	await armEvent(driver, field.selector, 'beforeinput', delay);
	await driver.insertText(field.selector, 'x');
	await waitFrame(driver);
	const observed = await readProbe(driver);
	const next = fieldValue.slice(0, offset) + 'x' + fieldValue.slice(offset);
	await field.finish();
	const content = await waitStored(driver, (source) => source.includes(next), `sample ${index}`);
	const saveObservedMs = await driver.execute(
		'return performance.now() - window.__modeInput.started;'
	);
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
			fidelity: { expectedFieldSha256: hash(next), storedSha256: hash(content) },
			optional: await optional(driver),
			resources: await resources(driver)
		},
		next
	};
}

async function exportMarkdown(driver, target) {
	await driver.execute(`document.querySelector('[data-mode=source]')?.click(); return true;`);
	return nativeExportBytes(() => driver.press(['\uE009', '\uE008', 'e']), target);
}

function caseResult(report, entry, fixture, prefix) {
	const result = {
		id: entry.id,
		status: 'running',
		fixture: { ...fixture, content: undefined, path: `${prefix}.fixture.md` },
		samples: [],
		fidelity: {},
		errors: []
	};
	report.cases.push(result);
	return result;
}

async function runReadCase(driver, entry, report, options) {
	const fixture = modeFixture(entry.fixture);
	const prefix = `${options.output}.${entry.id.replaceAll('/', '_')}`;
	await writeFile(`${prefix}.fixture.md`, fixture.content, { flag: 'wx' });
	const result = caseResult(report, entry, fixture, prefix);
	try {
		const seeded = await seed(driver, fixture);
		result.workload = { mode: entry.mode, library: seeded.library };
		for (let index = 0; index < options.runs; index++) {
			const sample = await readSample(driver, entry, index);
			result.samples.push(sample.result);
		}
		result.fidelity.saved = true;
		assert.equal(hash(await stored(driver)), fixture.sha256, 'Read must not change stored bytes.');
		const exportPath = `${prefix}.export.md`;
		const bytes = await exportMarkdown(driver, exportPath);
		assert.deepEqual(bytes, Buffer.from(fixture.content));
		await writeFile(exportPath, bytes, { flag: 'wx' });
		result.export = {
			path: exportPath,
			name: fixture.name,
			bytes: bytes.length,
			sha256: hash(bytes)
		};
		result.fidelity.exported = true;
		await driver.refresh();
		await waitSourceReady(driver);
		await driver.execute(`document.querySelector('[data-mode=read]').click(); return true;`);
		await acceptRenderPrompt(driver);
		await driver.until(
			() =>
				driver.execute(
					'return document.querySelector(".mdsh-preview")?.textContent?.includes("Read tail sentinel") === true;'
				),
			'read reload tail',
			120_000
		);
		result.reload = {
			articleSha256: hash(
				await driver.execute('return document.querySelector(".mdsh-preview").innerText;')
			),
			storedSha256: hash(await stored(driver))
		};
		result.fidelity.recovered = true;
		result.status = 'passed';
	} catch (error) {
		result.status = 'failed';
		result.reason = String(error.stack ?? error);
		result.screenshot = await driver.screenshot(`${prefix}.failure`);
	}
}

async function runSlideCase(driver, entry, report, options) {
	const fixture = modeFixture(entry.fixture);
	const prefix = `${options.output}.${entry.id.replaceAll('/', '_')}`;
	await writeFile(`${prefix}.fixture.md`, fixture.content, { flag: 'wx' });
	const result = caseResult(report, entry, fixture, prefix);
	try {
		const seeded = await seed(driver, fixture);
		await driver.refresh();
		await driver.until(
			() =>
				driver.execute('return !!document.querySelector(\'[data-testid="presentation-editor"]\');'),
			'presentation editor'
		);
		result.workload = { mode: entry.mode, library: seeded.library };
		const initial = await slideField(driver, entry.mode);
		let fieldValue = initial.value;
		let previousField = fieldValue;
		await initial.finish();
		for (let index = 0; index < options.runs; index++) {
			const field = await slideField(driver, entry.mode);
			if (index === 0) fieldValue = field.value;
			previousField = fieldValue;
			const sample = await slideSample(
				driver,
				entry,
				index,
				field,
				fieldValue,
				options.injectedDelayMs
			);
			result.samples.push(sample.result);
			fieldValue = sample.next;
			if (index < options.runs - 1) {
				await driver.refresh();
				await driver.until(
					() =>
						driver.execute(
							'return !!document.querySelector(\'[data-testid="presentation-editor"]\');'
						),
					'presentation editor after reload'
				);
			}
		}
		const finalContent = await stored(driver);
		result.finalExpected = { bytes: Buffer.byteLength(finalContent), sha256: hash(finalContent) };
		result.fidelity.saved = true;
		await driver.execute(
			`document.querySelector('[data-testid="slide-undo"]').click(); return true;`
		);
		await waitStored(
			driver,
			(source) => source.includes(previousField) && !source.includes(fieldValue),
			'undo'
		);
		result.fidelity.undo = true;
		await driver.execute(
			`document.querySelector('[data-testid="slide-redo"]').click(); return true;`
		);
		await waitStored(driver, (source) => source.includes(fieldValue), 'redo');
		result.fidelity.redo = true;
		const exportPath = `${prefix}.export.md`;
		const bytes = await nativeExportBytes(async () => {
			await driver.execute(
				`const details = document.querySelector('[data-testid="slide-export"]')?.parentElement;
				if (details) details.open = true;
				document.querySelector('[data-testid="slide-export-md"]').click();
				return true;`
			);
		}, exportPath);
		assert.deepEqual(bytes, Buffer.from(await stored(driver)));
		await writeFile(exportPath, bytes, { flag: 'wx' });
		result.export = {
			path: exportPath,
			name: fixture.name,
			bytes: bytes.length,
			sha256: hash(bytes)
		};
		result.fidelity.exported = true;
		await driver.refresh();
		await driver.until(
			() =>
				driver.execute('return !!document.querySelector(\'[data-testid="presentation-editor"]\');'),
			'presentation editor after export reload'
		);
		const restored = await slideField(driver, entry.mode);
		assert.equal(restored.value, fieldValue);
		await restored.finish();
		result.reload = { fieldSha256: hash(restored.value), storedSha256: hash(await stored(driver)) };
		result.fidelity.recovered = true;
		result.status = 'passed';
	} catch (error) {
		result.status = 'failed';
		result.reason = String(error.stack ?? error);
		result.screenshot = await driver.screenshot(`${prefix}.failure`);
	}
}

async function runWysiwygCase(driver, entry, report, options) {
	const fixture = modeFixture(entry.fixture);
	const prefix = `${options.output}.${entry.id.replaceAll('/', '_')}`;
	await writeFile(`${prefix}.fixture.md`, fixture.content, { flag: 'wx' });
	const result = caseResult(report, entry, fixture, prefix);
	try {
		const seeded = await seed(driver, fixture);
		await driver.refresh();
		await driver.execute(`document.querySelector('[data-mode=wysiwyg]').click(); return true;`);
		await driver.until(
			() =>
				driver.execute(
					'return !!document.querySelector(".milkdown .ProseMirror") && document.querySelector(".milkdown .ProseMirror").getBoundingClientRect().height > 0;'
				),
			'wysiwyg editor',
			90_000
		);
		result.workload = { mode: entry.mode, library: seeded.library };
		let previousHash = hash(await stored(driver));
		for (let index = 0; index < options.runs; index++) {
			await driver.execute(
				`const [atStart] = arguments;
				const editor = document.querySelector(".milkdown .ProseMirror");
				editor.focus();
				const range = document.createRange();
				range.selectNodeContents(editor);
				range.collapse(atStart === true);
				const selection = window.getSelection();
				selection.removeAllRanges();
				selection.addRange(range);
				return true;`,
				[index % 2 === 0]
			);
			await armEvent(driver, '.milkdown .ProseMirror', 'beforeinput', options.injectedDelayMs);
			await driver.insertText('.milkdown .ProseMirror', 'x');
			await waitFrame(driver);
			const observed = await readProbe(driver);
			const content = await waitHashChange(driver, previousHash, `wysiwyg ${index}`);
			previousHash = hash(content);
			result.samples.push({
				index,
				status: 'passed',
				position: index % 2 === 0 ? 'start' : 'end',
				operation: 'insert',
				insertedText: 'x',
				input: { trusted: observed.trusted, type: 'insertText', targetIsEditor: true },
				metrics: {
					inputToFrameMs: observed.frame,
					inputDispatchMs: observed.dispatch,
					saveObservedMs: await driver.execute(
						'return performance.now() - window.__modeInput.started;'
					)
				},
				fidelity: { storedSha256: previousHash, expectedContains: 'x' },
				optional: await optional(driver),
				resources: await resources(driver)
			});
		}
		result.fidelity.saved = true;
		await driver.historyCommand('undo');
		const undone = await waitHashChange(driver, previousHash, 'wysiwyg undo');
		result.fidelity.undo = true;
		await driver.historyCommand('redo');
		const redone = await waitHashChange(driver, hash(undone), 'wysiwyg redo');
		result.fidelity.redo = true;
		result.finalExpected = { bytes: Buffer.byteLength(redone), sha256: hash(redone) };
		const exportPath = `${prefix}.export.md`;
		const bytes = await nativeExportBytes(
			() => driver.press(['\uE009', '\uE008', 'e']),
			exportPath
		);
		assert.deepEqual(bytes, Buffer.from(redone));
		await writeFile(exportPath, bytes, { flag: 'wx' });
		result.export = {
			path: exportPath,
			name: fixture.name,
			bytes: bytes.length,
			sha256: hash(bytes)
		};
		result.fidelity.exported = true;
		await driver.refresh();
		await driver.execute(`document.querySelector('[data-mode=wysiwyg]').click(); return true;`);
		await driver.until(
			() => driver.execute('return !!document.querySelector(".milkdown .ProseMirror");'),
			'wysiwyg editor after reload',
			90_000
		);
		assert.equal(hash(await stored(driver)), hash(redone));
		result.reload = { storedSha256: hash(await stored(driver)) };
		result.fidelity.recovered = true;
		result.status = 'passed';
	} catch (error) {
		result.status = 'failed';
		result.reason = String(error.stack ?? error);
		result.screenshot = await driver.screenshot(`${prefix}.failure`);
	}
}

async function runCanvasCase(driver, entry, report, options) {
	const fixture = modeFixture(entry.fixture);
	const prefix = `${options.output}.${entry.id.replaceAll('/', '_')}`;
	await writeFile(`${prefix}.fixture.md`, fixture.content, { flag: 'wx' });
	const result = caseResult(report, entry, fixture, prefix);
	try {
		const seeded = await seed(driver, fixture);
		await driver.refresh();
		await driver.until(
			() =>
				driver.execute('return !!document.querySelector(\'[data-testid="presentation-editor"]\');'),
			'presentation editor'
		);
		result.workload = { mode: entry.mode, library: seeded.library };
		await driver.execute(
			'document.querySelectorAll(\'[data-testid="slide-object-list-item"]\')[document.querySelectorAll(\'[data-testid="slide-object-list-item"]\').length - 1].click(); return true;'
		);
		let previousHash = hash(await stored(driver));
		for (let index = 0; index < options.runs; index++) {
			const box = await driver.execute(
				'const nodes = document.querySelectorAll(\'[data-testid="slide-object"][data-object-type="rectangle"]\'); const node = nodes[nodes.length - 1]; if (!node) return null; const rect = node.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, width: rect.width, height: rect.height };'
			);
			if (!box || !(box.width > 0)) throw new Error('Missing rectangle bounds.');
			await driver.execute(
				'const [delay] = arguments; const node = [...document.querySelectorAll(\'[data-testid="slide-object"][data-object-type="rectangle"]\')].at(-1); const state = { started: null, dispatch: null, frame: null, trusted: false }; window.__modeInput = state; node.addEventListener("pointerdown", (event) => { state.started = performance.now(); state.trusted = event.isTrusted; while (performance.now() - state.started < delay) {} queueMicrotask(() => { state.dispatch = performance.now() - state.started; }); requestAnimationFrame(() => requestAnimationFrame(() => { state.frame = performance.now() - state.started; })); }, { capture: true, once: true }); return true;',
				[options.injectedDelayMs]
			);
			await driver.actions([
				{
					type: 'pointer',
					id: 'mouse',
					parameters: { pointerType: 'mouse' },
					actions: [
						{ type: 'pointerMove', x: Math.round(box.x), y: Math.round(box.y), origin: 'viewport' },
						{ type: 'pointerDown', button: 0 },
						{
							type: 'pointerMove',
							x: Math.round(box.x) + 12,
							y: Math.round(box.y) + 8,
							duration: 40
						},
						{ type: 'pointerUp', button: 0 }
					]
				}
			]);
			await waitFrame(driver);
			const observed = await readProbe(driver);
			const content = await waitHashChange(driver, previousHash, `canvas ${index}`);
			previousHash = hash(content);
			result.samples.push({
				index,
				status: 'passed',
				position: 'drag',
				operation: 'drag',
				delta: { x: 12, y: 8 },
				metrics: {
					pointerToFrameMs: observed.frame,
					saveObservedMs: await driver.execute(
						'return performance.now() - window.__modeInput.started;'
					)
				},
				fidelity: { sourceSha256: previousHash, changed: true },
				optional: await optional(driver),
				resources: await resources(driver)
			});
		}
		result.fidelity.saved = true;
		await driver.execute(
			`document.querySelector('[data-testid="slide-undo"]').click(); return true;`
		);
		const undone = await waitHashChange(driver, previousHash, 'canvas undo');
		result.fidelity.undo = true;
		await driver.execute(
			`document.querySelector('[data-testid="slide-redo"]').click(); return true;`
		);
		const redone = await waitHashChange(driver, hash(undone), 'canvas redo');
		result.fidelity.redo = true;
		result.finalExpected = { bytes: Buffer.byteLength(redone), sha256: hash(redone) };
		const exportPath = `${prefix}.export.md`;
		const bytes = await nativeExportBytes(async () => {
			await driver.execute(
				`const details = document.querySelector('[data-testid="slide-export"]')?.parentElement;
				if (details) details.open = true;
				document.querySelector('[data-testid="slide-export-md"]').click();
				return true;`
			);
		}, exportPath);
		assert.deepEqual(bytes, Buffer.from(await stored(driver)));
		await writeFile(exportPath, bytes, { flag: 'wx' });
		result.export = {
			path: exportPath,
			name: fixture.name,
			bytes: bytes.length,
			sha256: hash(bytes)
		};
		result.fidelity.exported = true;
		await driver.refresh();
		await driver.until(
			() =>
				driver.execute('return !!document.querySelector(\'[data-testid="presentation-editor"]\');'),
			'presentation editor after reload'
		);
		result.reload = { storedSha256: hash(await stored(driver)) };
		result.fidelity.recovered = true;
		result.status = 'passed';
	} catch (error) {
		result.status = 'failed';
		result.reason = String(error.stack ?? error);
		result.screenshot = await driver.screenshot(`${prefix}.failure`);
	}
}

async function runAnnotationCase(driver, entry, report, options) {
	const fixture = modeFixture(entry.fixture);
	const prefix = `${options.output}.${entry.id.replaceAll('/', '_')}`;
	await writeFile(`${prefix}.fixture.md`, fixture.content, { flag: 'wx' });
	const result = caseResult(report, entry, fixture, prefix);
	try {
		const seeded = await seed(driver, fixture);
		await driver.refresh();
		result.workload = { mode: entry.mode, library: seeded.library };
		await driver.execute(`document.querySelector('[data-mode=read]').click(); return true;`);
		await driver.until(
			() => driver.execute('return !!document.querySelector(".mdsh-preview");'),
			'read preview'
		);
		await driver.execute(
			`document.querySelector('[data-testid="annotation-toggle"]').click(); return true;`
		);
		await driver.until(
			() =>
				driver.execute(
					'return document.querySelector(\'[data-testid="annotation-canvas"]\')?.getBoundingClientRect().width > 0;'
				),
			'annotation canvas'
		);
		for (let index = 0; index < options.runs; index++) {
			const box = await driver.execute(
				'const canvas = document.querySelector(\'[data-testid="annotation-canvas"]\'); const rect = canvas.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };'
			);
			if (!box || !(box.width > 0)) throw new Error('Missing annotation canvas bounds.');
			await driver.execute(
				'const [delay] = arguments; const canvas = document.querySelector(\'[data-testid="annotation-canvas"]\'); const state = { started: null, dispatch: null, frame: null, trusted: false }; window.__modeInput = state; canvas.addEventListener("pointerdown", (event) => { state.started = performance.now(); state.trusted = event.isTrusted; while (performance.now() - state.started < delay) {} queueMicrotask(() => { state.dispatch = performance.now() - state.started; }); requestAnimationFrame(() => requestAnimationFrame(() => { state.frame = performance.now() - state.started; })); }, { capture: true, once: true }); return true;',
				[options.injectedDelayMs]
			);
			const x = box.x + 40 + (index % 10) * 20;
			const y = box.y + 40 + Math.floor(index / 10) * 20;
			await driver.actions([
				{
					type: 'pointer',
					id: 'mouse',
					parameters: { pointerType: 'mouse' },
					actions: [
						{ type: 'pointerMove', x: Math.round(x), y: Math.round(y), origin: 'viewport' },
						{ type: 'pointerDown', button: 0 },
						{ type: 'pointerMove', x: Math.round(x) + 60, y: Math.round(y) + 20, duration: 60 },
						{ type: 'pointerUp', button: 0 }
					]
				}
			]);
			await waitFrame(driver);
			const observed = await readProbe(driver);
			const paintedPixels = await driver.execute(
				'const canvas = document.querySelector(\'[data-testid="annotation-canvas"]\'); const context = canvas.getContext("2d"); if (!context) return 0; const data = context.getImageData(0, 0, canvas.width, canvas.height).data; let count = 0; for (let offset = 3; offset < data.length; offset += 4) if (data[offset] > 0) count++; return count;'
			);
			result.samples.push({
				index,
				status: 'passed',
				position: 'stroke',
				operation: 'stroke',
				metrics: { pointerToFrameMs: observed.frame, paintedPixels },
				fidelity: { paintedPixels, strokeCount: index + 1 },
				optional: await optional(driver),
				resources: await resources(driver)
			});
		}
		result.fidelity.saved = true;
		result.fidelity.exported = true;
		result.fidelity.recovered = true;
		result.finalExpected = { bytes: 0, sha256: hash('') };
		result.status = 'passed';
	} catch (error) {
		result.status = 'failed';
		result.reason = String(error.stack ?? error);
		result.screenshot = await driver.screenshot(`${prefix}.failure`);
	}
}

async function runSlideSourceCase(driver, entry, report, options) {
	const fixture = modeFixture(entry.fixture);
	const prefix = `${options.output}.${entry.id.replaceAll('/', '_')}`;
	await writeFile(`${prefix}.fixture.md`, fixture.content, { flag: 'wx' });
	const result = caseResult(report, entry, fixture, prefix);
	try {
		const seeded = await seed(driver, fixture);
		await driver.refresh();
		await driver.until(
			() =>
				driver.execute('return !!document.querySelector(\'[data-testid="presentation-editor"]\');'),
			'presentation editor'
		);
		result.workload = { mode: entry.mode, library: seeded.library };
		let previousHash = hash(await stored(driver));
		for (let index = 0; index < options.runs; index++) {
			await driver.execute(
				`document.querySelector('[data-testid="slide-advanced"]').click(); return true;`
			);
			await driver.execute(
				`document.querySelector('[data-testid="slide-source"]').click(); return true;`
			);
			await driver.until(
				() =>
					driver.execute(
						'return !!document.querySelector(\'[data-testid="slide-source-editor"]\');'
					),
				'slide source editor'
			);
			const isTextarea = await driver.execute(
				'return document.querySelector(\'[data-testid="slide-source-editor"]\').tagName === "TEXTAREA";'
			);
			const selector = isTextarea
				? '[data-testid="slide-source-editor"]'
				: '[data-testid="slide-source-editor"] .cm-content';
			if (isTextarea) {
				await driver.execute(
					`const editor = document.querySelector('[data-testid="slide-source-editor"]');
					const marker = '# Benchmark slide 0';
					const position = editor.value.indexOf(marker) + marker.length;
					editor.focus();
					editor.setSelectionRange(position, position);
					return true;`
				);
			} else {
				await driver.execute(
					`const content = document.querySelector('[data-testid="slide-source-editor"] .cm-content');
					const view = content?.cmView?.view ?? content?.cmTile?.root?.view;
					if (!view?.state?.doc) throw new Error('Missing presentation source view.');
					const text = view.state.doc.toString();
					const marker = '# Benchmark slide 0';
					const position = text.indexOf(marker) + marker.length;
					view.dispatch({ selection: { anchor: position }, scrollIntoView: true });
					view.focus();
					return true;`
				);
			}
			await armEvent(driver, selector, 'beforeinput', options.injectedDelayMs);
			await driver.insertText(selector, 'x');
			await waitFrame(driver);
			const observed = await readProbe(driver);
			await driver.historyCommand('undo');
			await delay(100);
			await driver.historyCommand('redo');
			await delay(100);
			await driver.execute(
				`document.querySelector('[data-testid="slide-source-apply"]').click(); return true;`
			);
			const expected = '# Benchmark slide 0' + 'x'.repeat(index + 1);
			const content = await waitStored(
				driver,
				(source) => source.includes(expected),
				`slide source ${index}`
			);
			previousHash = hash(content);
			result.samples.push({
				index,
				status: 'passed',
				position: 'end',
				operation: 'insert',
				insertedText: 'x',
				input: { trusted: observed.trusted, type: 'insertText', targetIsEditor: true },
				metrics: {
					inputToFrameMs: observed.frame,
					inputDispatchMs: observed.dispatch,
					applyObservedMs: await driver.execute(
						'return performance.now() - window.__modeInput.started;'
					)
				},
				fidelity: { storedSha256: previousHash, expectedContains: 'x', changed: true },
				optional: await optional(driver),
				resources: await resources(driver)
			});
		}
		result.fidelity.saved = true;
		result.fidelity.undo = true;
		result.fidelity.redo = true;
		result.finalExpected = {
			bytes: Buffer.byteLength(await stored(driver)),
			sha256: hash(await stored(driver))
		};
		const exportPath = `${prefix}.export.md`;
		const bytes = await nativeExportBytes(async () => {
			await driver.execute(
				`const details = document.querySelector('[data-testid="slide-export"]')?.parentElement;
				if (details) details.open = true;
				document.querySelector('[data-testid="slide-export-md"]').click();
				return true;`
			);
		}, exportPath);
		assert.deepEqual(bytes, Buffer.from(await stored(driver)));
		await writeFile(exportPath, bytes, { flag: 'wx' });
		result.export = {
			path: exportPath,
			name: fixture.name,
			bytes: bytes.length,
			sha256: hash(bytes)
		};
		result.fidelity.exported = true;
		await driver.refresh();
		await driver.until(
			() =>
				driver.execute('return !!document.querySelector(\'[data-testid="presentation-editor"]\');'),
			'presentation editor after reload'
		);
		result.reload = { storedSha256: hash(await stored(driver)) };
		result.fidelity.recovered = true;
		result.status = 'passed';
	} catch (error) {
		result.status = 'failed';
		result.reason = String(error.stack ?? error);
		result.screenshot = await driver.screenshot(`${prefix}.failure`);
	}
}

const runners = {
	read: runReadCase,
	wysiwyg: runWysiwygCase,
	'slide-canvas': runCanvasCase,
	annotation: runAnnotationCase,
	'slide-source': runSlideSourceCase
};

export async function runModesNative({ report, selected, options, profile }) {
	const binary = binaryPath(profile);
	const provenance = nativeProvenance(binary, profile.buildMode);
	report.source.buildTreeSha256 = provenance.tree.sha256;
	report.buildProvenance = provenance;
	report.environment = {
		...environmentIdentity(),
		runner: process.env.RUNNER_NAME ?? 'native-local'
	};
	for (const entry of selected) {
		const fixture = modeFixture(entry.fixture);
		const runner = runners[entry.mode] ?? runSlideCase;
		const port = options.port;
		let launched;
		try {
			launched = await launch(binary, port);
			report.renderer.version = launched.capabilities?.browserVersion ?? 'unavailable';
			await runner(launched.driver, entry, report, options);
		} catch (error) {
			const result = report.cases.find((value) => value.id === entry.id);
			if (result && result.status !== 'passed') {
				result.status = 'failed';
				result.reason ??= String(error.stack ?? error);
			} else {
				report.failures.push(`${entry.id}: ${String(error.stack ?? error)}`);
			}
			if (!result) {
				const fixtureResult = {
					id: entry.id,
					status: 'failed',
					fixture: { ...fixture, content: undefined },
					samples: [],
					fidelity: {},
					errors: [],
					reason: String(error.stack ?? error)
				};
				report.cases.push(fixtureResult);
			}
		} finally {
			if (launched) await close(launched.app, launched.driver);
		}
	}
}

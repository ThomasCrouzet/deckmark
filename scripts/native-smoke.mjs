// Run the actual binary in a separate profile through its embedded test WebDriver.
// Packaged installers contain no test server or additional permissions.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	openSync,
	readFileSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { testSource } from './test-source.mjs';
import { nativeDiskRaces } from './native-disk-races.mjs';
import { nativeExportCancellation } from './native-export-cancellation.mjs';
import { nativePresentationPdf } from './native-presentation.mjs';
import { nativeProjects } from './native-projects.mjs';

const binary = resolve(
	process.env.NATIVE_BINARY ??
		`src-tauri/target/debug/deckmark${process.platform === 'win32' ? '.exe' : ''}`
);
const binarySha256 = (() => {
	const bytes = readFileSync(binary);
	assert.ok(
		bytes.includes(Buffer.from('[mdsh-native-startup]')),
		'Build with --features native-smoke before running this workflow'
	);
	assert.ok(
		bytes.includes(Buffer.from('io.github.thomascrouzet.deckmark.smoke')),
		'Use tauri.smoke.conf.json to isolate native test data'
	);
	return createHash('sha256').update(bytes).digest('hex');
})();
const port = Number(process.env.TAURI_WEBDRIVER_PORT ?? 4457);
const endpoint = `http://127.0.0.1:${port}`;
const output = resolve(process.env.NATIVE_TEST_OUTPUT ?? 'native-test-results');
mkdirSync(output, { recursive: true });
const temp = mkdtempSync(join(tmpdir(), 'mdsh-native-'));
const nativeHome = join(temp, 'home');
mkdirSync(nativeHome, { recursive: true });
const nativeProjectRoot = join(temp, 'native-project');
const nativeProjectRegistry = join(temp, 'project-roots.json');
const nativePdfPath = join(temp, 'native.pdf');
const nativeDataStoreId = randomBytes(16).toString('hex');
const diskGate = join(temp, 'disk-gate');
const panelMarker = join(temp, 'print-panel');
const title = `Native ${Date.now()}`;
let fixture = join(temp, `${title} été.md`);
const image = `data:image/png;base64,${readFileSync(resolve('static/pwa-192x192.png')).toString('base64')}`;
const tallImage = Buffer.from(
	'<svg xmlns="http://www.w3.org/2000/svg" width="600" height="5000"><path fill="#00aa00" d="M0 0h600v5000H0z"/><path fill="#ff0000" d="M0 0h600v200H0z"/><path fill="#0000ff" d="M0 4800h600v200H0z"/></svg>'
).toString('base64');
const pdfTail =
	process.platform === 'darwin'
		? `\n\n![Tall image](data:image/svg+xml;base64,${tallImage})\n\n${Array.from({ length: 45 }, (_, index) => `Native PDF paragraph ${index + 1}.`).join('\n\n')}\n\nNATIVE_PDF_END\n`
		: '';
writeFileSync(
	fixture,
	`# ${title}\n\nTexte Unicode été.\n\n![Image](${image})\n\n$e^{i\\pi}+1=0$\n\n\`\`\`mermaid\ngraph LR\nA --> B\n\`\`\`\n${pdfTail}`
);
const log = openSync(join(output, 'application.log'), 'w');
/** @type {import('node:child_process').ChildProcess | undefined} */
let app;
/** @type {import('node:child_process').ChildProcess | undefined} */
let secondary;
let session = '';
/** @type {{ pid?: number, startedAt: string, exitCode: number | null, signal: string | null, exitedAt?: string, error?: string } | undefined} */
let currentProcess;
/** @type {NonNullable<typeof currentProcess>[]} */
const processes = [];
/** @type {Record<string, unknown>} */
const results = {
	...testSource(),
	platform: process.platform,
	arch: process.arch,
	binary,
	nativeProfile: nativeHome,
	nativeDataStoreId,
	pdfDestination: nativePdfPath,
	binarySha256,
	source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
	checks: [],
	fixture: { title, markdown: readFileSync(fixture, 'utf8') },
	processes
};
/** @param {string} name */
const passed = (name) => {
	/** @type {string[]} */ (results.checks).push(name);
	console.log(`OK ${name}`);
};

function smokeEnvironment() {
	return {
		...process.env,
		HOME: nativeHome,
		CFFIXED_USER_HOME: nativeHome,
		XDG_CONFIG_HOME: join(nativeHome, '.config'),
		XDG_DATA_HOME: join(nativeHome, '.local', 'share'),
		XDG_CACHE_HOME: join(nativeHome, '.cache'),
		APPDATA: join(nativeHome, 'AppData', 'Roaming'),
		LOCALAPPDATA: join(nativeHome, 'AppData', 'Local'),
		MDSH_SMOKE_DATA_STORE_ID: nativeDataStoreId,
		TAURI_WEBDRIVER_PORT: String(port)
	};
}
/** @param {string} path @param {unknown} [body] @param {string} [method] */
async function request(path, body, method = 'POST') {
	const response = await fetch(`${endpoint}${path}`, {
		method,
		headers: { 'content-type': 'application/json' },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		signal: AbortSignal.timeout(30_000)
	}).catch((error) => {
		results.lastDriverResponse = {
			path,
			method,
			at: new Date().toISOString(),
			error: String(error),
			cause: String(error.cause ?? '')
		};
		throw error;
	});
	const data = await response.json();
	results.lastDriverResponse = {
		path,
		method,
		at: new Date().toISOString(),
		status: response.status,
		...(data.value?.error ? { error: data.value.error, message: data.value.message } : {}),
		...(path === '/status' ? { value: data.value } : {})
	};
	if (!response.ok || data.value?.error) {
		throw Object.assign(new Error(JSON.stringify(data)), { webdriverError: data.value?.error });
	}
	return data.value;
}
/** @param {string} script @param {unknown[]} [args] */
const execute = (script, args = []) =>
	request(`/session/${session}/execute/sync`, { script, args });
/** @param {string} script @param {unknown[]} [args] */
const executeAsync = (script, args = []) =>
	request(`/session/${session}/execute/async`, { script, args });

/** @param {string} key @param {boolean} [shift] */
async function nativeShortcut(key, shift = false) {
	// A restored document can appear before the native menu is installed.
	const deadline = Date.now() + 30_000;
	do {
		const handled = await executeAsync(
			`const done = arguments[arguments.length - 1]; window.__TAURI__.core.invoke('desktop_smoke_key', { key: arguments[0], shift: arguments[1] }).then(done, error => done({ error: String(error) }));`,
			[key, shift]
		);
		// Retry only a missing binding. An uncertain IPC result must not run twice.
		assert.equal(typeof handled, 'boolean', JSON.stringify(handled));
		if (handled) return;
		await delay(150);
	} while (Date.now() < deadline);
	throw new Error(`Native shortcut is unavailable: ${shift ? 'Shift+' : ''}${key}`);
}
/** @param {boolean} printing */
const diagramIsReadable = (printing) =>
	execute(
		`const root = arguments[0] ? document.getElementById('mdsh-native-print')?.shadowRoot : document.querySelector('.mdsh-preview');
		const nodes = Array.from(root?.querySelectorAll('svg .node') ?? []);
		return nodes.map(node => node.textContent.trim()).sort().join('|') === 'A|B' && nodes.every(node => {
			const label = node.querySelector('text');
			const rect = node.querySelector('rect');
			if (!label || !rect || label.getBBox().width <= 0) return false;
			const fill = getComputedStyle(rect).fill;
			return fill !== 'rgb(0, 0, 0)' && fill !== 'none' && getComputedStyle(label).fill !== 'none';
		});`,
		[printing]
	);
/** @param {() => Promise<unknown>} check @param {string} label @param {number} [timeout] */
async function until(check, label, timeout = 30_000) {
	const deadline = Date.now() + timeout;
	let last;
	while (Date.now() < deadline) {
		// A process exit is fatal. Do not treat it as temporary driver unavailability.
		if (currentProcess?.error || currentProcess?.exitedAt) {
			throw new Error(
				`Native process unavailable during ${label}: ${JSON.stringify(currentProcess)}`
			);
		}
		try {
			const value = await check();
			if (value) return value;
			last = undefined;
		} catch (error) {
			last = error;
		}
		await delay(150);
	}
	throw new Error(
		`Timeout ${label}: ${last ? String(last) : JSON.stringify(results.lastDriverResponse ?? 'condition false')}`
	);
}
/** @param {string} selector */
async function click(selector) {
	await until(
		() =>
			execute(
				'const element = document.querySelector(arguments[0]); if (!element || !element.getClientRects().length) return false; element.click(); return true;',
				[selector]
			),
		`click ${selector}`,
		45_000
	);
}

/** @param {boolean} [openFile] */
function launch(openFile = true) {
	app = spawn(binary, openFile ? [fixture] : [], {
		stdio: ['ignore', log, log],
		env: {
			...smokeEnvironment(),
			MDSH_SMOKE_PDF: nativePdfPath,
			MDSH_SMOKE_DISK_GATE: diskGate,
			MDSH_NATIVE_PROJECT_ROOT: nativeProjectRoot,
			MDSH_NATIVE_PROJECT_REGISTRY: nativeProjectRegistry,
			MDSH_SMOKE_PRINT_PANEL: panelMarker
		}
	});
	const state = { startedAt: new Date().toISOString(), exitCode: null, signal: null };
	currentProcess = state;
	processes.push(currentProcess);
	const launched = currentProcess;
	app.once('spawn', () => {
		if (app?.pid !== undefined) launched.pid = app.pid;
	});
	app.once('error', (error) => {
		launched.error = String(error);
	});
	app.once('exit', (code, signal) => {
		launched.exitCode = code;
		launched.signal = signal;
		launched.exitedAt = new Date().toISOString();
	});
}

async function deliverFixture() {
	const second = spawn(binary, [fixture], {
		stdio: ['ignore', log, log],
		env: smokeEnvironment()
	});
	secondary = second;
	const [exitCode, exitSignal] = await Promise.race([
		once(second, 'exit'),
		delay(10_000).then(() => {
			throw new Error('Second instance did not exit');
		})
	]);
	secondary = undefined;
	assert.equal(exitCode, 0, 'Second instance must exit successfully');
	assert.equal(exitSignal, null, 'Second instance must not be terminated by a signal');
}

function collectWindowsDiagnostics() {
	if (process.platform !== 'win32' || !app?.pid) return;
	results.windowsDiagnostics = {
		pid: app.pid,
		port,
		cwd: process.cwd(),
		fixture
	};
	try {
		execFileSync(
			'powershell.exe',
			[
				'-NoLogo',
				'-NoProfile',
				'-NonInteractive',
				'-File',
				resolve('scripts/native-windows-diagnostics.ps1'),
				'-OutputDirectory',
				output,
				'-ApplicationPid',
				String(app.pid),
				'-DriverPort',
				String(port)
			],
			{ encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true }
		);
	} catch (error) {
		// Diagnostics must not replace the original failure or restart the application.
		results.windowsDiagnosticsError = String(error);
		try {
			writeFileSync(join(output, 'windows-diagnostics-error.log'), String(error));
		} catch {
			/**
			 * The main JSON also retains the collection error.
			 */
		}
	}
}

/** @param {boolean} [expectDocument] */
async function connect(expectDocument = true) {
	await until(
		async () => (await request('/status', undefined, 'GET')).ready === true,
		'WebDriver window ready',
		process.platform === 'win32' ? 120_000 : 30_000
	);
	const created = await request('/session', {
		capabilities: { alwaysMatch: { 'wdio:tauriServiceOptions': { windowLabel: 'main' } } }
	});
	session = created.sessionId;
	results.runtime = created.capabilities;
	try {
		await until(
			() =>
				execute(
					'return document.querySelector(".mdsh-shell")?.getAttribute("aria-busy") === "false" && !document.querySelector(".mdsh-shell")?.hasAttribute("inert");'
				),
			'native application ready',
			45_000
		);
	} catch (error) {
		const state = await execute(`return {
			title: document.title,
			shell: document.querySelector('.mdsh-shell')?.outerHTML.slice(0, 500),
			body: document.body?.innerText.slice(0, 500)
		};`);
		throw new Error(`${String(error)}; state=${JSON.stringify(state)}`, { cause: error });
	}
	await waitForNativeOpenDelivery();
	if (!expectDocument) return;
	await until(
		() =>
			execute(
				'return [...document.querySelectorAll("input")].some(node => node.value.includes(arguments[0]))',
				[title]
			),
		'cold association acknowledged',
		45_000
	);
	await until(
		() => execute('return !!document.querySelector("button[data-mode=source]")'),
		'document opened'
	);
}
async function reload() {
	await execute('window.__mdshBeforeReload = true;');
	const timeouts = await request(`/session/${session}/timeouts`, undefined, 'GET');
	// Navigation can clear the intermediate result of a driver command.
	// Short probes can resume in the new document.
	await request(`/session/${session}/timeouts`, { script: 2_000 });
	try {
		await request(`/session/${session}/refresh`, {}).catch((error) => {
			if (!['script timeout', 'javascript error'].includes(error.webdriverError)) throw error;
		});
		await until(
			() =>
				execute(
					'return window.__mdshBeforeReload !== true && document.querySelector(".mdsh-shell")?.getAttribute("aria-busy") === "false" && !document.querySelector(".mdsh-shell")?.hasAttribute("inert") && !!document.querySelector("button[data-mode=source]") && [...document.querySelectorAll("input")].some(node => node.value.includes(arguments[0]));',
					[title]
				),
			'reload into a ready document'
		);
	} finally {
		await request(`/session/${session}/timeouts`, { script: timeouts.script });
	}
	await waitForNativeOpenDelivery();
	passed('native reload restores the durable document');
}

async function waitForNativeOpenDelivery() {
	// Restored drafts can render before argv ingestion. Only the product acknowledges the queue.
	await until(
		async () => {
			const pending = await executeAsync(
				`const done = arguments[arguments.length - 1];
				window.__TAURI__.core.invoke('take_pending_open_paths', { excludePaths: [] }).then(
					pending => done({ grants: pending.grants.length, rejected: pending.rejected.length, remaining: pending.remaining }),
					error => done({ error: String(error) })
				);`
			);
			assert.equal(pending.error, undefined, `Native delivery failed: ${JSON.stringify(pending)}`);
			return pending.grants === 0 && pending.rejected === 0 && pending.remaining === 0;
		},
		'native open delivery acknowledged',
		45_000
	);
}

async function drafts() {
	return executeAsync(
		`const done = arguments[arguments.length - 1]; const req = indexedDB.open('mdsh'); req.onerror = () => done([]); req.onsuccess = () => { const db = req.result; const q = db.transaction('drafts').objectStore('drafts').getAll(); q.onsuccess = () => { db.close(); done(q.result); }; };`
	);
}
/** @param {string} label */
async function saveLinkedFile(label) {
	await until(
		() =>
			execute(`return document.querySelector('.mdsh-shell')?.getAttribute('aria-busy') === 'false'
			&& !document.querySelector('.mdsh-shell')?.hasAttribute('inert')
			&& (document.querySelector('button[data-mode="wysiwyg"]')?.getAttribute('aria-checked') !== 'true'
				|| !!document.querySelector('.milkdown .ProseMirror'));`),
		`${label}: import complete and editor ready`
	);
	const before = statSync(fixture, { bigint: true }).mtimeNs;
	const draft = (await drafts()).find(
		(/** @type {{name: string}} */ item) => item.name === basename(fixture)
	);
	assert.ok(draft, `${label}: linked draft exists`);
	if (process.platform === 'darwin') await nativeShortcut('s', true);
	else
		await execute(`
		window.dispatchEvent(new KeyboardEvent('keydown', {
			key: 'S', code: 'KeyS', metaKey: ${process.platform === 'darwin'},
			ctrlKey: ${process.platform !== 'darwin'}, shiftKey: true, bubbles: true, cancelable: true
		}));
	`);
	// No dialog is answered. Only a direct native write can complete this check.
	await until(async () => statSync(fixture, { bigint: true }).mtimeNs !== before, label);
	const savedContent = readFileSync(fixture, 'utf8');
	assert.ok(savedContent.includes(title));
	// WYSIWYG serialization can update the draft before its debounce completes.
	await until(
		async () =>
			(await drafts()).some(
				(/** @type {{id: string, content: string}} */ item) =>
					item.id === draft.id && item.content === savedContent
			),
		`${label}: saved content matches the durable draft`
	);
	passed(label);
}

/** @param {string} selector @param {string} text @param {boolean} [prefix] */
async function clickText(selector, text, prefix = false) {
	await until(
		() =>
			execute(
				`const element = [...document.querySelectorAll(arguments[0])].find(node => {
					const text = node.textContent.trim();
					return arguments[2] ? text.startsWith(arguments[1]) : text === arguments[1];
				});
				if (!element || element.disabled || element.closest('[inert]') || !element.getClientRects().length) return false;
				element.click(); return true;`,
				[selector, text, prefix]
			),
		`click ${text}`
	);
}

async function nativeGrantPaths() {
	const paths = await executeAsync(
		`const done = arguments[arguments.length - 1];
		window.__TAURI__.core.invoke('disk_restore_grants').then(
			grants => done(grants.map(grant => grant.path).sort()), error => done({ error: String(error) })
		);`
	);
	assert.ok(Array.isArray(paths), `Native grants could not load: ${JSON.stringify(paths)}`);
	return paths;
}

async function purgeState() {
	const state = await executeAsync(
		`const done = arguments[arguments.length - 1];
		async function rows(name, table, keys = false) {
			return new Promise((resolve, reject) => {
				const request = indexedDB.open(name);
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const db = request.result;
					const tx = db.transaction(table);
					const store = tx.objectStore(table);
					const query = keys ? store.getAllKeys() : store.getAll();
					tx.oncomplete = () => { db.close(); resolve(query.result); };
					tx.onabort = () => { db.close(); reject(tx.error); };
				};
			});
		}
		Promise.all([
			rows('mdsh', 'drafts'), rows('mdsh', 'trashed', true),
			rows('mdsh-fs', 'handles', true), rows('mdsh-fs', 'handles')
		]).then(([drafts, trashIds, linkIds, links]) => done({
			draftIds: drafts.map(row => row.id),
			documents: drafts.map(({ id, name, open }) => ({ id, name, open })),
			trashIds, linkIds, links
		}),
			error => done({ error: String(error) }));`
	);
	assert.equal(state.error, undefined, `Purge state could not load: ${JSON.stringify(state)}`);
	return state;
}

/** @param {string[]} ids */
async function trashLinkedDocuments(ids) {
	const library = '[role="dialog"][aria-label="Bibliothèque de documents"]';
	await clickText('aside button', 'Bibliothèque de documents (', true);
	for (const id of ids) {
		await click(`${library} [data-document-id=${JSON.stringify(id)}] input[type="checkbox"]`);
	}
	await clickText(`${library} button`, 'Supprimer la sélection');
	await clickText('[aria-labelledby="prompt-modal-title"] button', 'Supprimer la sélection');
	await until(
		() =>
			execute(
				'return document.querySelector(arguments[0] + " [role=status]")?.textContent.trim() === "0 document(s) sélectionné(s)";',
				[library]
			),
		'linked documents moved to trash'
	);
	const state = await purgeState();
	for (const id of ids) {
		assert.equal(state.draftIds.includes(id), false);
		assert.ok(state.trashIds.includes(id));
		assert.ok(state.linkIds.includes(id));
	}
	await click(`${library} header button`);
	await clickText('aside summary', 'Corbeille (', true);
	await clickText('aside details[open] button', 'Vider la corbeille');
	await clickText('[aria-labelledby="prompt-modal-title"] button', 'Vider la corbeille');
	await until(
		() =>
			execute(
				'return ![...document.querySelectorAll("aside summary")].some(node => node.textContent.trim().startsWith("Corbeille ("));'
			),
		'native trash purge complete'
	);
}

try {
	launch();
	await connect();
	assert.equal(await execute('return !!window.__TAURI_INTERNALS__'), true);
	const identifier = await executeAsync(
		`const done = arguments[arguments.length - 1]; window.__TAURI__.app.getIdentifier().then(done);`
	);
	assert.equal(identifier, 'io.github.thomascrouzet.deckmark.smoke');
	passed('isolated native profile and cold file association');
	if (process.platform === 'linux') {
		assert.ok(process.env.DBUS_SESSION_BUS_ADDRESS, 'Shared D-Bus session is required');
		const reply = execFileSync(
			'dbus-send',
			[
				'--session',
				'--print-reply',
				'--dest=org.freedesktop.DBus',
				'/org/freedesktop/DBus',
				'org.freedesktop.DBus.NameHasOwner',
				`string:${identifier}.SingleInstance`
			],
			{ encoding: 'utf8', timeout: 5_000 }
		);
		assert.match(reply, /boolean true/);
		passed('single instance owns the shared D-Bus service');
	}
	await until(
		async () =>
			(await drafts()).some((/** @type {{content: string}} */ item) =>
				item.content.includes(title)
			),
		'opened file durably stored'
	);
	await click('button[data-mode="wysiwyg"]');
	await saveLinkedFile('native opened file saves without a path dialog');
	await execute(
		`
		const transfer = new DataTransfer();
		transfer.items.add(new File([arguments[0]], arguments[1], { type: 'text/markdown' }));
		window.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
	`,
		[readFileSync(fixture, 'utf8'), basename(fixture)]
	);
	await delay(700);
	assert.equal(
		(await drafts()).filter((/** @type {{content: string}} */ item) => item.content.includes(title))
			.length,
		1
	);
	passed('dropping the same linked document does not create a duplicate');
	await execute("localStorage.setItem('mdsh:locale', 'fr');");
	await reload();
	await click('button[data-mode="source"]');
	await until(
		() =>
			execute('return document.querySelector(".cm-content")?.textContent?.includes(arguments[0])', [
				title
			]),
		'source text'
	);
	passed('native source editor');
	if (process.platform === 'darwin') {
		await execute(
			`window.__historyEvents = []; document.addEventListener('beforeinput', event => { if (event.inputType.startsWith('history')) window.__historyEvents.push({ type: event.inputType, target: event.target.className, prevented: event.defaultPrevented }); });`
		);
		await execute(
			`document.querySelector('.cm-content').focus(); document.execCommand('insertText', false, 'NATIVE_UNDO_PROBE');`
		);
		await until(
			() =>
				execute(
					`return document.querySelector('.cm-content').textContent.includes('NATIVE_UNDO_PROBE')`
				),
			'typed native text'
		);
		await nativeShortcut('z');
		await until(
			() =>
				execute(
					`return !document.querySelector('.cm-content').textContent.includes('NATIVE_UNDO_PROBE')`
				),
			'native menu undo'
		);
		await nativeShortcut('z', true);
		await until(
			() =>
				execute(
					`return document.querySelector('.cm-content').textContent.includes('NATIVE_UNDO_PROBE')`
				),
			'native menu redo'
		);
		await nativeShortcut('z');
		await nativeShortcut(',');
		await until(
			() => execute(`return !!document.querySelector('[role="dialog"]')`),
			'native settings shortcut'
		);
		await click('[role="dialog"] button[aria-label="Fermer"]');
		await nativeShortcut('n');
		await until(
			() =>
				execute(`return document.querySelector('header input')?.value.startsWith('Sans titre')`),
			'native new document'
		);
		await nativeShortcut('w');
		await until(
			() =>
				execute(`return document.querySelector('header input')?.value.includes(arguments[0])`, [
					title
				]),
			'native close returns to the previous document'
		);
		passed('macOS menu accelerators reach source undo redo and settings');
		passed('macOS New and Close shortcuts run once and keep the window open');
	}
	const before = await drafts();
	assert.equal(
		before.filter((/** @type {{ content: string }} */ d) => d.content.includes(title)).length,
		1
	);
	await deliverFixture();
	await delay(500);
	assert.equal(
		(await drafts()).filter((/** @type {{ content: string }} */ d) => d.content.includes(title))
			.length,
		1
	);
	passed('single instance and file delivery without duplicates');
	await saveLinkedFile('native reopened file saves without a path dialog');
	const oldPath = fixture;
	const renamedName = `${title} renamed été.md`;
	const renamedPath = join(temp, renamedName);
	await execute(
		`
		const input = document.querySelector('header input');
		input.focus(); input.value = arguments[0];
		input.dispatchEvent(new Event('input', { bubbles: true }));
	`,
		[renamedName]
	);
	assert.ok(existsSync(oldPath));
	assert.equal(existsSync(renamedPath), false);
	await execute("document.querySelector('header input').blur();");
	await until(async () => existsSync(renamedPath) && !existsSync(oldPath), 'native disk rename');
	fixture = renamedPath;
	await until(
		async () =>
			(await drafts()).some((/** @type {{name: string}} */ item) => item.name === renamedName),
		'durable renamed draft'
	);
	await saveLinkedFile('renamed file saves to its new disk path');
	passed('native rename commits on blur and preserves the disk link');
	const beforeRestart = once(
		/** @type {import('node:child_process').ChildProcess} */ (app),
		'exit'
	);
	await executeAsync(
		`const done = arguments[arguments.length - 1]; window.__TAURI__.core.invoke('desktop_smoke_request_close').then(() => done(true), error => done({ error: String(error) }));`
	).catch(() => {});
	await Promise.race([
		beforeRestart,
		delay(15_000).then(() => {
			throw new Error('Native close before disk test blocked');
		})
	]);
	app = undefined;
	session = '';
	launch(false);
	await connect();
	await saveLinkedFile(
		'restored file saves after process restart without reimport or a path dialog'
	);
	await click('button[data-mode="wysiwyg"]');
	await until(
		() => execute('return !!document.querySelector(".milkdown .ProseMirror")'),
		'visual editor',
		45_000
	);
	passed('native WYSIWYG loads');
	if (process.platform === 'darwin') {
		await click('.milkdown .ProseMirror');
		await execute(
			`const editor = document.querySelector('.ProseMirror'); const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); document.execCommand('insertText', false, 'NATIVE_VISUAL_HISTORY');`
		);
		await until(
			() =>
				execute(
					`return document.querySelector('.ProseMirror').textContent.includes('NATIVE_VISUAL_HISTORY')`
				),
			'native visual edit'
		);
		await nativeShortcut('z');
		await until(
			() =>
				execute(
					`return !document.querySelector('.ProseMirror').textContent.includes('NATIVE_VISUAL_HISTORY')`
				),
			'native visual undo'
		);
		await nativeShortcut('z', true);
		await until(
			() =>
				execute(
					`return document.querySelector('.ProseMirror').textContent.includes('NATIVE_VISUAL_HISTORY')`
				),
			'native visual redo'
		);
		await nativeShortcut('z');
		assert.equal(
			await execute(
				`const event = new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true, cancelable: true }); return document.querySelector('.ProseMirror').dispatchEvent(event);`
			),
			true
		);
		passed('native visual Undo Redo and Control-only text navigation');
	}
	await click('button[data-mode="read"]');
	await until(
		() =>
			execute(
				'return document.querySelector(".mdsh-preview img")?.naturalWidth > 0 && !!document.querySelector(".mdsh-preview .katex") && !!document.querySelector(".mdsh-preview .mermaid-block svg")'
			),
		'images math diagram',
		45_000
	);
	passed('native read images math diagram');
	await until(() => diagramIsReadable(false), 'readable Mermaid labels and colours', 45_000);
	passed('native Mermaid labels and node colours');
	const screenshot = await request(`/session/${session}/screenshot`, undefined, 'GET');
	writeFileSync(join(output, 'read.png'), Buffer.from(screenshot, 'base64'));
	if (process.platform === 'darwin') {
		results.exportCancellation = await nativeExportCancellation({
			execute,
			executeAsync,
			click,
			drafts,
			until,
			panelMarker
		});
		passed('native export panels cancel without clearing edits');
	}
	if (process.platform === 'darwin') {
		await execute(
			`window.__printDiagnostics = []; const report = console.error; console.error = (...args) => { window.__printDiagnostics.push(args.map(String)); report(...args); }; const invoke = window.__TAURI_INTERNALS__.invoke; window.__TAURI_INTERNALS__.invoke = (command, ...args) => { const result = invoke(command, ...args); if (command === 'desktop_print') { window.__printDiagnostics.push({ command, args }); result.then(value => window.__printDiagnostics.push({ value }), error => window.__printDiagnostics.push({ error: String(error) })); } return result; };`
		);
		await execute(
			`const messages = new Set(); new MutationObserver(() => { for (const alert of document.querySelectorAll('[role="alert"]')) { const message = alert.textContent.trim(); if (!messages.has(message)) { messages.add(message); window.__printDiagnostics.push({ alert: message }); } } }).observe(document.body, { childList: true, subtree: true });`
		);
		await execute(
			`window.addEventListener('beforeprint', () => { const host = document.getElementById('mdsh-native-print'); const root = host?.shadowRoot ?? host; window.__printDiagnostics.push({ beforeprint: true, images: [...root.querySelectorAll('img')].map(image => ({ width: image.getBoundingClientRect().width, height: image.getBoundingClientRect().height, maxHeight: getComputedStyle(image).maxHeight, parentDisplay: getComputedStyle(image.parentElement).display, breakInside: getComputedStyle(image.parentElement).breakInside })) }); });`
		);
		await click('button[aria-label="Exporter en PDF"]');
		await until(
			() => existsSync(nativePdfPath) && statSync(nativePdfPath).size > 10_000,
			'product native PDF export',
			45_000
		);
		await until(
			() => execute('return !document.getElementById("mdsh-native-print")'),
			'native print operation completed',
			45_000
		);
		const bytes = readFileSync(nativePdfPath);
		writeFileSync(join(output, 'native.pdf'), bytes);
		assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
		assert.ok(bytes.length > 10_000);
		assert.ok((bytes.toString('latin1').match(/\/Subtype\s*\/Image\b/g) ?? []).length >= 1);
		results.pdfSha256 = createHash('sha256').update(bytes).digest('hex');
		const inspector = join(temp, 'pdf-inspector');
		execFileSync('swiftc', ['-O', resolve('scripts/inspect-native-pdf.swift'), '-o', inspector], {
			stdio: 'inherit',
			timeout: 180_000
		});
		const inspect = (directory) => {
			mkdirSync(directory, { recursive: true });
			writeFileSync(join(directory, 'native.pdf'), readFileSync(nativePdfPath));
			execFileSync(inspector, [nativePdfPath, directory], { stdio: 'inherit', timeout: 30_000 });
			return JSON.parse(readFileSync(join(directory, 'native-pdf-inspection.json'), 'utf8'));
		};
		results.pdfInspections = [inspect(output)];
		passed('product macOS print operation exports a PDF with the embedded image');
		const firstExportTime = statSync(nativePdfPath).mtimeMs;
		await nativeShortcut('p');
		await until(
			() => statSync(nativePdfPath).mtimeMs !== firstExportTime,
			'repeated native PDF shortcut',
			45_000
		);
		await until(
			() => execute('return !document.getElementById("mdsh-native-print")'),
			'repeated native PDF cleanup',
			45_000
		);
		results.pdfInspections.push(inspect(join(output, 'repeated-pdf')));
		passed('native PDF shortcut can export again after completion');
		results.presentationPdf = await nativePresentationPdf({
			execute,
			click,
			nativeShortcut,
			until,
			nativePdfPath,
			output,
			temp,
			expectedTitle: title
		});
		passed('native presentation export keeps one 16:9 page for each slide');
	} else {
		// Keep the actual preparation steps. Replace only the final OS dialog call
		// to let the driver produce the PDF automatically.
		await execute(
			'window.__nativePrintCalled = false; window.__nativeOriginalPrint = window.print; window.print = () => { window.__nativePrintCalled = true; };'
		);
		await click('button[aria-label="Exporter en PDF"]');
		await until(
			() => execute('return window.__nativePrintCalled === true'),
			'native print preparation',
			45_000
		);
		assert.equal(
			await execute(
				'return document.getElementById("mdsh-native-print")?.shadowRoot?.querySelector("img")?.naturalWidth'
			),
			192
		);
		passed('native print uses top window with decoded image');
		await until(() => diagramIsReadable(true), 'printable Mermaid labels and colours', 45_000);
		passed('native print preserves Mermaid labels and colours');
		// WKPDFConfiguration captures screen media, not print media.
		// Enable the print stylesheet for this capture. Keep the product content.
		await execute(
			`const style = document.createElement('style'); style.id = 'native-smoke-capture-style'; style.textContent = 'body > :not(#mdsh-native-print){display:none!important} #mdsh-native-print{position:static!important;width:auto!important} html,body{height:auto!important;overflow:visible!important}'; document.head.append(style);`
		);
		const pdf = await request(`/session/${session}/print`, { background: true });
		const bytes = Buffer.from(pdf, 'base64');
		assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
		assert.ok(bytes.length > 10_000);
		const pdfStructure = bytes.toString('latin1');
		assert.equal((pdfStructure.match(/\/Type\s*\/Page\b/g) ?? []).length, 1);
		assert.ok((pdfStructure.match(/\/Subtype\s*\/Image\b/g) ?? []).length >= 1);
		writeFileSync(join(output, 'native.pdf'), bytes);
		passed('native WebView render capture contains the image');
		// The replacement dialog does not emit afterprint. Complete its cycle,
		// remove only the capture stylesheet, and return control to the editor.
		await execute(
			`document.getElementById('native-smoke-capture-style')?.remove(); window.print = window.__nativeOriginalPrint; delete window.__nativeOriginalPrint; window.dispatchEvent(new Event('afterprint'));`
		);
	}
	await until(
		() =>
			execute(
				'return !document.getElementById("mdsh-native-print") && !Array.from(document.head.querySelectorAll("style")).some(style => style.textContent.includes("#mdsh-native-print")) && !!document.querySelector("button[data-mode=source]")?.getClientRects().length'
			),
		'editor restored after print'
	);
	passed('native print cleanup restores the editor');
	await click('button[data-mode="wysiwyg"]');
	await until(
		() => execute('return !!document.querySelector(".milkdown .ProseMirror")'),
		'WYSIWYG before close',
		45_000
	);
	await click('.milkdown .ProseMirror');
	await execute(
		`const node = document.querySelector('.milkdown .ProseMirror'); const range = document.createRange(); range.selectNodeContents(node); range.collapse(false); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);`
	);
	const editable = await request(`/session/${session}/element`, {
		using: 'css selector',
		value: '.milkdown .ProseMirror'
	});
	await request(
		`/session/${session}/element/${editable['element-6066-11e4-a52e-4f735466cecf']}/value`,
		{ text: '\nPersisted before native close.' }
	);

	const closed = once(/** @type {import('node:child_process').ChildProcess} */ (app), 'exit');
	// Close immediately, without waiting for the debounce. The product must wait for the save.
	await executeAsync(
		`const done = arguments[arguments.length - 1]; window.__TAURI__.core.invoke('desktop_smoke_request_close').then(() => done(true), error => done({ error: String(error) }));`
	).catch(() => {});
	await Promise.race([
		closed,
		delay(15_000).then(() => {
			throw new Error('Native close blocked');
		})
	]);
	app = undefined;
	session = '';
	launch();
	await connect();
	await until(
		async () =>
			(await drafts()).some(
				(/** @type {{ content: string }} */ d) =>
					d.content.includes(title) && d.content.includes('Persisted before native close.')
			),
		'durable content on relaunch'
	);
	passed('immediate native WYSIWYG close waits for durable save and relaunch');
	assert.ok(readFileSync(fixture, 'utf8').includes(title));

	results.diskRaces = await nativeDiskRaces({
		execute,
		executeAsync,
		until,
		fixture,
		gate: diskGate,
		output,
		deliverFixture
	});
	await waitForNativeOpenDelivery();
	passed('native replacement rename substitution and revocation races reject stale writes');
	results.nativeProjects = await nativeProjects({
		execute,
		executeAsync,
		until,
		fixtureRoot: nativeProjectRoot,
		projectRegistry: nativeProjectRegistry,
		gate: diskGate,
		output,
		restart: async () => {
			const stopped = once(/** @type {import('node:child_process').ChildProcess} */ (app), 'exit');
			app.kill();
			await Promise.race([
				stopped,
				delay(15_000).then(() => {
					throw new Error('Native restart for project grants blocked');
				})
			]);
			app = undefined;
			session = '';
			launch(false);
			await connect(false);
		}
	});
	passed('native project roots remain confined across refresh restart and revocation');
	const diskBeforePurge = readFileSync(fixture);
	const linkedDraft = (await drafts()).find(
		(/** @type {{name: string}} */ item) => item.name === basename(fixture)
	);
	assert.ok(linkedDraft, 'Native purge fixture has a durable draft');
	const initialState = await purgeState();
	const link = initialState.links[initialState.linkIds.indexOf(linkedDraft.id)];
	assert.equal(link?.kind, 'path');
	const grantsBeforePurge = await nativeGrantPaths();
	assert.ok(grantsBeforePurge.includes(link.path), 'Native grant exists before purge');
	// Give two closed documents the same real native link. The UI performs all deletions.
	const sharedOwners = [1, 2].map((index) => ({
		...linkedDraft,
		id: `${linkedDraft.id}-shared-${index}`,
		name: `${title} shared ${index}.md`,
		open: false,
		order: linkedDraft.order + index
	}));
	const seeded = await executeAsync(
		`const [owners, link] = arguments; const done = arguments[arguments.length - 1];
		function put(name, table, values, keyed) {
			return new Promise((resolve, reject) => {
				const request = indexedDB.open(name);
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const db = request.result; const tx = db.transaction(table, 'readwrite');
					for (const owner of values) {
						if (keyed) tx.objectStore(table).put(link, owner.id);
						else tx.objectStore(table).put(owner);
					}
					tx.oncomplete = () => { db.close(); resolve(); };
					tx.onabort = () => { db.close(); reject(tx.error); };
				};
			});
		}
		Promise.all([put('mdsh', 'drafts', owners, false), put('mdsh-fs', 'handles', owners, true)])
			.then(() => done(true), error => done({ error: String(error) }));`,
		[sharedOwners, link]
	);
	assert.equal(seeded, true);
	await execute(`localStorage.setItem('mdsh:activeId', arguments[0]);`, [linkedDraft.id]);
	await reload();
	await trashLinkedDocuments([linkedDraft.id]);
	const sharedState = await purgeState();
	assert.equal(sharedState.draftIds.includes(linkedDraft.id), false);
	assert.equal(sharedState.trashIds.includes(linkedDraft.id), false);
	assert.equal(sharedState.linkIds.includes(linkedDraft.id), false);
	for (const owner of sharedOwners) {
		assert.ok(sharedState.draftIds.includes(owner.id));
		assert.ok(sharedState.linkIds.includes(owner.id));
	}
	assert.ok((await nativeGrantPaths()).includes(link.path));
	assert.deepEqual(readFileSync(fixture), diskBeforePurge);
	results.trashPurge = { path: link.path, originalId: linkedDraft.id, sharedState };
	passed('native trash purge keeps a path owned by closed documents');

	// Native open uses the surviving path owner and restores the disk filename.
	await deliverFixture();
	await until(
		async () =>
			(await drafts()).some(
				(/** @type {{id: string, name: string, open: boolean}} */ row) =>
					row.id === sharedOwners[0].id && row.name === basename(fixture) && row.open === true
			),
		'native reopen updates the retained owner name'
	);
	await waitForNativeOpenDelivery();
	const reopenedState = await purgeState();
	results.trashPurge = { ...results.trashPurge, reopenedState };
	assert.deepEqual(reopenedState.draftIds, sharedState.draftIds);
	assert.deepEqual(reopenedState.linkIds, sharedState.linkIds);
	assert.equal(reopenedState.draftIds.includes(linkedDraft.id), false);
	assert.deepEqual(readFileSync(fixture), diskBeforePurge);
	passed('native reopen preserves the shared owner ID and restores the disk filename');

	await trashLinkedDocuments(sharedOwners.map((owner) => owner.id));
	const purgedState = await purgeState();
	const purgedIds = [linkedDraft.id, ...sharedOwners.map((owner) => owner.id)];
	for (const id of purgedIds) {
		assert.equal(purgedState.draftIds.includes(id), false);
		assert.equal(purgedState.trashIds.includes(id), false);
		assert.equal(purgedState.linkIds.includes(id), false);
	}
	assert.deepEqual(
		purgedState.draftIds,
		initialState.draftIds.filter((/** @type {string} */ id) => id !== linkedDraft.id)
	);
	assert.deepEqual(
		purgedState.linkIds,
		initialState.linkIds.filter((/** @type {string} */ id) => id !== linkedDraft.id)
	);
	const grantsAfterPurge = await nativeGrantPaths();
	results.trashPurge = {
		path: link.path,
		purgedIds,
		grantsBeforePurge,
		grantsAfterPurge,
		sharedState,
		reopenedState,
		purgedState,
		diskSha256: createHash('sha256').update(diskBeforePurge).digest('hex')
	};
	assert.deepEqual(readFileSync(fixture), diskBeforePurge);
	assert.equal(
		grantsAfterPurge.includes(link.path),
		false,
		'Empty trash must revoke native access'
	);
	passed('native Empty trash revokes the last shared path without changing the disk file');

	const purgeClose = once(/** @type {import('node:child_process').ChildProcess} */ (app), 'exit');
	await executeAsync(
		`const done = arguments[arguments.length - 1]; window.__TAURI__.core.invoke('desktop_smoke_request_close').then(() => done(true), error => done({ error: String(error) }));`
	).catch(() => {});
	await Promise.race([
		purgeClose,
		delay(15_000).then(() => {
			throw new Error('Native close after trash purge blocked');
		})
	]);
	app = undefined;
	session = '';
	launch(false);
	await connect(false);
	const grantsAfterRestart = await nativeGrantPaths();
	const restartedState = await purgeState();
	results.trashPurge = { ...results.trashPurge, grantsAfterRestart, restartedState };
	assert.equal(
		grantsAfterRestart.includes(link.path),
		false,
		'Purged native access must stay revoked'
	);
	assert.deepEqual(restartedState, purgedState);
	assert.deepEqual(readFileSync(fixture), diskBeforePurge);
	const purgedScreenshot = await request(`/session/${session}/screenshot`, undefined, 'GET');
	writeFileSync(join(output, 'trash-purged.png'), Buffer.from(purgedScreenshot, 'base64'));
	passed('native purge stays revoked after restart without opening the fixture');
	results.passed = true;
} catch (error) {
	results.error = String(error);
	collectWindowsDiagnostics();
	if (session) {
		try {
			results.page = await execute(
				'return { printDiagnostics: window.__printDiagnostics, printHost: !!document.getElementById("mdsh-native-print"), historyEvents: window.__historyEvents, text: document.body.innerText, editors: [...document.querySelectorAll(".cm-content")].map(node => node.textContent), inputs: [...document.querySelectorAll("input")].map(node => ({name:node.getAttribute("aria-label"),value:node.value})) };'
			);
		} catch {
			/**
			 * The window can already be closed.
			 */
		}
	}
	throw error;
} finally {
	try {
		writeFileSync(join(output, 'results.json'), JSON.stringify(results, null, 2));
	} finally {
		if (secondary?.pid) secondary.kill();
		if (app?.pid) app.kill();
	}
}

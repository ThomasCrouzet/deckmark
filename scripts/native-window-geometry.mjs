// Native window geometry check for the Desktop main and quick-capture windows.
//
// The script runs against the real WebView. It records the monitor work area,
// scale factor, logical and physical bounds, the WebView identity and a
// screenshot for each window state. Run it on a small screen or at a high
// display scale to prove that both windows stay inside the usable area.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { arch, release as osRelease, tmpdir, version as osVersion } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { testSource } from './test-source.mjs';

const binary = resolve(
	process.env.NATIVE_BINARY ??
		`src-tauri/target/debug/deckmark${process.platform === 'win32' ? '.exe' : ''}`
);
const port = Number(process.env.TAURI_WEBDRIVER_PORT ?? 4458);
const endpoint = `http://127.0.0.1:${port}`;
const output = resolve(process.env.NATIVE_TEST_OUTPUT ?? 'native-window-geometry');
mkdirSync(output, { recursive: true });
const temp = mkdtempSync(join(tmpdir(), 'mdsh-window-geometry-'));
const nativeHome = join(temp, 'home');
mkdirSync(nativeHome, { recursive: true });
const log = openSync(join(output, 'application.log'), 'w');
const invokeScript = `const done = arguments[arguments.length - 1];
window.__TAURI__.core.invoke(arguments[0], arguments[1]).then(
  value => done({ value }),
  error => done({ rejection: String(error) })
);`;

/** @type {import('node:child_process').ChildProcess | undefined} */
let app;
let session = '';
/** @type {any[]} */
const checks = [];
/** @type {Record<string, unknown>} */
const evidence = {
	...testSource(join(output, 'source-runtime')),
	platform: process.platform,
	arch: arch(),
	osRelease: osRelease(),
	osVersion: osVersion(),
	node: process.version,
	binary,
	binarySha256: createHash('sha256').update(readFileSync(binary)).digest('hex')
};

/** @param {string} name */
function passed(name) {
	checks.push(name);
	console.log(`OK ${name}`);
}

/**
 * @param {string} path
 * @param {unknown} [body]
 * @param {string} [method]
 */
async function request(path, body, method = 'POST') {
	const response = await fetch(`${endpoint}${path}`, {
		method,
		headers: { 'content-type': 'application/json' },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		signal: AbortSignal.timeout(30_000)
	});
	const data = await response.json();
	if (!response.ok || data.value?.error) throw new Error(JSON.stringify(data));
	return data.value;
}

/**
 * @param {() => Promise<unknown>} check
 * @param {string} label
 * @param {number} [timeout]
 */
async function until(check, label, timeout = 30_000) {
	const deadline = Date.now() + timeout;
	let last;
	while (Date.now() < deadline) {
		try {
			const value = await check();
			if (value) return value;
			last = undefined;
		} catch (error) {
			last = error;
		}
		await delay(150);
	}
	throw new Error(`Timeout ${label}: ${last ? String(last) : 'condition false'}`);
}

/** @param {string} script @param {unknown[]} [args] */
const execute = (script, args = []) =>
	request(`/session/${session}/execute/sync`, { script, args });
/** @param {string} script @param {unknown[]} [args] */
const executeAsync = (script, args = []) =>
	request(`/session/${session}/execute/async`, { script, args });
/** @param {string} command @param {Record<string, unknown>} [args] */
const invoke = (command, args = {}) => executeAsync(invokeScript, [command, args]);

/** @param {string} label */
async function switchWindow(label) {
	await until(
		async () => {
			try {
				const handles = await request(`/session/${session}/window/handles`, undefined, 'GET');
				if (!Array.isArray(handles) || !handles.includes(label)) return false;
				await request(`/session/${session}/window`, { handle: label });
				return true;
			} catch {
				return false;
			}
		},
		`switch to the ${label} window`,
		30_000
	);
}

/** @param {string} name */
async function screenshot(name) {
	const bytes = await request(`/session/${session}/screenshot`, undefined, 'GET');
	writeFileSync(join(output, name), Buffer.from(bytes, 'base64'));
	return `${name} (${Buffer.from(bytes, 'base64').length} bytes)`;
}

/**
 * @param {string} label
 * @param {{ value?: any, rejection?: string }} response
 */
function readGeometry(label, response) {
	assert.equal(response.rejection, undefined, `${label}: ${response.rejection}`);
	const geometry = response.value;
	assert.ok(geometry, `${label}: no geometry`);
	evidence[label] = geometry;
	return geometry;
}

/**
 * @param {string} label
 * @param {any} geometry
 */
function assertFits(label, geometry) {
	const work = geometry.workAreaLogical;
	assert.ok(
		geometry.innerSizeLogical.width <= work.width + 1,
		`${label}: ${geometry.innerSizeLogical.width} logical px wide exceeds the ${work.width} px work area`
	);
	assert.ok(
		geometry.innerSizeLogical.height <= work.height + 1,
		`${label}: ${geometry.innerSizeLogical.height} logical px high exceeds the ${work.height} px work area`
	);
	const area = geometry.workArea;
	const position = geometry.outerPosition;
	assert.ok(position.x >= area.x - 1, `${label}: origin is left of the work area`);
	assert.ok(position.y >= area.y - 1, `${label}: origin is above the work area`);
	assert.ok(position.x < area.x + area.width, `${label}: origin is right of the work area`);
	assert.ok(position.y < area.y + area.height, `${label}: origin is below the work area`);
	assert.ok(
		position.x + geometry.outerSize.width <= area.x + area.width + 1,
		`${label}: right edge is outside the work area`
	);
	assert.ok(
		position.y + geometry.outerSize.height <= area.y + area.height + 1,
		`${label}: bottom edge is outside the work area`
	);
}

async function checkMainControls(label) {
	const saveState = await execute(
		`const node = document.querySelector('[data-testid=save-document]');
		return node ? { present: true, disabled: node.hasAttribute('disabled') } : { present: false };`
	);
	if (!saveState.present || saveState.disabled) {
		const demoClicked = await execute(
			`const node = document.querySelector('[data-testid=welcome-demo]');
			if (!node) return false;
			node.click();
			return true;`
		);
		if (!demoClicked) {
			await execute(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true }));
				return true;`);
			await until(
				() => execute(`return !!document.querySelector('[data-testid=create-note]');`),
				`${label}: new document dialog`,
				15_000
			);
			await execute(`document.querySelector('[data-testid=create-note]').click(); return true;`);
		}
		await until(
			() =>
				execute(
					`const node = document.querySelector('[data-testid=save-document]');
					return !!node && !node.hasAttribute('disabled');`
				),
			`${label}: main document opens`,
			45_000
		);
	}
	const controls = await execute(`const rect = (node) => {
		if (!node) return null;
		const box = node.getBoundingClientRect();
		return {
			testid: node.getAttribute('data-testid'),
			label: node.getAttribute('aria-label'),
			width: box.width,
			height: box.height,
			top: box.top,
			bottom: box.bottom,
			left: box.left,
			right: box.right
		};
	};
	return {
		viewport: { width: innerWidth, height: innerHeight },
		toolbar: rect(document.querySelector('#app-toolbar')),
		buttons: [...document.querySelectorAll('#app-toolbar button')]
			.map(rect)
			.filter((entry) => entry.width > 0 && entry.height > 0)
	};`);
	evidence[`${label}Controls`] = controls;
	const { viewport, toolbar, buttons } = controls;
	assert.ok(toolbar && toolbar.width > 0 && toolbar.height > 0, `${label}: toolbar has no box`);
	assert.ok(
		toolbar.left >= -1 && toolbar.top >= -1,
		`${label}: toolbar starts outside the viewport`
	);
	assert.ok(
		toolbar.right <= viewport.width + 1 && toolbar.bottom <= viewport.height + 1,
		`${label}: toolbar ends outside the ${viewport.width}x${viewport.height} viewport`
	);
	assert.ok(buttons.length > 0, `${label}: the toolbar has no visible control`);
	for (const button of buttons) {
		assert.ok(
			button.left >= -1 && button.top >= -1,
			`${label}: ${button.label} starts outside the viewport`
		);
		assert.ok(
			button.right <= viewport.width + 1 && button.bottom <= viewport.height + 1,
			`${label}: ${button.label} ends outside the viewport`
		);
	}
	passed(`${label}: main toolbar and ${buttons.length} visible controls are inside the viewport`);
}

async function checkMainCommands(label) {
	const commands = [
		{ query: 'save', id: 'save' },
		{ query: 'export', id: 'export-md' },
		{ query: 'settings', id: 'settings' }
	];
	await until(
		() =>
			execute(`const trigger = document.querySelector('.palette-trigger');
			if (!trigger) return false;
			trigger.click();
			return true;`),
		`${label}: command palette trigger`,
		15_000
	);
	for (const command of commands) {
		await until(
			() =>
				execute(
					`const input = document.querySelector('[role=combobox]');
				if (!input) return false;
				input.value = arguments[0];
				input.dispatchEvent(new Event('input', { bubbles: true }));
				return true;`,
					[command.query]
				),
			`${label}: ${command.id} query`,
			15_000
		);
		const option = await until(
			() =>
				execute(
					`const node = document.querySelector('#cmd-palette-opt-' + arguments[0]);
				if (!node) return null;
				const box = node.getBoundingClientRect();
				return {
					disabled: node.getAttribute('aria-disabled'),
					width: box.width,
					height: box.height,
					top: box.top,
					bottom: box.bottom,
					left: box.left,
					right: box.right,
					viewport: { width: innerWidth, height: innerHeight }
				};`,
					[command.id]
				),
			`${label}: ${command.id} command`,
			15_000
		);
		evidence[`${label}${command.id}`] = option;
		assert.notEqual(option.disabled, 'true', `${label}: ${command.id} is unavailable`);
		assert.ok(option.width > 0 && option.height > 0, `${label}: ${command.id} has no box`);
		assert.ok(
			option.left >= -1 && option.top >= -1,
			`${label}: ${command.id} starts outside the viewport`
		);
		assert.ok(
			option.right <= option.viewport.width + 1 && option.bottom <= option.viewport.height + 1,
			`${label}: ${command.id} ends outside the viewport`
		);
	}
	await execute(`const dialog = document.querySelector('[role=dialog][aria-modal=true]');
		if (dialog) dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		return true;`);
	await until(
		() => execute(`return !document.querySelector('#cmd-palette-listbox');`),
		`${label}: command palette closes`,
		15_000
	);
	passed(`${label}: Save, Export and Settings are reachable from the command palette`);
}

async function checkCaptureControls(label) {
	await until(
		() => execute('return !!document.querySelector("#quick-capture-title")'),
		'quick capture ready',
		30_000
	);
	const controls = await execute(`const rect = (selector) => {
		const node = document.querySelector(selector);
		if (!node) return null;
		const box = node.getBoundingClientRect();
		return { width: box.width, height: box.height, top: box.top, bottom: box.bottom };
	};
	return {
		viewport: { width: innerWidth, height: innerHeight },
		title: rect('#quick-capture-title'),
		content: rect('[data-testid=capture-content]'),
		cancel: rect('[data-testid=capture-cancel]'),
		save: rect('[data-testid=capture-save]')
	};`);
	evidence[`${label}Controls`] = controls;
	for (const name of ['title', 'content', 'cancel', 'save']) {
		const box = controls[name];
		assert.ok(box && box.width > 0 && box.height > 0, `${label}: ${name} has no box`);
		assert.ok(box.top >= 0, `${label}: ${name} starts above the viewport`);
	}
	for (const name of ['title', 'cancel', 'save']) {
		assert.ok(
			controls[name].bottom <= controls.viewport.height + 1,
			`${label}: ${name} ends below the ${controls.viewport.height} px viewport`
		);
	}
	// The content field can sit below the fold on a short work area. Its own
	// scroll area must still bring it fully into view.
	const scrolled =
		await execute(`const node = document.querySelector('[data-testid=capture-content]');
		const scroller = node?.closest('.overflow-y-auto');
		if (!node || !scroller) return null;
		scroller.scrollTop = node.offsetTop;
		const box = node.getBoundingClientRect();
		return { top: box.top, bottom: box.bottom, scrollTop: scroller.scrollTop, viewport: innerHeight };`);
	evidence[`${label}ContentScroll`] = scrolled;
	assert.ok(scrolled, `${label}: content has no scroll container`);
	assert.ok(
		scrolled.scrollTop > 0 || controls.content.bottom <= controls.viewport.height + 1,
		`${label}: content cannot be scrolled into view`
	);
	assert.ok(
		scrolled.bottom <= scrolled.viewport + 1,
		`${label}: content stays below the viewport after scrolling`
	);
	passed(`${label}: title, content, Cancel and Save are reachable`);
}

async function run() {
	app = spawn(binary, [], {
		stdio: ['ignore', log, log],
		env: {
			...process.env,
			HOME: nativeHome,
			CFFIXED_USER_HOME: nativeHome,
			XDG_CONFIG_HOME: join(nativeHome, '.config'),
			XDG_DATA_HOME: join(nativeHome, '.local', 'share'),
			XDG_CACHE_HOME: join(nativeHome, '.cache'),
			APPDATA: join(nativeHome, 'AppData', 'Roaming'),
			LOCALAPPDATA: join(nativeHome, 'AppData', 'Local'),
			TAURI_WEBDRIVER_PORT: String(port)
		}
	});
	app.once('exit', (code, signal) => {
		if (session) {
			evidence.applicationExit = { code, signal };
		}
	});

	await until(
		async () => (await request('/status', undefined, 'GET')).ready === true,
		'WebDriver window ready',
		60_000
	);
	const created = await request('/session', {
		capabilities: { alwaysMatch: { 'wdio:tauriServiceOptions': { windowLabel: 'main' } } }
	});
	session = created.sessionId;
	evidence.runtime = created.capabilities;
	evidence.webview = {
		browserName: created.capabilities?.browserName ?? null,
		browserVersion: created.capabilities?.browserVersion ?? null,
		platformName: created.capabilities?.platformName ?? null
	};
	await until(
		() =>
			execute(
				'return document.querySelector(".mdsh-shell")?.getAttribute("aria-busy") === "false" && !document.querySelector(".mdsh-shell")?.hasAttribute("inert");'
			),
		'native application ready',
		60_000
	);

	const main = readGeometry('main', await invoke('desktop_window_geometry'));
	assertFits('main launch', main);
	evidence.mainScreenshot = await screenshot('main-window.png');
	passed('main window fits the monitor work area at launch');
	await checkMainControls('main launch');
	await checkMainCommands('main launch');

	const shown = await invoke('desktop_capture_show');
	assert.equal(shown.rejection, undefined, shown.rejection);
	const capture = readGeometry(
		'captureLaunch',
		await invoke('desktop_window_geometry', { label: 'capture' })
	);
	assertFits('capture launch', capture);
	await switchWindow('capture');
	await checkCaptureControls('capture launch');
	evidence.captureLaunchScreenshot = await screenshot('capture-window.png');
	passed('quick capture fits the work area at launch');

	await invoke('desktop_capture_hide');
	await switchWindow('main');
	const reopened = await invoke('desktop_capture_show');
	assert.equal(reopened.rejection, undefined, reopened.rejection);
	const reuse = readGeometry(
		'captureReuse',
		await invoke('desktop_window_geometry', { label: 'capture' })
	);
	assertFits('capture reuse', reuse);
	await switchWindow('capture');
	evidence.captureReuseScreenshot = await screenshot('capture-window-reuse.png');
	passed('quick capture still fits after hide and reopen');

	const shortWorkArea = capture.workAreaLogical.height < 420;
	evidence.shortWorkArea = shortWorkArea;
	if (shortWorkArea) {
		assert.ok(
			capture.innerSizeLogical.height <= capture.workAreaLogical.height,
			'The capture window is taller than the short work area'
		);
		passed('quick capture is shorter than the short work area');
	}

	await invoke('desktop_capture_hide');
	await switchWindow('main');
	checks.push('done');
}

try {
	await run();
} catch (error) {
	evidence.error = String(error);
	evidence.lastApplicationLog = readFileSync(join(output, 'application.log'), 'utf8')
		.split('\n')
		.filter(Boolean)
		.slice(-20);
	throw error;
} finally {
	if (app && app.exitCode === null) {
		app.kill('SIGTERM');
		await Promise.race([once(app, 'exit'), delay(5_000)]);
	}
	rmSync(temp, { recursive: true, force: true });
	writeFileSync(
		join(output, 'native-window-geometry.json'),
		JSON.stringify(
			{
				recordedAt: new Date().toISOString(),
				command: 'node scripts/native-window-geometry.mjs',
				checks,
				...evidence
			},
			null,
			2
		)
	);
}

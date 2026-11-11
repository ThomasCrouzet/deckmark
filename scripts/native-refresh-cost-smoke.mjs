// Focused native project refresh-cost reproduction and benchmark.
//
// Run against a native-smoke build:
//   NATIVE_REFRESH_DOCS=600 NATIVE_REFRESH_LABEL=600 \
//     dbus-run-session -- xvfb-run -a node scripts/native-refresh-cost-smoke.mjs
//
// The script creates the project fixture itself, imports it through the
// Projects panel, restarts so document bodies are deferred, then measures a
// no-change refresh and a save. It writes one JSON report and prints a summary.
// The same file runs against the pre-fix and post-fix binaries.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { processTreeMemory } from './native-process-memory.mjs';

const binary = resolve(process.env.NATIVE_BINARY ?? 'src-tauri/target/debug/deckmark');
const documentCount = Number(process.env.NATIVE_REFRESH_DOCS ?? 600);
const documentBytes = Number(process.env.NATIVE_REFRESH_CONTENT_BYTES ?? 32 * 1024);
const repeat = Number(process.env.NATIVE_REFRESH_REPEAT ?? 1);
const label = process.env.NATIVE_REFRESH_LABEL ?? String(documentCount);
const outputDirectory = resolve(process.env.NATIVE_REFRESH_OUT ?? 'native-refresh-cost');
const port = Number(process.env.TAURI_WEBDRIVER_PORT ?? 4468);
const endpoint = `http://127.0.0.1:${port}`;
const temp = mkdtempSync(join(tmpdir(), 'mdsh-refresh-cost-'));
const home = join(temp, 'home');
const projectRoot = join(temp, 'project');
const registry = join(temp, 'project-roots.json');
const log = join(outputDirectory, `application-${label}.log`);
mkdirSync(home, { recursive: true });
mkdirSync(projectRoot, { recursive: true });
mkdirSync(outputDirectory, { recursive: true });
const section = 'Representative project content. ';
const filler = 'x'.repeat(Math.max(0, documentBytes - 64));
for (let index = 0; index < documentCount; index += 1) {
	writeFileSync(
		join(projectRoot, `note-${String(index).padStart(4, '0')}.md`),
		`# Note ${index}\n\n${section}${filler}\n`
	);
}
writeFileSync(join(projectRoot, 'README.md'), '# Bench project\n');
const binaryBytes = readFileSync(binary);
assert.ok(
	binaryBytes.includes(Buffer.from('[mdsh-native-startup]')),
	'Build with --features native-smoke before running this script'
);
const binarySha256 = createHash('sha256').update(binaryBytes).digest('hex');
const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const dataStoreId = randomBytes(16).toString('hex');
const logStream = await import('node:fs').then(({ openSync }) => openSync(log, 'a'));
let app;
let session = '';

function environment() {
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
		TAURI_WEBDRIVER_PORT: String(port),
		MDSH_NATIVE_PROJECT_ROOT: projectRoot,
		MDSH_NATIVE_PROJECT_REGISTRY: registry
	};
}

function launch() {
	app = spawn(binary, [], { stdio: ['ignore', logStream, logStream], env: environment() });
}

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

const execute = (script, args = []) =>
	request(`/session/${session}/execute/sync`, { script, args });
const executeAsync = (script, args = []) =>
	request(`/session/${session}/execute/async`, { script, args });

async function until(check, description, timeout = 120_000) {
	const deadline = Date.now() + timeout;
	let last;
	while (Date.now() < deadline) {
		if (app?.exitCode !== null && app?.exitCode !== undefined)
			throw new Error(`Native process exited during ${description}: ${app.exitCode}`);
		try {
			const value = await check();
			if (value) return value;
		} catch (error) {
			last = error;
		}
		await delay(150);
	}
	throw new Error(`Timeout ${description}: ${last ? String(last) : 'condition false'}`);
}

async function connect() {
	await until(
		async () => (await request('/status', undefined, 'GET')).ready === true,
		'WebDriver ready',
		120_000
	);
	const created = await request('/session', {
		capabilities: { alwaysMatch: { 'wdio:tauriServiceOptions': { windowLabel: 'main' } } }
	});
	session = created.sessionId;
	await until(
		() =>
			execute(
				'return document.querySelector(".mdsh-shell")?.getAttribute("aria-busy") === "false" && !document.querySelector(".mdsh-shell")?.hasAttribute("inert");'
			),
		'application ready',
		60_000
	);
}

async function restart() {
	const stopped = once(app, 'exit');
	app.kill();
	await Promise.race([
		stopped,
		delay(20_000).then(() => {
			throw new Error('restart blocked');
		})
	]);
	launch();
	await connect();
}

async function clickLabel(labels) {
	await until(
		() =>
			execute(
				`const labels = arguments[0];
				const button = [...document.querySelectorAll('button')].find(node =>
					labels.includes(node.textContent.trim()) && !node.disabled && node.getClientRects().length
				);
				if (!button) return false;
				button.click();
				return true;`,
				[labels]
			),
		`click ${labels[0]}`,
		60_000
	);
}

async function openProjectsPanel() {
	const open = await execute('return !!document.getElementById("projects-title")');
	if (!open) {
		await until(
			() =>
				execute(
					`const button = document.querySelector('[data-testid="projects-open"]');
					if (!button || button.disabled || !button.getClientRects().length) return false;
					button.click(); return true;`
				),
			'open Projects panel',
			60_000
		);
	}
	await until(
		() => execute('return !!document.getElementById("projects-title")'),
		'Projects panel'
	);
}

async function waitForIdle(settleMs = 500) {
	await new Promise((resolveDelay) => setTimeout(resolveDelay, settleMs));
	await until(
		() =>
			execute(
				`const panel = document.querySelector('[role="dialog"][aria-labelledby="projects-title"]');
				const close = panel?.querySelector('header button');
				return !!panel && !panel.querySelector('[data-testid="projects-busy"]') &&
					!!close && !close.disabled && close.getClientRects().length > 0;`
			),
		'Projects panel idle',
		300_000
	);
}

async function waitForDocument(relativePath) {
	await until(
		() =>
			execute(
				`return [...document.querySelectorAll('[role="dialog"] [data-project-document]')]
					.some(node => node.getAttribute('data-project-document') === arguments[0]);`,
				[relativePath]
			),
		`project document ${relativePath}`,
		300_000
	);
}

async function installCounters() {
	await execute(
		`window.__refreshCost = { draftGets: 0, baselineWrites: 0, draftCursorOpens: 0 };
		const originalGet = IDBObjectStore.prototype.get;
		window.__restoreRefreshCostGet = () => { IDBObjectStore.prototype.get = originalGet; };
		IDBObjectStore.prototype.get = function (key) {
		  if (this.name === 'drafts') window.__refreshCost.draftGets += 1;
		  return originalGet.call(this, key);
		};
		const originalPut = IDBObjectStore.prototype.put;
		window.__restoreRefreshCostPut = () => { IDBObjectStore.prototype.put = originalPut; };
		IDBObjectStore.prototype.put = function (value, key) {
		  const row = Array.isArray(value) ? value[0] : value;
		  if (row && typeof row === 'object' && typeof row.key === 'string' &&
		      row.key.startsWith('project-native-revisions:'))
		    window.__refreshCost.baselineWrites += 1;
		  return key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
		};
		const originalOpen = IDBObjectStore.prototype.openCursor;
		window.__restoreRefreshCostCursor = () => { IDBObjectStore.prototype.openCursor = originalOpen; };
		IDBObjectStore.prototype.openCursor = function (...args) {
		  if (this.name === 'drafts') window.__refreshCost.draftCursorOpens += 1;
		  return originalOpen.apply(this, args);
		};
		return true;`
	);
}

const resetCounters = () =>
	execute(
		'window.__refreshCost = { draftGets: 0, baselineWrites: 0, draftCursorOpens: 0 }; return true;'
	);
const readCounters = () => execute('return window.__refreshCost;');

function treeCpuMs(pid) {
	if (process.platform !== 'linux') return null;
	try {
		const children = new Map();
		for (const entry of readdirSync('/proc')) {
			const child = Number(entry);
			if (!child) continue;
			try {
				const stat = readFileSync(`/proc/${child}/stat`, 'utf8');
				const close = stat.lastIndexOf(')');
				const fields = stat.slice(close + 2).split(' ');
				const ppid = Number(fields[1]);
				const ticks = Number(fields[11]) + Number(fields[12]);
				const list = children.get(ppid) ?? [];
				list.push({ pid: child, ticks });
				children.set(ppid, list);
			} catch {
				/* exited */
			}
		}
		let ticks = 0;
		const queue = [pid];
		while (queue.length) {
			const current = queue.pop();
			try {
				const stat = readFileSync(`/proc/${current}/stat`, 'utf8');
				const close = stat.lastIndexOf(')');
				const fields = stat.slice(close + 2).split(' ');
				ticks += Number(fields[11]) + Number(fields[12]);
			} catch {
				/* exited */
			}
			for (const child of children.get(current) ?? []) queue.push(child.pid);
		}
		return Math.round((ticks / 100) * 1000);
	} catch {
		return null;
	}
}

const measureMemory = () => (app?.pid ? processTreeMemory(app.pid) : null);

async function main() {
	launch();
	await connect();
	await openProjectsPanel();
	await clickLabel(['Ouvrir un dossier du disque', 'Open a disk folder']);
	await waitForDocument('note-0000.md');
	await waitForIdle();
	const imported = await executeAsync(
		`const done = arguments[arguments.length - 1];
		const request = indexedDB.open('mdsh');
		request.onerror = () => done({ error: String(request.error) });
		request.onsuccess = () => {
		  const db = request.result;
		  const transaction = db.transaction(['projects', 'drafts']);
		  const projects = transaction.objectStore('projects').getAll();
		  const drafts = transaction.objectStore('drafts').getAll();
		  transaction.oncomplete = () => {
		    db.close();
		    const project = projects.result.find((row) => row.nativeRootId);
		    done({
		      projectId: project?.id ?? null,
		      rootId: project?.nativeRootId ?? null,
		      documents: drafts.result.filter((row) => row.projectId === project?.id).length
		    });
		  };
		  transaction.onerror = () => done({ error: String(transaction.error) });
		};`
	);
	assert.ok(imported.projectId, 'native project imported');
	assert.ok(imported.documents >= documentCount, `documents ${imported.documents}`);
	const payload = await executeAsync(
		`const [rootId] = arguments; const done = arguments[arguments.length - 1];
		window.__TAURI__.core.invoke('project_open_root', { rootId }).then(
		  async (snapshot) => {
		    const manifest = await window.__TAURI__.core.invoke('project_manifest', {
		      token: snapshot.token,
		      verified: true
		    });
		    const full = await window.__TAURI__.core.invoke('project_refresh', {
		      token: snapshot.token
		    });
		    done({
		      entries: manifest.entries.length,
		      manifestBytes: JSON.stringify(manifest).length,
		      snapshotBytes: JSON.stringify(full).length
		    });
		  },
		  error => done({ error: String(error) })
		);`,
		[imported.rootId]
	);
	assert.equal(payload.error, undefined, payload.error);

	await restart();
	await openProjectsPanel();
	await waitForDocument('note-0000.md');
	await waitForIdle();
	await installCounters();

	const refreshSample = async () => {
		await resetCounters();
		const memoryBefore = measureMemory();
		const cpuBefore = treeCpuMs(app.pid);
		const started = performance.now();
		await clickLabel(['Actualiser depuis le disque', 'Refresh from disk']);
		await waitForIdle(100);
		const ms = Number((performance.now() - started).toFixed(1));
		const memoryAfter = measureMemory();
		const cpuAfter = treeCpuMs(app.pid);
		const counters = await readCounters();
		return {
			...counters,
			ms,
			rssBeforeMb: memoryBefore?.mb ?? null,
			rssAfterMb: memoryAfter?.mb ?? null,
			cpuMs: cpuBefore === null || cpuAfter === null ? null : cpuAfter - cpuBefore
		};
	};
	const refreshSamples = [];
	for (let attempt = 0; attempt < Math.max(1, repeat); attempt += 1) {
		refreshSamples.push(await refreshSample());
	}
	const refresh = refreshSamples[0];
	const sortedRefreshMs = refreshSamples.map((sample) => sample.ms).sort((a, b) => a - b);
	const percentile = (values, fraction) =>
		values[Math.min(values.length - 1, Math.ceil(fraction * values.length) - 1)];

	await resetCounters();
	const saveMemoryBefore = measureMemory();
	const saveCpuBefore = treeCpuMs(app.pid);
	const saveStarted = performance.now();
	await clickLabel(['Enregistrer le projet sur disque', 'Save project to disk']);
	await waitForIdle(100);
	const saveMs = Number((performance.now() - saveStarted).toFixed(1));
	const saveMemoryAfter = measureMemory();
	const saveCpuAfter = treeCpuMs(app.pid);
	const save = await readCounters();

	const report = {
		label,
		source,
		binarySha256,
		platform: process.platform,
		documentCount: imported.documents,
		payload,
		refresh: {
			...refresh,
			settleMs: 100,
			p50Ms: percentile(sortedRefreshMs, 0.5),
			p95Ms: percentile(sortedRefreshMs, 0.95),
			samples: refreshSamples
		},
		save: {
			...save,
			ms: saveMs,
			settleMs: 100,
			rssBeforeMb: saveMemoryBefore?.mb ?? null,
			rssAfterMb: saveMemoryAfter?.mb ?? null,
			cpuMs: saveCpuBefore === null || saveCpuAfter === null ? null : saveCpuAfter - saveCpuBefore
		},
		checkedAt: new Date().toISOString()
	};
	writeFileSync(
		join(outputDirectory, `native-refresh-cost-${label}.json`),
		JSON.stringify(report, null, 2)
	);
	console.log(JSON.stringify(report, null, 2));
	await execute(
		'window.__restoreRefreshCostGet?.(); window.__restoreRefreshCostPut?.(); window.__restoreRefreshCostCursor?.(); return true;'
	);
	app.kill();
	await Promise.race([once(app, 'exit'), delay(15_000)]);
}

main().catch((error) => {
	console.error(error);
	try {
		app?.kill();
	} catch {
		/* already gone */
	}
	process.exitCode = 1;
});

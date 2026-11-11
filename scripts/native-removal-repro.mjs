// Focused native disk-removal reproduction.
//
// Run against a native-smoke build:
//   dbus-run-session -- xvfb-run -a node scripts/native-removal-repro.mjs
//
// The script imports a small project, reloads, deletes a clean note, a second
// note and a binary asset outside DeckMark, then refreshes twice. It records
// whether the missing review exists, whether the local rows and bytes remain,
// and whether the stored manifest still holds the deleted paths.
// The same file runs against the pre-fix and post-fix binaries.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const binary = resolve(process.env.NATIVE_BINARY ?? 'src-tauri/target/debug/deckmark');
const label = process.env.NATIVE_REMOVAL_LABEL ?? 'removal';
const outputDirectory = resolve(
	process.env.NATIVE_REMOVAL_OUT ?? 'native-test-results/removal-repro'
);
const port = Number(process.env.TAURI_WEBDRIVER_PORT ?? 4469);
const endpoint = `http://127.0.0.1:${port}`;
const temp = mkdtempSync(join(tmpdir(), 'mdsh-removal-'));
const home = join(temp, 'home');
const projectRoot = join(temp, 'project');
const registry = join(temp, 'project-roots.json');
const log = join(outputDirectory, `application-${label}.log`);
mkdirSync(home, { recursive: true });
mkdirSync(join(projectRoot, 'notes'), { recursive: true });
mkdirSync(join(projectRoot, 'images'), { recursive: true });
mkdirSync(outputDirectory, { recursive: true });
writeFileSync(join(projectRoot, 'notes', 'clean.md'), '# Clean note\n');
writeFileSync(join(projectRoot, 'notes', 'dirty.md'), '# Dirty note\n');
writeFileSync(join(projectRoot, 'images', 'logo.png'), Buffer.from([137, 80, 78, 71, 7]));
const binaryBytes = readFileSync(binary);
assert.ok(
	binaryBytes.includes(Buffer.from('[mdsh-native-startup]')),
	'Build with --features native-smoke before running this script'
);
const binarySha256 = createHash('sha256').update(binaryBytes).digest('hex');
const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const dataStoreId = randomBytes(16).toString('hex');
const logDescriptor = await import('node:fs').then(({ openSync }) => openSync(log, 'a'));
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
	app = spawn(binary, [], { stdio: ['ignore', logDescriptor, logDescriptor], env: environment() });
}

async function request(path, body, method = 'POST') {
	const response = await fetch(`${endpoint}${path}`, {
		method,
		headers: { 'content-type': 'application/json' },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		signal: AbortSignal.timeout(180_000)
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
	await request(`/session/${session}/timeouts`, { script: 120_000 });
	await until(
		() =>
			execute(
				'return document.querySelector(".mdsh-shell")?.getAttribute("aria-busy") === "false" && !document.querySelector(".mdsh-shell")?.hasAttribute("inert");'
			),
		'application ready',
		120_000
	);
}

async function reloadPage() {
	await execute('window.__mdshBeforeReload = true;');
	const timeouts = await request(`/session/${session}/timeouts`, undefined, 'GET');
	await request(`/session/${session}/timeouts`, { script: 5_000 });
	await request(`/session/${session}/refresh`, {}).catch((error) => {
		if (!['script timeout', 'javascript error'].includes(error.webdriverError)) throw error;
	});
	await until(
		() =>
			execute(
				'return window.__mdshBeforeReload !== true && document.querySelector(".mdsh-shell")?.getAttribute("aria-busy") === "false" && !document.querySelector(".mdsh-shell")?.hasAttribute("inert");'
			),
		'reload ready',
		180_000
	);
	await request(`/session/${session}/timeouts`, { script: timeouts.script });
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
		180_000
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
		120_000
	);
}

const readState = () =>
	executeAsync(
		`const done = arguments[arguments.length - 1];
		const request = indexedDB.open('mdsh');
		request.onerror = () => done({ error: String(request.error) });
		request.onsuccess = () => {
		  const db = request.result;
		  const transaction = db.transaction(['projects', 'drafts', 'projectAssets', 'metadata']);
		  const projects = transaction.objectStore('projects').getAll();
		  const drafts = transaction.objectStore('drafts').getAll();
		  const assets = transaction.objectStore('projectAssets').getAll();
		  const metadata = transaction.objectStore('metadata').getAll();
		  transaction.oncomplete = () => {
		    db.close();
		    const project = projects.result.find((row) => row.nativeRootId);
		    const missingRow = metadata.result.find((row) => row.key.startsWith('project-native-missing:'));
		    const manifestRow = metadata.result.find((row) => row.key.startsWith('project-native-manifest:'));
		    const missing = missingRow ? JSON.parse(missingRow.value) : [];
		    const manifest = manifestRow ? JSON.parse(manifestRow.value) : [];
		    done({
		      projectId: project?.id ?? null,
		      missingKey: !!missingRow,
		      missingEntries: missing.map((entry) => entry.path ?? entry.relativePath),
		      manifestPaths: manifest.map((entry) => entry.relativePath),
		      localDocuments: drafts.result.filter((row) => row.projectId === project?.id)
		        .map((row) => row.relativePath).sort(),
		      localAssets: assets.result.filter((row) => row.projectId === project?.id)
		        .map((row) => ({ path: row.path, bytes: [...new Uint8Array(row.data)] }))
		    });
		  };
		  transaction.onerror = () => done({ error: String(transaction.error) });
		};`
	);

const missingUiPaths = () =>
	execute(
		`const section = document.querySelector('[data-native-project-missing]');
		if (!section) return [];
		return [...section.querySelectorAll('[data-native-missing-path]')]
		  .map((node) => node.getAttribute('data-native-missing-path'))
		  .sort();`
	);

async function main() {
	launch();
	await connect();
	await openProjectsPanel();
	await clickLabel(['Ouvrir un dossier du disque', 'Open a disk folder']);
	await waitForDocument('notes/clean.md');
	await waitForIdle();
	await reloadPage();
	await openProjectsPanel();
	await waitForDocument('notes/clean.md');
	await waitForIdle();

	rmSync(join(projectRoot, 'notes', 'clean.md'));
	rmSync(join(projectRoot, 'notes', 'dirty.md'));
	rmSync(join(projectRoot, 'images', 'logo.png'));
	await clickLabel(['Actualiser depuis le disque', 'Refresh from disk']);
	await waitForIdle(100);
	const first = await readState();
	const firstUi = await missingUiPaths();
	await clickLabel(['Actualiser depuis le disque', 'Refresh from disk']);
	await waitForIdle(100);
	const second = await readState();
	const secondUi = await missingUiPaths();

	const report = {
		label,
		source,
		binarySha256,
		platform: process.platform,
		expectedRemoved: ['images/logo.png', 'notes/clean.md', 'notes/dirty.md'],
		first: { ...first, missingUiPaths: firstUi },
		second: { ...second, missingUiPaths: secondUi },
		checkedAt: new Date().toISOString()
	};
	writeFileSync(
		join(outputDirectory, `native-removal-${label}.json`),
		JSON.stringify(report, null, 2)
	);
	console.log(JSON.stringify(report, null, 2));
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

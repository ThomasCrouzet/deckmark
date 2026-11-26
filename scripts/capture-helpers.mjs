/** Shared setup for real browser captures. Build the app before use. */
import { chromium, expect } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { testSource } from './test-source.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const VIEWPORT = { width: 1280, height: 800 };
export const FIXED_TIME = '2026-09-24T10:00:00.000Z';

export const IDEAS = {
	name: 'Ideas',
	content: `# Ideas

- Write and save a local draft.
- Link related documents.
- Export a PDF when the document is ready.

See [[Field notes]] and [[Diagrams]].
`
};

export const DIAGRAMS = {
	name: 'Diagrams',
	content: `# Diagrams

A short path from draft to document.

\`\`\`mermaid
flowchart LR
  A[Write] --> B[Save locally]
  B --> C[Export]
\`\`\`

Back to [[Field notes]].
`
};

export const FIELD_NOTES = {
	name: 'Field notes',
	content: `# Field notes

Write **Markdown**. Keep your drafts on this device.

See [[Ideas]] and [[Diagrams]].

## Math and code

Euler's identity: $e^{i\\pi} + 1 = 0$

\`\`\`ts
const note = { title: 'Field notes', local: true };
\`\`\`

## Next steps

- [x] Write and save a draft
- [x] Link related documents
- [ ] Export a PDF
`
};

export function runTool(command, args) {
	const result = spawnSync(command, args, {
		cwd: ROOT,
		encoding: 'utf8',
		timeout: 120_000,
		maxBuffer: 8 * 1024 * 1024
	});
	if (result.error || result.status !== 0) {
		throw new Error(`${command} failed: ${result.error?.message ?? result.stderr}`);
	}
	return result.stdout.trim();
}

export async function fileEvidence(path) {
	const data = await readFile(path);
	return { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
}

export function probeMedia(path) {
	return JSON.parse(
		runTool('ffprobe', [
			'-v',
			'error',
			'-select_streams',
			'v:0',
			'-show_entries',
			'stream=codec_name,width,height:format=duration,size',
			'-of',
			'json',
			path
		])
	);
}

async function requireFreePort(port) {
	const probe = createServer();
	await new Promise((resolve, reject) => {
		probe.once('error', reject);
		probe.listen(port, '127.0.0.1', () => probe.close(resolve));
	});
}

async function stopPreview(child) {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	await new Promise((resolve) => {
		const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
		timer.unref();
		child.once('close', () => {
			clearTimeout(timer);
			resolve();
		});
		child.kill('SIGTERM');
	});
}

/** Keep evidence on success and failure. Each run owns its browser and server. */
export async function withCapture(name, defaultPort, scenario) {
	const port = Number(process.env.CAPTURE_PORT ?? defaultPort);
	if (!Number.isInteger(port) || port < 1024 || port > 65535) {
		throw new Error('CAPTURE_PORT must be an integer from 1024 to 65535.');
	}
	const basePath = (process.env.BASE_PATH ?? '').replace(/\/$/, '');
	if (basePath && !/^\/[\w/-]+$/.test(basePath)) throw new Error('BASE_PATH is invalid.');
	const baseURL = `http://127.0.0.1:${port}${basePath}/`;
	const build = {
		index: await fileEvidence(join(ROOT, 'build', 'index.html')),
		serviceWorker: await fileEvidence(join(ROOT, 'build', 'sw.js')),
		logoDark: await fileEvidence(join(ROOT, 'build', 'brand', 'logo-dark.svg')),
		logoLight: await fileEvidence(join(ROOT, 'build', 'brand', 'logo-light.svg'))
	};
	const ffmpegVersion = runTool('ffmpeg', ['-version']).split('\n')[0];
	runTool('ffprobe', ['-version']);
	await requireFreePort(port);
	await mkdir(join(ROOT, 'test-results'), { recursive: true });
	const evidenceDir = await mkdtemp(join(ROOT, 'test-results', `capture-${name}-`));
	const metadata = {
		status: 'running',
		command: `node scripts/capture-${name === 'demo' ? 'demo-gif' : 'screenshots'}.mjs`,
		startedAt: new Date().toISOString(),
		baseURL,
		build,
		revision: runTool('git', ['rev-parse', 'HEAD']),
		workingTree: runTool('git', ['status', '--short']),
		sourceIdentity: testSource(),
		node: process.version,
		platform: `${process.platform}/${process.arch}`,
		ffmpegVersion,
		viewport: VIEWPORT,
		deviceScaleFactor: 2,
		locale: 'en-US',
		timezoneId: 'UTC',
		clockStartTime: FIXED_TIME,
		pageErrors: [],
		httpErrors: []
	};
	let browser;
	let preview;
	let spawnError;
	let interrupted = false;
	let previewLog = '';
	const onSignal = (code) => {
		interrupted = true;
		process.exitCode = code;
		preview?.kill('SIGTERM');
		void browser?.close().catch(() => {});
	};
	const onInterrupt = () => onSignal(130);
	const onTerminate = () => onSignal(143);
	process.once('SIGINT', onInterrupt);
	process.once('SIGTERM', onTerminate);
	try {
		preview = spawn(
			process.execPath,
			[
				join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
				'preview',
				'--outDir',
				'build',
				'--host',
				'127.0.0.1',
				'--port',
				String(port),
				'--strictPort'
			],
			{ cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }
		);
		preview.on('error', (error) => (spawnError = error));
		preview.stdout.on('data', (chunk) => (previewLog += chunk));
		preview.stderr.on('data', (chunk) => (previewLog += chunk));
		const deadline = Date.now() + 60_000;
		for (;;) {
			if (interrupted) throw new Error('Capture interrupted.');
			if (spawnError) throw spawnError;
			if (preview.exitCode !== null || preview.signalCode !== null) {
				throw new Error(`Preview stopped before capture.\n${previewLog}`);
			}
			try {
				const response = await fetch(baseURL, { signal: AbortSignal.timeout(2000) });
				await response.body?.cancel();
				if (response.ok) break;
			} catch {
				// Wait for the local preview server to accept connections.
			}
			if (Date.now() > deadline) throw new Error(`Preview did not start.\n${previewLog}`);
			await delay(200);
		}
		browser = await chromium.launch();
		if (interrupted) throw new Error('Capture interrupted.');
		metadata.browser = browser.version();
		console.log(`[capture] Evidence: ${evidenceDir}`);
		metadata.result = await scenario({ browser, baseURL, evidenceDir, metadata });
		if (interrupted) throw new Error('Capture interrupted.');
		expect(metadata.pageErrors, 'The app must not report a page error.').toEqual([]);
		expect(metadata.httpErrors, 'All local assets must load.').toEqual([]);
		metadata.status = 'passed';
	} catch (error) {
		metadata.status = 'failed';
		metadata.error = String(error.stack ?? error);
		let index = 0;
		for (const context of browser?.contexts() ?? []) {
			for (const page of context.pages()) {
				await page
					.screenshot({ path: join(evidenceDir, `failure-${index++}.png`), timeout: 3000 })
					.catch(() => {});
			}
		}
		throw error;
	} finally {
		try {
			await browser?.close();
		} finally {
			await stopPreview(preview);
			process.removeListener('SIGINT', onInterrupt);
			process.removeListener('SIGTERM', onTerminate);
			metadata.finishedAt = new Date().toISOString();
			await writeFile(join(evidenceDir, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n');
			await writeFile(join(evidenceDir, 'preview.log'), previewLog);
		}
	}
}

/**
 * Interface fonts for README captures. The app uses the system font stack, so a
 * Linux capture host would show DejaVu. Inter and JetBrains Mono stand in for
 * the macOS system fonts (Debian: fonts-inter, fonts-jetbrains-mono); a host
 * without them falls back to the app's own stack. Slides use Inter in place of
 * DIN Alternate and Bahnschrift.
 */
export const CAPTURE_FONTS_CSS =
	":root { --font-sans: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif;" +
	" --font-prose: 'Inter', -apple-system, 'SF Pro Text', 'Segoe UI', sans-serif;" +
	" --font-mono: 'JetBrains Mono NL', ui-monospace, 'SF Mono', Menlo, monospace; }" +
	" .mdsh-slide { font-family: 'Inter', 'DIN Alternate', Bahnschrift, sans-serif !important; }";

/** Reset on a neutral route so the app cannot keep an IndexedDB connection open. */
export async function newCapturePage(
	session,
	theme = 'dark',
	{ deviceScaleFactor = 2, interfaceFonts = false } = {}
) {
	const context = await session.browser.newContext({
		viewport: VIEWPORT,
		deviceScaleFactor,
		locale: 'en-US',
		timezoneId: 'UTC',
		colorScheme: theme,
		reducedMotion: 'reduce',
		serviceWorkers: 'allow'
	});
	if (interfaceFonts) {
		// Every document and frame gets the font rules, so reloads keep them.
		await context.addInitScript((css) => {
			const add = () => {
				const style = document.createElement('style');
				style.dataset.captureFonts = '';
				style.textContent = css;
				document.head.appendChild(style);
			};
			if (document.head) add();
			else document.addEventListener('DOMContentLoaded', add, { once: true });
		}, CAPTURE_FONTS_CSS);
	}
	const page = await context.newPage();
	page.setDefaultTimeout(15_000);
	page.setDefaultNavigationTimeout(30_000);
	page.on('pageerror', (error) => {
		const detail = error.stack ?? error.message;
		session.metadata.pageErrors.push(detail);
		console.error(`[capture] Page error at ${page.url()}:\n${detail}`);
	});
	page.on('response', (response) => {
		if (response.status() >= 400 && response.url().startsWith(new URL(session.baseURL).origin)) {
			session.metadata.httpErrors.push({ url: response.url(), status: response.status() });
		}
	});
	// Start at a known time. Date must advance for editor debounce functions.
	await page.clock.install({ time: new Date(FIXED_TIME) });
	const resetURL = new URL('/api/__mdsh_capture_reset__', session.baseURL).href;
	await page.route(resetURL, (route) =>
		route.fulfill({
			contentType: 'text/html',
			body: '<!doctype html><html lang="en"><title>Reset capture</title><body></body></html>'
		})
	);
	try {
		await page.goto(resetURL);
		await page.evaluate(async (theme) => {
			if (typeof indexedDB === 'undefined' || typeof localStorage === 'undefined') {
				throw new Error('Browser storage is not available.');
			}
			await Promise.all(
				['mdsh', 'mdsh-fs'].map(
					(name) =>
						new Promise((resolve, reject) => {
							const request = indexedDB.deleteDatabase(name);
							request.onsuccess = () => resolve();
							request.onerror = () => reject(request.error);
							request.onblocked = () => reject(new Error(`Database reset blocked: ${name}`));
						})
				)
			);
			localStorage.clear();
			localStorage.setItem('mdsh:locale', 'en');
			localStorage.setItem('mdsh:theme', theme);
			localStorage.setItem('mdsh:mode', 'source');
		}, theme);
	} finally {
		await page.unroute(resetURL);
	}
	await page.goto(session.baseURL);
	await expect(page.locator('.mdsh-shell[aria-busy="false"]:not([inert])')).toBeVisible();
	await expect(page.locator('html')).toHaveAttribute('lang', 'en');
	await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
	await expect(page.getByTestId('welcome-new')).toBeVisible();
	await expect(
		page.locator('#welcome-title').getByRole('img', { name: 'DeckMark', exact: true })
	).toBeVisible();
	await expect(page.locator(`#welcome-title .brand-logo-${theme}`)).toBeVisible();
	await expect(page.locator('.mdsh-local-indicator')).toHaveText('Ready offline', {
		timeout: 60_000
	});
	// Let the real offline notification close before the first capture.
	await expect(page.getByRole('button', { name: 'Close notification', exact: true })).toHaveCount(
		0,
		{ timeout: 15_000 }
	);
	return page;
}

export async function readDrafts(page) {
	return page.evaluate(
		() =>
			new Promise((resolve, reject) => {
				if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB is unavailable.'));
				const request = indexedDB.open('mdsh');
				request.onupgradeneeded = () => request.transaction.abort();
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					if (!database.objectStoreNames.contains('drafts')) {
						database.close();
						return reject(new Error('The draft table is missing.'));
					}
					const transaction = database.transaction('drafts', 'readonly');
					const rows = transaction.objectStore('drafts').getAll();
					transaction.oncomplete = () => {
						database.close();
						resolve(rows.result);
					};
					transaction.onabort = () => {
						database.close();
						reject(transaction.error);
					};
				};
			})
	);
}

export async function waitForSaved(page, name, content) {
	await expect
		.poll(
			async () => (await readDrafts(page)).find((row) => row.name === `${name}.md`)?.content.trim(),
			{
				timeout: 15_000,
				message: `Wait for the normal 400 ms save: ${name}`
			}
		)
		.toBe(content.trim());
	await expect(page.locator('#app-statusbar')).toContainText('Local drafts:');
}

export async function ensureMode(page, mode) {
	const button = page.locator(`button[data-mode="${mode}"]`);
	await button.click();
	await expect(button).toHaveAttribute('aria-checked', 'true');
	const selector = {
		source: '.cm-content',
		wysiwyg: '.milkdown .ProseMirror',
		read: '.mdsh-preview'
	};
	await expect(page.locator(selector[mode])).toBeVisible({ timeout: 20_000 });
}

export async function createDocument(page, name) {
	if (await page.getByTestId('welcome-new').isVisible()) {
		await page.getByTestId('welcome-new').click();
	} else {
		await page
			.locator('aside')
			.getByRole('button', { name: /^New file, shortcut / })
			.click();
	}
	await page.getByTestId('create-note').click();
	const input = page.locator('#app-toolbar input[aria-label^="File name"]');
	await input.fill(name);
	await input.press('Enter');
	await expect(input).toBeEnabled();
	await expect(input).toHaveValue(name);
	await expect
		.poll(async () => (await readDrafts(page)).some((row) => row.name === `${name}.md`))
		.toBe(true);
	await expect(input).not.toHaveClass(/border-accent/);
}

export async function writeSource(page, name, content) {
	await ensureMode(page, 'source');
	await page.locator('.cm-content').click();
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.insertText(content);
	await waitForSaved(page, name, content);
}

export async function seedDocuments(page, documents) {
	for (const { name, content } of documents) {
		await createDocument(page, name);
		await writeSource(page, name, content);
	}
}

export async function openPalette(page) {
	await page.getByRole('button', { name: 'Command palette', exact: true }).click();
	const palette = page.getByRole('dialog', { name: 'Command palette', exact: true });
	await expect(palette.getByRole('combobox')).toBeFocused();
	await expect(palette.getByRole('option').first()).toBeVisible();
	return palette;
}

/** Capture only the real viewport. Hide the caret for stable images. */
export async function saveScreenshot(page, path) {
	await expect(page.getByRole('alert')).toHaveCount(0);
	await page.mouse.move(0, 0);
	await page.evaluate(async () => {
		await document.fonts.ready;
		// Editor controls can contain empty, hidden image placeholders.
		const images = Array.from(document.images).filter(
			(image) => image.currentSrc && image.getClientRects().length > 0
		);
		await Promise.all(
			images.map(async (image) => {
				try {
					await image.decode();
				} catch {
					throw new Error(`Visible image failed to decode: ${image.currentSrc}`);
				}
			})
		);
		await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
	});
	await page.screenshot({
		path,
		fullPage: false,
		animations: 'disabled',
		caret: 'hide',
		style: '.cm-cursor, .cm-cursor-primary { visibility: hidden !important; }'
	});
}

/** The fixture is an ordinary Markdown deck with editable text and shapes. */
export function launchDeck() {
	let nextId = 0;
	const element = (type, x, y, width, height, options = {}) => ({
		id: `orbit-element-${++nextId}`,
		type,
		x,
		y,
		width,
		height,
		rotation: 0,
		fill: 'transparent',
		stroke: 'none',
		strokeWidth: 0,
		color: '#142e38',
		fontSize: 28,
		textAlign: 'left',
		content: '',
		...options
	});
	const text = (x, y, width, height, content, fontSize = 28, options = {}) =>
		element('text', x, y, width, height, { content, fontSize, ...options });
	const shape = (type, x, y, width, height, fill, options = {}) =>
		element(type, x, y, width, height, { fill, ...options });
	const footer = (number) => [
		shape('rectangle', 72, 642, 1136, 2, '#c9d2cc'),
		text(72, 658, 700, 44, 'ORBIT / LAUNCH BRIEFING', 17),
		text(1130, 658, 78, 44, `0${number}`, 17, { textAlign: 'right' })
	];
	const slides = [
		{
			id: 'orbit-cover',
			background: '#f8f5ed',
			notes: 'Introduce Orbit. A small launch with a clear plan.',
			elements: [
				text(72, 66, 650, 44, 'A SMALL IDEA. A NEW DIRECTION.', 20),
				text(64, 182, 740, 164, '**ORBIT**', 112),
				text(72, 350, 660, 132, 'From field notes  \nto launch day.', 40),
				shape('rounded-rectangle', 80, 514, 350, 56, '#f77542'),
				text(92, 518, 330, 48, '**READY FOR LAUNCH**', 20),
				shape('ellipse', 832, 168, 300, 300, 'transparent', {
					stroke: '#b7c7c0',
					strokeWidth: 2
				}),
				shape('ellipse', 784, 120, 396, 396, 'transparent', {
					stroke: '#b7c7c0',
					strokeWidth: 2
				}),
				shape('ellipse', 894, 230, 176, 176, '#142e38'),
				shape('ellipse', 1082, 202, 68, 68, '#f77542'),
				shape('ellipse', 810, 436, 34, 34, '#448c7b'),
				...footer(1)
			]
		},
		{
			id: 'orbit-plan',
			background: '#f8f5ed',
			notes: 'Show the path from connected notes to a checked project and a shared briefing.',
			elements: [
				text(72, 64, 900, 48, 'THE FLIGHT PLAN', 20),
				text(68, 134, 1120, 112, '**A clear path from idea to launch.**', 51),
				...[
					['01', 'CONNECT', 'Link the notes.  \nKeep the context.', '#e3ece5'],
					['02', 'CHECK', 'Review the project.  \nExport a copy.', '#f7e4d8'],
					['03', 'PRESENT', 'Build the briefing.  \nTell the story.', '#dfebee']
				].flatMap(([number, title, description, fill], index) => {
					const x = 80 + index * 382;
					return [
						shape('rounded-rectangle', x, 296, 354, 282, fill),
						text(x + 24, 312, 300, 80, number, 40),
						text(x + 24, 400, 300, 64, `**${title}**`, 27),
						text(x + 24, 474, 306, 84, description, 25)
					];
				}),
				...footer(2)
			]
		},
		{
			id: 'orbit-ready',
			background: '#e3ece5',
			notes: 'The notes, project, and briefing are ready. Invite the team to launch.',
			elements: [
				text(72, 64, 760, 44, 'THE NEXT CHAPTER STARTS HERE.', 20),
				text(68, 176, 780, 244, '**Ready for  \nwhat is next.**', 72),
				text(76, 470, 670, 100, 'Notes connected. Project checked.  \nLet us launch.', 29),
				shape('ellipse', 858, 214, 298, 298, '#f77542'),
				text(874, 286, 266, 150, '**GO**', 94, { textAlign: 'center' }),
				...footer(3)
			]
		}
	];
	const body = slides
		.map(
			(slide) =>
				`<!-- mdsh-slide:${slide.id} -->\n\n` +
				slide.elements
					.filter((item) => item.type === 'text')
					.map((item) => `<!-- mdsh-element:${item.id} -->\n${item.content}\n`)
					.join('\n')
		)
		.join('\n---\n\n');
	return `${body}\n\n<!-- mdsh-presentation\n${JSON.stringify({
		version: 1,
		width: 1280,
		height: 720,
		theme: 'default',
		slides: slides.map((slide) => ({
			...slide,
			elements: slide.elements.map((item) => ({ ...item, content: '' }))
		}))
	})}\n-->\n`;
}

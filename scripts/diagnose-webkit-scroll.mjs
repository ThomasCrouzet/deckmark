// Temporary local diagnostic. It is not a gate or a committed test.
import { createServer } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { webkit } from '@playwright/test';
import { largeNote, libraryRows, projectRows } from './benchmark-fixtures/corpus.mjs';

const projectRoot = resolve(import.meta.dirname, '..');
const contentTypes = {
	'.css': 'text/css; charset=utf-8',
	'.html': 'text/html; charset=utf-8',
	'.js': 'application/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.png': 'image/png',
	'.svg': 'image/svg+xml',
	'.webmanifest': 'application/manifest+json',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2'
};
const port = Number(process.env.DIAG_PORT ?? 4210);
const output = process.argv[2];
const cycles = Number(process.argv[3] ?? 5);
if (!output || !isAbsolute(output)) throw new Error('Pass an absolute output path.');

const large = largeNote();
const library = libraryRows();
const project = projectRows();

async function startServer() {
	const buildRoot = resolve(projectRoot, 'build');
	const indexHtml = await readFile(resolve(buildRoot, 'index.html'));
	const html = indexHtml.toString('utf8');
	const manifestHref = html.match(/href="([^"]*manifest\.webmanifest)"/)?.[1] ?? '';
	const basePath = manifestHref.startsWith('/')
		? manifestHref.slice(0, manifestHref.lastIndexOf('/'))
		: '';
	const server = createServer(async (request, response) => {
		try {
			const url = new URL(request.url ?? '/', 'http://127.0.0.1');
			let relativePath = url.pathname.slice(basePath.length).replace(/^\/+/, '');
			if (!relativePath) relativePath = 'index.html';
			let path = resolve(buildRoot, decodeURIComponent(relativePath));
			const fromBuild = relative(buildRoot, path);
			if (!fromBuild || fromBuild.startsWith(`..${sep}`) || isAbsolute(fromBuild))
				throw new Error('outside build');
			try {
				if (!(await stat(path)).isFile()) throw new Error('not a file');
			} catch {
				path = resolve(buildRoot, 'index.html');
			}
			response.writeHead(200, {
				'Cache-Control': 'no-store',
				'Content-Type': contentTypes[extname(path)] ?? 'application/octet-stream'
			});
			response.end(path.endsWith('index.html') ? indexHtml : await readFile(path));
		} catch (error) {
			response.writeHead(500);
			response.end(String(error));
		}
	});
	await new Promise((done, reject) => {
		server.once('error', reject);
		server.listen(port, '127.0.0.1', done);
	});
	return { server, url: `http://127.0.0.1:${port}${basePath}/` };
}

async function seed(page) {
	const rows = [
		{
			id: 'bench-large',
			name: 'bench-large.md',
			content: large,
			createdAt: 1_700_000_000_000,
			updatedAt: 1_700_000_000_000,
			order: -1,
			open: true
		},
		...library,
		...project.documents
	];
	await page.evaluate(
		async ({ rows, project }) => {
			await new Promise((done, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const names = [...database.objectStoreNames];
					const stores = ['drafts', ...(names.includes('projects') ? ['projects'] : [])];
					const tx = database.transaction(stores, 'readwrite');
					const drafts = tx.objectStore('drafts');
					drafts.clear();
					for (const row of rows) drafts.put(row);
					if (names.includes('projects')) {
						const projects = tx.objectStore('projects');
						projects.clear();
						projects.put(project);
					}
					tx.oncomplete = () => {
						database.close();
						done();
					};
					tx.onerror = () => reject(tx.error);
				};
			});
			localStorage.setItem('mdsh:activeId', 'bench-large');
			localStorage.setItem('mdsh:mode', 'source');
			localStorage.setItem('mdsh:locale', 'en');
		},
		{ rows, project: project.project }
	);
}

async function waitForShell(page) {
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor({
		state: 'visible',
		timeout: 60_000
	});
}

async function enterRead(page) {
	await page.evaluate(() => {
		document.querySelector('button[data-mode="read"]')?.click();
	});
	await page.locator('.mdsh-read .mdsh-preview').waitFor({ state: 'visible', timeout: 60_000 });
	await page.waitForFunction(
		() => (document.querySelector('.mdsh-preview')?.textContent?.length ?? 0) > 100_000,
		undefined,
		{ timeout: 60_000 }
	);
}

async function leaveRead(page) {
	await page.evaluate(() => {
		document.querySelector('button[data-mode="source"]')?.click();
	});
	await page.locator('.cm-content').first().waitFor({ state: 'visible', timeout: 30_000 });
}

async function scrollSample(page, ratio) {
	return page.evaluate(
		(ratio) =>
			new Promise((resolvePromise) => {
				const scroller = document.querySelector('.mdsh-read');
				if (!scroller) {
					resolvePromise({ supported: false, reason: 'missing-scroller' });
					return;
				}
				const room = scroller.scrollHeight - scroller.clientHeight;
				const startedAt = performance.now();
				scroller.scrollTop = Math.round(room * ratio);
				requestAnimationFrame(() => {
					const frame1At = performance.now();
					requestAnimationFrame(() => {
						const frame2At = performance.now();
						resolvePromise({
							supported: true,
							ms: frame2At - startedAt,
							frame1Ms: frame1At - startedAt,
							frame2Ms: frame2At - startedAt,
							room,
							applied: scroller.scrollTop,
							scrollHeight: scroller.scrollHeight,
							clientHeight: scroller.clientHeight,
							nodes: scroller.querySelectorAll('*').length,
							tables: scroller.querySelectorAll('table').length,
							codeBlocks: scroller.querySelectorAll('pre').length,
							images: scroller.querySelectorAll('img').length,
							visibility: document.visibilityState
						});
					});
				});
		}),
		ratio
	);
}

async function frameCadence(page) {
	return page.evaluate(
		() =>
			new Promise((resolvePromise) => {
				const startedAt = performance.now();
				requestAnimationFrame(() => {
					const frame1At = performance.now();
					requestAnimationFrame(() => {
						resolvePromise({ ms: performance.now() - startedAt, frame1Ms: frame1At - startedAt });
					});
				});
			})
	);
}

const { server, url } = await startServer();
const browser = await webkit.launch();
const context = await browser.newContext({ locale: 'en-US' });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
await page.goto(url);
await waitForShell(page);
await seed(page);
await page.reload();
await waitForShell(page);
const source = page.locator('.cm-content').first();
await source.waitFor({ state: 'visible', timeout: 30_000 });
// Preceding acceptance sequence: source typing, document switches, large open,
// large typing, then five read-mode cycles.
for (let run = 0; run < 5; run += 1) {
	await page.evaluate(
		(text) => {
			const editor = document.querySelector('.cm-content');
			if (!editor) return;
			editor.focus();
			document.execCommand('insertText', false, text);
		},
		` source${run}`
	);
}
for (let run = 0; run < 5; run += 1) {
	const id = `bench-${String((run % 6) + 1).padStart(3, '0')}`;
	await page.evaluate((target) => {
		document.querySelector(`button[data-file-id="${target}"]`)?.click();
	}, id);
	await page.waitForFunction(
		(expected) => document.querySelector('header input')?.value === expected,
		id,
		{ timeout: 30_000 }
	);
}
for (let run = 0; run < 5; run += 1) {
	await page.evaluate(() => {
		document.querySelector('button[data-file-id="bench-000"]')?.click();
	});
	await page.waitForFunction(
		() => document.querySelector('header input')?.value === 'bench-000',
		undefined,
		{ timeout: 30_000 }
	);
	await page.evaluate(() => {
		document.querySelector('button[data-file-id="bench-large"]')?.click();
	});
	await page.waitForFunction(
		() => document.querySelector('header input')?.value === 'bench-large',
		undefined,
		{ timeout: 60_000 }
	);
}
await page.evaluate(() => {
	const editor = document.querySelector('.cm-content');
	if (!editor) return;
	editor.focus();
	document.execCommand('insertText', false, ' large');
});
for (let cycle = 0; cycle < 5; cycle += 1) {
	await enterRead(page);
	await leaveRead(page);
}
await enterRead(page);
const modeState = await page.evaluate(() => ({
	activeMode: document.querySelector('button[data-mode][aria-checked="true"]')?.getAttribute('data-mode'),
	scroller: Boolean(document.querySelector('.mdsh-read')),
	previewChars: document.querySelector('.mdsh-preview')?.textContent?.length ?? 0,
	bodyNodes: document.querySelectorAll('*').length
}));
const css = process.env.DIAG_CSS ?? '';
if (css) {
	await page.addStyleTag({ content: css });
	await page.waitForTimeout(200);
}
const cadence = await frameCadence(page);
const samples = [];
for (let run = 0; run < cycles; run += 1) {
	samples.push(await scrollSample(page, ((run % 8) + 1) / 9));
}
const report = {
	schemaVersion: 1,
	generatedAt: new Date().toISOString(),
	target: 'webkit-local-diagnostic',
	url,
	engine: 'webkit',
	browserVersion: browser.version(),
	sourceRevision: process.env.SOURCE_REVISION ?? null,
	workingDiffSha256: process.env.WORKING_DIFF_SHA256 ?? null,
	fixture: {
		id: 'bench-large',
		bytes: Buffer.byteLength(large),
		libraryDocuments: library.length,
		projectDocuments: project.documents.length
	},
	modeState,
	css,
	cadence,
	cycles: samples.length,
	samples,
	summary: {
		p50: samples.map((sample) => sample.ms).sort((a, b) => a - b)[Math.floor(samples.length / 2)],
		max: Math.max(...samples.map((sample) => sample.ms))
	},
	pageErrors
};
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output, modeState, samples, summary: report.summary }, null, 2));
await browser.close();
await new Promise((done) => server.close(done));

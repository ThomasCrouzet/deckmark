// Capture a Chromium CPU profile for one document switch. The command reads
// local fixtures, writes one profile file, and sends no telemetry. Build with
// source maps first when you need readable frames:
//
//   BASE_PATH='' npx vite build --sourcemap
//   node scripts/profile-switch.mjs --output /tmp/switch.cpuprofile
import { createServer } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { chromium } from '@playwright/test';
import { largeNote, libraryRows, projectRows } from './benchmark-fixtures/corpus.mjs';

const projectRoot = resolve(import.meta.dirname, '..');
const buildRoot = join(projectRoot, 'build');
const contentTypes = {
	'.css': 'text/css; charset=utf-8',
	'.html': 'text/html; charset=utf-8',
	'.js': 'application/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.webmanifest': 'application/manifest+json',
	'.woff2': 'font/woff2'
};

function parseArguments(args) {
	const options = { fileId: 'bench-002', output: '/tmp/deckmark-switch.cpuprofile', port: 4899 };
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === '--file-id') options.fileId = args[++index] ?? options.fileId;
		else if (arg === '--output') options.output = resolve(args[++index] ?? options.output);
		else if (arg === '--port') options.port = Number(args[++index] ?? options.port);
		else throw new Error(`Unknown argument: ${arg}`);
	}
	if (!isAbsolute(options.output)) throw new Error('--output must be an absolute path.');
	return options;
}

async function startServer(port) {
	const indexHtml = await readFile(join(buildRoot, 'index.html'));
	const server = createServer(async (request, response) => {
		try {
			const url = new URL(request.url ?? '/', 'http://127.0.0.1');
			let path = resolve(buildRoot, url.pathname.replace(/^\/+/, '') || 'index.html');
			const fromBuild = relative(buildRoot, path);
			if (!fromBuild || fromBuild.startsWith(`..${sep}`) || isAbsolute(fromBuild)) {
				throw new Error('Request path is outside build/.');
			}
			try {
				if (!(await stat(path)).isFile()) throw new Error('Not a file.');
			} catch {
				path = join(buildRoot, 'index.html');
			}
			const body = path.endsWith('index.html') ? indexHtml : await readFile(path);
			response.writeHead(200, {
				'Content-Type': contentTypes[extname(path)] ?? 'application/octet-stream',
				'Cache-Control': 'no-store'
			});
			response.end(body);
		} catch {
			response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
			response.end('The profile request failed.');
		}
	});
	await new Promise((resolvePromise, reject) => {
		server.once('error', reject);
		server.listen(port, '127.0.0.1', resolvePromise);
	});
	return server;
}

async function seed(page) {
	const library = libraryRows();
	const { project, documents } = projectRows();
	const rows = [
		...library,
		{
			id: 'bench-large',
			name: 'bench-large.md',
			content: largeNote(),
			createdAt: 1_700_000_000_000,
			updatedAt: 1_700_000_000_000,
			order: -1,
			open: true
		},
		...documents
	];
	await page.evaluate(
		async ({ rows: draftRows, project: projectRow }) => {
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
						projects.put(projectRow);
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
		{ rows, project: project }
	);
}

const options = parseArguments(process.argv.slice(2));
const server = await startServer(options.port);
const browser = await chromium.launch();
const context = await browser.newContext({ locale: 'en-US' });
const page = await context.newPage();
try {
	await page.goto(`http://127.0.0.1:${options.port}/`);
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor({ state: 'visible' });
	await seed(page);
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor({ state: 'visible' });
	await page.locator('.cm-content').first().waitFor({ state: 'visible', timeout: 30_000 });
	await page.waitForTimeout(1_000);
	const session = await context.newCDPSession(page);
	await session.send('Profiler.enable');
	await session.send('Profiler.setSamplingInterval', { interval: 100 });
	await session.send('Profiler.start');
	await page.evaluate(
		(id) => document.querySelector(`button[data-file-id="${id}"]`)?.click(),
		options.fileId
	);
	await page.waitForFunction(
		(id) => document.querySelector('header input')?.value === id,
		options.fileId,
		{ timeout: 30_000 }
	);
	const { profile } = await session.send('Profiler.stop');
	await mkdir(dirname(options.output), { recursive: true });
	await writeFile(options.output, `${JSON.stringify(profile)}\n`, 'utf8');
	console.log(
		`Wrote ${profile.samples.length} samples from the switch to ${options.fileId} in ${options.output}.`
	);
} finally {
	await browser.close();
	server.closeAllConnections();
	server.close();
}

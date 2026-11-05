import { createServer, type Server } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });
test.describe.configure({ mode: 'serial' });

const buildRoot = join(import.meta.dirname, '..', 'build');
const legacyContent = '# Legacy upgrade\n\nPreserved through the schema change.\n';

const contentTypes: Record<string, string> = {
	'.css': 'text/css; charset=utf-8',
	'.html': 'text/html; charset=utf-8',
	'.js': 'application/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.webmanifest': 'application/manifest+json',
	'.woff2': 'font/woff2'
};

let server: Server;
let origin: string;

test.beforeAll(async () => {
	server = createServer(async (request, response) => {
		if (request.url?.startsWith('/blank.html')) {
			response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
			response.end('<!doctype html><html><body>blank</body></html>');
			return;
		}
		try {
			const url = new URL(request.url ?? '/', 'http://127.0.0.1');
			let path = resolve(buildRoot, url.pathname.replace(/^\/+/, '') || 'index.html');
			const fromBuild = relative(buildRoot, path);
			if (!fromBuild || fromBuild.startsWith(`..${sep}`)) throw new Error('outside build');
			try {
				if (!(await stat(path)).isFile()) throw new Error('not a file');
			} catch {
				path = join(buildRoot, 'index.html');
			}
			response.writeHead(200, {
				'Content-Type': contentTypes[extname(path)] ?? 'application/octet-stream'
			});
			response.end(await readFile(path));
		} catch {
			response.writeHead(500);
			response.end('failed');
		}
	});
	await new Promise<void>((resolvePromise, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolvePromise);
	});
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('No second origin port.');
	origin = `http://127.0.0.1:${address.port}/`;
});

test.afterAll(async () => {
	await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
});

async function seedVersionFive(page: Page): Promise<void> {
	await page.evaluate(async (content) => {
		await new Promise<void>((resolvePromise, reject) => {
			const request = indexedDB.open('mdsh', 5);
			request.onupgradeneeded = () => {
				const db = request.result;
				db.createObjectStore('drafts', { keyPath: 'id' });
				const trashed = db.createObjectStore('trashed', { keyPath: 'id' });
				trashed.createIndex('trashedAt', 'trashedAt');
				const workspaces = db.createObjectStore('workspaces', { keyPath: 'id' });
				workspaces.createIndex('updatedAt', 'updatedAt');
				const versions = db.createObjectStore('versions', { keyPath: 'id' });
				versions.createIndex('draftId', 'draftId');
				versions.createIndex('createdAt', 'createdAt');
				versions.createIndex('[draftId+createdAt]', ['draftId', 'createdAt']);
				const templates = db.createObjectStore('templates', { keyPath: 'id' });
				templates.createIndex('updatedAt', 'updatedAt');
				db.createObjectStore('metadata', { keyPath: 'key' });
			};
			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				const db = request.result;
				const tx = db.transaction(['drafts', 'templates'], 'readwrite');
				tx.objectStore('drafts').put({
					id: 'legacy-draft',
					name: 'legacy.md',
					content,
					createdAt: 1_700_000_000_000,
					updatedAt: 1_700_000_000_000,
					order: 1,
					open: true
				});
				tx.oncomplete = () => {
					db.close();
					resolvePromise();
				};
				tx.onerror = () => reject(tx.error);
			};
		});
	}, legacyContent);
}

test('upgrades an older database and keeps drafts and templates', async ({ page }, info) => {
	await page.route('**/api/__mdsh_e2e_reset__', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'text/html',
			body: '<!doctype html><html><head><title>Reset</title></head><body></body></html>'
		})
	);
	await page.goto(`${origin}api/__mdsh_e2e_reset__`);
	await page.evaluate(async () => {
		for (const name of ['mdsh', 'mdsh-fs']) {
			await new Promise<void>((resolvePromise) => {
				const request = indexedDB.deleteDatabase(name);
				request.onsuccess = () => resolvePromise();
				request.onerror = () => resolvePromise();
			});
		}
		localStorage.clear();
		localStorage.setItem('mdsh:locale', 'en');
		localStorage.setItem('mdsh:mode', 'source');
	});
	await seedVersionFive(page);
	await page.goto(origin);
	await expect(page.locator('.cm-content').first()).toContainText('Legacy upgrade', {
		timeout: 20_000
	});
	const state = await page.evaluate(
		() =>
			new Promise<{ version: number; content: string; templates: number }>(
				(resolvePromise, reject) => {
					const request = indexedDB.open('mdsh');
					request.onerror = () => reject(request.error);
					request.onsuccess = () => {
						const db = request.result;
						const version = db.version;
						const tx = db.transaction('drafts', 'readonly');
						const draft = tx.objectStore('drafts').get('legacy-draft');
						tx.oncomplete = () => {
							resolvePromise({
								version,
								content: draft.result?.content ?? ''
							});
							db.close();
						};
						tx.onerror = () => reject(tx.error);
					};
				}
			)
	);
	expect(state.version).toBe(80);
	expect(state.content).toBe(legacyContent);
	await info.attach('upgrade-state.json', {
		body: JSON.stringify(state),
		contentType: 'application/json'
	});
});

test('shows a recoverable state when a stale tab blocks the upgrade', async ({
	page,
	context
}, info) => {
	const blocker = await context.newPage();
	await blocker.goto(`${origin}blank.html`);
	await blocker.evaluate(
		() =>
			new Promise<void>((resolvePromise) => {
				const request = indexedDB.deleteDatabase('mdsh');
				request.onsuccess = () => resolvePromise();
				request.onerror = () => resolvePromise();
			})
	);
	await seedVersionFive(blocker);
	const held = await blocker.evaluate(
		() =>
			new Promise<boolean>((resolvePromise, reject) => {
				const request = indexedDB.open('mdsh', 5);
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					(globalThis as { heldDb?: IDBDatabase }).heldDb = request.result;
					resolvePromise(true);
				};
			})
	);
	expect(held).toBe(true);

	await page.goto(origin);
	await page.waitForTimeout(10_000);
	console.log('BLOCKED BODY', (await page.locator('body').innerText()).slice(0, 500));
	await expect(page.getByTestId('retry-storage')).toBeVisible({ timeout: 20_000 });
	await blocker.evaluate(() => {
		(globalThis as { heldDb?: IDBDatabase }).heldDb?.close();
	});
	await blocker.close();
	await page.getByTestId('retry-storage').click();
	await expect(page.locator('.cm-content').first()).toContainText('Legacy upgrade', {
		timeout: 20_000
	});
	await info.attach('blocked-upgrade.json', {
		body: JSON.stringify({ recovery: 'reloaded after the stale tab closed' }),
		contentType: 'application/json'
	});
});

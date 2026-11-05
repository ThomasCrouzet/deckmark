import { createServer, type Server } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { resetAppState } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

const buildRoot = join(import.meta.dirname, '..', 'build');
const sentinel = 'ORIGIN_TRANSFER_SENTINEL_6f2a';
const apiKey = 'origin_session_value_3e91';

let second: Server;
let secondOrigin: string;

const contentTypes: Record<string, string> = {
	'.css': 'text/css; charset=utf-8',
	'.html': 'text/html; charset=utf-8',
	'.js': 'application/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.webmanifest': 'application/manifest+json',
	'.woff2': 'font/woff2'
};

test.beforeAll(async () => {
	second = createServer(async (request, response) => {
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
			const body = path.endsWith('index.html') ? await readFile(path) : await readFile(path);
			response.writeHead(200, {
				'Content-Type': contentTypes[extname(path)] ?? 'application/octet-stream'
			});
			response.end(body);
		} catch {
			response.writeHead(500);
			response.end('failed');
		}
	});
	await new Promise<void>((resolvePromise, reject) => {
		second.once('error', reject);
		second.listen(0, '127.0.0.1', resolvePromise);
	});
	const address = second.address();
	if (!address || typeof address === 'string') throw new Error('No second origin port.');
	secondOrigin = `http://127.0.0.1:${address.port}/`;
});

test.afterAll(async () => {
	await new Promise<void>((resolvePromise) => second.close(() => resolvePromise()));
});

async function openEnglish(page: Page, origin?: string): Promise<void> {
	if (origin) {
		await page.goto(origin);
	} else {
		await resetAppState(page);
		await page.evaluate(() => localStorage.setItem('mdsh:locale', 'en'));
		await page.reload();
	}
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
}

async function openSettings(page: Page): Promise<void> {
	await page.keyboard.press('ControlOrMeta+Shift+p');
	await page.getByRole('combobox').fill('Settings');
	await page.keyboard.press('Enter');
	await expect(page.getByTestId('host-section')).toBeVisible();
}

test('transfers a portable backup explicitly between origins without keys', async ({
	page
}, info) => {
	await openEnglish(page);
	await page.locator('input[type="file"][accept*="text/markdown"]').setInputFiles({
		name: 'transfer.md',
		mimeType: 'text/markdown',
		buffer: Buffer.from(`# ${sentinel}\n\n${sentinel}\n`)
	});
	await expect(page.locator('.cm-content')).toContainText(sentinel);
	await page.evaluate((key) => sessionStorage.setItem('mdsh:ai-key', key), apiKey);

	await openSettings(page);
	await expect(page.getByTestId('host-identity')).toContainText(/local development/i);
	await expect(page.getByTestId('host-other')).toHaveCount(0);
	const [download] = await Promise.all([
		page.waitForEvent('download'),
		page.getByTestId('host-export').click()
	]);
	const backupPath = await download.path();
	expect(backupPath).toBeTruthy();

	await openEnglish(page, secondOrigin);
	await expect(page.locator('.mdsh-shell[aria-busy="false"]:not([inert])')).toBeVisible();
	await openSettings(page);
	await page.locator('input[type="file"][accept*="application/json"]').setInputFiles(backupPath!);
	await expect(page.getByRole('button', { name: 'Merge' })).toBeVisible();
	await page.getByRole('button', { name: 'Merge' }).click();
	await page.keyboard.press('Escape');
	await expect(page.locator('.mdsh-shell[aria-busy="false"]:not([inert])')).toBeVisible({
		timeout: 20_000
	});
	const restored = await page.evaluate(
		() =>
			new Promise<string[]>((resolvePromise, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const rows = request.result.transaction('drafts').objectStore('drafts').getAll();
					rows.onerror = () => reject(rows.error);
					rows.onsuccess = () => {
						request.result.close();
						resolvePromise(rows.result.map((row) => row.content));
					};
				};
			})
	);
	expect(restored.join('\n')).toContain(sentinel);
	const keyAfter = await page.evaluate(() => sessionStorage.getItem('mdsh:ai-key'));
	expect(keyAfter).toBeNull();

	await info.attach('cross-origin-transfer.json', {
		body: JSON.stringify({
			from: '127.0.0.1',
			to: new URL(secondOrigin).origin,
			contentPresent: true,
			apiKeyPresent: keyAfter !== null
		}),
		contentType: 'application/json'
	});
});

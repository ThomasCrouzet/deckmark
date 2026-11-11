import { execSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { test, expect, type Download, type Page } from '@playwright/test';
import { resetAppState } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

const documents: Record<string, string> = {
	'README.md': ['# Home', '', 'Everything starts here. Search token: zebracrossing.', ''].join(
		'\n'
	),
	'docs/C# guide.md': ['# C# guide', '', 'Search token: hashwombat.', ''].join('\n'),
	'docs/50% complete.md': ['# 50% complete', '', 'Search token: percentotter.', ''].join('\n'),
	'docs/Café (draft).md': ['# Café (draft)', '', 'Search token: unicodeplatypus.', ''].join('\n')
};

const queries = [
	{ token: 'hashwombat', title: 'C# guide', path: '/docs/C%23%20guide.html' },
	{ token: 'percentotter', title: '50% complete', path: '/docs/50%25%20complete.html' },
	{
		token: 'unicodeplatypus',
		title: 'Café (draft)',
		path: '/docs/Caf%C3%A9%20%28draft%29.html'
	}
] as const;

const contentTypes: Record<string, string> = {
	'.css': 'text/css; charset=utf-8',
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.txt': 'text/plain; charset=utf-8'
};

async function seedProject(page: Page): Promise<void> {
	await resetAppState(page);
	await page.evaluate(async (fixtures) => {
		await new Promise<void>((resolvePromise, reject) => {
			const request = indexedDB.open('mdsh');
			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				const database = request.result;
				const transaction = database.transaction(['drafts', 'projects'], 'readwrite');
				const drafts = transaction.objectStore('drafts');
				const projects = transaction.objectStore('projects');
				projects.put({ id: 'search-project', name: 'Search project', createdAt: 1, updatedAt: 1 });
				Object.entries(fixtures).forEach(([relativePath, content], index) => {
					drafts.put({
						id: `search-${index}`,
						name: relativePath.split('/').pop()!,
						projectId: 'search-project',
						relativePath,
						content,
						kind: 'note',
						order: index,
						open: true,
						createdAt: 1,
						updatedAt: 1
					});
				});
				transaction.oncomplete = () => {
					database.close();
					resolvePromise();
				};
				transaction.onerror = () => reject(transaction.error);
			};
		});
		localStorage.setItem('mdsh:locale', 'en');
		localStorage.setItem('mdsh:mode', 'source');
	}, documents);
	await page.reload();
}

async function extractSite(buffer: Buffer, root: string): Promise<void> {
	const JSZip = (await import('jszip')).default;
	const zip = await JSZip.loadAsync(buffer);
	for (const entry of Object.values(zip.files)) {
		if (entry.dir) continue;
		const path = join(root, entry.name);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, await entry.async('nodebuffer'));
	}
}

function serveSite(root: string): Promise<{ origin: string; server: Server }> {
	const server = createServer(async (request, response) => {
		try {
			const url = new URL(request.url ?? '/', 'http://127.0.0.1');
			const requested = decodeURIComponent(url.pathname.replace(/^\/+/, '') || 'index.html');
			const path = resolve(root, requested);
			const fromRoot = relative(root, path);
			if (!fromRoot || fromRoot.startsWith(`..${sep}`)) throw new Error('outside site');
			if (!(await stat(path)).isFile()) throw new Error('missing file');
			response.writeHead(200, {
				'Content-Type': contentTypes[extname(path).toLowerCase()] ?? 'application/octet-stream'
			});
			response.end(await readFile(path));
		} catch {
			response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
			response.end('not found');
		}
	});
	return new Promise((resolvePromise, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (!address || typeof address === 'string') {
				reject(new Error('No site server port'));
				return;
			}
			resolvePromise({ origin: `http://127.0.0.1:${address.port}/`, server });
		});
	});
}

async function navHrefs(page: Page): Promise<Record<string, string>> {
	const links = await page
		.locator('.site-nav a')
		.evaluateAll((elements) =>
			elements.map((element) => [
				element.textContent?.trim() ?? '',
				element.getAttribute('href') ?? ''
			])
		);
	return Object.fromEntries(links);
}

test('search result links match navigation for encoded page paths', async ({
	page,
	browser
}, testInfo) => {
	await seedProject(page);
	await page.getByTestId('projects-open').click();
	const projects = page.getByRole('dialog', { name: 'Markdown projects' });
	await projects.getByRole('button', { name: 'Export documentation site' }).click();
	await expect(page.getByTestId('docs-site-panel')).toBeVisible();

	const downloadPromise = page.waitForEvent('download');
	await page.getByTestId('docs-site-run').click();
	const download: Download = await downloadPromise;
	const zipPath = testInfo.outputPath('search-site.zip');
	await download.saveAs(zipPath);
	await expect(page.getByTestId('docs-site-summary')).toContainText('4 page(s)');

	const zipBuffer = await readFile(zipPath);
	const siteRoot = testInfo.outputPath('site');
	await extractSite(zipBuffer, siteRoot);
	const { origin, server } = await serveSite(siteRoot);
	const site = await browser.newPage();
	const pageErrors: string[] = [];
	site.on('pageerror', (error) => pageErrors.push(error.message));
	const observed: Array<{ query: string; nav: string; search: string; path: string }> = [];
	const nested = { href: '' };
	try {
		await site.goto(`${origin}index.html`);
		const navAtRoot = await navHrefs(site);
		for (const entry of queries) {
			await site.locator('#site-search-input').fill(entry.token);
			const results = site.locator('.site-search-results a');
			await expect(results, entry.token).toHaveCount(1);
			const result = results.first();
			const searchHref = (await result.getAttribute('href')) ?? '';
			expect(searchHref, entry.token).not.toContain('%2523');
			expect(searchHref, entry.token).not.toContain('%2525');
			expect(new URL(searchHref, site.url()).href, entry.token).toBe(
				new URL(navAtRoot[entry.title] ?? '', site.url()).href
			);
			expect(new URL(searchHref, site.url()).pathname, entry.token).toBe(entry.path);
			observed.push({
				query: entry.token,
				nav: navAtRoot[entry.title] ?? '',
				search: searchHref,
				path: entry.path
			});
			await result.click();
			expect(new URL(site.url()).pathname).toBe(entry.path);
			await expect(site.locator('.site-page-header h1')).toHaveText(entry.title);
			await site.goto(`${origin}index.html`);
		}

		await site.goto(`${origin}docs/C%23%20guide.html`);
		await expect(site.locator('.site-page-header h1')).toHaveText('C# guide');
		const navAtNested = await navHrefs(site);
		await site.locator('#site-search-input').fill('percentotter');
		const nestedResults = site.locator('.site-search-results a');
		await expect(nestedResults).toHaveCount(1);
		const nestedResult = nestedResults.first();
		nested.href = (await nestedResult.getAttribute('href')) ?? '';
		expect(new URL(nested.href, site.url()).href).toBe(
			new URL(navAtNested['50% complete'] ?? '', site.url()).href
		);
		expect(new URL(nested.href, site.url()).pathname).toBe('/docs/50%25%20complete.html');
		await nestedResult.click();
		expect(new URL(site.url()).pathname).toBe('/docs/50%25%20complete.html');
		await expect(site.locator('.site-page-header h1')).toHaveText('50% complete');
		expect(pageErrors).toEqual([]);
	} finally {
		await site.close();
		await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
	}

	const artifactPath = testInfo.outputPath('docs-site-search-paths.json');
	await writeFile(
		artifactPath,
		`${JSON.stringify(
			{
				command:
					'E2E_PORT=4186 npx playwright test e2e/docs-site-search-paths.spec.ts --workers=1 --retries=0 --reporter=line',
				revision: execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim(),
				environment: { node: process.version, browser: browser.browserType().name() },
				fixtures: Object.keys(documents),
				result: { observed, nestedHref: nested.href, pageErrors }
			},
			null,
			2
		)}\n`,
		'utf8'
	);
	await testInfo.attach('docs-site-search-paths.json', {
		path: artifactPath,
		contentType: 'application/json'
	});
	await testInfo.attach('search-site.zip', { path: zipPath, contentType: 'application/zip' });
});

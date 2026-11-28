import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { test, expect, type Download, type Page } from '@playwright/test';
import { resetAppState } from './helpers';

// Risk (review finding SEC-01): the documentation site export published
// imported XML, XSLT and SVGZ files unchanged. A static host serves these as
// active documents, so their script runs on the publishing origin. The export
// must publish only an allowlist of inert file types and rename every other
// file with a `.txt` suffix. The payloads come from the review probe.

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

const XML = `<?xml version="1.0"?>
<root xmlns:h="http://www.w3.org/1999/xhtml"><h:script>fetch('/hit?p=' + encodeURIComponent(location.pathname))</h:script></root>
`;
const XSL_DOCUMENT = `<?xml version="1.0"?>
<?xml-stylesheet type="text/xsl" href="t.xsl"?>
<r/>
`;
const XSL = `<?xml version="1.0"?>
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
<xsl:template match="/"><html><body><script>fetch('/hit?p=xslt')</script></body></html></xsl:template>
</xsl:stylesheet>
`;
const SVGZ = gzipSync(
	Buffer.from(
		`<svg xmlns="http://www.w3.org/2000/svg"><script>fetch('/hit?p=svgz')</script></svg>`,
		'utf8'
	)
);
const CSS = 'body { color: #155e48; }\n';
const TEXT = 'Plain notes\n';
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
	'base64'
);

const README = [
	'# Home',
	'',
	'[Asset XML](assets/asset.xml)',
	'',
	'[Feed](code/feed.xml)',
	'',
	'[Stylesheet document](assets/doc.xml)',
	'',
	'![Picture](assets/pixel.png)',
	''
].join('\n');

/** Inactive assets that the site keeps under their own names. */
const KEPT = ['assets/pixel.png', 'assets/site.css', 'assets/notes.txt'];

/** Imported assets carry `application/octet-stream`, as the project import stores them. */
const ACTIVE_ASSETS: Array<[string, Buffer | string]> = [
	['assets/asset.xml', XML],
	['assets/doc.xml', XSL_DOCUMENT],
	['assets/t.xsl', XSL],
	['assets/x.svgz', SVGZ],
	['assets/f.rss', XML],
	['assets/a.atom', XML],
	['assets/d.rdf', XML],
	['assets/m.mml', XML],
	['assets/s.xsd', XML],
	['assets/p.xslt', XSL]
];

const contentTypes: Record<string, string> = {
	'.css': 'text/css; charset=utf-8',
	'.html': 'text/html; charset=utf-8',
	'.png': 'image/png',
	'.txt': 'text/plain; charset=utf-8',
	'.xml': 'application/xml',
	'.xsl': 'application/xslt+xml',
	'.xslt': 'application/xslt+xml',
	'.xsd': 'application/xml',
	'.rss': 'application/rss+xml',
	'.atom': 'application/atom+xml',
	'.rdf': 'application/rdf+xml',
	'.mml': 'application/mathml+xml',
	'.svgz': 'image/svg+xml'
};

async function seedProject(page: Page): Promise<void> {
	await resetAppState(page);
	await page.evaluate(
		async (values) => {
			await new Promise<void>((resolvePromise, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const transaction = database.transaction(
						['drafts', 'projects', 'projectAssets'],
						'readwrite'
					);
					const encoder = new TextEncoder();
					transaction.objectStore('drafts').put({
						id: 'home',
						name: 'README.md',
						projectId: 'active-project',
						relativePath: 'README.md',
						content: values.readme,
						kind: 'note',
						order: 0,
						open: true,
						createdAt: 1,
						updatedAt: 1
					});
					transaction.objectStore('drafts').put({
						id: 'feed',
						name: 'feed.xml',
						projectId: 'active-project',
						relativePath: 'code/feed.xml',
						content: values.xml,
						kind: 'code',
						order: 1,
						open: true,
						createdAt: 1,
						updatedAt: 1
					});
					transaction.objectStore('projects').put({
						id: 'active-project',
						name: 'Active project',
						createdAt: 1,
						updatedAt: 1
					});
					values.assets.forEach(([path, bytes, mime], index) => {
						const data = typeof bytes === 'string' ? encoder.encode(bytes) : new Uint8Array(bytes);
						transaction.objectStore('projectAssets').put({
							id: `asset-${index}`,
							projectId: 'active-project',
							path,
							mime,
							data,
							bytes: data.byteLength
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
		},
		{
			readme: README,
			xml: XML,
			assets: [
				...ACTIVE_ASSETS.map(([path, data]) => [
					path,
					typeof data === 'string' ? data : Array.from(data),
					'application/octet-stream'
				]),
				['assets/pixel.png', Array.from(PNG), 'image/png'],
				['assets/site.css', CSS, 'text/css'],
				['assets/notes.txt', TEXT, 'text/plain']
			] as Array<[string, string | number[], string]>
		}
	);
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

function serveSite(root: string, hits: string[]): Promise<{ origin: string; server: Server }> {
	const server = createServer(async (request, response) => {
		try {
			const url = new URL(request.url ?? '/', 'http://127.0.0.1');
			if (url.pathname === '/hit') {
				hits.push(url.searchParams.get('p') ?? '');
				response.writeHead(204);
				response.end();
				return;
			}
			const requested = decodeURIComponent(url.pathname.replace(/^\/+/, '') || 'index.html');
			const path = resolve(root, requested);
			const fromRoot = relative(root, path);
			if (!fromRoot || fromRoot.startsWith(`..${sep}`)) throw new Error('outside site');
			if (!(await stat(path)).isFile()) throw new Error('missing file');
			const extension = extname(path).toLowerCase();
			response.writeHead(200, {
				'Content-Type': contentTypes[extension] ?? 'application/octet-stream',
				// A static host serves a gzip SVG with its content encoding.
				...(extension === '.svgz' ? { 'Content-Encoding': 'gzip' } : {})
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

test('the documentation site publishes only inert file types and renames the rest', async ({
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
	const zipPath = testInfo.outputPath('active-content-site.zip');
	await download.saveAs(zipPath);
	await expect(page.getByTestId('docs-site-summary')).toContainText('1 page(s)');
	await expect(page.getByTestId('docs-site-summary')).toContainText('0 error(s)');

	const zipBuffer = await readFile(zipPath);
	const JSZip = (await import('jszip')).default;
	const zip = await JSZip.loadAsync(zipBuffer);
	const paths = Object.keys(zip.files).filter((path) => !zip.files[path]!.dir);
	const activePaths = [...ACTIVE_ASSETS.map(([path]) => path), 'code/feed.xml'];
	for (const path of activePaths) {
		expect(paths, path).not.toContain(path);
		expect(paths, path).toContain(`${path}.txt`);
	}
	for (const path of KEPT) expect(paths, path).toContain(path);
	expect(await zip.files['assets/asset.xml.txt']!.async('string')).toBe(XML);
	expect(await zip.files['assets/doc.xml.txt']!.async('string')).toBe(XSL_DOCUMENT);
	expect(await zip.files['assets/t.xsl.txt']!.async('string')).toBe(XSL);
	expect(await zip.files['assets/x.svgz.txt']!.async('nodebuffer')).toEqual(SVGZ);
	expect(await zip.files['code/feed.xml.txt']!.async('string')).toBe(XML);
	const home = await zip.files['index.html']!.async('string');
	expect(home).toContain('href="assets/asset.xml.txt"');
	expect(home).toContain('href="code/feed.xml.txt"');

	const renamed = page.locator('[data-docs-site-issue][data-code="document-renamed"]');
	await expect(renamed).toHaveCount(activePaths.length);

	const siteRoot = testInfo.outputPath('site');
	await extractSite(zipBuffer, siteRoot);
	const hits: string[] = [];
	const { origin, server } = await serveSite(siteRoot, hits);
	const standalone = await browser.newPage();
	const visited: string[] = [];
	try {
		for (const path of paths) {
			if (!/\.(?:txt|xml|xsl|xslt|xsd|rss|atom|rdf|mml|svgz)$/i.test(path)) continue;
			// A browser may download a binary file that a host serves as text. A
			// download runs no script, so it is not an execution.
			await standalone.goto(`${origin}${path}`).catch((error: Error) => {
				if (!/Download is starting/.test(error.message)) throw error;
			});
			await standalone.waitForTimeout(250);
			visited.push(path);
		}
		// The probe fetches `/hit` from every payload that runs.
		await standalone.waitForTimeout(500);
	} finally {
		await standalone.close();
		await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
	}
	expect(visited.length).toBeGreaterThanOrEqual(activePaths.length);
	expect(hits).toEqual([]);

	const artifact = testInfo.outputPath('docs-site-active-content-artifact.json');
	await writeFile(
		artifact,
		`${JSON.stringify(
			{
				command:
					'npx playwright test e2e/docs-site-export-active-content.spec.ts --workers=1 --retries=0',
				revision: execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim(),
				fixtureSha256: createHash('sha256')
					.update(JSON.stringify({ README, XML, XSL_DOCUMENT, XSL }))
					.update(SVGZ)
					.digest('hex'),
				environment: { node: process.version, browser: browser.browserType().name() },
				result: { files: paths, visited, hits }
			},
			null,
			2
		)}\n`,
		'utf8'
	);
	await testInfo.attach('docs-site-active-content-artifact.json', {
		path: artifact,
		contentType: 'application/json'
	});
	await testInfo.attach('active-content-site.zip', {
		path: zipPath,
		contentType: 'application/zip'
	});
});

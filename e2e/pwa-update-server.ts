import { createServer } from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Keep the build snapshot in memory so a concurrent build cannot change a served release.
export async function createPwaUpdateServer(buildDirectory: string, basePath = '') {
	const prefix = basePath.replace(/\/+$/, '');
	const appRoot = `${prefix}/`;
	const rootEntry = new RegExp(`url:"${escapeRegExp(appRoot)}",revision:"[^"]+"`);
	const assets = new Map<string, Buffer>();
	async function visit(directory: string): Promise<void> {
		for (const item of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, item.name);
			if (item.isDirectory()) await visit(path);
			else
				assets.set('/' + relative(buildDirectory, path).split(sep).join('/'), await readFile(path));
		}
	}
	await visit(buildDirectory);
	let version = 1;
	const types: Record<string, string> = {
		'.html': 'text/html',
		'.js': 'application/javascript',
		'.css': 'text/css',
		'.json': 'application/json',
		'.webmanifest': 'application/manifest+json',
		'.svg': 'image/svg+xml',
		'.png': 'image/png',
		'.woff2': 'font/woff2'
	};
	const worker = assets.get('/sw.js')?.toString();
	if (!worker || !rootEntry.test(worker)) {
		throw new Error('Le build doit contenir un SW avec la racine révisionnée.');
	}
	const server = createServer((request, response) => {
		const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
		const relativePath =
			prefix && pathname.startsWith(prefix) ? pathname.slice(prefix.length) || '/' : pathname;
		const key = relativePath === '/' ? '/index.html' : relativePath;
		let body = assets.get(key);
		if (!body) {
			response.writeHead(404).end();
			return;
		}
		if (key === '/index.html') {
			body = Buffer.from(
				body
					.toString()
					.replace('</head>', `<meta name="pwa-test-release" content="${version}"></head>`)
			);
		}
		if (key === '/sw.js') {
			// Install the actual version with the new precached HTML.
			body = Buffer.from(
				worker.replace(rootEntry, `url:"${appRoot}",revision:"pwa-test-${version}"`) +
					`\nself.addEventListener('message', event => { if (event.data?.type === 'PWA_TEST_VERSION') event.ports[0]?.postMessage(${version}); });\n`
			);
		}
		response.writeHead(200, {
			'Content-Type': types[extname(key)] ?? 'application/octet-stream',
			'Cache-Control': 'no-store'
		});
		response.end(body);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('Port de test indisponible.');
	return {
		origin: `http://127.0.0.1:${address.port}`,
		publishNextVersion() {
			version += 1;
		},
		async close() {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve()))
			);
		}
	};
}

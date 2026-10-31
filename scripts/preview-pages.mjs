// Serve the static build locally at /deckmark/ to simulate GitHub Pages.
// Use this server to reproduce absolute path failures before deployment.
import { execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

console.log('🔨 Build with BASE_PATH=/deckmark...');
execSync('npm run build', {
	stdio: 'inherit',
	env: { ...process.env, BASE_PATH: '/deckmark' }
});

const ROOT = resolve('build');
const PREFIX = '/deckmark';
const PORT = 4173;
const TYPES = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'application/javascript',
	'.mjs': 'application/javascript',
	'.css': 'text/css',
	'.json': 'application/json',
	'.webmanifest': 'application/manifest+json',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.webp': 'image/webp',
	'.woff2': 'font/woff2',
	'.ico': 'image/x-icon',
	'.txt': 'text/plain; charset=utf-8'
};

const server = createServer(async (req, res) => {
	const url = req.url ?? '/';
	// Redirect the root and paths outside the prefix to /deckmark/, as on GitHub Pages.
	if (!url.startsWith(PREFIX)) {
		res.writeHead(302, { Location: PREFIX + url });
		res.end();
		return;
	}
	let path = url.slice(PREFIX.length).split('?')[0];
	if (path === '' || path === '/') path = '/index.html';
	const fsPath = normalize(join(ROOT, path));
	// Reject paths outside build/ to prevent path traversal.
	if (!fsPath.startsWith(ROOT)) {
		res.writeHead(403);
		res.end('Forbidden');
		return;
	}
	try {
		const s = await stat(fsPath);
		if (s.isDirectory()) throw new Error('directory');
		const buf = await readFile(fsPath);
		res.writeHead(200, {
			'Content-Type': TYPES[extname(fsPath)] ?? 'application/octet-stream',
			'Cache-Control': 'no-store'
		});
		res.end(buf);
	} catch {
		// Serve index.html as the SPA fallback for unknown routes.
		try {
			const buf = await readFile(join(ROOT, 'index.html'));
			res.writeHead(200, {
				'Content-Type': 'text/html; charset=utf-8',
				'Cache-Control': 'no-store'
			});
			res.end(buf);
		} catch {
			res.writeHead(404);
			res.end('Not found');
		}
	}
});

server.listen(PORT, () => {
	console.log(`✓ Served at http://localhost:${PORT}${PREFIX}/`);
	console.log('  Press Ctrl+C to stop.');
});

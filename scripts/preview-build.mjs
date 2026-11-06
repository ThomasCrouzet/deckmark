#!/usr/bin/env node
// Serve a prebuilt static artifact for tests. This server reads build/ only.
// It does not run a build and does not need the SvelteKit server output.
// Usage: node scripts/preview-build.mjs [--host 127.0.0.1] [--port 4173] [--base-path '']
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const ROOT = resolve('build');
const TYPES = {
	'.css': 'text/css; charset=utf-8',
	'.html': 'text/html; charset=utf-8',
	'.ico': 'image/x-icon',
	'.js': 'application/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.mjs': 'application/javascript; charset=utf-8',
	'.png': 'image/png',
	'.svg': 'image/svg+xml',
	'.txt': 'text/plain; charset=utf-8',
	'.webmanifest': 'application/manifest+json',
	'.webp': 'image/webp',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2'
};

function parseArgs(args) {
	const options = { host: '127.0.0.1', port: 4173, basePath: '' };
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === '--host') options.host = args[++index] ?? options.host;
		else if (arg === '--port') options.port = Number(args[++index] ?? options.port);
		else if (arg === '--base-path') options.basePath = args[++index] ?? '';
		else throw new Error(`Unknown argument: ${arg}`);
	}
	if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
		throw new Error('--port must be an integer from 1 through 65535.');
	}
	return options;
}

const options = parseArgs(process.argv.slice(2));
const prefix = options.basePath.replace(/\/+$/, '');

function send(response, status, body, type = 'text/plain; charset=utf-8') {
	response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
	response.end(body);
}

const server = createServer(async (request, response) => {
	const url = new URL(request.url ?? '/', `http://${options.host}`);
	let pathname = url.pathname;
	if (prefix && pathname.startsWith(prefix)) pathname = pathname.slice(prefix.length) || '/';
	const candidate = normalize(join(ROOT, decodeURIComponent(pathname)));
	const relativePath = candidate.slice(ROOT.length + 1);
	if (candidate !== ROOT && (relativePath.startsWith('..') || relativePath.startsWith(sep))) {
		send(response, 403, 'Forbidden');
		return;
	}
	try {
		const entry = await stat(candidate);
		if (entry.isDirectory()) throw new Error('directory');
		const body = await readFile(candidate);
		send(response, 200, body, TYPES[extname(candidate)] ?? 'application/octet-stream');
	} catch {
		try {
			const body = await readFile(join(ROOT, 'index.html'));
			send(response, 200, body, TYPES['.html']);
		} catch {
			send(response, 404, 'Not found');
		}
	}
});

server.listen(options.port, options.host, () => {
	console.log(`Serving build at http://${options.host}:${options.port}${prefix}/`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
	process.on(signal, () => server.close(() => process.exit(0)));
}

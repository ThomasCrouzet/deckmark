import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { generateSW } from 'workbox-build';

const projectRoot = resolve(import.meta.dirname, '..');
const buildDirectory = resolve(projectRoot, 'build');
const basePath = process.env.BASE_PATH ?? '';

if (basePath && !/^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)$/.test(basePath)) {
	throw new Error('BASE_PATH must be empty or a leading-slash path without a final slash.');
}

async function isMermaidElkChunk(url) {
	if (!url.includes('/chunks/') || !url.endsWith('.js')) return false;
	const path = resolve(buildDirectory, url);
	try {
		if ((await stat(path)).size < 1_000_000) return false;
		return (await readFile(path, 'utf8')).includes('org.eclipse.elk');
	} catch (error) {
		if (error?.code === 'ENOENT') return false;
		throw error;
	}
}

async function transformManifest(entries) {
	const manifest = [];
	for (const entry of entries) {
		if (entry.url === 'manifest.webmanifest') continue;
		if (await isMermaidElkChunk(entry.url)) continue;
		manifest.push(entry.url === 'index.html' ? { ...entry, url: `${basePath}/` } : entry);
	}
	return { manifest };
}

await stat(resolve(buildDirectory, 'index.html'));

const result = await generateSW({
	globDirectory: buildDirectory,
	globPatterns: [
		'_app/immutable/entry/*.js',
		'_app/immutable/nodes/*.js',
		'_app/immutable/chunks/*.js',
		'_app/immutable/workers/*.js',
		'_app/immutable/assets/*.{css,woff2}',
		'print/*.css',
		'katex/**/*.css',
		'katex/**/*.woff2',
		'index.html',
		'favicon.{ico,svg}',
		'brand/logo-{dark,light}.svg',
		'apple-touch-icon-180x180.png',
		'maskable-icon-512x512.png',
		'pwa-{64x64,192x192,512x512}.png',
		'manifest.webmanifest'
	],
	maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
	manifestTransforms: [transformManifest],
	navigateFallback: `${basePath}/`,
	navigateFallbackDenylist: [/^\/api/],
	cleanupOutdatedCaches: true,
	clientsClaim: false,
	skipWaiting: false,
	swDest: resolve(buildDirectory, 'sw.js')
});

for (const warning of result.warnings) console.warn(warning);
if (result.count === 0) throw new Error('The service worker precache manifest is empty.');
await stat(resolve(buildDirectory, 'sw.js'));
console.log(`service worker: ${result.count} files / ${result.size} bytes`);

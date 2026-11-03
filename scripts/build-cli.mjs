import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

const root = resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const stubNotify = resolve(root, 'cli/stubs/notify.ts');
const stubAppEnv = resolve(root, 'cli/stubs/app-env.ts');
const stubReport = resolve(root, 'cli/stubs/report.ts');

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	await bundle();
}

export async function bundle() {
	await build({
		configFile: false,
		root,
		logLevel: 'warn',
		plugins: [
			{
				name: 'deckmark-cli-stubs',
				enforce: 'pre',
				resolveId(source) {
					if (source.endsWith('notify.svelte')) return stubNotify;
					if (source === '$app/env') return stubAppEnv;
					if (source === './report' || source === '../report') return stubReport;
					return null;
				}
			}
		],
		define: {
			__DECKMARK_VERSION__: JSON.stringify(packageJson.version)
		},
		build: {
			ssr: true,
			outDir: '.cli',
			emptyOutDir: true,
			copyPublicDir: false,
			target: 'node22',
			minify: false,
			rollupOptions: {
				input: resolve(root, 'cli/deckmark.ts'),
				output: {
					format: 'esm',
					entryFileNames: 'deckmark.mjs',
					codeSplitting: false
				}
			}
		},
		ssr: {
			noExternal: true
		}
	});
}

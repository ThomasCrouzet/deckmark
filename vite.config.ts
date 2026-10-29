import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, loadEnv } from 'vite';
import { bundleGraphPlugin } from './scripts/bundle-graph.mjs';

const dev = process.env.NODE_ENV !== 'production';
const repoBase = (process.env.BASE_PATH ?? '') as '' | `/${string}`;

export default defineConfig(({ mode }) => {
	// Vite does not load `.env.local` into `process.env` for this configuration.
	// Application code receives it through `import.meta.env`. Use `loadEnv` here.
	const env = loadEnv(mode, process.cwd(), 'VITE_');
	// Contributors can add short MagicDNS hostnames outside `.ts.net`.
	// Keep machine-specific names in `.env.local`: VITE_DEV_ALLOWED_HOSTS=my-machine.
	const extraAllowedHosts = (env.VITE_DEV_ALLOWED_HOSTS ?? '')
		.split(',')
		.map((h) => h.trim())
		.filter(Boolean);

	return {
		server: {
			// The development server binds to the Tailscale IP (see `make dev`).
			// Allow MagicDNS Host headers without triggering DNS rebinding protection.
			// `.ts.net` covers `<machine>.tail-XXXX.ts.net`.
			// Use `VITE_DEV_ALLOWED_HOSTS` for additional short hostnames.
			// Vite reads `server.*` only in development and preview, not production.
			allowedHosts: ['.ts.net', ...extraAllowedHosts]
		},
		define: {
			// Mermaid includes Vue (esm-bundler), which needs these tree-shaking flags.
			// These flags prevent console warnings and improve dead-code removal.
			__VUE_OPTIONS_API__: 'false',
			__VUE_PROD_DEVTOOLS__: 'false',
			__VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false'
		},
		plugins: [
			tailwindcss(),
			sveltekit({
				compilerOptions: {
					runes: ({ filename }) =>
						filename.split(/[/\\]/).includes('node_modules') ? undefined : true
				},
				adapter: adapter({ fallback: 'index.html', precompress: false, strict: true }),
				paths: { base: dev ? '' : repoBase },
				prerender: {
					// With ssr = false, static HTML contains only the hydration shell.
					// Internal anchors, including the #main skip link, resolve after hydration.
					handleMissingId: 'ignore'
				},
				csp: {
					mode: 'hash',
					directives: {
						'default-src': ['self'],
						// No runtime dependency creates WebAssembly instances (checked with mermaid 11.16, katex, and highlight.js).
						// Do not add wasm-unsafe-eval.
						// Mermaid/KaTeX e2e tests use the built app with this CSP.
						// They check whether a future dependency needs WebAssembly.
						'script-src': ['self'],
						'style-src': ['self', 'unsafe-inline'],
						'font-src': ['self', 'data:'],
						'img-src': ['self', 'data:', 'blob:'],
						'media-src': ['self', 'blob:'],
						'connect-src': ['self', 'https:'],
						'worker-src': ['self', 'blob:'],
						'base-uri': ['self'],
						'form-action': ['none'],
						// Block iframes. The app does not need them.
						// Mermaid uses its own sandbox with `securityLevel: strict`, independently of CSP.
						'frame-src': ['none'],
						// Prevent third-party sites from embedding mdsh (clickjacking).
						'frame-ancestors': ['none'],
						// Block `<object>`, `<embed>`, and `<applet>`. The app does not need them.
						'object-src': ['none']
					}
				}
			}),
			bundleGraphPlugin()
		],
		build: {
			rolldownOptions: {
				output: {
					// Merge tiny generated chunks without removing offline features from the precache.
					// Group only lazy-loaded libraries large enough to need a separate chunk.
					// In commit 3f5b5ad, grouping Mermaid moved `__vitePreload` into its chunk.
					// The app entry then imported Mermaid statically and loaded 2.5 MiB before first paint.
					// Only render/markdown.ts uses DOMPurify; that module belongs to render-core.
					// After the build, check that the entry does not import these chunks statically.
					// See the production build troubleshooting instructions.
					//
					// §1.4 - Do not force Mermaid into a manual chunk.
					// The June 2026 build confirmed a separate bundler chunk (about 115 KB gzip).
					// Both render/markdown.ts and milkdown-mermaid-preview.ts use dynamic imports.
					// The renderer also checks `mermaidCodes.length > 0`.
					// Mermaid stays outside the static entry/node graph. Documents without diagrams do not load it.
					// This meets the roadmap isolation requirement.
					codeSplitting: {
						minSize: 1000,
						groups: [
							{
								name(id: string): string | null {
									// Startup state and its shared dependencies use one offline resource.
									if (id.endsWith('/src/lib/files.svelte.ts')) return 'workspace-state';
									// These dependency-free helpers share one small offline resource.
									if (id.endsWith('/src/lib/config.ts') || id.endsWith('/src/lib/abort.ts'))
										return 'operation-utils';
									// The desktop bridge stays lazy and uses one offline resource.
									if (id.includes('node_modules/@tauri-apps/api/')) return 'desktop-api';
									// Share icon components across panels to limit precache requests.
									if (id.includes('node_modules/@lucide/svelte/')) return 'icons';
									if (id.includes('node_modules/marked/')) return 'render-core';
									if (id.includes('node_modules/highlight.js/')) return 'render-highlight';
									if (id.includes('node_modules/katex/')) return 'render-math';
									if (id.includes('node_modules/jszip/')) return 'export-zip';
									if (id.includes('node_modules/js-yaml/')) return 'frontmatter';
									return null;
								}
							}
						]
					}
				}
			}
		}
	};
});

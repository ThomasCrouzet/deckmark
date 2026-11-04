import js from '@eslint/js';
import ts from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import svelteParser from 'svelte-eslint-parser';
import tsParser from '@typescript-eslint/parser';

export default [
	js.configs.recommended,
	...ts.configs.recommended,
	...svelte.configs['flat/recommended'],
	prettier,
	...svelte.configs['flat/prettier'],
	{
		languageOptions: {
			globals: {
				...globals.browser,
				...globals.node
			}
		}
	},
	{
		// Parse `.svelte` components and `.svelte.ts` stores with svelte-eslint-parser.
		// It supports `$state`, `$derived`, and `$effect`.
		// Use typescript-eslint for embedded TypeScript.
		files: ['**/*.svelte', '**/*.svelte.ts'],
		languageOptions: {
			parser: svelteParser,
			parserOptions: {
				parser: tsParser
			}
		}
	},
	{
		rules: {
			'@typescript-eslint/no-unused-vars': [
				'warn',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
			],
			// Lint `.svelte.ts` stores and reject `any`. The former global exclusion is removed.
			'@typescript-eslint/no-explicit-any': 'error',
			// §1.3 - Route logs through report.ts (reportError/reportWarning) or storage.ts (reportPersistenceError).
			// Only these modules can call `console`. See the override below.
			// This prevents console errors that do not notify the user.
			'no-console': 'error',
			// §A4.3 - Prevent static imports of heavy libraries that must load on demand.
			// Static imports add these libraries to the page chunk (60 KB gzip limit).
			// See the bundle budget in ARCHITECTURE.md.
			// Modules that load on demand can use static imports in their own separate chunks.
			'no-restricted-imports': [
				'error',
				{
					paths: [
						{ name: 'marked', message: 'Lazy-load only (see ARCHITECTURE.md).' },
						{ name: 'mermaid', message: 'Lazy-load only (see ARCHITECTURE.md).' },
						{ name: 'jszip', message: 'Lazy-load only (see ARCHITECTURE.md).' },
						{ name: 'js-yaml', message: 'Lazy-load only (see ARCHITECTURE.md).' },
						{ name: 'dompurify', message: 'Lazy-load only (see ARCHITECTURE.md).' },
						{ name: 'katex', message: 'Lazy-load only (see ARCHITECTURE.md).' },
						{ name: 'highlight.js', message: 'Lazy-load only (see ARCHITECTURE.md).' }
					],
					patterns: [
						{ group: ['katex/*'], message: 'Lazy-load only (see ARCHITECTURE.md).' },
						{ group: ['highlight.js/*'], message: 'Lazy-load only (see ARCHITECTURE.md).' },
						{ group: ['mermaid/*'], message: 'Lazy-load only (see ARCHITECTURE.md).' }
					]
				}
			]
		}
	},
	{
		// §1.3 - Only these two logging modules can call `console` directly.
		// All other application modules send logs through them.
		files: ['src/lib/report.ts', 'src/lib/storage.ts'],
		rules: {
			'no-console': 'off'
		}
	},
	{
		// Tests inspect console calls. Benchmarks use console output.
		// The production no-console rule does not apply to these files.
		files: ['**/*.test.ts', '**/*.spec.ts', '**/*.bench.test.ts'],
		rules: {
			'no-console': 'off'
		}
	},
	{
		// §A4.3 - These modules load on demand.
		// See dynamic imports in services/export.ts, Editor.svelte, ReadView.svelte, and +page.svelte prefetch.
		// Their static imports enter separate chunks and do not exceed the initial bundle budget.
		files: [
			'src/lib/render/**/*.ts',
			'src/lib/services/export.ts',
			'src/lib/milkdown-mermaid-preview.ts'
		],
		rules: {
			'no-restricted-imports': 'off'
		}
	},
	{
		// Node CLI scripts use console output for screenshots, OG images, and Pages preview.
		// The no-console rule applies to application code in src/.
		files: ['scripts/**/*.mjs', 'scripts/**/*.js'],
		rules: {
			'no-console': 'off'
		}
	},
	{
		// The CLI is a separate Node bundle. Static renderer imports do not
		// enter the Web graph or the PWA precache.
		files: ['cli/**/*.ts'],
		rules: {
			'no-restricted-imports': 'off'
		}
	},
	{
		// The executable wrapper writes diagnostics without the UI logger.
		files: ['bin/**/*.mjs'],
		rules: {
			'no-console': 'off'
		}
	},
	{
		ignores: [
			'.cli/',
			'build/',
			'coverage/',
			'playwright-report/',
			'production-report/',
			'production-results/',
			'test-results/',
			'native-test-results/',
			'.svelte-kit/',
			'node_modules/',
			'package-lock.json',
			'dist/',
			// Tauri Rust build artifacts (generated JS helpers under target/).
			'src-tauri/target/',
			'src-tauri/gen/',
			// Local agent / editor tooling (not part of the app surface).
			'.codex/',
			'.claude/',
			'.agents/'
		]
	}
];

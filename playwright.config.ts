import { readFileSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';
import { testSource } from './scripts/test-source.mjs';

const e2ePort = process.env.E2E_PORT ?? '4173';
const e2eBaseUrl = `http://127.0.0.1:${e2ePort}`;
// A prebuilt run reuses one verified instrumented build across shards.
// The provenance check fails before the preview server starts when the
// artifact, its inputs or its source do not match this checkout.
const prebuilt = process.env.E2E_PREBUILT === '1';
// A balanced shard records the partition identity in its reports. The
// manifest check compares this identity with the planned shard list, so a
// stale selection cannot pass as the current partition.
const shardMetaPath = process.env.E2E_SHARD_META;
const partition = shardMetaPath ? JSON.parse(readFileSync(shardMetaPath, 'utf8')) : null;

/**
 * Playwright end-to-end tests for user workflows.
 * Chromium: full suite (FSA, golden-path, and mobile).
 * WebKit: selected workflows. FSA requires Chromium.
 */
export default defineConfig({
	testDir: './e2e',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	// Retry twice in CI for temporary CPU or network failures.
	// Seed data in source mode through helpers.writeSourceContent.
	// Do not depend on asynchronous restoration of `mdsh:mode`.
	retries: process.env.CI ? 2 : 0,
	...(process.env.CI ? { workers: 1 } : {}),
	captureGitInfo: { commit: true, diff: true },
	metadata: {
		...testSource(),
		nodeVersion: process.version,
		prebuilt,
		partition,
		repeatCommand: 'npx playwright test --ignore-snapshots --grep-invert "Snapshots visuels"'
	},
	reporter: [
		...(process.env.CI ? ([['github']] as const) : []),
		['list'],
		['html', { outputFolder: 'playwright-report', open: 'never' }],
		['json', { outputFile: 'test-results/results.json' }],
		['./scripts/source-fidelity-reporter.mjs']
	],
	use: {
		baseURL: e2eBaseUrl,
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
		// The UI defaults to English and detects navigator.language.
		// These tests check French strings, so use fr-FR.
		// locale-en.spec.ts checks English. TypeScript checks catalog key parity.
		locale: 'fr-FR'
	},
	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'] },
			// Mobile tests expect the Sidebar drawer. Exclude them from the desktop suite.
			testIgnore: ['**/mobile.spec.ts', '**/presentation-mobile.spec.ts']
		},
		{
			// Test the Sidebar drawer and presentation touch paths in mobile specs only.
			// The desktop project covers the other paths.
			// Pixel 5 uses `defaultBrowserType: chromium`; iPhone 13 does not.
			// CI installs Chromium with `npx playwright install --with-deps chromium`.
			name: 'mobile-chromium',
			use: { ...devices['Pixel 5'] },
			testMatch: [
				'**/mobile.spec.ts',
				'**/presentation-mobile.spec.ts',
				'**/presentation-responsive-tasks.spec.ts'
			]
		},
		{
			name: 'firefox',
			use: { ...devices['Desktop Firefox'] },
			testMatch: [
				'**/json-tools.spec.ts',
				'**/code-editor.spec.ts',
				'**/editor-state.spec.ts',
				'**/toast-overlap.spec.ts',
				'**/golden-path.spec.ts',
				'**/search-replace.spec.ts',
				'**/editor-width.spec.ts',
				'**/image-layout.spec.ts',
				'**/image-resize-budget.spec.ts',
				'**/image-nodeview-proxy.spec.ts',
				'**/image-fetch-policy.spec.ts',
				'**/keyboard-platform.spec.ts',
				'**/editor-tab.spec.ts',
				'**/table-editing.spec.ts',
				'**/wiki-links.spec.ts',
				'**/source-fidelity.spec.ts',
				'**/markdown-blank-lines.spec.ts',
				'**/presentation-editor.spec.ts',
				'**/presentation-export.spec.ts',
				'**/presentation-offline.spec.ts',
				'**/offline-review.spec.ts',
				'**/presentation-files.spec.ts',
				'**/presentation-review.spec.ts',
				'**/note-type-guard.spec.ts',
				'**/read-preview-isolation.spec.ts',
				'**/read-annotations.spec.ts',
				'**/modal-isolation-review.spec.ts',
				'**/palette-load-review.spec.ts',
				'**/palette-pagination.spec.ts',
				'**/toolbar-density.spec.ts',
				'**/presentation-toolbar-density.spec.ts',
				'**/presentation-format.spec.ts',
				'**/docs-site-export-svg.spec.ts',
				'**/docs-site-export-html.spec.ts',
				'**/docs-site-search-paths.spec.ts',
				'**/export-download-lifetime.spec.ts'
			]
		},
		{
			// WebKit covers persistence, content editing, layout, and source preservation.
			// FSA-dependent tests remain intentionally limited to Chromium.
			name: 'webkit',
			use: { ...devices['Desktop Safari'] },
			testMatch: [
				'**/json-tools.spec.ts',
				'**/code-editor.spec.ts',
				'**/split-view.spec.ts',
				'**/toc-modes.spec.ts',
				'**/navigation-stats-scroll.spec.ts',
				'**/editor-state.spec.ts',
				'**/toast-overlap.spec.ts',
				'**/golden-path.spec.ts',
				'**/search-replace.spec.ts',
				'**/editor-width.spec.ts',
				'**/image-layout.spec.ts',
				'**/image-input-latency.spec.ts',
				'**/image-preview-budget.spec.ts',
				'**/project-media-cache.spec.ts',
				'**/image-resize-budget.spec.ts',
				'**/image-nodeview-proxy.spec.ts',
				'**/image-fetch-policy.spec.ts',
				'**/keyboard-platform.spec.ts',
				'**/editor-tab.spec.ts',
				'**/table-editing.spec.ts',
				'**/wiki-links.spec.ts',
				'**/source-fidelity.spec.ts',
				'**/markdown-blank-lines.spec.ts',
				'**/editor-large-note-visibility.spec.ts',
				'**/presentation-editor.spec.ts',
				'**/presentation-export.spec.ts',
				'**/presentation-files.spec.ts',
				'**/offline-review.spec.ts',
				'**/presentation-review.spec.ts',
				'**/note-type-guard.spec.ts',
				'**/read-preview-isolation.spec.ts',
				'**/read-annotations.spec.ts',
				'**/modal-isolation-review.spec.ts',
				'**/palette-load-review.spec.ts',
				'**/palette-pagination.spec.ts',
				'**/toolbar-density.spec.ts',
				'**/presentation-toolbar-density.spec.ts',
				'**/presentation-format.spec.ts',
				'**/docs-site-export-svg.spec.ts',
				'**/docs-site-export-html.spec.ts',
				'**/docs-site-search-paths.spec.ts',
				'**/image-source-incremental.spec.ts',
				'**/docs-site-fragments.spec.ts',
				'**/export-download-lifetime.spec.ts'
			]
		},
		{
			name: 'mobile-webkit',
			use: { ...devices['iPhone 13'] },
			testMatch: ['**/mobile.spec.ts', '**/presentation-mobile.spec.ts']
		}
	],
	webServer: {
		env: { VITE_SOURCE_FIDELITY_METRICS: '1' },
		command: prebuilt
			? `node scripts/build-provenance.mjs verify --kind e2e --instrumentation source-fidelity && node scripts/preview-build.mjs --host 127.0.0.1 --port ${e2ePort}`
			: `npm run build && npm run preview -- --host 127.0.0.1 --port ${e2ePort} --strictPort`,
		url: e2eBaseUrl,
		// Do not reuse an unknown server.
		// Another project on this port would make the tests check the wrong application.
		reuseExistingServer: false,
		timeout: 120_000,
		stdout: 'ignore',
		stderr: 'pipe'
	}
});

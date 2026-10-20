import { defineConfig, devices } from '@playwright/test';
import { testSource } from './scripts/test-source.mjs';

const e2ePort = process.env.E2E_PORT ?? '4173';
const e2eBaseUrl = `http://127.0.0.1:${e2ePort}`;

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
	workers: process.env.CI ? 1 : undefined,
	captureGitInfo: { commit: true, diff: true },
	metadata: {
		...testSource(),
		nodeVersion: process.version,
		repeatCommand: 'npx playwright test --ignore-snapshots --grep-invert "Snapshots visuels"'
	},
	reporter: [
		...(process.env.CI ? ([['github']] as const) : []),
		['list'],
		['html', { outputFolder: 'playwright-report', open: 'never' }],
		['json', { outputFile: 'test-results/results.json' }]
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
			testIgnore: '**/mobile.spec.ts'
		},
		{
			// Test the Sidebar drawer, touch targets, and responsive layout in mobile.spec.ts only.
			// The desktop project covers the other paths.
			// Pixel 5 uses `defaultBrowserType: chromium`; iPhone 13 does not.
			// CI installs Chromium with `npx playwright install --with-deps chromium`.
			name: 'mobile-chromium',
			use: { ...devices['Pixel 5'] },
			testMatch: '**/mobile.spec.ts'
		},
		{
			name: 'firefox',
			use: { ...devices['Desktop Firefox'] },
			testMatch: [
				'**/golden-path.spec.ts',
				'**/search-replace.spec.ts',
				'**/editor-width.spec.ts',
				'**/image-layout.spec.ts',
				'**/keyboard-platform.spec.ts',
				'**/wiki-links.spec.ts',
				'**/source-fidelity.spec.ts'
			]
		},
		{
			// WebKit covers persistence, content editing, layout, and source preservation.
			// FSA-dependent tests remain intentionally limited to Chromium.
			name: 'webkit',
			use: { ...devices['Desktop Safari'] },
			testMatch: [
				'**/golden-path.spec.ts',
				'**/search-replace.spec.ts',
				'**/editor-width.spec.ts',
				'**/image-layout.spec.ts',
				'**/keyboard-platform.spec.ts',
				'**/wiki-links.spec.ts',
				'**/source-fidelity.spec.ts'
			]
		},
		{
			name: 'mobile-webkit',
			use: { ...devices['iPhone 13'] },
			testMatch: '**/mobile.spec.ts'
		}
	],
	webServer: {
		command: `npm run build && npm run preview -- --host 127.0.0.1 --port ${e2ePort} --strictPort`,
		url: e2eBaseUrl,
		// Do not reuse an unknown server.
		// Another project on this port would make the tests check the wrong application.
		reuseExistingServer: false,
		timeout: 120_000,
		stdout: 'ignore',
		stderr: 'pipe'
	}
});

import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';
import { testSource } from '../scripts/test-source.mjs';

const output = resolve(
	process.env.OFFLINE_REVIEW_OUTPUT_DIR ?? 'test-results/offline-review',
	process.env.OFFLINE_REVIEW_PHASE ?? 'run'
);

export default defineConfig({
	testDir: '.',
	testMatch: 'offline-review.spec.ts',
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 90_000,
	metadata: {
		...testSource(),
		buildDirectory: resolve(process.env.OFFLINE_REVIEW_BUILD_DIR ?? 'build'),
		repeatCommand:
			'OFFLINE_REVIEW_PHASE=final npx playwright test --config e2e/offline-review.config.ts'
	},
	outputDir: resolve(output, 'artifacts'),
	reporter: [
		['list'],
		['html', { outputFolder: resolve(output, 'html'), open: 'never' }],
		['json', { outputFile: resolve(output, 'results.json') }]
	],
	use: {
		locale: 'en-US',
		reducedMotion: 'reduce',
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure'
	},
	projects: [
		{ name: 'chromium', use: { ...devices['Desktop Chrome'] } },
		{ name: 'firefox', use: { ...devices['Desktop Firefox'] } },
		{ name: 'webkit', use: { ...devices['Desktop Safari'] } }
	]
});

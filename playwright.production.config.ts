import { defineConfig, devices } from '@playwright/test';
import packageJson from './package.json' with { type: 'json' };
import { testSource } from './scripts/test-source.mjs';

const expectedSha = process.env.EXPECTED_SHA;
if (!expectedSha || !/^[a-f0-9]{40}$/i.test(expectedSha)) {
	throw new Error('Set EXPECTED_SHA to the full 40-character source commit SHA.');
}

const targets = [
	{
		name: 'github-pages',
		url: process.env.PAGES_URL ?? 'https://thomascrouzet.github.io/deckmark/',
		basePath: '/deckmark'
	},
	{
		name: 'cloudflare-pages',
		url: process.env.CLOUDFLARE_URL ?? 'https://www.deckmark.dev/',
		basePath: ''
	}
];

export default defineConfig({
	testDir: './e2e-production',
	fullyParallel: false,
	workers: 1,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	timeout: 120_000,
	expect: { timeout: 15_000 },
	outputDir: 'production-results',
	captureGitInfo: { commit: true, diff: true },
	metadata: {
		...testSource(),
		expectedSha: expectedSha.toLowerCase(),
		expectedVersion: packageJson.version,
		targets,
		repeatCommand: `EXPECTED_SHA=${expectedSha} PAGES_URL=${JSON.stringify(targets[0]?.url)} CLOUDFLARE_URL=${JSON.stringify(targets[1]?.url)} npx playwright test --config playwright.production.config.ts`
	},
	reporter: [
		['list'],
		['html', { outputFolder: 'production-report', open: 'never' }],
		['json', { outputFile: 'production-results/results.json' }]
	],
	use: {
		...devices['Desktop Chrome'],
		locale: 'en-US',
		serviceWorkers: 'allow',
		navigationTimeout: 30_000,
		actionTimeout: 15_000,
		trace: 'retain-on-failure',
		screenshot: 'on'
	},
	projects: targets.map(({ name, url, basePath }) => ({
		name,
		use: { baseURL: url },
		metadata: { expectedBasePath: basePath }
	}))
});

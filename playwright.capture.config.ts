import { defineConfig } from '@playwright/test';
import base from './playwright.config';

export default defineConfig(base, {
	webServer: {
		command:
			'npm run build:desktop && npm run preview -- --host 127.0.0.1 --port 4413 --strictPort',
		env: { VITE_SOURCE_FIDELITY_METRICS: '1' },
		url: 'http://127.0.0.1:4413',
		reuseExistingServer: false,
		timeout: 120_000
	},
	use: { baseURL: 'http://127.0.0.1:4413' }
});

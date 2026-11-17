// Shared measurement contract for realistic save contention evidence.
//
// This module is test-only. It does not change product behavior. Other
// performance lanes can import the same revision/span names so that a sample
// from one workload can be compared with a sample from another.

export const saveContentionSchema = 'deckmark-save-contention/1';

export const revisionSpanContract = {
	version: 'deckmark-revision-span/1',
	textUnit: 'utf-16-code-unit',
	baseRevision: 'sha256(exact document text before the accepted change)',
	acceptedSpan: '{ from, to, insert }: offsets in the base text, insert is the exact text',
	resultRevision: 'sha256(exact document text after the accepted change)',
	durableRevision: 'sha256(exact drafts.content value after the observed save)',
	rule: 'A sample passes only when resultRevision equals durableRevision and the base/span recompute the result exactly.'
} as const;

export type ContentionEnvironment = {
	readonly id: string;
	readonly platform: string;
	readonly environment: string;
	readonly status: 'tested' | 'not-tested';
	readonly reason: string;
};

const notTested = (id: string, platform: string, environment: string, reason: string) =>
	({ id, platform, environment, status: 'not-tested', reason }) as const;

const tested = (id: string, platform: string, environment: string) =>
	({ id, platform, environment, status: 'tested', reason: 'This run executed the case.' }) as const;

const browserRows: Record<string, ContentionEnvironment> = {
	chromium: tested('desktop-chromium', 'Windows/Linux/macOS', 'Chromium desktop'),
	firefox: tested('desktop-firefox', 'Windows/Linux/macOS', 'Firefox desktop'),
	webkit: tested('desktop-webkit', 'macOS', 'Playwright WebKit desktop')
};

export function contentionEnvironment(project: string): ContentionEnvironment[] {
	const current = browserRows[project];
	const browsers = ['chromium', 'firefox', 'webkit'].map((name) => {
		if (browserRows[name].id === current?.id) return browserRows[name];
		return notTested(
			browserRows[name].id,
			browserRows[name].platform,
			browserRows[name].environment,
			'Another browser project ran this file. This row is not tested in this run.'
		);
	});
	return [
		...browsers,
		notTested(
			'desktop-installed-pwa',
			'Windows/Linux/macOS',
			'Installed PWA, separate install and relaunch',
			'Playwright does not install a PWA or reproduce an installed lifecycle.'
		),
		notTested(
			'iphone-safari',
			'iPhone',
			'Safari tab, physical device',
			'No physical iPhone is attached to this run.'
		),
		notTested(
			'iphone-home-screen',
			'iPhone',
			'Home Screen PWA, physical device',
			'No physical installed iPhone app is attached to this run.'
		),
		notTested(
			'ipad-safari',
			'iPad',
			'Safari tab, physical device',
			'No physical iPad is attached to this run.'
		),
		notTested(
			'ipad-home-screen',
			'iPad',
			'Home Screen PWA, physical device',
			'No physical installed iPad app is attached to this run.'
		),
		notTested(
			'native-windows-webview2',
			'Windows x64',
			'Tauri WebView2 optimized release binary',
			'No Windows native build or WebView2 session is available in this run.'
		),
		notTested(
			'native-linux-webkitgtk',
			'Linux x64',
			'Tauri WebKitGTK optimized release binary',
			'No native Linux binary session is available in this run.'
		),
		notTested(
			'native-macos-wkwebview',
			'macOS Apple Silicon',
			'Tauri WKWebView optimized release binary',
			'No macOS native build or WKWebView session is available in this run.'
		)
	];
}

export type NumericSummary = {
	denominator: number;
	p50: number;
	p95: number;
	max: number;
	statistic: 'nearest-rank';
};

export function summarize(values: readonly number[]): NumericSummary {
	const sorted = [...values].filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
	if (!sorted.length) return { denominator: 0, p50: 0, p95: 0, max: 0, statistic: 'nearest-rank' };
	const at = (ratio: number) => sorted[Math.max(1, Math.ceil(sorted.length * ratio)) - 1];
	return {
		denominator: sorted.length,
		p50: at(0.5),
		p95: at(0.95),
		max: sorted[sorted.length - 1],
		statistic: 'nearest-rank'
	};
}

export const unsupportedMetrics = {
	compositorPaint: {
		supported: false,
		reason: 'A second animation frame is a frame opportunity, not observed composited pixels.'
	},
	compositorFrameTiming: {
		supported: false,
		reason: 'This browser workflow exposes no compositor frame timing boundary.'
	},
	nativeRss: {
		supported: false,
		reason: 'The browser context does not expose attributable native or process RSS.'
	},
	installedPwaLifecycle: {
		supported: false,
		reason: 'A browser context is not an installed PWA with its own launch and suspension.'
	}
} as const;

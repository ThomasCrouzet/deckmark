// Evaluate one retained benchmark report against a reviewed budget file.
// This command measures nothing. It lets a release audit apply the same
// fail-closed gate to an artifact and reject missing or invalid evidence.
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { budgetReport, loadBudgets } from './benchmark-shared.mjs';

function parseArguments(args) {
	const options = {
		report: null,
		budgets: resolve(import.meta.dirname, 'benchmark-budgets.json'),
		platform: null,
		enforce: true
	};
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === '--report') options.report = args[++index] ?? null;
		else if (arg === '--budgets') options.budgets = resolve(args[++index] ?? '');
		else if (arg === '--platform') options.platform = args[++index] ?? null;
		else if (arg === '--report-only') options.enforce = false;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	if (!options.report) throw new Error('--report is required.');
	if (!isAbsolute(options.report)) throw new Error('--report must be an absolute path.');
	return options;
}

function inferPlatform(report) {
	if (report.budget?.platformKey) return report.budget.platformKey;
	if (report.target === 'web' && report.browser?.name) return `web-${report.browser.name}`;
	if (report.target === 'native') {
		const os = report.environment?.os?.platform;
		if (os === 'win32') return 'native-windows-webview2';
		if (os === 'darwin') return 'native-macos-wkwebview';
		if (os === 'linux') return 'native-linux-webkitgtk';
	}
	return null;
}

/** Validate the report shape that the gate depends on. */
function reportFailures(report) {
	const failures = [];
	if (!report || typeof report !== 'object') return ['invalid-report:not-an-object'];
	if (report.status === 'failed') failures.push('invalid-report:benchmark-run-failed');
	if (report.passed === false) failures.push('invalid-report:benchmark-run-failed');
	if (!Number.isInteger(report.schemaVersion) || report.schemaVersion < 2) {
		failures.push('invalid-report:unsupported-schema');
	}
	if (!report.summary || typeof report.summary !== 'object') {
		failures.push('invalid-report:missing-summary');
	}
	if (Array.isArray(report.failures) && report.failures.length > 0) {
		failures.push('invalid-report:recorded-failures');
	}
	if (!report.source || typeof report.source !== 'string') {
		failures.push('invalid-report:missing-source-identity');
	}
	if (!report.buildMode || typeof report.buildMode !== 'string') {
		failures.push('invalid-report:missing-build-mode');
	}
	return failures;
}

async function main() {
	const options = parseArguments(process.argv.slice(2));
	const report = JSON.parse(await readFile(resolve(options.report), 'utf8'));
	const structural = reportFailures(report);
	const platformKey = options.platform ?? inferPlatform(report);
	const budgets = await loadBudgets(options.budgets);
	const budget = platformKey
		? budgetReport({ platformKey, summary: report.summary ?? {}, budgets })
		: {
				platformKey: null,
				status: 'invalid',
				failures: ['missing-platform-identity'],
				metrics: {}
			};
	if (!platformKey) structural.push('missing-platform-identity');
	const failures = [...structural, ...(budget.failures ?? [])];
	const result = {
		report: resolve(options.report),
		platformKey,
		enforced: options.enforce,
		status: failures.length === 0 && budget.status === 'ok' ? 'ok' : 'failed',
		failures,
		budget
	};
	console.log(JSON.stringify(result, null, 2));
	if (options.enforce && result.status !== 'ok') {
		process.exitCode = 1;
	}
}

await main();

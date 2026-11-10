import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hostname } from 'node:os';
import { environmentIdentity } from './benchmark-shared.mjs';
import { testSource } from './test-source.mjs';
import { modeFixture, modeMatrix } from './benchmark-fixtures/modes.mjs';
import { auditModes } from './benchmark-modes-audit.mjs';
import { modeMethods } from './benchmark-modes-contract.mjs';
import { sourceIdentity } from './benchmark-stress-contract.mjs';

const root = resolve(import.meta.dirname, '..');

function parse(args) {
	const options = {
		profile: 'web-light-chromium-production',
		caseIds: [],
		runs: 20,
		output: null,
		list: false,
		fixture: null,
		prebuilt: false,
		enforce: false,
		injectedDelayMs: 0,
		port: 4188,
		budgets: resolve(import.meta.dirname, 'benchmark-budgets.json')
	};
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === '--list') options.list = true;
		else if (arg === '--fixture') options.fixture = args[++index];
		else if (arg === '--cases') options.caseIds = args[++index].split(',');
		else if (arg === '--profile') options.profile = args[++index];
		else if (arg === '--runs') options.runs = Number(args[++index]);
		else if (arg === '--output') options.output = args[++index];
		else if (arg === '--budgets') options.budgets = resolve(args[++index]);
		else if (arg === '--prebuilt') options.prebuilt = true;
		else if (arg === '--enforce-budgets') options.enforce = true;
		else if (arg === '--inject-delay-ms') options.injectedDelayMs = Number(args[++index]);
		else if (arg === '--port') options.port = Number(args[++index]);
		else throw new Error(`Unknown mode argument: ${arg}`);
	}
	if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 100)
		throw new Error('--runs must be 1 through 100.');
	if (
		!Number.isFinite(options.injectedDelayMs) ||
		options.injectedDelayMs < 0 ||
		options.injectedDelayMs > 2000
	)
		throw new Error('--inject-delay-ms must be 0 through 2000.');
	if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535)
		throw new Error('Invalid port.');
	return options;
}

export async function modesMain(args) {
	const options = parse(args);
	if (options.list) {
		console.log(JSON.stringify(modeMatrix(), null, 2));
		return;
	}
	if (options.fixture) {
		console.log(JSON.stringify(modeFixture(options.fixture)));
		return;
	}
	if (!options.output || !isAbsolute(options.output))
		throw new Error('--output must be an absolute path outside the repository.');
	const fromRoot = relative(root, resolve(options.output));
	if (!fromRoot.startsWith(`..${sep}`) && fromRoot !== '..')
		throw new Error('--output must be outside the repository.');
	if (!options.caseIds.length || new Set(options.caseIds).size !== options.caseIds.length)
		throw new Error('Select unique --cases from --list.');
	const matrix = modeMatrix();
	const selected = options.caseIds.map((id) => {
		const entry = matrix.cases.find((value) => value.id === id);
		if (!entry) throw new Error(`Unknown mode case: ${id}`);
		return entry;
	});
	const budgets = JSON.parse(await readFile(options.budgets, 'utf8'));
	const profile = budgets.modes?.profiles?.[options.profile];
	if (!profile) throw new Error(`Unknown mode profile: ${options.profile}`);
	const source = testSource();
	const report = {
		schema: 'deckmark-mode-bench/1',
		evidenceKind: 'browser-run',
		generatedAt: new Date().toISOString(),
		profile: options.profile,
		target: profile.target,
		edition: profile.edition,
		buildMode: profile.buildMode,
		renderer: { name: profile.renderer, version: 'unavailable' },
		source: {
			revision: source.source,
			tree: source.sourceTree,
			diffSha256: source.workingDiffSha256,
			untrackedSha256: Object.fromEntries(
				source.untracked.map((entry) => [entry.path, entry.sha256])
			),
			buildTreeSha256: null
		},
		environment: { ...environmentIdentity(), runner: process.env.RUNNER_NAME ?? hostname() },
		command: [process.execPath, ...process.argv.slice(1)],
		plan: { caseIds: options.caseIds, runs: options.runs },
		methods: structuredClone(modeMethods),
		injectedDelayMs: options.injectedDelayMs,
		limits: [
			'The Read first-content clock is the mode click to the first article text. It includes script and parse work, not compositor paint.',
			'Read samples reload the page and switch from Source to Read, so each sample is a cold render.',
			'The slide input clock uses a trusted beforeinput event and a textarea selection. It is not a physical key or an IME.',
			'The slide save clock includes polling and the 400 ms draft delay; it is not pure transaction CPU.',
			'Only Read, slide text and slide notes have adapters. Other modes and native stress transport remain unavailable.',
			'Reports are strict only with enforced budgets, a clean source tree and an external artifact receipt.'
		],
		cases: [],
		failures: []
	};
	try {
		if (profile.target !== 'web')
			throw new Error(
				'Native mode transport is not implemented. A browser report cannot satisfy a native profile.'
			);
		if (!options.prebuilt)
			throw new Error(
				'Mode browser runs require --prebuilt and verified production build provenance.'
			);
		execFileSync(
			process.execPath,
			[
				'scripts/build-provenance.mjs',
				'verify',
				'--kind',
				'web-benchmark',
				'--instrumentation',
				'none'
			],
			{ cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }
		);
		const provenance = JSON.parse(
			await readFile(resolve(root, 'build/build-provenance.json'), 'utf8')
		);
		report.source.buildTreeSha256 = provenance.tree.sha256;
		report.buildProvenance = provenance;
		const { runModesWeb } = await import('./benchmark-modes-web.mjs');
		await runModesWeb({ report, selected, options });
	} catch (error) {
		report.failures.push(String(error.stack ?? error));
		for (const entry of selected) {
			if (report.cases.some((value) => value.id === entry.id)) continue;
			report.cases.push({
				id: entry.id,
				status: 'unavailable',
				reason: String(error),
				samples: []
			});
		}
	}
	report.source.after = sourceIdentity(testSource());
	try {
		report.audit = await auditModes(report, budgets, options.caseIds, options.enforce);
	} catch (error) {
		report.audit = { schema: 'deckmark-mode-audit/1', status: 'failed', failures: [String(error)] };
	}
	await writeFile(options.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
	console.log(
		JSON.stringify(
			{
				output: options.output,
				failures: report.failures,
				audit: report.audit,
				cases: report.cases.map(({ id, status, reason }) => ({ id, status, reason }))
			},
			null,
			2
		)
	);
	if (
		report.failures.length ||
		report.cases.some((entry) => entry.status !== 'passed') ||
		(options.enforce && report.audit.status !== 'ok')
	)
		process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	await modesMain(process.argv.slice(2));
}

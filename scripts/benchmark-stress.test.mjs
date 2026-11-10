import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { stressFixture } from './benchmark-fixtures/stress.mjs';

const root = resolve(import.meta.dirname, '..');
const directory = mkdtempSync(join(tmpdir(), 'deckmark-stress-controls-'));
const digest = (text) => createHash('sha256').update(text).digest('hex');
const caseId = 'source/markdown-50kb/lib-0';
const profile = 'web-light-chromium-production';
let sequence = 0;
let invocation = 0;
console.log(
	JSON.stringify({ stressControlArtifacts: directory, evidenceKind: 'synthetic-control' })
);

const method = {
	version: 'codemirror-insert/1',
	clock: 'performance.now',
	start: 'target-beforeinput-capture',
	inputToFrameMs: 'second-animation-frame',
	inputDispatchMs: 'queued-microtask',
	saveObservedMs: 'after-exact-indexeddb-observation',
	insertion: 'x',
	positions: [
		{ id: 'start', ratio: 0.02 },
		{ id: 'middle', ratio: 0.5 },
		{ id: 'end', ratio: 0.98 }
	],
	offset: 'Math.round(currentUtf16Length*ratio)',
	warmups: 0,
	framesBeforeInput: 2,
	idleAfterSampleMs: 550,
	statistic: 'nearest-rank',
	percentiles: [0.5, 0.95],
	decimals: 3
};
const canonical = (value) =>
	JSON.stringify(value, (_key, item) =>
		item && typeof item === 'object' && !Array.isArray(item)
			? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
			: item
	);
const state = (text) => ({
	editorSha256: digest(text),
	storedSha256: digest(text),
	editorOrigin: 'codemirror-state-doc',
	storedOrigin: 'indexeddb-drafts-row'
});
const key = (value, code) => ({
	key: value,
	code,
	ctrl: true,
	meta: false,
	shift: false,
	trusted: true,
	targetIsEditor: true
});
const inputFiles = [
	'package.json',
	'package-lock.json',
	'vite.config.ts',
	'tsconfig.json',
	'scripts/build-edition.mjs',
	'scripts/generate-service-worker.mjs',
	'scripts/patch-milkdown-images.mjs',
	'.github/workflows/deploy.yml',
	'.github/workflows/desktop.yml'
];

function cli(script, args) {
	const argv = [join(root, 'scripts', script), ...args];
	const result = spawnSync(process.execPath, argv, {
		cwd: root,
		encoding: 'utf8',
		maxBuffer: 32 * 1024 * 1024,
		timeout: 30_000
	});
	const artifact = join(directory, 'cli-' + invocation++);
	writeFileSync(artifact + '.stdout', result.stdout ?? '');
	writeFileSync(artifact + '.stderr', result.stderr ?? '');
	writeFileSync(
		artifact + '.json',
		JSON.stringify(
			{
				command: [process.execPath, ...argv],
				cwd: root,
				exitCode: result.status,
				signal: result.signal,
				error: result.error?.message ?? null,
				stdout: artifact + '.stdout',
				stderr: artifact + '.stderr'
			},
			null,
			2
		) + '\n'
	);
	return result;
}

function control() {
	const budgets = JSON.parse(readFileSync(join(root, 'scripts/benchmark-budgets.json'), 'utf8'));
	budgets.stress ??= { version: 1, minimumRuns: 20, profiles: {} };
	budgets.stress.profiles[profile] = {
		target: 'web',
		edition: 'web',
		renderer: 'chromium',
		buildMode: 'production-static',
		role: 'blocking',
		review: 'Synthetic CLI control only. Not a product baseline.',
		evidenceKind: 'synthetic-control',
		limits: { inputToFrameMs: 50, inputDispatchMs: 30, saveObservedMs: 2000 },
		resourceLimits: { domNodes: 1000, canvasPixels: 0, heapBytes: 1000000 }
	};
	const { content, ...fixture } = stressFixture('markdown-50kb');
	const prefix = join(directory, 'sidecars-' + sequence++);
	fixture.path = prefix + '.fixture.md';
	writeFileSync(fixture.path, content);
	let expected = content;
	let previous = content;
	const samples = Array.from({ length: 20 }, (_, index) => {
		previous = expected;
		const offset = Math.round(expected.length * method.positions[index % 3].ratio);
		expected = expected.slice(0, offset) + 'x' + expected.slice(offset);
		return {
			index,
			status: 'passed',
			operation: 'insert',
			insertedText: 'x',
			offset,
			position: method.positions[index % 3].id,
			sourceLength: previous.length,
			selection: { anchor: offset, head: offset },
			input: { trusted: true, type: 'insertText', targetIsEditor: true },
			metrics: { inputToFrameMs: 12, inputDispatchMs: 2, saveObservedMs: 420 },
			fidelity: {
				expectedSha256: digest(expected),
				...state(expected),
				beforeEditorSha256: digest(previous)
			},
			optional: {
				longTasks: { supported: true, unit: 'ms', values: [] },
				heap: {
					supported: true,
					unit: 'bytes',
					value: 12345,
					origin: 'performance.memory-estimate'
				},
				...Object.fromEntries(
					['transactionCpu', 'preview', 'validation', 'postIdleCpu', 'rss'].map((name) => [
						name,
						{ supported: false, reason: 'Synthetic explicit unsupported ' + name }
					])
				)
			},
			resources: {
				units: { domNodes: 'count', canvasDimensions: 'backing-pixels' },
				domNodes: 500,
				canvases: []
			}
		};
	});
	const exported = {
		path: prefix + '.export.md',
		name: fixture.name,
		bytes: Buffer.byteLength(expected),
		sha256: digest(expected)
	};
	writeFileSync(exported.path, expected);
	const clean = {
		revision: 'a'.repeat(40),
		tree: 'b'.repeat(40),
		diffSha256: digest(''),
		untrackedSha256: {}
	};
	const provenance = {
		schemaVersion: 1,
		kind: 'web-benchmark',
		source: clean.revision,
		sourceTree: clean.tree,
		edition: 'web',
		basePath: '',
		buildMode: 'production-static',
		instrumentation: 'none',
		inputs: Object.fromEntries(inputFiles.map((name) => [name, digest(name)])),
		builder: { node: 'v22.23.4', platform: 'linux', arch: 'x64' },
		tree: { files: 1, sha256: digest('synthetic build bytes') }
	};
	const sentinel = 'Stable sentinel content.\n';
	const report = {
		schema: 'deckmark-stress/2',
		evidenceKind: 'synthetic-control',
		method: structuredClone(method),
		profile,
		target: 'web',
		edition: 'web',
		buildMode: 'production-static',
		renderer: { name: 'chromium', version: 'synthetic-control' },
		source: { ...clean, buildTreeSha256: provenance.tree.sha256, after: structuredClone(clean) },
		buildProvenance: provenance,
		injectedDelayMs: 0,
		environment: {
			os: { platform: 'linux', release: 'control', arch: 'x64' },
			runner: 'synthetic-control',
			node: 'v22.23.4'
		},
		command: ['synthetic-control'],
		plan: { caseIds: [caseId], runs: 20 },
		cases: [
			{
				id: caseId,
				status: 'passed',
				fixture,
				workload: {
					mode: 'source',
					library: { count: 0, totalRows: 2, idsSha256: digest('[]'), rowsSha256: digest('[]') }
				},
				samples,
				export: exported,
				finalExpected: { bytes: Buffer.byteLength(expected), sha256: digest(expected) },
				history: {
					platform: 'Linux x86_64',
					mainId: 'stress-main',
					undoShortcut: 'ControlOrMeta+z',
					redoShortcut: 'Control+y',
					redoKeys: [key('y', 'KeyY')],
					main: {
						beforeUndo: state(expected),
						afterUndo: state(previous),
						afterRedo: state(expected),
						undoKeys: [key('z', 'KeyZ')]
					},
					sentinel: {
						id: 'stress-sentinel',
						initial: state(sentinel),
						afterInsert: state(sentinel + 'x'),
						afterUndo: state(sentinel),
						undoKeys: [key('z', 'KeyZ')]
					},
					fileReturn: state(expected)
				},
				reload: {
					activeId: 'stress-main',
					main: state(expected),
					sentinelStoredSha256: digest(sentinel),
					storedOrigin: 'indexeddb-drafts-row'
				},
				fidelity: { saved: true, exported: true, perFileUndo: true, redo: true, recovered: true }
			}
		]
	};
	const receipt = {
		schema: 'deckmark-stress-artifact-trust/1',
		scope: 'external-artifact-byte-review',
		evidenceKind: 'synthetic-control',
		reviewer: 'Synthetic CLI control, no real browser execution attested',
		reviewedAt: '2026-01-01T00:00:00.000Z',
		source: { revision: clean.revision, tree: clean.tree },
		provenanceSha256: digest(canonical(provenance)),
		buildTree: structuredClone(provenance.tree),
		inputs: structuredClone(provenance.inputs),
		files: Object.fromEntries(
			[fixture, exported].map((entry) => [entry.path, { bytes: entry.bytes, sha256: entry.sha256 }])
		)
	};
	return { budgets, report, receipt };
}

function audit(change = () => {}, extra = []) {
	const value = control();
	change(value);
	const prefix = join(directory, String(sequence++));
	writeFileSync(prefix + '-report.json', JSON.stringify(value.report));
	writeFileSync(prefix + '-budgets.json', JSON.stringify(value.budgets));
	value.receipt.reportSha256 = digest(readFileSync(prefix + '-report.json'));
	writeFileSync(prefix + '-receipt.json', JSON.stringify(value.receipt));
	return cli('benchmark-gate.mjs', [
		'--suite',
		'stress',
		'--report',
		prefix + '-report.json',
		'--budgets',
		prefix + '-budgets.json',
		'--cases',
		(value.caseIds ?? [caseId]).join(','),
		...(!value.omitReceipt
			? [
					'--receipt',
					prefix + '-receipt.json',
					'--receipt-sha256',
					digest(readFileSync(prefix + '-receipt.json'))
				]
			: []),
		...extra
	]);
}

test('lists all requested mode and fixture tiers without starting a browser', () => {
	const run = cli('benchmark-local.mjs', ['--suite', 'stress', '--list']);
	assert.equal(run.status, 0, run.stderr);
	const matrix = JSON.parse(run.stdout);
	for (const mode of [
		'source',
		'code',
		'json',
		'split',
		'wysiwyg',
		'read',
		'annotation',
		'slide-canvas',
		'slide-text',
		'slide-notes',
		'slide-source'
	]) {
		assert.ok(
			matrix.cases.some((entry) => entry.mode === mode),
			mode
		);
	}
	for (const fixture of [
		'markdown-1mb',
		'markdown-5mb',
		'line-1mb',
		'headings-1000',
		'rich-markdown',
		'json-1mb',
		'json-5mb',
		'json-10mb',
		'deck-20',
		'deck-100',
		'deck-300'
	]) {
		assert.ok(
			matrix.fixtures.some((entry) => entry.id === fixture),
			fixture
		);
	}
	for (const count of [300, 900, 3000])
		assert.ok(matrix.cases.some((entry) => entry.library === count));
});

test('generates reproducible exact-size JSON and a one-megabyte single line', () => {
	for (const [id, bytes] of [
		['json-1mb', 1_000_000],
		['json-5mb', 5_000_000],
		['json-10mb', 10_000_000],
		['line-1mb', 1_000_000]
	]) {
		const first = cli('benchmark-stress.mjs', ['--fixture', id]);
		assert.equal(first.status, 0, first.stderr);
		const fixture = JSON.parse(first.stdout);
		assert.equal(Buffer.byteLength(fixture.content), bytes);
		assert.equal(fixture.sha256, digest(fixture.content));
		if (id.startsWith('json')) assert.equal(typeof JSON.parse(fixture.content).payload, 'string');
		else assert.equal(fixture.content.includes('\n'), false);
		const second = cli('benchmark-stress.mjs', ['--fixture', id]);
		assert.equal(first.stdout, second.stdout);
	}
});

test('accepts complete raw evidence against explicit synthetic reviewed limits', () => {
	const run = audit();
	assert.equal(run.status, 0, run.stderr + run.stdout);
	const result = JSON.parse(run.stdout);
	assert.equal(result.status, 'ok');
	assert.equal(result.cases[caseId].metrics.inputToFrameMs.runs, 20);
	assert.equal(result.cases[caseId].metrics.inputToFrameMs.p95, 12);
});

const malformed = [
	[
		'missing case',
		({ report }) => {
			report.cases = [];
		}
	],
	[
		'missing raw metric',
		({ report }) => {
			delete report.cases[0].samples[0].metrics.inputToFrameMs;
		}
	],
	[
		'aborted sample',
		({ report }) => {
			report.cases[0].samples[0].status = 'aborted';
		}
	],
	[
		'dropped sample',
		({ report }) => {
			report.cases[0].samples.pop();
		}
	],
	[
		'duplicate sample',
		({ report }) => {
			report.cases[0].samples[1].index = 0;
		}
	],
	[
		'negative metric',
		({ report }) => {
			report.cases[0].samples[0].metrics.inputDispatchMs = -1;
		}
	],
	[
		'low count',
		({ report }) => {
			report.plan.runs = 5;
			report.cases[0].samples.length = 5;
		}
	],
	[
		'wrong profile',
		({ report }) => {
			report.buildMode = 'debug';
		}
	],
	[
		'missing source',
		({ report }) => {
			delete report.source.tree;
		}
	],
	[
		'lost bytes',
		({ report }) => {
			report.cases[0].samples[0].fidelity.storedSha256 = digest('lost');
		}
	],
	[
		'missing export',
		({ report }) => {
			delete report.cases[0].fidelity.exported;
		}
	],
	[
		'wrong undo',
		({ report }) => {
			report.cases[0].fidelity.perFileUndo = false;
		}
	],
	[
		'unknown optional metric support',
		({ report }) => {
			report.cases[0].samples[0].optional.longTasks = { supported: false };
		}
	],
	[
		'unreviewed limits',
		({ budgets }) => {
			budgets.stress.profiles[profile].role = 'report-only';
		}
	],
	[
		'missing limit',
		({ budgets }) => {
			delete budgets.stress.profiles[profile].limits.inputToFrameMs;
		}
	]
];
malformed.push(
	[
		'G1 absent method',
		({ report }) => {
			delete report.method;
		}
	],
	[
		'G1 wrong method version',
		({ report }) => {
			report.method.version = 'unknown';
		}
	],
	[
		'G1 changed clock boundary',
		({ report }) => {
			report.method.start = 'after-driver-return';
		}
	],
	[
		'G1 changed warmups',
		({ report }) => {
			report.method.warmups = 1;
		}
	],
	[
		'G1 absent input schedule',
		({ report }) => {
			for (const sample of report.cases[0].samples)
				for (const field of ['input', 'position', 'operation', 'offset']) delete sample[field];
		}
	],
	[
		'G1 untrusted paste',
		({ report }) => {
			for (const sample of report.cases[0].samples)
				sample.input = { trusted: false, type: 'insertFromPaste', targetIsEditor: true };
		}
	],
	[
		'G1 wrong input target',
		({ report }) => {
			report.cases[0].samples[0].input.targetIsEditor = false;
		}
	],
	[
		'G1 identical positions',
		({ report }) => {
			for (const sample of report.cases[0].samples) sample.position = 'start';
		}
	],
	[
		'G1 wrong offset',
		({ report }) => {
			report.cases[0].samples[0].offset += 1;
		}
	],
	[
		'G1 invalid selection',
		({ report }) => {
			report.cases[0].samples[0].selection.head += 1;
		}
	],
	[
		'G1 absent source length',
		({ report }) => {
			delete report.cases[0].samples[0].sourceLength;
		}
	],
	[
		'G1 wrong insertion',
		({ report }) => {
			report.cases[0].samples[0].insertedText = 'other';
		}
	],
	[
		'G1 wrong before editor hash',
		({ report }) => {
			report.cases[0].samples[0].fidelity.beforeEditorSha256 = digest('wrong');
		}
	],
	[
		'G2 relabeled workload',
		(value) => {
			const id = 'source/markdown-1mb/lib-0';
			value.report.cases[0].id = id;
			value.report.plan.caseIds = [id];
			value.caseIds = [id];
		}
	],
	[
		'G2 wrong fixture arguments',
		({ report }) => {
			report.cases[0].fixture.arguments.id = 'markdown-1mb';
		}
	],
	[
		'G2 wrong fixture hash',
		({ report }) => {
			report.cases[0].fixture.sha256 = digest('wrong fixture');
		}
	],
	[
		'G2 wrong mode',
		({ report }) => {
			report.cases[0].workload.mode = 'json';
		}
	],
	[
		'G2 wrong library',
		({ report }) => {
			report.cases[0].workload.library.count = 300;
		}
	],
	[
		'G2 wrong library membership',
		({ report }) => {
			report.cases[0].workload.library.idsSha256 = digest('wrong ids');
		}
	],
	[
		'G2 absent provenance',
		({ report }) => {
			delete report.buildProvenance;
		}
	],
	[
		'G2 conflicting source identity',
		({ report }) => {
			report.source.revision = 'c'.repeat(40);
			report.source.tree = 'd'.repeat(40);
			report.source.buildTreeSha256 = 'e'.repeat(64);
		}
	],
	[
		'G2 dirty diff',
		({ report }) => {
			report.source.diffSha256 = digest('dirty');
		}
	],
	[
		'G2 untracked source',
		({ report }) => {
			report.source.untrackedSha256 = { 'file.txt': digest('untracked') };
		}
	],
	[
		'G2 dirty ending source',
		({ report }) => {
			report.source.after.diffSha256 = digest('changed while collecting');
		}
	],
	[
		'G2 source changed during collection',
		({ report }) => {
			report.source.after.revision = 'c'.repeat(40);
		}
	],
	[
		'G2 wrong build instrumentation',
		({ report }) => {
			report.buildProvenance.instrumentation = 'source-fidelity';
		}
	],
	[
		'G2 mismatched builder',
		({ report }) => {
			report.buildProvenance.builder.platform = 'darwin';
		}
	],
	[
		'G2 missing provenance input',
		({ report }) => {
			delete report.buildProvenance.inputs['package-lock.json'];
		}
	],
	[
		'G2 absent external receipt',
		(value) => {
			value.omitReceipt = true;
		}
	],
	[
		'G2 wrong external provenance digest',
		({ receipt }) => {
			receipt.provenanceSha256 = digest('wrong provenance');
		}
	],
	[
		'G2 wrong external build receipt',
		({ receipt }) => {
			receipt.buildTree.sha256 = digest('wrong build');
		}
	],
	[
		'G2 unbound synthetic evidence kind',
		({ report }) => {
			report.evidenceKind = 'browser-run';
		}
	],
	[
		'G3 absent capabilities and resources',
		({ report }) => {
			for (const sample of report.cases[0].samples) {
				delete sample.optional;
				delete sample.resources;
			}
		}
	],
	[
		'G3 empty capabilities',
		({ report }) => {
			report.cases[0].samples[0].optional = {};
		}
	],
	[
		'G3 invalid supported heap',
		({ report }) => {
			report.cases[0].samples[0].optional.heap = { supported: true, unit: 'wrong', value: -1 };
		}
	],
	[
		'G3 absent long-task values',
		({ report }) => {
			delete report.cases[0].samples[0].optional.longTasks.values;
		}
	],
	[
		'G3 invalid long-task value',
		({ report }) => {
			report.cases[0].samples[0].optional.longTasks.values = [-1];
		}
	],
	[
		'G3 invented transaction CPU',
		({ report }) => {
			report.cases[0].samples[0].optional.transactionCpu = {
				supported: true,
				unit: 'ms',
				value: 0
			};
		}
	],
	[
		'G3 unsupported value pretending zero',
		({ report }) => {
			report.cases[0].samples[0].optional.rss.value = 0;
		}
	],
	[
		'G3 absent resources',
		({ report }) => {
			delete report.cases[0].samples[0].resources;
		}
	],
	[
		'G3 invalid DOM count',
		({ report }) => {
			report.cases[0].samples[0].resources.domNodes = -1;
		}
	],
	[
		'G3 invalid canvas backing dimension',
		({ report }) => {
			report.cases[0].samples[0].resources.canvases = [{ width: 10, height: -1 }];
		}
	],
	[
		'G3 invalid resource unit',
		({ report }) => {
			report.cases[0].samples[0].resources.units.domNodes = 'ms';
		}
	],
	[
		'G3 resource limit exceeded',
		({ report, budgets }) => {
			budgets.stress.profiles[report.profile].resourceLimits.domNodes = 1;
		}
	],
	[
		'G3 resource limits unreviewed',
		({ report, budgets }) => {
			budgets.stress.profiles[report.profile].resourceLimits = null;
		}
	],
	[
		'G3 unknown resource limit',
		({ report, budgets }) => {
			budgets.stress.profiles[report.profile].resourceLimits.unknown = 1;
		}
	],
	[
		'G3 configured unsupported heap sample',
		({ report }) => {
			report.cases[0].samples[0].optional.heap = {
				supported: false,
				reason: 'Synthetic engine heap unavailable for this sample'
			};
		}
	],
	[
		'G3 configured unsupported RSS',
		({ report, budgets }) => {
			budgets.stress.profiles[report.profile].resourceLimits.rssBytes = 100;
		}
	],
	[
		'G4 absent export and history evidence',
		({ report }) => {
			delete report.cases[0].export;
			delete report.cases[0].history;
		}
	],
	[
		'G4 contradictory export hash',
		({ report }) => {
			report.cases[0].export.sha256 = digest('wrong export');
		}
	],
	[
		'G4 contradictory export name',
		({ report }) => {
			report.cases[0].export.name = 'wrong.md';
		}
	],
	[
		'G4 contradictory export byte count',
		({ report }) => {
			report.cases[0].export.bytes = 1;
		}
	],
	[
		'G4 changed export sidecar bytes',
		({ report }) => {
			writeFileSync(report.cases[0].export.path, 'lost bytes');
		}
	],
	[
		'G4 absent main undo state',
		({ report }) => {
			delete report.cases[0].history.main.afterUndo;
		}
	],
	[
		'G4 stale durable undo state',
		({ report }) => {
			report.cases[0].history.main.afterUndo.storedSha256 =
				report.cases[0].history.main.beforeUndo.storedSha256;
		}
	],
	[
		'G4 lost sentinel undo',
		({ report }) => {
			report.cases[0].history.sentinel.afterUndo = report.cases[0].history.sentinel.afterInsert;
		}
	],
	[
		'G4 no real redo event',
		({ report }) => {
			report.cases[0].history.redoKeys = [];
		}
	],
	[
		'G4 untrusted undo event',
		({ report }) => {
			report.cases[0].history.main.undoKeys[0].trusted = false;
		}
	],
	[
		'G4 storage substituted for editor origin',
		({ report }) => {
			report.cases[0].samples[0].fidelity.editorOrigin = 'indexeddb-drafts-row';
		}
	],
	[
		'G4 absent reload observation',
		({ report }) => {
			delete report.cases[0].reload;
		}
	],
	[
		'G4 wrong reload file',
		({ report }) => {
			report.cases[0].reload.activeId = 'stress-sentinel';
		}
	],
	[
		'G4 wrong final expected bytes',
		({ report }) => {
			report.cases[0].finalExpected.bytes = 1;
		}
	],
	[
		'old incomplete schema',
		({ report }) => {
			report.schema = 'deckmark-stress/1';
		}
	]
);
for (const [name, change] of malformed) {
	test(`rejects ${name} with a nonzero process exit`, () => {
		const run = audit(change);
		assert.equal(run.status, 1, run.stderr + run.stdout);
		assert.equal(JSON.parse(run.stdout).status, 'failed');
	});
}

test('rejects an external receipt whose pinned byte digest differs', () => {
	const run = audit(() => {}, ['--receipt-sha256', 'f'.repeat(64)]);
	assert.equal(run.status, 1, run.stderr + run.stdout);
	assert.match(run.stdout, /receipt/);
});

test('rejects an injected raw latency regression instead of trusting a forged summary', () => {
	const run = audit(({ report }) => {
		for (const sample of report.cases[0].samples) sample.metrics.inputToFrameMs = 100;
		report.cases[0].summary = { inputToFrameMs: { p95: 1, runs: 20 } };
	});
	assert.equal(run.status, 1, run.stderr + run.stdout);
	assert.match(run.stdout, /over-budget/);
});

test('enforces the configured Chromium stress profile against a raw tail increase', () => {
	const configured = JSON.parse(readFileSync(join(root, 'scripts/benchmark-budgets.json'), 'utf8'))
		.stress.profiles[profile];
	const run = audit(({ budgets, report, receipt }) => {
		budgets.stress.profiles[profile] = configured;
		report.evidenceKind = 'browser-run';
		receipt.evidenceKind = 'browser-run';
		for (const sample of report.cases[0].samples)
			sample.metrics.inputToFrameMs = configured.limits.inputToFrameMs + 1;
	});
	assert.equal(run.status, 1, run.stderr + run.stdout);
	assert.match(run.stdout, /inputToFrameMs:over-budget/);
});

test('accepts the configured Chromium stress profile within its limits', () => {
	const configured = JSON.parse(readFileSync(join(root, 'scripts/benchmark-budgets.json'), 'utf8'))
		.stress.profiles[profile];
	const run = audit(({ budgets, report, receipt }) => {
		budgets.stress.profiles[profile] = configured;
		report.evidenceKind = 'browser-run';
		receipt.evidenceKind = 'browser-run';
	});
	assert.equal(run.status, 0, run.stderr + run.stdout);
	assert.equal(JSON.parse(run.stdout).status, 'ok');
});

test('report-only mode discloses low counts and does not claim a strict pass', () => {
	const run = audit(
		({ report }) => {
			report.plan.runs = 5;
			report.cases[0].samples.length = 5;
		},
		['--report-only']
	);
	assert.equal(run.status, 0, run.stderr + run.stdout);
	const result = JSON.parse(run.stdout);
	assert.equal(result.enforced, false);
	assert.equal(result.status, 'failed');
	assert.match(run.stdout, /tail.*insufficient/);
});

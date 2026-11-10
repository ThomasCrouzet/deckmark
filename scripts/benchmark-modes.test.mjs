import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { modeFixture } from './benchmark-fixtures/modes.mjs';
import { modeMethods } from './benchmark-modes-contract.mjs';
import { libraryIdentity, provenanceInputs, sha256 } from './benchmark-stress-contract.mjs';

const root = resolve(import.meta.dirname, '..');
const directory = mkdtempSync(join(tmpdir(), 'deckmark-mode-controls-'));
const profile = 'web-light-chromium-production';
let sequence = 0;
const digest = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) =>
	JSON.stringify(value, (_key, item) =>
		item && typeof item === 'object' && !Array.isArray(item)
			? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
			: item
	);

function cli(args) {
	const argv = [join(root, 'scripts', 'benchmark-modes-audit.mjs'), ...args];
	const result = spawnSync(process.execPath, argv, {
		cwd: root,
		encoding: 'utf8',
		maxBuffer: 32 * 1024 * 1024,
		timeout: 30_000
	});
	writeFileSync(
		join(directory, `control-${sequence++}.json`),
		JSON.stringify(
			{ argv, status: result.status, stdout: result.stdout, stderr: result.stderr },
			null,
			2
		)
	);
	return result;
}

function control() {
	const budgets = JSON.parse(readFileSync(join(root, 'scripts/benchmark-budgets.json'), 'utf8'));
	budgets.modes.profiles[profile] = {
		...budgets.modes.profiles[profile],
		role: 'blocking',
		review: 'Synthetic CLI control only. Not a product baseline.',
		evidenceKind: 'synthetic-control',
		limits: {
			readFirstContentMs: 100,
			readFullRenderMs: 200,
			slideInputToFrameMs: 20,
			slideInputDispatchMs: 5,
			slideSaveObservedMs: 500
		},
		resourceLimits: { domNodes: 5000, canvasPixels: 0, heapBytes: 1000000 }
	};
	const readFixture = modeFixture('read-rich-30');
	const slideFixture = modeFixture('deck-20');
	const prefix = join(directory, `case-${sequence++}`);
	const readFixturePath = `${prefix}.read.fixture.md`;
	const readExportPath = `${prefix}.read.export.md`;
	const slideFixturePath = `${prefix}.slide.fixture.md`;
	const slideExportPath = `${prefix}.slide.export.md`;
	writeFileSync(readFixturePath, readFixture.content);
	writeFileSync(readExportPath, readFixture.content);
	writeFileSync(slideFixturePath, slideFixture.content);
	const readDescriptor = { ...readFixture, content: undefined, path: readFixturePath };
	const slideDescriptor = { ...slideFixture, content: undefined, path: slideFixturePath };
	const initialField = '# Benchmark slide 0\n\nStable slide text.';
	let field = initialField;
	const slideSamples = Array.from({ length: 20 }, (_, index) => {
		const position = modeMethods.slide.positions[index % 3];
		const offset = Math.round(field.length * position.ratio);
		const next = field.slice(0, offset) + 'x' + field.slice(offset);
		const sample = {
			index,
			status: 'passed',
			position: position.id,
			operation: 'insert',
			insertedText: 'x',
			offset,
			sourceLength: field.length,
			input: { trusted: true, type: 'insertText', targetIsEditor: true },
			metrics: { inputToFrameMs: 10, inputDispatchMs: 1, saveObservedMs: 400 },
			fidelity: {
				expectedFieldSha256: digest(next),
				storedSha256: digest(next),
				storedOrigin: 'indexeddb-drafts-row'
			},
			optional: {
				longTasks: { supported: true, unit: 'ms', values: [] },
				heap: {
					supported: true,
					unit: 'bytes',
					origin: 'performance.memory-estimate',
					value: 1000
				},
				...Object.fromEntries(
					['transactionCpu', 'preview', 'validation', 'postIdleCpu', 'rss'].map((name) => [
						name,
						{ supported: false, reason: `Synthetic unsupported ${name}` }
					])
				)
			},
			resources: {
				units: { domNodes: 'count', canvasDimensions: 'backing-pixels' },
				domNodes: 100,
				canvases: []
			}
		};
		field = next;
		return sample;
	});
	writeFileSync(slideExportPath, `synthetic final source ${field}`);
	const slideExportHash = sha256(`synthetic final source ${field}`);
	const readSamples = Array.from({ length: 20 }, (_, index) => ({
		index,
		status: 'passed',
		metrics: { firstContentMs: 50, fullRenderMs: 150, diagramCount: 30 },
		fidelity: {
			tail: true,
			diagramCount: true,
			sourceSha256: readFixture.sha256,
			fixtureSha256: readFixture.sha256
		},
		optional: {
			longTasks: { supported: true, unit: 'ms', values: [] },
			heap: {
				supported: true,
				unit: 'bytes',
				origin: 'performance.memory-estimate',
				value: 1000
			},
			...Object.fromEntries(
				['transactionCpu', 'preview', 'validation', 'postIdleCpu', 'rss'].map((name) => [
					name,
					{ supported: false, reason: `Synthetic unsupported ${name}` }
				])
			)
		},
		resources: {
			units: { domNodes: 'count', canvasDimensions: 'backing-pixels' },
			domNodes: 100,
			canvases: []
		}
	}));
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
		inputs: Object.fromEntries(provenanceInputs.map((name) => [name, digest(name)])),
		builder: { node: 'v22.23.4', platform: 'linux', arch: 'x64' },
		tree: { files: 1, sha256: digest('synthetic build bytes') }
	};
	const report = {
		schema: 'deckmark-mode-bench/1',
		evidenceKind: 'synthetic-control',
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
		plan: {
			caseIds: ['read/read-rich-30/lib-0', 'slide-text/deck-20/lib-0'],
			runs: 20
		},
		methods: structuredClone(modeMethods),
		cases: [
			{
				id: 'read/read-rich-30/lib-0',
				status: 'passed',
				fixture: readDescriptor,
				workload: { mode: 'read', library: libraryIdentity(0) },
				samples: readSamples,
				fidelity: { saved: true, exported: true, recovered: true },
				export: {
					path: readExportPath,
					name: readFixture.name,
					bytes: Buffer.byteLength(readFixture.content),
					sha256: readFixture.sha256
				}
			},
			{
				id: 'slide-text/deck-20/lib-0',
				status: 'passed',
				fixture: slideDescriptor,
				workload: { mode: 'slide-text', library: libraryIdentity(0) },
				samples: slideSamples,
				fidelity: { saved: true, exported: true, undo: true, redo: true, recovered: true },
				finalExpected: {
					bytes: Buffer.byteLength(`synthetic final source ${field}`),
					sha256: slideExportHash
				},
				export: {
					path: slideExportPath,
					name: slideFixture.name,
					bytes: Buffer.byteLength(`synthetic final source ${field}`),
					sha256: slideExportHash
				},
				reload: {
					fieldSha256: digest(field),
					storedSha256: slideExportHash,
					storedOrigin: 'indexeddb-drafts-row'
				}
			}
		]
	};
	const files = {};
	for (const path of [readFixturePath, readExportPath, slideFixturePath, slideExportPath]) {
		const bytes = readFileSync(path);
		files[path] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
	}
	const receipt = {
		schema: 'deckmark-stress-artifact-trust/1',
		scope: 'external-artifact-byte-review',
		evidenceKind: 'synthetic-control',
		reviewer: 'Synthetic CLI control',
		reviewedAt: '2026-01-01T00:00:00.000Z',
		source: { revision: clean.revision, tree: clean.tree },
		provenanceSha256: digest(canonical(provenance)),
		buildTree: structuredClone(provenance.tree),
		inputs: structuredClone(provenance.inputs),
		files
	};
	return { budgets, report, receipt };
}

function audit(change = () => {}) {
	const value = control();
	change(value);
	const prefix = join(directory, `audit-${sequence++}`);
	writeFileSync(`${prefix}-report.json`, JSON.stringify(value.report));
	writeFileSync(`${prefix}-budgets.json`, JSON.stringify(value.budgets));
	value.receipt.reportSha256 = digest(readFileSync(`${prefix}-report.json`));
	writeFileSync(`${prefix}-receipt.json`, JSON.stringify(value.receipt));
	return cli([
		'--report',
		`${prefix}-report.json`,
		'--budgets',
		`${prefix}-budgets.json`,
		'--cases',
		value.report.plan.caseIds.join(','),
		'--receipt',
		`${prefix}-receipt.json`,
		'--receipt-sha256',
		digest(readFileSync(`${prefix}-receipt.json`))
	]);
}

test('accepts complete Read and slide evidence against synthetic limits', () => {
	const run = audit();
	assert.equal(run.status, 0, run.stderr + run.stdout);
	const result = JSON.parse(run.stdout);
	assert.equal(result.status, 'ok');
	assert.equal(result.cases['read/read-rich-30/lib-0'].metrics.firstContentMs.runs, 20);
	assert.equal(result.cases['slide-text/deck-20/lib-0'].metrics.saveObservedMs.runs, 20);
});

const malformed = [
	['missing read sample', ({ report }) => report.cases[0].samples.pop()],
	[
		'missing slide metric',
		({ report }) => delete report.cases[1].samples[0].metrics.saveObservedMs
	],
	[
		'wrong read diagram count',
		({ report }) => (report.cases[0].samples[0].metrics.diagramCount = 29)
	],
	[
		'lost slide field bytes',
		({ report }) => (report.cases[1].samples[0].fidelity.expectedFieldSha256 = digest('lost'))
	],
	['missing export', ({ report }) => delete report.cases[1].export],
	['missing undo', ({ report }) => (report.cases[1].fidelity.undo = false)],
	['wrong final source', ({ report }) => (report.cases[1].finalExpected.sha256 = digest('wrong'))],
	['low runs', ({ report }) => (report.plan.runs = 5)],
	['wrong profile', ({ report }) => (report.buildMode = 'debug')],
	['missing receipt', ({ report }) => (report.source.tree = 'c'.repeat(40))]
];
for (const [name, change] of malformed) {
	test(`rejects ${name}`, () => {
		const run = audit(change);
		assert.equal(run.status, 1, run.stderr + run.stdout);
		assert.equal(JSON.parse(run.stdout).status, 'failed');
	});
}

test('rejects a raw tail increase under the configured profile limits', () => {
	const run = audit(({ report }) => {
		for (const sample of report.cases[1].samples) sample.metrics.saveObservedMs = 5000;
	});
	assert.equal(run.status, 1, run.stderr + run.stdout);
	assert.match(run.stdout, /saveObservedMs:over-budget/);
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const directory = mkdtempSync(join(tmpdir(), 'deckmark-stress-controls-'));
const digest = (text) => createHash('sha256').update(text).digest('hex');
const caseId = 'source/markdown-1mb/lib-0';
const profile = 'web-light-chromium-production';
let sequence = 0;

function cli(script, args) {
	return spawnSync(process.execPath, [join(root, 'scripts', script), ...args], {
		cwd: root,
		encoding: 'utf8',
		maxBuffer: 32 * 1024 * 1024,
		timeout: 30_000
	});
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
		limits: { inputToFrameMs: 50, inputDispatchMs: 30, saveObservedMs: 2000 }
	};
	const expectedHash = digest('Synthetic exact-byte control');
	const report = {
		schema: 'deckmark-stress/1',
		profile,
		target: 'web',
		edition: 'web',
		buildMode: 'production-static',
		renderer: { name: 'chromium', version: 'synthetic-control' },
		source: {
			revision: 'a'.repeat(40),
			tree: 'b'.repeat(40),
			diffSha256: digest(''),
			buildTreeSha256: digest('build'),
			untrackedSha256: {}
		},
		environment: {
			os: { platform: 'linux', release: 'control', arch: 'x64' },
			runner: 'synthetic-control'
		},
		command: ['synthetic-control'],
		plan: { caseIds: [caseId], runs: 20 },
		cases: [
			{
				id: caseId,
				status: 'passed',
				fixture: { id: 'markdown-1mb', bytes: 1_000_000, sha256: digest('fixture') },
				samples: Array.from({ length: 20 }, (_, index) => ({
					index,
					status: 'passed',
					position: ['start', 'middle', 'end'][index % 3],
					operation: 'insert',
					metrics: { inputToFrameMs: 12, inputDispatchMs: 2, saveObservedMs: 420 },
					fidelity: {
						expectedSha256: expectedHash,
						storedSha256: expectedHash,
						editorSha256: expectedHash
					},
					optional: { longTasks: { supported: false, reason: 'Synthetic unsupported engine' } }
				})),
				fidelity: { saved: true, exported: true, perFileUndo: true, redo: true, recovered: true }
			}
		]
	};
	return { budgets, report };
}

function audit(change = () => {}, extra = []) {
	const value = control();
	change(value);
	const prefix = join(directory, String(sequence++));
	writeFileSync(prefix + '-report.json', JSON.stringify(value.report));
	writeFileSync(prefix + '-budgets.json', JSON.stringify(value.budgets));
	return cli('benchmark-gate.mjs', [
		'--suite',
		'stress',
		'--report',
		prefix + '-report.json',
		'--budgets',
		prefix + '-budgets.json',
		'--cases',
		caseId,
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
			delete report.cases[0].samples[0].optional.longTasks.reason;
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
for (const [name, change] of malformed) {
	test(`rejects ${name} with a nonzero process exit`, () => {
		const run = audit(change);
		assert.equal(run.status, 1, run.stderr + run.stdout);
		assert.equal(JSON.parse(run.stdout).status, 'failed');
	});
}

test('rejects an injected raw latency regression instead of trusting a forged summary', () => {
	const run = audit(({ report }) => {
		for (const sample of report.cases[0].samples) sample.metrics.inputToFrameMs = 100;
		report.cases[0].summary = { inputToFrameMs: { p95: 1, runs: 20 } };
	});
	assert.equal(run.status, 1, run.stderr + run.stdout);
	assert.match(run.stdout, /over-budget/);
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

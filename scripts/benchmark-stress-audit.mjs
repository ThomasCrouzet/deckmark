import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { summarize } from './benchmark-shared.mjs';
import { stressMatrix } from './benchmark-fixtures/stress.mjs';

export const requiredStressMetrics = ['inputToFrameMs', 'inputDispatchMs', 'saveObservedMs'];
const hash = (value, length = 64) =>
	typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value);

export function auditStress(report, budgets, expectedCases, enforce = true) {
	const failures = [];
	const warnings = [];
	const cases = {};
	const fail = (value) => failures.push(value);
	if (report?.failures?.length) fail('recorded-run-failures');
	const profile = budgets.stress?.profiles?.[report?.profile];
	if (report?.schema !== 'deckmark-stress/1') fail('unsupported-schema');
	if (!profile) fail('unknown-profile');
	if (
		!Array.isArray(expectedCases) ||
		!expectedCases.length ||
		new Set(expectedCases).size !== expectedCases.length
	)
		fail('invalid-expected-cases');
	for (const key of ['target', 'edition', 'buildMode']) {
		if (!report?.[key] || report[key] !== profile?.[key]) fail(`profile-mismatch:${key}`);
	}
	if (!report?.renderer?.version || report.renderer.name !== profile?.renderer)
		fail('profile-mismatch:renderer');
	for (const [field, length] of [
		['revision', 40],
		['tree', 40],
		['diffSha256', 64],
		['buildTreeSha256', 64]
	]) {
		if (!hash(report?.source?.[field], length)) fail(`missing-source:${field}`);
	}
	if (!report?.source?.untrackedSha256 || typeof report.source.untrackedSha256 !== 'object')
		fail('missing-untracked-identity');
	if (
		!report?.environment?.os?.platform ||
		!report.environment.os.release ||
		!report.environment.os.arch ||
		!report.environment.runner
	)
		fail('missing-runtime-identity');
	if (!Array.isArray(report?.command) || !report.command.length) fail('missing-command');
	if (profile?.role !== 'blocking' || !profile?.review) fail('unreviewed-profile');
	for (const metric of requiredStressMetrics) {
		if (!Number.isFinite(profile?.limits?.[metric]) || profile.limits[metric] < 0)
			fail(`missing-limit:${metric}`);
	}
	const runs = report?.plan?.runs;
	const minimum = Math.max(20, budgets.stress?.minimumRuns ?? 20);
	if (!Number.isInteger(runs) || runs < minimum) {
		fail('too-few-runs');
		warnings.push('tail-estimate-insufficient: p95 below 20 samples is not stable tail evidence');
	}
	const planned = report?.plan?.caseIds;
	if (
		!Array.isArray(planned) ||
		JSON.stringify([...planned].sort()) !== JSON.stringify([...(expectedCases ?? [])].sort())
	)
		fail('case-plan-mismatch');
	const actual = Array.isArray(report?.cases) ? report.cases : [];
	const known = new Set(stressMatrix().cases.map((entry) => entry.id));
	if (
		actual.length !== expectedCases?.length ||
		new Set(actual.map((entry) => entry.id)).size !== actual.length
	)
		fail('case-count-mismatch');
	for (const id of expectedCases ?? []) {
		if (!known.has(id)) fail(`${id}:unknown-case`);
		const entry = actual.find((value) => value.id === id);
		if (!entry) {
			fail(`${id}:missing-case`);
			continue;
		}
		if (entry.status !== 'passed') fail(`${id}:case-not-passed`);
		if (
			!entry.fixture?.id ||
			!hash(entry.fixture.sha256) ||
			!Number.isInteger(entry.fixture.bytes) ||
			entry.fixture.bytes < 1
		)
			fail(`${id}:missing-fixture-identity`);
		for (const key of ['saved', 'exported', 'perFileUndo', 'redo', 'recovered']) {
			if (entry.fidelity?.[key] !== true) fail(`${id}:fidelity:${key}`);
		}
		const samples = Array.isArray(entry.samples) ? entry.samples : [];
		if (samples.length !== runs || !samples.length) fail(`${id}:sample-count-mismatch`);
		const metrics = {};
		for (let index = 0; index < samples.length; index++) {
			const sample = samples[index];
			if (sample.index !== index || sample.status !== 'passed')
				fail(`${id}:${index}:invalid-sample`);
			const fidelity = sample.fidelity;
			if (
				!hash(fidelity?.expectedSha256) ||
				fidelity.expectedSha256 !== fidelity.storedSha256 ||
				fidelity.expectedSha256 !== fidelity.editorSha256
			)
				fail(`${id}:${index}:byte-mismatch`);
			for (const [name, optional] of Object.entries(sample.optional ?? {})) {
				if (optional.supported !== true && (optional.supported !== false || !optional.reason))
					fail(`${id}:${index}:unknown-support:${name}`);
			}
			for (const metric of requiredStressMetrics) {
				const value = sample.metrics?.[metric];
				if (!Number.isFinite(value) || value < 0) fail(`${id}:${index}:invalid-metric:${metric}`);
			}
		}
		for (const metric of requiredStressMetrics) {
			metrics[metric] = {
				...summarize(samples.map((sample) => sample.metrics?.[metric])),
				unit: 'ms'
			};
			if (metrics[metric].p95 > profile?.limits?.[metric]) fail(`${id}:${metric}:over-budget`);
		}
		cases[id] = { attempted: samples.length, metrics };
	}
	for (const entry of actual)
		if (!expectedCases?.includes(entry.id)) fail(`${entry.id}:unexpected-case`);
	return {
		schema: 'deckmark-stress-audit/1',
		status: failures.length ? 'failed' : 'ok',
		enforced: enforce,
		profile: report?.profile,
		failures,
		warnings,
		cases
	};
}

export async function stressAuditMain(args) {
	const options = {
		report: null,
		budgets: resolve(import.meta.dirname, 'benchmark-budgets.json'),
		caseIds: [],
		enforce: true
	};
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === '--report') options.report = args[++index];
		else if (arg === '--budgets') options.budgets = resolve(args[++index]);
		else if (arg === '--cases') options.caseIds = args[++index].split(',');
		else if (arg === '--report-only') options.enforce = false;
		else throw new Error(`Unknown stress audit argument: ${arg}`);
	}
	if (!options.report || !isAbsolute(options.report))
		throw new Error('--report must be an absolute path.');
	const result = auditStress(
		JSON.parse(await readFile(options.report, 'utf8')),
		JSON.parse(await readFile(options.budgets, 'utf8')),
		options.caseIds,
		options.enforce
	);
	console.log(JSON.stringify(result, null, 2));
	if (options.enforce && result.status !== 'ok') process.exitCode = 1;
}

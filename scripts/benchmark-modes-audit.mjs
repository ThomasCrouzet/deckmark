import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { summarize } from './benchmark-shared.mjs';
import { sourceFailures, sidecar, trustFailures } from './benchmark-stress-audit.mjs';
import {
	finiteNonnegative,
	isDigest,
	libraryIdentity,
	requiredCapabilities,
	safeCount,
	same,
	sha256
} from './benchmark-stress-contract.mjs';
import { modeFixture, modeMatrix } from './benchmark-fixtures/modes.mjs';
import { modeMethods } from './benchmark-modes-contract.mjs';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const cases = new Map(modeMatrix().cases.map((entry) => [entry.id, entry]));

const nativeInputNames = ['untrackedCount', 'workingDiffSha256'];

// A native run cannot use the static Web build provenance. Its binary embeds
// the frontend, so the exact native binary hash identifies the measured app.
function nativeSourceFailures(report, profile, fail) {
	const source = report.source ?? {};
	for (const field of ['revision', 'tree'])
		if (!isDigest(source[field], 40)) fail(`source:invalid-${field}`);
	for (const [name, snapshot] of [
		['before', source],
		['after', source.after]
	]) {
		if (
			!object(snapshot) ||
			snapshot.diffSha256 !== sha256('') ||
			!object(snapshot.untrackedSha256) ||
			Object.keys(snapshot.untrackedSha256).length
		)
			fail(`source:${name}:not-clean`);
		if (snapshot?.revision !== source.revision || snapshot?.tree !== source.tree)
			fail(`source:${name}:identity-mismatch`);
	}
	const provenance = report.buildProvenance;
	if (!object(provenance)) {
		fail('provenance:missing');
		return;
	}
	if (
		provenance.schemaVersion !== 1 ||
		provenance.kind !== 'native-benchmark' ||
		provenance.instrumentation !== 'none' ||
		provenance.basePath !== ''
	)
		fail('provenance:wrong-build-contract');
	if (provenance.source !== source.revision || provenance.sourceTree !== source.tree)
		fail('provenance:source-mismatch');
	if (
		provenance.edition !== report.edition ||
		provenance.buildMode !== report.buildMode ||
		provenance.edition !== profile?.edition
	)
		fail('provenance:profile-mismatch');
	if (
		!object(provenance.binary) ||
		!text(provenance.binary.path) ||
		!isDigest(provenance.binary.sha256) ||
		!safeCount(provenance.binary.bytes) ||
		provenance.binary.bytes === 0
	)
		fail('native-build:binary-invalid');
	else if (
		source.buildTreeSha256 !== provenance.binary.sha256 ||
		provenance.tree?.sha256 !== provenance.binary.sha256 ||
		provenance.tree?.files !== 1
	)
		fail('native-build:binary-mismatch');
	if (
		!object(provenance.inputs) ||
		!same(Object.keys(provenance.inputs).sort(), nativeInputNames) ||
		!isDigest(provenance.inputs.workingDiffSha256) ||
		provenance.inputs.untrackedCount !== 0
	)
		fail('provenance:invalid-inputs');
	const environment = report.environment;
	if (
		!text(environment?.runner) ||
		!text(environment?.node) ||
		!text(environment?.os?.platform) ||
		!text(environment?.os?.release) ||
		!text(environment?.os?.arch)
	)
		fail('environment:missing-identity');
	if (
		provenance.builder?.node !== environment?.node ||
		provenance.builder?.platform !== environment?.os?.platform ||
		provenance.builder?.arch !== environment?.os?.arch ||
		(provenance.builder?.release && provenance.builder.release !== environment?.os?.release)
	)
		fail('provenance:builder-mismatch');
}

const metricLimits = {
	read: {
		firstContentMs: 'readFirstContentMs',
		fullRenderMs: 'readFullRenderMs'
	},
	slide: {
		inputToFrameMs: 'slideInputToFrameMs',
		inputDispatchMs: 'slideInputDispatchMs',
		saveObservedMs: 'slideSaveObservedMs'
	},
	wysiwyg: {
		inputToFrameMs: 'wysiwygInputToFrameMs',
		inputDispatchMs: 'wysiwygInputDispatchMs',
		saveObservedMs: 'wysiwygSaveObservedMs'
	},
	canvas: {
		pointerToFrameMs: 'canvasPointerToFrameMs',
		saveObservedMs: 'canvasSaveObservedMs'
	},
	annotation: {
		pointerToFrameMs: 'annotationPointerToFrameMs',
		paintedPixels: 'annotationPaintedPixels'
	},
	'slide-source': {
		inputToFrameMs: 'slideSourceInputToFrameMs',
		inputDispatchMs: 'slideSourceInputDispatchMs',
		applyObservedMs: 'slideSourceApplyObservedMs'
	}
};

const familyFor = (mode) =>
	mode === 'read'
		? 'read'
		: mode === 'slide-text' || mode === 'slide-notes'
			? 'slide'
			: mode === 'slide-canvas'
				? 'canvas'
				: mode;

function sampleResources(sample, label, maxima, fail) {
	for (const name of requiredCapabilities) {
		const value = sample?.optional?.[name];
		if (!object(value) || typeof value.supported !== 'boolean') {
			fail(`${label}:capabilities:${name}`);
			continue;
		}
		if (name === 'longTasks') {
			if (value.supported) {
				if (
					value.unit !== 'ms' ||
					!Array.isArray(value.values) ||
					value.values.some((entry) => !finiteNonnegative(entry))
				)
					fail(`${label}:capabilities:longTasks:invalid-values`);
			} else if (!text(value.reason)) fail(`${label}:capabilities:longTasks:reason`);
		} else if (name === 'heap') {
			if (value.supported) {
				if (
					value.unit !== 'bytes' ||
					!finiteNonnegative(value.value) ||
					value.origin !== 'performance.memory-estimate'
				)
					fail(`${label}:capabilities:heap:invalid-value`);
				else maxima.heapBytes = Math.max(maxima.heapBytes ?? 0, value.value);
			} else if (!text(value.reason)) fail(`${label}:capabilities:heap:reason`);
		} else if (!value.supported) {
			if (!text(value.reason)) fail(`${label}:capabilities:${name}:reason`);
		} else fail(`${label}:capabilities:${name}:unsupported-by-method`);
	}
	const resources = sample?.resources;
	if (
		!object(resources) ||
		!same(resources.units, { domNodes: 'count', canvasDimensions: 'backing-pixels' }) ||
		!safeCount(resources.domNodes) ||
		resources.domNodes === 0 ||
		!Array.isArray(resources.canvases)
	) {
		fail(`${label}:resources:invalid-observation`);
		return;
	}
	let pixels = 0;
	for (const canvas of resources.canvases) {
		if (
			!object(canvas) ||
			!safeCount(canvas.width) ||
			!safeCount(canvas.height) ||
			!safeCount(canvas.width * canvas.height)
		)
			fail(`${label}:resources:invalid-canvas`);
		else pixels += canvas.width * canvas.height;
	}
	maxima.domNodes = Math.max(maxima.domNodes ?? 0, resources.domNodes);
	maxima.canvasPixels = Math.max(maxima.canvasPixels ?? 0, pixels);
}

function readCase(entry, catalog, fixture, samples, label, fail) {
	const expected = catalog.expected;
	const maxima = {};
	const metrics = {};
	for (const key of ['firstContentMs', 'fullRenderMs']) {
		const values = samples.map((sample) => sample?.metrics?.[key]);
		if (values.some((value) => !finiteNonnegative(value))) fail(`${label}:invalid-metric:${key}`);
	}
	for (let index = 0; index < samples.length; index++) {
		const sample = samples[index];
		const sampleLabel = `${label}:${index}`;
		if (sample.index !== index || sample.status !== 'passed') fail(`${sampleLabel}:invalid-sample`);
		if (sample.metrics?.diagramCount !== expected.diagrams)
			fail(`${sampleLabel}:diagram-count-mismatch`);
		if (
			sample.fidelity?.tail !== true ||
			sample.fidelity?.diagramCount !== true ||
			sample.fidelity?.fixtureSha256 !== fixture.sha256 ||
			sample.fidelity?.sourceSha256 !== fixture.sha256
		)
			fail(`${sampleLabel}:fidelity-mismatch`);
		sampleResources(sample, sampleLabel, maxima, fail);
	}
	metrics.firstContentMs = summarize(samples.map((sample) => sample.metrics.firstContentMs));
	metrics.fullRenderMs = summarize(samples.map((sample) => sample.metrics.fullRenderMs));
	metrics.diagramCount = {
		runs: samples.length,
		unit: 'count',
		measured: true,
		complete: true,
		p50: expected.diagrams,
		p95: expected.diagrams,
		min: expected.diagrams,
		max: expected.diagrams
	};
	return { metrics, maxima };
}

function slideCase(entry, catalog, fixture, samples, label, fail) {
	const maxima = {};
	let field = catalog.expected.initialField;
	const positions = modeMethods.slide.positions;
	for (let index = 0; index < samples.length; index++) {
		const sample = samples[index];
		const sampleLabel = `${label}:${index}`;
		const position = positions[index % 3];
		const offset = Math.round(field.length * position.ratio);
		const next = field.slice(0, offset) + 'x' + field.slice(offset);
		if (sample.index !== index || sample.status !== 'passed') fail(`${sampleLabel}:invalid-sample`);
		if (
			sample.position !== position.id ||
			sample.operation !== 'insert' ||
			sample.insertedText !== 'x' ||
			sample.offset !== offset ||
			sample.sourceLength !== field.length ||
			!same(sample.input, { trusted: true, type: 'insertText', targetIsEditor: true })
		)
			fail(`${sampleLabel}:input-schedule-mismatch`);
		if (
			sample.fidelity?.expectedFieldSha256 !== sha256(next) ||
			!isDigest(sample.fidelity?.storedSha256)
		)
			fail(`${sampleLabel}:byte-or-origin-mismatch`);
		for (const key of Object.keys(metricLimits.slide))
			if (!finiteNonnegative(sample.metrics?.[key])) fail(`${sampleLabel}:invalid-metric:${key}`);
		sampleResources(sample, sampleLabel, maxima, fail);
		field = next;
	}
	if (!isDigest(entry.finalExpected?.sha256)) fail(`${label}:final-expected-missing`);
	if (
		entry.export?.sha256 !== entry.finalExpected?.sha256 ||
		entry.reload?.storedSha256 !== entry.finalExpected?.sha256
	)
		fail(`${label}:final-source-mismatch`);
	const metrics = {};
	for (const key of Object.keys(metricLimits.slide))
		metrics[key] = summarize(samples.map((sample) => sample.metrics[key]));
	return { metrics, maxima };
}

function interactionCase(entry, catalog, samples, label, fail) {
	const family = familyFor(catalog.mode);
	const maxima = {};
	const metrics = {};
	for (const key of Object.keys(metricLimits[family])) {
		const values = samples.map((sample) => sample?.metrics?.[key]);
		if (values.some((value) => !finiteNonnegative(value))) fail(`${label}:invalid-metric:${key}`);
		metrics[key] = summarize(values);
	}
	for (let index = 0; index < samples.length; index++) {
		const sample = samples[index];
		const sampleLabel = `${label}:${index}`;
		if (sample.index !== index || sample.status !== 'passed') fail(`${sampleLabel}:invalid-sample`);
		if (family === 'annotation') {
			if (
				!finiteNonnegative(sample.fidelity?.paintedPixels) ||
				sample.fidelity.paintedPixels <= 0 ||
				sample.fidelity?.strokeCount !== index + 1
			)
				fail(`${sampleLabel}:paint-mismatch`);
		} else if (family === 'canvas') {
			if (!isDigest(sample.fidelity?.sourceSha256)) fail(`${sampleLabel}:source-hash-missing`);
			if (sample.fidelity?.changed !== true) fail(`${sampleLabel}:source-not-changed`);
		} else {
			if (!isDigest(sample.fidelity?.storedSha256)) fail(`${sampleLabel}:stored-hash-missing`);
			if (sample.fidelity?.expectedContains !== 'x') fail(`${sampleLabel}:expected-text-missing`);
		}
		sampleResources(sample, sampleLabel, maxima, fail);
	}
	if (family !== 'annotation') {
		if (!isDigest(entry.finalExpected?.sha256)) fail(`${label}:final-expected-missing`);
		if (
			entry.export?.sha256 !== entry.finalExpected?.sha256 ||
			entry.reload?.storedSha256 !== entry.finalExpected?.sha256
		)
			fail(`${label}:final-source-mismatch`);
	}
	return { metrics, maxima };
}

export async function auditModes(value, budgets, expectedCases, enforce = true, trust = {}) {
	const report = object(value) ? value : {};
	const failures = [],
		warnings = [],
		resultCases = {};
	const fail = (message) => failures.push(message);
	if (report.schema !== 'deckmark-mode-bench/1') fail('unsupported-schema');
	if (!same(report.methods, modeMethods)) fail('method:version-or-boundary-mismatch');
	if (!['browser-run', 'native-run', 'synthetic-control'].includes(report.evidenceKind))
		fail('evidence-kind:invalid');
	const profile = budgets.modes?.profiles?.[report.profile];
	if (!profile) fail('unknown-profile');
	if (report.evidenceKind !== (profile?.evidenceKind ?? 'browser-run'))
		fail('evidence-kind:profile-mismatch');
	if (report.failures?.length || report.status === 'failed') fail('recorded-run-failures');
	if (
		!Array.isArray(expectedCases) ||
		!expectedCases.length ||
		new Set(expectedCases).size !== expectedCases.length
	)
		fail('invalid-expected-cases');
	expectedCases = Array.isArray(expectedCases) ? expectedCases : [];
	for (const key of ['target', 'edition', 'buildMode'])
		if (!report[key] || report[key] !== profile?.[key]) fail(`profile-mismatch:${key}`);
	if (profile?.target === 'native') {
		if (
			report.target !== 'native' ||
			report.edition !== 'desktop' ||
			!['debug', 'release'].includes(report.buildMode)
		)
			fail('unsupported-native-profile');
	} else if (
		report.target !== 'web' ||
		report.edition !== 'web' ||
		report.buildMode !== 'production-static'
	)
		fail('unsupported-production-profile');
	if (!text(report.renderer?.version) || report.renderer?.name !== profile?.renderer)
		fail('profile-mismatch:renderer');
	if (
		!Array.isArray(report.command) ||
		!report.command.length ||
		report.command.some((arg) => !text(arg))
	)
		fail('missing-command');
	if (profile?.target === 'native') nativeSourceFailures(report, profile, fail);
	else sourceFailures(report, profile, fail);
	const receipt = trustFailures(report, trust, fail);
	if (profile?.role !== 'blocking' || !text(profile?.review)) fail('unreviewed-profile');
	const runs = report.plan?.runs;
	if (!Number.isInteger(runs) || runs < Math.max(20, budgets.modes?.minimumRuns ?? 20)) {
		fail('too-few-runs');
		warnings.push('tail-estimate-insufficient: p95 below 20 samples is not stable tail evidence');
	}
	if (
		!Array.isArray(report.plan?.caseIds) ||
		!same([...report.plan.caseIds].sort(), [...expectedCases].sort())
	)
		fail('case-plan-mismatch');
	const actual = Array.isArray(report.cases) ? report.cases : [];
	if (
		actual.length !== expectedCases.length ||
		new Set(actual.map((entry) => entry?.id)).size !== actual.length
	)
		fail('case-count-mismatch');
	for (const id of expectedCases) {
		const catalog = cases.get(id),
			entry = actual.find((item) => item?.id === id);
		if (!catalog) {
			fail(`${id}:unknown-case`);
			continue;
		}
		if (!entry) {
			fail(`${id}:missing-case`);
			continue;
		}
		if (entry.status !== 'passed' || entry.errors?.length) {
			fail(`${id}:case-not-passed`);
			resultCases[id] = { attempted: entry.samples?.length ?? 0, status: entry.status };
			continue;
		}
		const fixture = modeFixture(catalog.fixture);
		for (const key of ['id', 'name', 'bytes', 'sha256', 'generator', 'arguments'])
			if (!same(entry.fixture?.[key], fixture?.[key])) fail(`${id}:fixture:${key}:mismatch`);
		if (
			entry.workload?.mode !== catalog.mode ||
			!same(entry.workload?.library, libraryIdentity(catalog.library))
		)
			fail(`${id}:workload:mismatch`);
		await sidecar(entry.fixture, fixture.content, receipt, `${id}:fixture`, fail);
		const family = familyFor(catalog.mode);
		for (const key of family === 'annotation' ? ['saved'] : ['saved', 'exported', 'recovered'])
			if (entry.fidelity?.[key] !== true) fail(`${id}:fidelity:${key}`);
		const samples = Array.isArray(entry.samples) ? entry.samples : [];
		if (samples.length !== runs || !samples.length || samples.length > 100)
			fail(`${id}:sample-count-mismatch`);
		const measured =
			family === 'read'
				? readCase(entry, catalog, fixture, samples, id, fail)
				: family === 'slide'
					? slideCase(entry, catalog, fixture, samples, id, fail)
					: interactionCase(entry, catalog, samples, id, fail);
		if (family === 'annotation') {
			// The annotation canvas is in-memory only; there is no stored or exported source.
		} else if (
			family === 'slide' ||
			family === 'wysiwyg' ||
			family === 'canvas' ||
			family === 'slide-source'
		) {
			if (entry.fidelity?.undo !== true || entry.fidelity?.redo !== true)
				fail(`${id}:fidelity:history`);
			if (!entry.export?.path) {
				fail(`${id}:export:missing`);
				resultCases[id] = { attempted: samples.length, metrics: measured.metrics };
				continue;
			}
			const finalSource = await readFile(entry.export.path);
			await sidecar(entry.export, finalSource, receipt, `${id}:export`, fail);
		} else {
			await sidecar(entry.export, fixture.content, receipt, `${id}:export`, fail);
			if (entry.export?.sha256 !== fixture.sha256) fail(`${id}:export:byte-mismatch`);
		}
		for (const [key, limit] of Object.entries(metricLimits[family])) {
			const metric = measured.metrics[key];
			if (!metric || metric.p95 > profile?.limits?.[limit]) fail(`${id}:${key}:over-budget`);
		}
		const resourceLimits = profile?.resourceLimits;
		for (const [name, limit] of Object.entries(resourceLimits ?? {})) {
			const capability = { heapBytes: 'heap', rssBytes: 'rss' }[name];
			if (
				measured.maxima[name] === undefined ||
				(capability && samples.some((sample) => sample?.optional?.[capability]?.supported !== true))
			)
				fail(`${id}:resource:${name}:unsupported`);
			else if (measured.maxima[name] > limit) fail(`${id}:resource:${name}:over-budget`);
		}
		resultCases[id] = {
			attempted: samples.length,
			metrics: measured.metrics,
			resourceMaxima: measured.maxima
		};
	}
	for (const entry of actual)
		if (!expectedCases.includes(entry?.id)) fail(`${entry?.id}:unexpected-case`);
	return {
		schema: 'deckmark-mode-audit/1',
		status: failures.length ? 'failed' : 'ok',
		enforced: enforce,
		profile: report.profile,
		evidenceKind: report.evidenceKind,
		failures,
		warnings,
		cases: resultCases
	};
}

export async function modeAuditMain(args) {
	const options = {
		report: null,
		budgets: resolve(import.meta.dirname, 'benchmark-budgets.json'),
		caseIds: [],
		enforce: true,
		receipt: null,
		receiptSha256: null
	};
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === '--report') options.report = args[++index];
		else if (arg === '--budgets') options.budgets = resolve(args[++index]);
		else if (arg === '--cases') options.caseIds = args[++index].split(',');
		else if (arg === '--receipt') options.receipt = args[++index];
		else if (arg === '--receipt-sha256') options.receiptSha256 = args[++index];
		else if (arg === '--report-only') options.enforce = false;
		else throw new Error(`Unknown mode audit argument: ${arg}`);
	}
	if (!options.report || !isAbsolute(options.report))
		throw new Error('--report must be an absolute path.');
	const bytes = await readFile(options.report);
	const trust = { reportSha256: sha256(bytes), errors: [] };
	if (options.receipt) {
		try {
			if (!isAbsolute(options.receipt)) throw new Error('Receipt path must be absolute.');
			const receipt = await readFile(options.receipt);
			if (!isDigest(options.receiptSha256) || sha256(receipt) !== options.receiptSha256)
				trust.errors.push('receipt:pinned-digest-mismatch');
			trust.receipt = JSON.parse(receipt.toString('utf8'));
		} catch {
			trust.errors.push('receipt:unavailable-or-invalid');
		}
	}
	const result = await auditModes(
		JSON.parse(bytes.toString('utf8')),
		JSON.parse(await readFile(options.budgets, 'utf8')),
		options.caseIds,
		options.enforce,
		trust
	);
	console.log(JSON.stringify(result, null, 2));
	if (options.enforce && result.status !== 'ok') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	await modeAuditMain(process.argv.slice(2));
}

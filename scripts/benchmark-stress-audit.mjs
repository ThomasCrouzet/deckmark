import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { summarize } from './benchmark-shared.mjs';
import {
	canonical,
	catalogCase,
	catalogFixture,
	finiteNonnegative,
	isDigest,
	libraryIdentity,
	provenanceInputs,
	requiredCapabilities,
	resourceKeys,
	safeCount,
	same,
	sentinelText,
	sha256,
	stressMethod
} from './benchmark-stress-contract.mjs';

export const requiredStressMetrics = ['inputToFrameMs', 'inputDispatchMs', 'saveObservedMs'];
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.trim().length > 0;

export function sourceFailures(report, profile, fail) {
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
		provenance.kind !== 'web-benchmark' ||
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
		!safeCount(provenance.tree?.files) ||
		provenance.tree.files === 0 ||
		!isDigest(provenance.tree?.sha256) ||
		source.buildTreeSha256 !== provenance.tree?.sha256
	)
		fail('provenance:build-tree-mismatch');
	if (
		!object(provenance.inputs) ||
		!same(Object.keys(provenance.inputs).sort(), [...provenanceInputs].sort()) ||
		Object.values(provenance.inputs).some((value) => !isDigest(value))
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

export function trustFailures(report, trust, fail) {
	for (const error of trust.errors ?? []) fail(error);
	const receipt = trust.receipt;
	if (!object(receipt)) {
		fail('receipt:required-external-trust');
		return null;
	}
	if (
		receipt.schema !== 'deckmark-stress-artifact-trust/1' ||
		receipt.scope !== 'external-artifact-byte-review' ||
		!text(receipt.reviewer) ||
		!text(receipt.reviewedAt) ||
		!Number.isFinite(Date.parse(receipt.reviewedAt))
	)
		fail('receipt:invalid-review');
	if (!isDigest(trust.reportSha256) || receipt.reportSha256 !== trust.reportSha256)
		fail('receipt:report-digest-mismatch');
	if (receipt.evidenceKind !== report.evidenceKind) fail('receipt:evidence-kind-mismatch');
	if (!same(receipt.source, { revision: report.source?.revision, tree: report.source?.tree }))
		fail('receipt:source-mismatch');
	if (receipt.provenanceSha256 !== sha256(canonical(report.buildProvenance) ?? ''))
		fail('receipt:provenance-digest-mismatch');
	if (
		!same(receipt.buildTree, report.buildProvenance?.tree) ||
		!same(receipt.inputs, report.buildProvenance?.inputs)
	)
		fail('receipt:build-mismatch');
	if (!object(receipt.files)) fail('receipt:missing-files');
	return receipt;
}

export async function sidecar(descriptor, expected, receipt, label, fail) {
	if (
		!object(descriptor) ||
		typeof descriptor.path !== 'string' ||
		!isAbsolute(descriptor.path) ||
		descriptor.bytes !== Buffer.byteLength(expected) ||
		descriptor.sha256 !== sha256(expected)
	) {
		fail(`${label}:descriptor-mismatch`);
		return;
	}
	const trusted = receipt?.files?.[descriptor.path];
	if (!same(trusted, { bytes: descriptor.bytes, sha256: descriptor.sha256 }))
		fail(`${label}:receipt-file-mismatch`);
	try {
		const bytes = await readFile(descriptor.path);
		if (!bytes.equals(Buffer.from(expected))) fail(`${label}:sidecar-bytes-mismatch`);
	} catch {
		fail(`${label}:sidecar-unavailable`);
	}
}

function stateMatches(value, expected) {
	return (
		object(value) &&
		value.editorOrigin === 'codemirror-state-doc' &&
		value.storedOrigin === 'indexeddb-drafts-row' &&
		value.editorSha256 === sha256(expected) &&
		value.storedSha256 === sha256(expected)
	);
}

function keyMatches(events, key, mac, shift) {
	return (
		Array.isArray(events) &&
		events.some(
			(event) =>
				object(event) &&
				event.key === key &&
				event.code === (key.toLowerCase() === 'y' ? 'KeyY' : 'KeyZ') &&
				event.trusted === true &&
				event.targetIsEditor === true &&
				event.ctrl === !mac &&
				event.meta === mac &&
				event.shift === shift
		)
	);
}

function historyFailures(entry, mode, initial, previous, final, environment, fail) {
	const id = entry.id;
	const history = entry.history ?? {};
	const sentinel = sentinelText(mode);
	const offset = mode === 'json' ? sentinel.length - 2 : sentinel.length;
	const edited = sentinel.slice(0, offset) + 'x' + sentinel.slice(offset);
	const mac = environment?.os?.platform === 'darwin';
	if (
		!text(history.platform) ||
		/Mac/.test(history.platform) !== mac ||
		history.mainId !== 'stress-main' ||
		history.sentinel?.id !== 'stress-sentinel'
	)
		fail(`${id}:history:identity`);
	if (
		history.undoShortcut !== 'ControlOrMeta+z' ||
		history.redoShortcut !== (mac ? 'Meta+Shift+Z' : 'Control+y')
	)
		fail(`${id}:history:shortcut`);
	if (
		!keyMatches(history.redoKeys, mac ? 'Z' : 'y', mac, mac) ||
		!keyMatches(history.main?.undoKeys, 'z', mac, false) ||
		!keyMatches(history.sentinel?.undoKeys, 'z', mac, false)
	)
		fail(`${id}:history:missing-trusted-key`);
	for (const [name, value, expected] of [
		['sentinel-initial', history.sentinel?.initial, sentinel],
		['sentinel-insert', history.sentinel?.afterInsert, edited],
		['sentinel-undo', history.sentinel?.afterUndo, sentinel],
		['file-return', history.fileReturn, final],
		['before-undo', history.main?.beforeUndo, final],
		['after-undo', history.main?.afterUndo, previous],
		['after-redo', history.main?.afterRedo, final]
	])
		if (!stateMatches(value, expected)) fail(`${id}:history:${name}:state-mismatch`);
	if (sha256(initial) === sha256(final)) fail(`${id}:history:no-measured-edit`);
	if (
		entry.reload?.activeId !== 'stress-main' ||
		!stateMatches(entry.reload?.main, final) ||
		entry.reload?.storedOrigin !== 'indexeddb-drafts-row' ||
		entry.reload?.sentinelStoredSha256 !== sha256(sentinel)
	)
		fail(`${id}:reload:state-mismatch`);
}

function sampleResources(sample, label, maxima, fail) {
	const capabilities = sample.optional;
	if (!object(capabilities)) {
		fail(`${label}:capabilities:missing`);
	} else {
		if (!same(Object.keys(capabilities).sort(), [...requiredCapabilities].sort()))
			fail(`${label}:capabilities:membership`);
		for (const name of requiredCapabilities) {
			const value = capabilities[name];
			if (!object(value)) {
				fail(`${label}:capabilities:${name}:missing`);
				continue;
			}
			if (value.supported === false) {
				if (!text(value.reason) || Object.hasOwn(value, 'value') || Object.hasOwn(value, 'values'))
					fail(`${label}:capabilities:${name}:invalid-unsupported`);
			} else if (value.supported === true && name === 'longTasks') {
				if (
					value.unit !== 'ms' ||
					!Array.isArray(value.values) ||
					value.values.some((number) => !finiteNonnegative(number))
				)
					fail(`${label}:capabilities:longTasks:invalid-values`);
			} else if (value.supported === true && name === 'heap') {
				if (
					value.unit !== 'bytes' ||
					!finiteNonnegative(value.value) ||
					value.origin !== 'performance.memory-estimate'
				)
					fail(`${label}:capabilities:heap:invalid-value`);
				else maxima.heapBytes = Math.max(maxima.heapBytes ?? 0, value.value);
			} else fail(`${label}:capabilities:${name}:unsupported-by-method`);
		}
	}
	const resources = sample.resources;
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
	if (!safeCount(pixels)) fail(`${label}:resources:invalid-canvas-pixels`);
	else maxima.canvasPixels = Math.max(maxima.canvasPixels ?? 0, pixels);
	maxima.domNodes = Math.max(maxima.domNodes ?? 0, resources.domNodes);
}

export async function auditStress(value, budgets, expectedCases, enforce = true, trust = {}) {
	const report = object(value) ? value : {};
	const failures = [],
		warnings = [],
		cases = {};
	const fail = (message) => failures.push(message);
	if (report.schema !== 'deckmark-stress/2') fail('unsupported-schema');
	if (!same(report.method, stressMethod)) fail('method:version-or-boundary-mismatch');
	if (!['browser-run', 'synthetic-control'].includes(report.evidenceKind))
		fail('evidence-kind:invalid');
	const profile = budgets.stress?.profiles?.[report.profile];
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
	if (
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
	if (!finiteNonnegative(report.injectedDelayMs) || report.injectedDelayMs > 2000)
		fail('invalid-injected-delay');
	sourceFailures(report, profile, fail);
	const receipt = trustFailures(report, trust, fail);
	if (profile?.role !== 'blocking' || !text(profile?.review)) fail('unreviewed-profile');
	for (const metric of requiredStressMetrics)
		if (!finiteNonnegative(profile?.limits?.[metric])) fail(`missing-limit:${metric}`);
	const resourceLimits = profile?.resourceLimits;
	if (!object(resourceLimits)) fail('resources:unreviewed-limits');
	else {
		for (const name of ['domNodes', 'canvasPixels'])
			if (!finiteNonnegative(resourceLimits[name])) fail(`resources:missing-limit:${name}`);
		for (const [name, limit] of Object.entries(resourceLimits))
			if (!resourceKeys.includes(name) || !finiteNonnegative(limit))
				fail(`resources:invalid-limit:${name}`);
	}
	const runs = report.plan?.runs;
	if (!Number.isInteger(runs) || runs < Math.max(20, budgets.stress?.minimumRuns ?? 20)) {
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
		const catalog = catalogCase(id),
			entry = actual.find((item) => item?.id === id);
		if (!catalog) {
			fail(`${id}:unknown-case`);
			continue;
		}
		if (!entry) {
			fail(`${id}:missing-case`);
			continue;
		}
		if (catalog.adapter !== 'web') fail(`${id}:unsupported-adapter`);
		if (entry.status !== 'passed' || entry.errors?.length) fail(`${id}:case-not-passed`);
		const fixture = catalogFixture(catalog.fixture);
		for (const key of ['id', 'name', 'bytes', 'sha256', 'generator', 'arguments'])
			if (!same(entry.fixture?.[key], fixture[key])) fail(`${id}:fixture:${key}:mismatch`);
		if (
			entry.workload?.mode !== catalog.mode ||
			!same(entry.workload?.library, libraryIdentity(catalog.library))
		)
			fail(`${id}:workload:mismatch`);
		await sidecar(entry.fixture, fixture.content, receipt, `${id}:fixture`, fail);
		for (const key of ['saved', 'exported', 'perFileUndo', 'redo', 'recovered'])
			if (entry.fidelity?.[key] !== true) fail(`${id}:fidelity:${key}`);
		const samples = Array.isArray(entry.samples) ? entry.samples : [];
		if (samples.length !== runs || !samples.length || samples.length > 100)
			fail(`${id}:sample-count-mismatch`);
		let final = fixture.content,
			previous = final;
		const maxima = {};
		for (let index = 0; index < Math.min(samples.length, 100); index++) {
			const sample = samples[index] ?? {},
				label = `${id}:${index}`;
			const position = stressMethod.positions[index % 3],
				offset = Math.round(final.length * position.ratio);
			if (sample.index !== index || sample.status !== 'passed') fail(`${label}:invalid-sample`);
			if (
				sample.position !== position.id ||
				sample.operation !== 'insert' ||
				sample.insertedText !== 'x' ||
				sample.offset !== offset ||
				sample.sourceLength !== final.length ||
				!same(sample.selection, { anchor: offset, head: offset })
			)
				fail(`${label}:input-schedule-mismatch`);
			if (
				sample.input?.trusted !== true ||
				sample.input?.type !== 'insertText' ||
				sample.input?.targetIsEditor !== true
			)
				fail(`${label}:input-event-mismatch`);
			previous = final;
			final = final.slice(0, offset) + 'x' + final.slice(offset);
			if (
				!stateMatches(sample.fidelity, final) ||
				sample.fidelity?.expectedSha256 !== sha256(final) ||
				sample.fidelity?.beforeEditorSha256 !== sha256(previous)
			)
				fail(`${label}:byte-or-origin-mismatch`);
			for (const metric of requiredStressMetrics)
				if (!finiteNonnegative(sample.metrics?.[metric])) fail(`${label}:invalid-metric:${metric}`);
			sampleResources(sample, label, maxima, fail);
		}
		if (!same(entry.finalExpected, { bytes: Buffer.byteLength(final), sha256: sha256(final) }))
			fail(`${id}:final-expected-mismatch`);
		if (entry.export?.name !== fixture.name) fail(`${id}:export:name-mismatch`);
		await sidecar(entry.export, final, receipt, `${id}:export`, fail);
		historyFailures(
			entry,
			catalog.mode,
			fixture.content,
			previous,
			final,
			report.environment,
			fail
		);
		const metrics = {};
		for (const metric of requiredStressMetrics) {
			metrics[metric] = summarize(samples.map((sample) => sample?.metrics?.[metric]));
			if (metrics[metric].p95 > profile?.limits?.[metric]) fail(`${id}:${metric}:over-budget`);
		}
		for (const [name, limit] of Object.entries(resourceLimits ?? {})) {
			const capability = { heapBytes: 'heap', rssBytes: 'rss' }[name];
			if (
				maxima[name] === undefined ||
				(capability && samples.some((sample) => sample?.optional?.[capability]?.supported !== true))
			)
				fail(`${id}:resource:${name}:unsupported`);
			else if (maxima[name] > limit) fail(`${id}:resource:${name}:over-budget`);
		}
		cases[id] = { attempted: samples.length, metrics, resourceMaxima: maxima };
	}
	for (const entry of actual)
		if (!expectedCases.includes(entry?.id)) fail(`${entry?.id}:unexpected-case`);
	return {
		schema: 'deckmark-stress-audit/2',
		status: failures.length ? 'failed' : 'ok',
		enforced: enforce,
		profile: report.profile,
		evidenceKind: report.evidenceKind,
		trustBoundary: 'caller-pinned external artifact receipt; not browser execution attestation',
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
		else throw new Error(`Unknown stress audit argument: ${arg}`);
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
	const result = await auditStress(
		JSON.parse(bytes.toString('utf8')),
		JSON.parse(await readFile(options.budgets, 'utf8')),
		options.caseIds,
		options.enforce,
		trust
	);
	console.log(JSON.stringify(result, null, 2));
	if (options.enforce && result.status !== 'ok') process.exitCode = 1;
}

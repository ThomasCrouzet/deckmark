import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resetAppState } from './helpers';
import { exportSource } from './source-fidelity-harness';
import { testSource } from '../scripts/test-source.mjs';

// Representative editor report for issues #327 and #572.
//
// One realistic note holds plain and mixed inline paragraphs near the start,
// middle and end, a long list, a wide table, an embedded image and a tail
// sentinel. The case records a separate row for each workload:
// - the accepted input samples with queue delay, dispatch and second-frame time,
// - the next accepted input delay,
// - the product stage spans and their p50/p95/max,
// - long tasks and the durable save measures,
// - the scoped or whole-document source route and the coarse fallback reason,
// - the exact durable bytes and the exported Markdown.
// A plain and a mixed paragraph are both measured so the route difference has a
// control. A control without a change proves that the probe does not report a
// publication for idle time. Every case runs one declared warmup pass and 20
// measured passes by default. Only measured passes enter an aggregate,
// denominator, percentile or budget.
//
// A second row records the first editor mount in a fresh browser context (cold)
// and a Source to WYSIWYG switch on the same document (warm). Service workers
// are blocked, so an installed PWA cache update is not measured.

test.use({ locale: 'fr-FR', reducedMotion: 'reduce', trace: 'off', serviceWorkers: 'block' });

const NOTE_ID = 'representative-report';
const NOTE_NAME = 'representative.md';
const BURST_SPACING_MS = 45;

type InputSample = {
	started: number;
	stamp: number;
	inputType: string | null;
	dispatch: number | null;
	frame: number | null;
};

type StageSample = {
	name: string;
	value: number;
	start: number;
	end: number;
};

type EditRecord = {
	documentId: string;
	revision: number;
	space: string;
	kind: string;
	previous: { from: number; to: number };
	next: { from: number; to: number };
};

type Probe = {
	keys: InputSample[];
	stages: StageSample[];
	counters: Record<string, number>;
	edits: EditRecord[];
	longTasks: Array<{ start: number; duration: number }>;
	longTasksSupported: boolean;
	observer?: PerformanceObserver;
};

declare global {
	interface Window {
		__representativeProbe?: Probe;
		__representativeOpenStart?: number;
		__representativeStall?: EventListener;
		__representativeStallRuns?: number;
	}
}

/** A representative note with unique edit targets and a 1x1 embedded image. */
function representativeNote(): string {
	const image =
		'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
	const lines: string[] = [
		'---',
		'title: Representative editor report',
		'tags: [performance, representative]',
		'---',
		'',
		'# Representative note',
		'',
		'## Start',
		'',
		'Plain start sentence stays stable here.',
		'',
		'Mixed start sentence stays stable here with **bold start**, _emphasis words_, [a link](https://example.invalid/), and `inline code`.',
		'',
		'## Long list',
		'',
		'Fill paragraph before the list keeps the note realistic and bounded.',
		''
	];
	for (let index = 0; index < 320; index += 1) {
		lines.push(`- List item ${index} keeps stable words in this representative note.`);
	}
	lines.push('', '## Wide table', '', '| key | value | note |', '| --- | --- | --- |');
	for (let index = 0; index < 140; index += 1) {
		lines.push(
			index === 100
				? `| row ${index} | value ${index} | stable cell ${index} target middle word |`
				: `| row ${index} | value ${index} | stable cell ${index} |`
		);
	}
	lines.push(
		'',
		'## Middle',
		'',
		'Plain middle sentence stays stable here.',
		'',
		'Mixed middle sentence stays stable here with **bold middle**, _emphasis words_, [a link](https://example.invalid/), and `inline code`.',
		'',
		`![Figure](${image})`,
		'',
		'## End',
		'',
		'Plain end sentence stays stable here.',
		'',
		'Mixed end sentence stays stable here with **bold end**, _emphasis words_, [a link](https://example.invalid/), and `inline code`.',
		'',
		'## Tail',
		'',
		'Tail paragraph keeps the caret target.'
	);
	// Filler prose after the targets keeps the note near a representative size
	// without changing the selected text.
	for (let index = 0; index < 120; index += 1) {
		lines.push(
			'',
			`Filler paragraph ${index} keeps ordinary prose and the same visible words for each run.`
		);
	}
	return `${lines.join('\n')}\n`;
}

async function seedNote(page: Page, source: string): Promise<void> {
	await page.evaluate(
		async ({ id, name, content }) => {
			await new Promise<void>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const transaction = database.transaction('drafts', 'readwrite');
					transaction.objectStore('drafts').put({
						id,
						name,
						content,
						createdAt: 1_700_000_000_000,
						updatedAt: 1_700_000_000_000,
						order: 0,
						open: true
					});
					transaction.oncomplete = () => {
						database.close();
						resolve();
					};
					transaction.onerror = () => reject(transaction.error);
				};
			});
			localStorage.setItem('mdsh:activeId', id);
			localStorage.setItem('mdsh:mode', 'source');
			localStorage.setItem('mdsh:locale', 'fr');
		},
		{ id: NOTE_ID, name: NOTE_NAME, content: source }
	);
}

async function storedRow(page: Page): Promise<{ content: string; length: number }> {
	return page.evaluate(
		(id) =>
			new Promise<{ content: string; length: number }>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const row = database.transaction('drafts').objectStore('drafts').get(id);
					row.onsuccess = () => {
						database.close();
						const content = (row.result as { content?: string } | undefined)?.content ?? '';
						resolve({ content, length: content.length });
					};
					row.onerror = () => {
						database.close();
						reject(row.error);
					};
				};
			}),
		NOTE_ID
	);
}

async function markOpenStart(page: Page): Promise<void> {
	await page.evaluate(() => {
		window.__representativeOpenStart = performance.now();
	});
}

async function measureOpen(page: Page): Promise<number> {
	return page.evaluate(() => {
		const start = window.__representativeOpenStart;
		return typeof start === 'number' ? performance.now() - start : 0;
	});
}

async function openVisualEditor(page: Page): Promise<number> {
	await markOpenStart(page);
	await page.locator('[data-mode=wysiwyg]').click();
	const largeDialog = page.getByRole('dialog', { name: 'Afficher ce document volumineux ?' });
	if (
		await largeDialog
			.waitFor({ state: 'visible', timeout: 3_000 })
			.then(() => true)
			.catch(() => false)
	)
		await largeDialog.getByRole('button', { name: 'Afficher le document', exact: true }).click();
	await expect(page.locator('.ProseMirror')).toHaveAttribute('contenteditable', 'true', {
		timeout: 180_000
	});
	return measureOpen(page);
}

async function installProbe(page: Page): Promise<void> {
	await page.locator('.ProseMirror').evaluate((element) => {
		const probe: Probe = {
			keys: [],
			stages: [],
			counters: {},
			edits: [],
			longTasks: [],
			longTasksSupported:
				typeof PerformanceObserver !== 'undefined' &&
				PerformanceObserver.supportedEntryTypes.includes('longtask')
		};
		(window as unknown as { __representativeProbe: Probe }).__representativeProbe = probe;
		window.addEventListener(
			'deckmark:editor-perf',
			(event) => {
				const detail = (
					event as CustomEvent<{
						kind: string;
						name?: string;
						value?: number;
						start?: number;
						end?: number;
						edit?: EditRecord;
					}>
				).detail;
				if (detail.kind === 'counter') {
					const name = detail.name ?? '';
					probe.counters[name] = (probe.counters[name] ?? 0) + 1;
					return;
				}
				if (detail.kind === 'edit') {
					if (detail.edit) probe.edits.push(detail.edit);
					return;
				}
				if (detail.kind !== 'duration' || detail.value === undefined) return;
				const end = detail.end ?? performance.now();
				probe.stages.push({
					name: detail.name ?? '',
					value: detail.value,
					start: detail.start ?? end - detail.value,
					end
				});
			},
			true
		);
		window.addEventListener(
			'deckmark:source-fidelity',
			(event) => {
				const path = (event as CustomEvent<string>).detail;
				const name = `sourceFidelityPath:${path}`;
				probe.counters[name] = (probe.counters[name] ?? 0) + 1;
			},
			true
		);
		const recordInput = (inputType: string | null, stamp: number) => {
			const started = performance.now();
			const sample: InputSample = {
				started,
				stamp,
				inputType,
				dispatch: null,
				frame: null
			};
			probe.keys.push(sample);
			queueMicrotask(() => {
				sample.dispatch = performance.now() - started;
			});
			requestAnimationFrame(() =>
				requestAnimationFrame(() => {
					sample.frame = performance.now() - started;
				})
			);
		};
		element.addEventListener(
			'beforeinput',
			(event) => {
				const input = event as InputEvent;
				// ProseMirror handles Enter on keydown and can prevent the
				// beforeinput event. The keydown listener below records it once.
				if (input.inputType === 'insertParagraph') return;
				recordInput(input.inputType ?? null, input.timeStamp);
			},
			true
		);
		element.addEventListener(
			'keydown',
			(event) => {
				const keyboard = event as KeyboardEvent;
				if (keyboard.key === 'Enter') recordInput('insertParagraph', keyboard.timeStamp);
			},
			true
		);
		if (probe.longTasksSupported) {
			const observer = new PerformanceObserver((list) => {
				for (const entry of list.getEntries())
					probe.longTasks.push({ start: entry.startTime, duration: entry.duration });
			});
			observer.observe({ type: 'longtask', buffered: false });
			probe.observer = observer;
		}
	});
}

async function resetProbe(page: Page): Promise<void> {
	await page.evaluate(() => {
		const probe = window.__representativeProbe;
		if (!probe) return;
		probe.observer?.takeRecords();
		probe.keys.length = 0;
		probe.stages.length = 0;
		probe.counters = {};
		probe.edits.length = 0;
		probe.longTasks.length = 0;
		performance.clearMeasures();
	});
}

async function readProbe(page: Page): Promise<Probe> {
	return page.evaluate(() => {
		const probe = window.__representativeProbe!;
		probe.longTasks.push(
			...(probe.observer?.takeRecords() ?? []).map((entry) => ({
				start: entry.startTime,
				duration: entry.duration
			}))
		);
		return {
			keys: probe.keys.map((key) => ({ ...key })),
			stages: probe.stages.map((stage) => ({ ...stage })),
			counters: { ...probe.counters },
			edits: probe.edits.map((edit) => structuredClone(edit)),
			longTasks: probe.longTasks.map((task) => ({ ...task })),
			longTasksSupported: probe.longTasksSupported
		};
	});
}

async function selectText(page: Page, editor: Locator, text: string): Promise<void> {
	await expect(editor).toBeVisible({ timeout: 60_000 });
	await editor.evaluate((root, target) => {
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		const nodes: Array<{ node: Node; from: number; to: number }> = [];
		let content = '';
		let node: Node | null;
		while ((node = walker.nextNode())) {
			const from = content.length;
			content += node.textContent;
			nodes.push({ node, from, to: content.length });
		}
		const index = content.indexOf(target);
		if (index < 0) throw new Error(`Sentence not found: ${target}`);
		const first = nodes.find(({ from, to }) => from <= index && to > index)!;
		const last = nodes.find(
			({ from, to }) => from < index + target.length && to >= index + target.length
		)!;
		const range = document.createRange();
		range.setStart(first.node, index - first.from);
		range.setEnd(last.node, index + target.length - last.from);
		(root as HTMLElement).focus();
		const selection = window.getSelection()!;
		selection.removeAllRanges();
		selection.addRange(range);
	}, text);
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			)
	);
	await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(text);
}

async function placeCaret(page: Page, text: string, edge: 'start' | 'end'): Promise<void> {
	const editor = page.locator('.ProseMirror');
	await selectText(page, editor, text);
	await page.keyboard.press(edge === 'start' ? 'ArrowLeft' : 'ArrowRight');
	await expect
		.poll(() => page.evaluate(() => window.getSelection()?.isCollapsed ?? false))
		.toBe(true);
}

/**
 * Set a collapsed ProseMirror selection at one edge of `text` through the
 * instrumented view handle. A native range that spans inline marks can keep a
 * non-collapsed editor selection after an arrow key, so a structural Enter must
 * use the editor selection directly.
 */
async function placeCaretInView(page: Page, text: string, edge: 'start' | 'end'): Promise<void> {
	await page.locator('.ProseMirror').evaluate(
		(root, { text: target, edge: side }) => {
			const view = (
				window as unknown as {
					__MDSH_EDITOR_VIEW__?: {
						state: {
							doc: unknown;
							selection: { constructor: { create(doc: unknown, pos: number): unknown } };
							tr: { setSelection(selection: unknown): { doc: unknown } };
						};
						posAtDOM(node: Node, offset: number): number;
						dispatch(transaction: unknown): void;
						focus(): void;
					};
				}
			).__MDSH_EDITOR_VIEW__;
			if (!view) throw new Error('Missing editor view.');
			const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
			const nodes: Array<{ node: Node; from: number; to: number }> = [];
			let content = '';
			let node: Node | null;
			while ((node = walker.nextNode())) {
				const from = content.length;
				content += node.textContent;
				nodes.push({ node, from, to: content.length });
			}
			const index = content.indexOf(target);
			if (index < 0) throw new Error(`Sentence not found: ${target}`);
			const offset = side === 'start' ? index : index + target.length;
			const entry = nodes.find(({ from, to }) => from <= offset && to >= offset);
			if (!entry) throw new Error(`No text node at the requested edge: ${target}`);
			const pos = view.posAtDOM(entry.node, offset - entry.from);
			const selection = view.state.selection.constructor.create(view.state.doc, pos);
			view.dispatch(view.state.tr.setSelection(selection));
			view.focus();
		},
		{ text, edge }
	);
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			)
	);
}

async function typeBurst(page: Page, text: string, spacing = BURST_SPACING_MS): Promise<void> {
	for (const [index, character] of [...text].entries()) {
		if (index > 0) await page.waitForTimeout(spacing);
		await page.keyboard.insertText(character);
	}
}

function percentile(values: readonly number[], ratio: number): number {
	if (!values.length) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.ceil(sorted.length * ratio) - 1] ?? 0;
}

function summary(values: readonly number[]): {
	denominator: number;
	p50: number;
	p95: number;
	max: number;
	statistic: 'nearest-rank';
} {
	const numbers = values.filter((value) => Number.isFinite(value));
	return {
		denominator: numbers.length,
		p50: percentile(numbers, 0.5),
		p95: percentile(numbers, 0.95),
		max: numbers.length ? Math.max(...numbers) : 0,
		statistic: 'nearest-rank'
	};
}

function stageSummary(stages: readonly StageSample[]): Record<string, unknown> {
	return Object.fromEntries(
		[...new Set(stages.map((stage) => stage.name))].map((name) => {
			const selected = stages.filter((stage) => stage.name === name);
			return [
				name,
				{
					...summary(selected.map((stage) => stage.value)),
					spans: selected.filter(
						(stage) => Number.isFinite(stage.start) && Number.isFinite(stage.end)
					).length
				}
			];
		})
	);
}

type MeasureSample = {
	count: number;
	p50: number;
	p95: number;
	max: number;
	detail: Record<string, number>;
	values: number[];
};

async function performanceMeasures(page: Page): Promise<Record<string, MeasureSample>> {
	return page.evaluate(() => {
		const names = [
			'mdsh:document-edit',
			'mdsh:document-serialization',
			'mdsh:document-derived',
			'mdsh:document-storage',
			'mdsh:metadata-job',
			'mdsh:metadata-transfer',
			'mdsh:draft-manifest',
			'mdsh:draft-metadata'
		];
		const result: Record<
			string,
			{
				count: number;
				p50: number;
				p95: number;
				max: number;
				detail: Record<string, number>;
				values: number[];
			}
		> = {};
		const percentile = (values: number[], ratio: number) => {
			if (!values.length) return 0;
			const sorted = [...values].sort((left, right) => left - right);
			return sorted[Math.ceil(sorted.length * ratio) - 1] ?? 0;
		};
		for (const name of names) {
			const entries = performance.getEntriesByName(name, 'measure');
			const values = entries.map((entry) => entry.duration);
			const detail: Record<string, number> = {};
			for (const entry of entries) {
				const fields = (entry as PerformanceEntry & { detail?: Record<string, unknown> }).detail;
				if (!fields) continue;
				for (const [field, value] of Object.entries(fields)) {
					if (typeof value === 'number' && Number.isFinite(value))
						detail[field] = (detail[field] ?? 0) + value;
				}
			}
			result[name] = {
				count: values.length,
				p50: percentile(values, 0.5),
				p95: percentile(values, 0.95),
				max: values.length ? Math.max(...values) : 0,
				detail,
				values
			};
		}
		return result;
	});
}

async function editorSnapshotChars(page: Page): Promise<number> {
	return page.evaluate(() => {
		const view = (
			window as unknown as {
				__MDSH_EDITOR_VIEW__?: { state: { doc: { toString(): string } } };
			}
		).__MDSH_EDITOR_VIEW__;
		return view?.state.doc.toString().length ?? 0;
	});
}

async function waitForSettled(page: Page, expectedKeys: number): Promise<void> {
	await page.waitForFunction(
		({ keys }) => {
			const probe = window.__representativeProbe;
			if (!probe) return false;
			return (
				probe.keys.length >= keys &&
				probe.keys.every((sample) => sample.frame !== null && sample.dispatch !== null)
			);
		},
		{ keys: expectedKeys },
		{ timeout: 60_000 }
	);
	await page.waitForTimeout(900);
}

async function waitForDurableExact(page: Page, expected: string): Promise<void> {
	await expect
		.poll(async () => (await storedRow(page)).content, {
			timeout: 45_000,
			message: 'the durable row must equal the expected source'
		})
		.toBe(expected);
}

type CaseResult = {
	id: string;
	description: string;
	run: number;
	warmup: boolean;
	undoRestored?: boolean;
	cache: 'warm' | 'cold';
	requestedSpacingMs: number[];
	stageSamples: StageSample[];
	nextInputDelayRaw: number[];
	inputs: {
		raw: Array<{
			queueDelayMs: number;
			dispatchMs: number;
			inputToFrameMs: number;
		}>;
		queueDelay: ReturnType<typeof summary>;
		dispatch: ReturnType<typeof summary>;
		inputToFrame: ReturnType<typeof summary>;
		nextInputDelay: ReturnType<typeof summary>;
	};
	longTasks: {
		supported: boolean;
		raw: Array<{ start: number; duration: number }>;
		count: number;
		p95: number;
		max: number;
	};
	stages: Record<string, unknown>;
	measures: Record<string, MeasureSample>;
	route: {
		scoped: number;
		full: number;
		reasons: Record<string, number>;
		sourcePaths: Record<string, number>;
		acceptedEdits: number;
	};
	snapshot: {
		editorChars: number;
		durableChars: number;
		durableBytes: number;
	};
	bytes: {
		/** `Chars` fields count UTF-16 code units. `durableBytes` is UTF-8. */
		postedSourceChars: number;
		postedEditChars: number;
		allocatedSnapshotChars: number;
		durableBytes: number;
	};
	heap: {
		supported: boolean;
		beforeBytes: number | null;
		afterBytes: number | null;
		deltaBytes: number | null;
	};
	durableExact: boolean;
};

async function heapBytes(page: Page): Promise<number | null> {
	return page.evaluate(() => {
		const memory = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory;
		return typeof memory?.usedJSHeapSize === 'number' ? memory.usedJSHeapSize : null;
	});
}

async function recordCase(
	page: Page,
	options: {
		id: string;
		description: string;
		run: number;
		warmup: boolean;
		expectedKeys: number;
		requestedSpacingMs: number[];
		expectedContent: string;
		cache?: 'warm' | 'cold';
		control?: boolean;
		action: () => Promise<void>;
	}
): Promise<CaseResult> {
	await resetProbe(page);
	const before = await storedRow(page);
	const heapBefore = await heapBytes(page);
	await options.action();
	if (!options.control) await waitForSettled(page, options.expectedKeys);
	else await page.waitForTimeout(50);
	const probe = await readProbe(page);
	const measures = await performanceMeasures(page);
	const after = await storedRow(page);
	const heapAfter = await heapBytes(page);
	const inputs = probe.keys.map((key) => ({
		queueDelayMs: Math.max(0, key.started - key.stamp),
		dispatchMs: key.dispatch ?? 0,
		inputToFrameMs: key.frame ?? 0
	}));
	const nextInputDelay: number[] = [];
	for (let index = 1; index < probe.keys.length; index += 1) {
		const requested = options.requestedSpacingMs[index - 1] ?? BURST_SPACING_MS;
		nextInputDelay.push(probe.keys[index]!.started - probe.keys[index - 1]!.started - requested);
	}
	const reasons = Object.fromEntries(
		Object.entries(probe.counters)
			.filter(([name]) => name.startsWith('sourceFidelityFullReason:'))
			.map(([name, count]) => [name.slice('sourceFidelityFullReason:'.length), count])
	);
	const sourcePaths = Object.fromEntries(
		Object.entries(probe.counters)
			.filter(([name]) => name.startsWith('sourceFidelityPath:'))
			.map(([name, count]) => [name.slice('sourceFidelityPath:'.length), count])
	);
	const editorChars = await editorSnapshotChars(page);
	return {
		id: options.id,
		description: options.description,
		run: options.run,
		warmup: options.warmup,
		cache: options.cache ?? 'warm',
		requestedSpacingMs: options.requestedSpacingMs,
		stageSamples: probe.stages,
		nextInputDelayRaw: nextInputDelay,
		inputs: {
			raw: inputs,
			queueDelay: summary(inputs.map((input) => input.queueDelayMs)),
			dispatch: summary(inputs.map((input) => input.dispatchMs)),
			inputToFrame: summary(inputs.map((input) => input.inputToFrameMs)),
			nextInputDelay: summary(nextInputDelay)
		},
		longTasks: {
			supported: probe.longTasksSupported,
			raw: probe.longTasks,
			count: probe.longTasks.length,
			p95: percentile(
				probe.longTasks.map((task) => task.duration),
				0.95
			),
			max: probe.longTasks.length ? Math.max(...probe.longTasks.map((task) => task.duration)) : 0
		},
		stages: stageSummary(probe.stages),
		measures,
		route: {
			scoped: probe.counters.sourceFidelityScoped ?? 0,
			full: probe.counters.sourceFidelityFull ?? 0,
			reasons,
			sourcePaths,
			acceptedEdits: probe.edits.length
		},
		snapshot: {
			editorChars,
			durableChars: after.length,
			durableBytes: Buffer.byteLength(after.content)
		},
		bytes: {
			postedSourceChars: measures['mdsh:metadata-transfer']?.detail.sourceBytes ?? 0,
			postedEditChars: measures['mdsh:metadata-transfer']?.detail.editBytes ?? 0,
			allocatedSnapshotChars: measures['mdsh:document-serialization']?.detail.chars ?? 0,
			durableBytes: Buffer.byteLength(after.content)
		},
		heap: {
			supported: heapBefore !== null && heapAfter !== null,
			beforeBytes: heapBefore,
			afterBytes: heapAfter,
			deltaBytes: heapBefore !== null && heapAfter !== null ? heapAfter - heapBefore : null
		},
		durableExact: options.control
			? after.length === before.length
			: after.content === options.expectedContent
	};
}

async function editCase(
	page: Page,
	target: string,
	edge: 'start' | 'end',
	text: string,
	expectedContent: string
): Promise<void> {
	await placeCaret(page, target, edge);
	await typeBurst(page, text);
	await waitForDurableExact(page, expectedContent);
}
const WARMUP_RUNS = 1;
const MINIMUM_TAIL_SAMPLES = 20;

type RepresentativeBudget = {
	version: number;
	defaults: { minimumSamples: number; toleranceRatio: number; warmupRuns: number };
	platforms: Record<
		string,
		{
			label: string;
			metrics: Record<
				string,
				{ p95: number; unit: string; minimumSamples?: number; note?: string }
			>;
		}
	>;
};

function loadRepresentativeBudget(): RepresentativeBudget | null {
	try {
		const value = JSON.parse(
			readFileSync(new URL('../scripts/representative-budgets.json', import.meta.url), 'utf8')
		) as RepresentativeBudget;
		if (value.version !== 1) throw new Error('Unsupported representative budget version.');
		return value;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
}

function configuredSampleRuns(): number {
	const raw = process.env.REPRESENTATIVE_SAMPLES ?? (process.env.CI ? '20' : '1');
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 1 || value > 50) {
		throw new Error('REPRESENTATIVE_SAMPLES must be an integer from 1 through 50.');
	}
	return value;
}

type MetricRecord = ReturnType<typeof summary> & {
	status: 'measured' | 'unsupported' | 'insufficient-samples';
	reason?: string;
};

function metricRecord(
	values: readonly number[],
	supported: boolean,
	reason?: string
): MetricRecord {
	const stats = summary(values);
	const status: MetricRecord['status'] = !supported
		? 'unsupported'
		: stats.denominator >= MINIMUM_TAIL_SAMPLES
			? 'measured'
			: 'insufficient-samples';
	return reason ? { ...stats, status, reason } : { ...stats, status };
}

function pooledMeasures(rows: readonly CaseResult[]): Record<string, MeasureSample> {
	const names = new Set(rows.flatMap((row) => Object.keys(row.measures)));
	return Object.fromEntries(
		[...names].map((name) => {
			const samples = rows
				.map((row) => row.measures[name])
				.filter((sample): sample is MeasureSample => Boolean(sample));
			const values = samples.flatMap((sample) => sample.values);
			const detail: Record<string, number> = {};
			for (const sample of samples) {
				for (const [field, value] of Object.entries(sample.detail)) {
					detail[field] = (detail[field] ?? 0) + value;
				}
			}
			return [
				name,
				{
					count: values.length,
					p50: percentile(values, 0.5),
					p95: percentile(values, 0.95),
					max: values.length ? Math.max(...values) : 0,
					detail,
					values
				}
			];
		})
	);
}

type AggregateCase = {
	id: string;
	description: string;
	cache: 'warm' | 'cold';
	requestedSpacingMs: number[];
	runs: { total: number; warmup: number; measured: number; measuredIndices: number[] };
	inputs: {
		raw: Array<{ run: number; queueDelayMs: number; dispatchMs: number; inputToFrameMs: number }>;
		queueDelay: ReturnType<typeof summary>;
		dispatch: ReturnType<typeof summary>;
		inputToFrame: ReturnType<typeof summary>;
		nextInputDelay: ReturnType<typeof summary>;
	};
	longTasks: {
		supported: boolean;
		raw: Array<{ run: number; start: number; duration: number }>;
		count: number;
		p95: number;
		max: number;
	};
	stages: Record<string, unknown>;
	measures: Record<string, MeasureSample>;
	route: {
		scoped: number;
		full: number;
		reasons: Record<string, number>;
		sourcePaths: Record<string, number>;
		acceptedEdits: number;
	};
	snapshot: CaseResult['snapshot'];
	bytes: CaseResult['bytes'];
	heap: {
		supported: boolean;
		samples: Array<{ run: number; deltaBytes: number }>;
		delta: ReturnType<typeof summary>;
	};
	durableExact: boolean;
	undoRestored: boolean;
	metrics: Record<string, MetricRecord>;
};

function aggregateCases(rows: readonly CaseResult[]): AggregateCase[] {
	return [...new Set(rows.map((row) => row.id))].map((id) => {
		const all = rows.filter((row) => row.id === id);
		const measured = all.filter((row) => !row.warmup);
		const inputs = measured.flatMap((row) =>
			row.inputs.raw.map((sample) => ({ run: row.run, ...sample }))
		);
		const nextInputDelay = measured.flatMap((row) => row.nextInputDelayRaw);
		const longTasks = measured.flatMap((row) =>
			row.longTasks.raw.map((task) => ({ run: row.run, ...task }))
		);
		const longTasksSupported =
			measured.length > 0 && measured.every((row) => row.longTasks.supported);
		const stages = measured.flatMap((row) => row.stageSamples);
		const reasons: Record<string, number> = {};
		const sourcePaths: Record<string, number> = {};
		for (const row of measured) {
			for (const [reason, count] of Object.entries(row.route.reasons)) {
				reasons[reason] = (reasons[reason] ?? 0) + count;
			}
			for (const [path, count] of Object.entries(row.route.sourcePaths)) {
				sourcePaths[path] = (sourcePaths[path] ?? 0) + count;
			}
		}
		const heapSamples = measured
			.map((row) => ({ run: row.run, deltaBytes: row.heap.deltaBytes }))
			.filter(
				(sample): sample is { run: number; deltaBytes: number } => sample.deltaBytes !== null
			);
		const stageNames = [...new Set(stages.map((stage) => stage.name))];
		const last = measured.at(-1) ?? all.at(-1)!;
		return {
			id,
			description: all[0]!.description,
			cache: all[0]!.cache,
			requestedSpacingMs: all[0]!.requestedSpacingMs,
			runs: {
				total: all.length,
				warmup: all.length - measured.length,
				measured: measured.length,
				measuredIndices: measured.map((row) => row.run)
			},
			inputs: {
				raw: inputs,
				queueDelay: summary(inputs.map((input) => input.queueDelayMs)),
				dispatch: summary(inputs.map((input) => input.dispatchMs)),
				inputToFrame: summary(inputs.map((input) => input.inputToFrameMs)),
				nextInputDelay: summary(nextInputDelay)
			},
			longTasks: {
				supported: longTasksSupported,
				raw: longTasks,
				count: longTasks.length,
				p95: percentile(
					longTasks.map((task) => task.duration),
					0.95
				),
				max: longTasks.length ? Math.max(...longTasks.map((task) => task.duration)) : 0
			},
			stages: stageSummary(stages),
			measures: pooledMeasures(measured),
			route: {
				scoped: measured.reduce((total, row) => total + row.route.scoped, 0),
				full: measured.reduce((total, row) => total + row.route.full, 0),
				reasons,
				sourcePaths,
				acceptedEdits: measured.reduce((total, row) => total + row.route.acceptedEdits, 0)
			},
			snapshot: last.snapshot,
			bytes: {
				postedSourceChars: measured.reduce((total, row) => total + row.bytes.postedSourceChars, 0),
				postedEditChars: measured.reduce((total, row) => total + row.bytes.postedEditChars, 0),
				allocatedSnapshotChars: measured.reduce(
					(total, row) => total + row.bytes.allocatedSnapshotChars,
					0
				),
				durableBytes: last.bytes.durableBytes
			},
			heap: {
				supported: measured.length > 0 && measured.every((row) => row.heap.supported),
				samples: heapSamples,
				delta: summary(heapSamples.map((sample) => sample.deltaBytes))
			},
			durableExact: measured.length > 0 && measured.every((row) => row.durableExact),
			undoRestored: all.every((row) => row.undoRestored !== false),
			metrics: {
				inputToFrameMs: metricRecord(
					inputs.map((input) => input.inputToFrameMs),
					true
				),
				queueDelayMs: metricRecord(
					inputs.map((input) => input.queueDelayMs),
					true
				),
				dispatchMs: metricRecord(
					inputs.map((input) => input.dispatchMs),
					true
				),
				nextInputDelayMs: metricRecord(nextInputDelay, true),
				longTaskMs: metricRecord(
					longTasks.map((task) => task.duration),
					longTasksSupported,
					'PerformanceObserver longtask is not exposed by this engine.'
				),
				heapDeltaBytes: metricRecord(
					heapSamples.map((sample) => sample.deltaBytes),
					heapSamples.length > 0,
					'The engine does not expose a JavaScript heap estimate.'
				),
				...Object.fromEntries(
					stageNames.map((name) => [
						`${name}Ms`,
						metricRecord(
							stages.filter((stage) => stage.name === name).map((stage) => stage.value),
							true
						)
					])
				)
			}
		};
	});
}

type BudgetResult = {
	key: string;
	caseId: string;
	metric: string;
	statistic: 'p95';
	denominator: number;
	minimumSamples: number;
	measuredP95: number;
	budgetP95: number;
	limitWithTolerance: number;
	unit: string;
	status: 'ok' | 'over-budget' | 'insufficient-samples' | 'unsupported';
	reason?: string;
};

function evaluateBudgets(
	cases: readonly AggregateCase[],
	platformKey: string,
	budget: RepresentativeBudget | null,
	sampleRuns: number
): {
	platformKey: string;
	status: 'ok' | 'failed' | 'not-enforced' | 'no-budget' | 'no-platform-baseline';
	enforced: boolean;
	minimumSamples: number;
	toleranceRatio: number;
	results: BudgetResult[];
} {
	if (!budget) {
		return {
			platformKey,
			status: 'no-budget',
			enforced: false,
			minimumSamples: MINIMUM_TAIL_SAMPLES,
			toleranceRatio: 0,
			results: []
		};
	}
	const platform = budget.platforms[platformKey];
	if (!platform) {
		return {
			platformKey,
			status: 'no-platform-baseline',
			enforced: false,
			minimumSamples: budget.defaults.minimumSamples,
			toleranceRatio: budget.defaults.toleranceRatio,
			results: []
		};
	}
	const results: BudgetResult[] = [];
	let overBudget = false;
	let insufficient = false;
	for (const [key, limit] of Object.entries(platform.metrics)) {
		const separator = key.indexOf('.');
		const caseId = key.slice(0, separator);
		const metricName = key.slice(separator + 1);
		const row = cases.find((entry) => entry.id === caseId);
		const metric = row?.metrics[metricName];
		const minimumSamples = limit.minimumSamples ?? budget.defaults.minimumSamples;
		if (!metric || metric.status === 'unsupported') {
			results.push({
				key,
				caseId,
				metric: metricName,
				statistic: 'p95',
				denominator: metric?.denominator ?? 0,
				minimumSamples,
				measuredP95: 0,
				budgetP95: limit.p95,
				limitWithTolerance: 0,
				unit: limit.unit,
				status: 'unsupported',
				reason: metric?.reason ?? 'The case does not record this metric.'
			});
			continue;
		}
		if (metric.denominator < minimumSamples) {
			insufficient = true;
			results.push({
				key,
				caseId,
				metric: metricName,
				statistic: 'p95',
				denominator: metric.denominator,
				minimumSamples,
				measuredP95: metric.p95,
				budgetP95: limit.p95,
				limitWithTolerance: 0,
				unit: limit.unit,
				status: 'insufficient-samples'
			});
			continue;
		}
		const limitWithTolerance = Number(
			(limit.p95 * (1 + budget.defaults.toleranceRatio)).toFixed(3)
		);
		const status = metric.p95 > limitWithTolerance ? 'over-budget' : 'ok';
		if (status === 'over-budget') overBudget = true;
		results.push({
			key,
			caseId,
			metric: metricName,
			statistic: 'p95',
			denominator: metric.denominator,
			minimumSamples,
			measuredP95: metric.p95,
			budgetP95: limit.p95,
			limitWithTolerance,
			unit: limit.unit,
			status
		});
	}
	const enforced = sampleRuns >= budget.defaults.minimumSamples;
	return {
		platformKey,
		status: !enforced ? 'not-enforced' : overBudget || insufficient ? 'failed' : 'ok',
		enforced,
		minimumSamples: budget.defaults.minimumSamples,
		toleranceRatio: budget.defaults.toleranceRatio,
		results
	};
}

type PassResult = { rows: CaseResult[]; expected: string };

async function runPass(
	page: Page,
	run: number,
	warmup: boolean,
	initial: string
): Promise<PassResult> {
	const rows: CaseResult[] = [];
	const base = { run, warmup };
	let expected = initial;

	const plainStart = 'Plain start sentence stays stable here';
	{
		const next = expected.replace(plainStart, `abc${plainStart}`);
		rows.push(
			await recordCase(page, {
				...base,
				id: 'plain-start',
				description: 'Three ordinary letters at the start of a plain paragraph.',
				expectedKeys: 3,
				requestedSpacingMs: [BURST_SPACING_MS, BURST_SPACING_MS],
				expectedContent: next,
				action: () => editCase(page, plainStart, 'start', 'abc', next)
			})
		);
		expected = next;
	}

	const mixedStart = 'Mixed start sentence stays stable here';
	{
		const next = expected.replace(mixedStart, `abc${mixedStart}`);
		rows.push(
			await recordCase(page, {
				...base,
				id: 'mixed-start',
				description:
					'Three ordinary letters at the start of a paragraph with bold, emphasis, a link and inline code.',
				expectedKeys: 3,
				requestedSpacingMs: [BURST_SPACING_MS, BURST_SPACING_MS],
				expectedContent: next,
				action: () => editCase(page, mixedStart, 'start', 'abc', next)
			})
		);
		expected = next;
	}

	const plainMiddle = 'Plain middle sentence stays stable here';
	{
		const next = expected.replace(plainMiddle, `${plainMiddle}abc`);
		rows.push(
			await recordCase(page, {
				...base,
				id: 'plain-middle',
				description: 'Three ordinary letters at the middle of a plain paragraph.',
				expectedKeys: 3,
				requestedSpacingMs: [BURST_SPACING_MS, BURST_SPACING_MS],
				expectedContent: next,
				action: () => editCase(page, plainMiddle, 'end', 'abc', next)
			})
		);
		expected = next;
	}

	const mixedMiddle = 'Mixed middle sentence stays stable here';
	{
		const next = expected.replace(mixedMiddle, `${mixedMiddle}abc`);
		rows.push(
			await recordCase(page, {
				...base,
				id: 'mixed-middle',
				description:
					'Three ordinary letters at the middle of a paragraph with unchanged inline marks.',
				expectedKeys: 3,
				requestedSpacingMs: [BURST_SPACING_MS, BURST_SPACING_MS],
				expectedContent: next,
				action: () => editCase(page, mixedMiddle, 'end', 'abc', next)
			})
		);
		expected = next;
	}

	const plainEnd = 'Plain end sentence stays stable here';
	{
		const next = expected.replace(plainEnd, `${plainEnd}abc`);
		rows.push(
			await recordCase(page, {
				...base,
				id: 'plain-end',
				description: 'Three ordinary letters at the end of a plain paragraph.',
				expectedKeys: 3,
				requestedSpacingMs: [BURST_SPACING_MS, BURST_SPACING_MS],
				expectedContent: next,
				action: () => editCase(page, plainEnd, 'end', 'abc', next)
			})
		);
		expected = next;
	}

	const mixedEnd = 'Mixed end sentence stays stable here';
	{
		const next = expected.replace(mixedEnd, `${mixedEnd}abc`);
		rows.push(
			await recordCase(page, {
				...base,
				id: 'mixed-end',
				description:
					'Three ordinary letters at the end of a paragraph with unchanged inline marks.',
				expectedKeys: 3,
				requestedSpacingMs: [BURST_SPACING_MS, BURST_SPACING_MS],
				expectedContent: next,
				action: () => editCase(page, mixedEnd, 'end', 'abc', next)
			})
		);
		expected = next;
	}

	const listTarget = 'List item 250 keeps stable words';
	{
		const next = expected.replace(listTarget, `${listTarget}abc`);
		rows.push(
			await recordCase(page, {
				...base,
				id: 'list-edit',
				description: 'Three ordinary letters inside one item of a 320 item list.',
				expectedKeys: 3,
				requestedSpacingMs: [BURST_SPACING_MS, BURST_SPACING_MS],
				expectedContent: next,
				action: () => editCase(page, listTarget, 'end', 'abc', next)
			})
		);
		expected = next;
	}

	const tableTarget = 'target middle';
	{
		const next = expected.replace(tableTarget, `${tableTarget}abc`);
		rows.push(
			await recordCase(page, {
				...base,
				id: 'table-edit',
				description: 'Three ordinary letters inside one cell of a 140 row table.',
				expectedKeys: 3,
				requestedSpacingMs: [BURST_SPACING_MS, BURST_SPACING_MS],
				expectedContent: next,
				action: () => editCase(page, tableTarget, 'end', 'abc', next)
			})
		);
		expected = next;
	}

	// Enter inside a mixed paragraph is a structural change. The local route
	// inserts only the paragraph break and keeps the inline marks. Undo returns
	// the document to the same state, so the next pass starts from the same
	// source.
	const splitExpected = expected.replace(' with **bold middle**', ' \n\nwith **bold middle**');
	{
		const row = await recordCase(page, {
			...base,
			id: 'mixed-enter-split',
			description: 'Enter before a bold run in a mixed-format paragraph.',
			expectedKeys: 1,
			requestedSpacingMs: [],
			expectedContent: splitExpected,
			action: async () => {
				await placeCaretInView(page, 'with bold middle', 'start');
				await page.keyboard.press('Enter');
				await waitForDurableExact(page, splitExpected);
			}
		});
		await page.keyboard.press('ControlOrMeta+z');
		await waitForDurableExact(page, expected);
		row.undoRestored = true;
		rows.push(row);
	}

	// Slow key repeat with publication and save intervals between keys.
	const tail = 'Tail paragraph keeps the caret target';
	const pauses = [300, 500, 800, 1_200];
	{
		let typed = '';
		const next = expected.replace(tail, `${tail}abcdefg`);
		rows.push(
			await recordCase(page, {
				...base,
				id: 'slow-key-repeat',
				description:
					'Three keys at 45 ms, then one key after each 300, 500, 800 and 1200 ms pause.',
				expectedKeys: 7,
				requestedSpacingMs: [BURST_SPACING_MS, BURST_SPACING_MS, ...pauses],
				expectedContent: next,
				action: async () => {
					await placeCaret(page, tail, 'end');
					for (const character of 'abc') {
						if (typed) await page.waitForTimeout(BURST_SPACING_MS);
						await page.keyboard.insertText(character);
						typed += character;
					}
					for (const pause of pauses) {
						await page.waitForTimeout(pause);
						const character = String.fromCharCode(100 + typed.length - 3);
						await page.keyboard.insertText(character);
						typed += character;
					}
					await waitForDurableExact(page, next);
				}
			})
		);
		expected = next;
	}

	return { rows, expected };
}

test('records a representative editor report and the mixed-format route matrix', async ({
	page
}, info) => {
	test.slow();
	test.setTimeout(1_800_000);
	const sampleRuns = configuredSampleRuns();
	await resetAppState(page, { mode: 'source' });
	const source = representativeNote();
	await seedNote(page, source);
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor({
		state: 'visible',
		timeout: 30_000
	});

	const coldOpenMs = await openVisualEditor(page);
	await installProbe(page);
	let expected = source;
	const rows: CaseResult[] = [];
	for (let run = 0; run < WARMUP_RUNS + sampleRuns; run += 1) {
		const pass = await runPass(page, run, run < WARMUP_RUNS, expected);
		expected = pass.expected;
		rows.push(...pass.rows);
	}

	// Control without a change: the same idle interval must not record a key,
	// a route decision or an accepted edit. One control row is enough; it has
	// no tail samples by construction.
	const tail = 'Tail paragraph keeps the caret target';
	const controlBefore = await storedRow(page);
	const control = await recordCase(page, {
		id: 'control-no-change',
		description: 'The caret stays in the tail paragraph for 1300 ms without a key.',
		run: WARMUP_RUNS + sampleRuns,
		warmup: false,
		expectedKeys: 0,
		requestedSpacingMs: [],
		expectedContent: expected,
		control: true,
		action: async () => {
			await placeCaret(page, tail, 'end');
			await page.waitForTimeout(1_300);
		}
	});
	const controlAfter = await storedRow(page);
	expect(controlAfter.content, 'the control must not change durable bytes').toBe(
		controlBefore.content
	);
	await page.evaluate(() => {
		const element = document.querySelector('.ProseMirror');
		if (!element) throw new Error('Missing editor element.');
		window.__representativeStallRuns = 0;
		window.__representativeStall = (event) => {
			if (!(event instanceof InputEvent)) return;
			window.__representativeStallRuns = (window.__representativeStallRuns ?? 0) + 1;
			const end = performance.now() + 120;
			while (performance.now() < end) {
				// A controlled 120 ms CPU stall proves the frame metric detects it.
			}
		};
		element.addEventListener('beforeinput', window.__representativeStall, true);
	});
	const stallExpected = expected.replace(tail, `${tail}z`);
	const stallControl = await recordCase(page, {
		id: 'stall-control',
		description:
			'One inserted letter after a test-only 120 ms busy wait in the input path. This is a negative control, not a product timing claim.',
		run: WARMUP_RUNS + sampleRuns,
		warmup: false,
		expectedKeys: 1,
		requestedSpacingMs: [],
		expectedContent: stallExpected,
		action: async () => {
			await placeCaret(page, tail, 'end');
			await page.keyboard.insertText('z');
			await waitForDurableExact(page, stallExpected);
		}
	});
	await page.evaluate(() => {
		const element = document.querySelector('.ProseMirror');
		if (!element || !window.__representativeStall) return;
		element.removeEventListener('beforeinput', window.__representativeStall, true);
		delete window.__representativeStall;
	});
	const stallEvents = await page.evaluate(() => window.__representativeStallRuns ?? 0);
	expected = stallExpected;

	// A Source to WYSIWYG switch on the same document measures the warm mount.
	await page.locator('[data-mode=source]').click();
	await expect(page.locator('.cm-content').first()).toBeVisible({ timeout: 30_000 });
	const warmOpenMs = await openVisualEditor(page);

	const actual = await exportSource(page, NOTE_NAME);
	await info.attach('representative-expected.md', {
		body: expected,
		contentType: 'text/markdown'
	});
	await info.attach('representative-actual.md', {
		body: actual,
		contentType: 'text/markdown'
	});

	const cases = aggregateCases(rows);
	const budget = loadRepresentativeBudget();
	const platformKey = `web-${info.project.name}`;
	const budgetResult = evaluateBudgets(cases, platformKey, budget, sampleRuns);
	const payload = {
		schema: 'deckmark-representative-editor/2',
		command: `REPRESENTATIVE_SAMPLES=${sampleRuns} npx playwright test e2e/representative-editor-report.spec.ts --project=${info.project.name} --workers=1 --retries=0 --trace=off`,
		identity: testSource(),
		build: {
			mode: 'source-fidelity-instrumented',
			prebuilt: process.env.E2E_PREBUILT === '1'
		},
		fixture: {
			name: NOTE_NAME,
			bytes: Buffer.byteLength(source),
			chars: source.length,
			generator: 'representativeNote()',
			listItems: 320,
			tableRows: 140,
			embeddedImages: 1
		},
		sampling: {
			warmupRuns: WARMUP_RUNS,
			measuredRuns: sampleRuns,
			totalRunsPerCase: WARMUP_RUNS + sampleRuns,
			exclusion:
				'Pass 0 of every edit case is warmup. It stays in rawRuns and is excluded from every aggregate, denominator, percentile and budget.',
			aggregateRule:
				'Samples from every measured pass of one case are pooled. Each 3-key case supplies 3 input-to-frame samples and 2 next-input gaps per pass.',
			minimumTailSamples: MINIMUM_TAIL_SAMPLES
		},
		method: {
			input:
				'Trusted keyboard.insertText events. Queue delay is handler entry minus the trusted event timeStamp. Dispatch is handler entry to its queued microtask. A second animation frame is a frame opportunity, not compositor paint.',
			nextInput: 'Observed handler entry gap minus the requested spacing.',
			stages: 'deckmark:editor-perf duration events with start and end on the performance clock.',
			route:
				'sourceFidelityScoped and sourceFidelityFull counters. The reason is a coarse changed-block class, not the exact internal predicate.',
			durable: 'The exact drafts.content row after the save settles.',
			heap: 'performance.memory.usedJSHeapSize where the browser exposes it. It is a JavaScript heap estimate, not native RSS.'
		},
		unsupported: {
			nativeRss: 'The browser context exposes no attributable native or process RSS.',
			compositorPaint: 'A second animation frame is a frame opportunity, not composited pixels.',
			physicalDevice: 'No physical display, thermal state or installed PWA lifecycle is measured.'
		},
		cache: {
			cold: {
				ms: coldOpenMs,
				note: 'First editor mount in a fresh browser context after seeding and reload.'
			},
			warm: {
				ms: warmOpenMs,
				note: 'Source to WYSIWYG switch on the same document and context. Service workers are blocked, so an installed PWA cache update is not measured.'
			}
		},
		cases,
		rawRuns: rows,
		control: {
			durationMs: 1_300,
			durableCharsBefore: controlBefore.length,
			durableCharsAfter: controlAfter.length,
			row: control
		},
		negativeControl: {
			row: stallControl,
			stallEvents,
			expectedInputToFrameMs: 120,
			detected: stallControl.inputs.inputToFrame.max >= 80
		},
		budget: budgetResult,
		expectedChars: expected.length,
		actualChars: actual.length,
		exactBytes: actual === expected,
		browser: page.context().browser()?.version(),
		environments: [
			{
				id: 'source-only',
				status: 'not-tested',
				reason: 'This artifact records a browser run. The module source review is separate.'
			},
			{
				id: 'node-isolated',
				status: 'not-tested',
				reason:
					'npx vitest run src/lib/source-fidelity.test.ts --maxWorkers=1 records the bounded parser input.'
			},
			{
				id: 'desktop-chromium',
				status: info.project.name === 'chromium' ? 'tested' : 'not-tested',
				reason:
					info.project.name === 'chromium'
						? 'This Chromium run executed the case.'
						: 'This file selected another browser project.'
			},
			{
				id: 'desktop-firefox',
				status: info.project.name === 'firefox' ? 'tested' : 'not-tested',
				reason:
					info.project.name === 'firefox'
						? 'This Firefox run executed the case.'
						: 'This file selected another browser project.'
			},
			{
				id: 'desktop-webkit',
				status: info.project.name === 'webkit' ? 'tested' : 'not-tested',
				reason:
					info.project.name === 'webkit'
						? 'This WebKit run executed the case.'
						: 'This file selected another browser project.'
			},
			{
				id: 'desktop-installed-pwa',
				status: 'not-tested',
				reason: 'Playwright does not install a PWA or reproduce its lifecycle.'
			},
			{
				id: 'physical-iphone-ipad',
				status: 'not-tested',
				reason: 'No physical iOS device is attached to this run.'
			},
			{
				id: 'native-windows-linux-macos',
				status: 'not-tested',
				reason: 'No optimized native WebView is attached to this run.'
			}
		]
	};
	const reportPath = info.outputPath('representative-editor-report.json');
	await writeFile(reportPath, JSON.stringify(payload, null, 2));
	await info.attach('representative-editor-report.json', {
		path: reportPath,
		contentType: 'application/json'
	});

	const byId = new Map(cases.map((row) => [row.id, row]));
	for (const id of [
		'plain-start',
		'plain-middle',
		'plain-end',
		'mixed-start',
		'mixed-middle',
		'mixed-end'
	]) {
		const row = byId.get(id)!;
		expect(row.runs.measured, `${id}: every measured pass is retained`).toBe(sampleRuns);
		expect(row.route.scoped, `${id}: the plain or mixed edit must stay local`).toBeGreaterThan(0);
		expect(row.route.full, `${id}: the plain or mixed edit must not parse the whole source`).toBe(
			0
		);
		expect(
			row.inputs.inputToFrame.denominator,
			`${id}: every key from every measured pass has a frame sample`
		).toBe(3 * sampleRuns);
		expect(
			row.metrics.inputToFrameMs.denominator,
			`${id}: the metric record shows the same denominator`
		).toBe(3 * sampleRuns);
		expect(
			row.inputs.nextInputDelay.denominator,
			`${id}: two next-input gaps per measured pass are recorded`
		).toBe(2 * sampleRuns);
		expect(
			row.bytes.allocatedSnapshotChars,
			`${id}: the serialized snapshot characters must be recorded`
		).toBeGreaterThan(0);
		expect(
			row.bytes.postedSourceChars + row.bytes.postedEditChars,
			`${id}: the posted metadata characters must be recorded`
		).toBeGreaterThan(0);
		expect(row.durableExact, `${id}: every measured save must hold the accepted text`).toBe(true);
	}
	for (const id of ['list-edit', 'table-edit']) {
		const row = byId.get(id)!;
		expect(
			row.route.scoped,
			`${id}: the container edit must keep the bounded route`
		).toBeGreaterThan(0);
		expect(row.route.full, `${id}: the container edit must not parse the whole source`).toBe(0);
		expect(
			Object.keys(row.route.reasons).some((reason) =>
				reason.startsWith(id === 'list-edit' ? 'container-list' : 'container-table')
			),
			`${id}: the container fallback reason must not be reported`
		).toBe(false);
		expect(row.durableExact, `${id}: the container edit must keep exact bytes`).toBe(true);
	}
	const enter = byId.get('mixed-enter-split')!;
	expect(enter.route.scoped, 'the mixed Enter split must stay local').toBeGreaterThan(0);
	expect(enter.route.full, 'the mixed Enter split must not parse the whole source').toBe(0);
	expect(enter.undoRestored, 'undo must restore the source after every measured split').toBe(true);
	const slow = byId.get('slow-key-repeat')!;
	expect(slow.inputs.nextInputDelay.denominator, 'the slow repeat records six gaps per pass').toBe(
		6 * sampleRuns
	);
	expect(slow.durableExact, 'the slow repeat must keep exact bytes').toBe(true);
	expect(control.inputs.raw, 'the control must not record a key').toHaveLength(0);
	expect(control.route.scoped + control.route.full, 'the control must not publish').toBe(0);
	expect(control.route.acceptedEdits, 'the control must not accept an edit').toBe(0);
	expect(
		control.bytes.postedSourceChars +
			control.bytes.postedEditChars +
			control.bytes.allocatedSnapshotChars,
		'the control must not post or allocate source bytes'
	).toBe(0);
	expect(control.durableExact, 'the control must not change the durable row').toBe(true);
	expect(stallEvents, 'the negative control must run its busy wait once').toBeGreaterThanOrEqual(1);
	expect(
		stallControl.inputs.inputToFrame.max,
		'the negative control must show the 120 ms stall in the frame metric'
	).toBeGreaterThanOrEqual(80);
	expect(actual, 'the exported source must keep every expected byte').toBe(expected);

	// A metric with fewer than 20 samples is not a tail estimate. Report the
	// status and enforce nothing until the reviewed baseline runs exist.
	for (const row of cases) {
		for (const [name, metric] of Object.entries(row.metrics)) {
			if (metric.status === 'insufficient-samples') {
				expect(metric.p95, `${row.id}.${name}: no tail claim from too few samples`).toBeDefined();
			}
		}
	}

	for (const result of budgetResult.results) {
		if (result.status === 'ok' || result.status === 'unsupported') continue;
		if (!budgetResult.enforced) continue;
		expect(
			result.status,
			`${result.key}: p95 ${result.measuredP95} ${result.unit} from ${result.denominator} samples against ${result.limitWithTolerance} ${result.unit}`
		).toBe('ok');
	}
});

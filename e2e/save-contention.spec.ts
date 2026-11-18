import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { resetAppState } from './helpers';
import {
	contentionEnvironment,
	revisionSpanContract,
	saveContentionSchema,
	summarize,
	unsupportedMetrics
} from './save-contention-contract';

// DOM tracing distorts input timing. Keep reduction and tracing off so the raw
// frame samples describe the browser scheduling, not the recorder.
test.use({ locale: 'en-US', reducedMotion: 'reduce', trace: 'off' });

const MAIN_ID = 'contention-main';
const OTHER_ID = 'contention-other';
const OBSERVED_METRICS = [
	'mdsh:document-edit',
	'mdsh:document-serialization',
	'mdsh:document-derived',
	'mdsh:document-storage',
	'mdsh:metadata-job',
	'mdsh:metadata-transfer',
	'mdsh:draft-manifest',
	'mdsh:draft-metadata'
] as const;

type ContentionSample = {
	index: number;
	phase: string;
	baseRevision: string;
	acceptedSpan: { from: number; to: number; insert: string };
	resultRevision: string;
	inputToFrameMs: number;
	inputDispatchMs: number;
	queueDelayMs: number;
	handlerProxyMs: number;
	trusted: boolean;
	inputType: string;
	targetIsEditor: boolean;
};

type PutRecord = {
	id: string;
	length: number;
	started: number;
	epochStarted: number;
	stalledMs: number;
};

type TransactionRecord = {
	id: string | null;
	length: number;
	started: number;
	epochStarted: number;
	ended?: number;
	epochEnded?: number;
	aborted?: boolean;
	stalledMs: number;
};

type ContentionProbe = {
	puts: PutRecord[];
	transactions: TransactionRecord[];
	longTasks: Array<{ start: number; duration: number }>;
	longTasksSupported: boolean;
	stallMs: number;
	stallIntervals: number[];
	inputStallMs: number;
	inputStallIntervals: number[];
	corruptNextPut: boolean;
	corruptions: string[];
	arm: (() => void) | null;
	current: Record<string, unknown> | null;
};

declare global {
	interface Window {
		__saveContention: ContentionProbe;
	}
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

function largeNote(bytes: number, label: string): string {
	const paragraph =
		'Stable save contention prose keeps the same visible words in each run. The note tests one accepted edit during an active durable write. ';
	let content = `# Save contention ${label}\n\n`;
	let section = 0;
	while (Buffer.byteLength(content) < bytes) {
		content += `## Section ${section}\n\n${paragraph}${section}\n\n`;
		section += 1;
	}
	return content;
}

type SeedRow = {
	id: string;
	name: string;
	content: string;
	order: number;
	open: boolean;
	createdAt: number;
	updatedAt: number;
};

async function seed(page: Page, rows: SeedRow[], activeId: string): Promise<void> {
	await page.evaluate(
		async ({ rows: input, activeId: active }) => {
			await new Promise<void>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const transaction = database.transaction('drafts', 'readwrite');
					const store = transaction.objectStore('drafts');
					store.clear();
					for (const row of input) store.put(row);
					transaction.oncomplete = () => {
						database.close();
						resolve();
					};
					transaction.onerror = () => {
						database.close();
						reject(transaction.error);
					};
				};
			});
			localStorage.setItem('mdsh:activeId', active);
			localStorage.setItem('mdsh:mode', 'source');
			localStorage.setItem('mdsh:locale', 'en');
		},
		{ rows, activeId }
	);
}

async function installProbe(page: Page): Promise<void> {
	await page.addInitScript(() => {
		type PutRecord = {
			id: string;
			length: number;
			started: number;
			epochStarted: number;
			stalledMs: number;
		};
		type TransactionRecord = {
			id: string | null;
			length: number;
			started: number;
			epochStarted: number;
			ended?: number;
			epochEnded?: number;
			aborted?: boolean;
			stalledMs: number;
		};
		const state = {
			puts: [] as PutRecord[],
			transactions: [] as TransactionRecord[],
			longTasks: [] as Array<{ start: number; duration: number }>,
			stallMs: 0,
			stallIntervals: [] as number[],
			inputStallMs: 0,
			inputStallIntervals: [] as number[],
			corruptNextPut: false,
			corruptions: [] as string[],
			arm: null as null | (() => void),
			current: null as null | Record<string, unknown>
		};
		Object.defineProperty(window, '__saveContention', { value: state, configurable: true });
		const supported = PerformanceObserver.supportedEntryTypes.includes('longtask');
		state.longTasksSupported = supported;
		if (supported) {
			const observer = new PerformanceObserver((list) =>
				state.longTasks.push(
					...list
						.getEntries()
						.map((entry) => ({ start: entry.startTime, duration: entry.duration }))
				)
			);
			observer.observe({ entryTypes: ['longtask'] });
		}
		const originalPut = IDBObjectStore.prototype.put;
		IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
			if (this.name !== 'drafts' || !value || typeof value !== 'object') {
				return originalPut.call(this, value as never, key);
			}
			let row = value as { id?: string; content?: string };
			if (state.corruptNextPut && typeof row.content === 'string') {
				state.corruptNextPut = false;
				state.corruptions.push(String(row.id));
				row = { ...row, content: `${row.content}#` };
			}
			const transaction = this.transaction;
			type TransactionProbe = IDBTransaction & {
				__contention?: TransactionRecord;
			};
			const probed = transaction as TransactionProbe;
			if (!probed.__contention) {
				probed.__contention = {
					id: typeof row.id === 'string' ? row.id : null,
					length: typeof row.content === 'string' ? row.content.length : 0,
					started: performance.now(),
					epochStarted: Date.now(),
					stalledMs: 0
				};
				state.transactions.push(probed.__contention);
				transaction.addEventListener(
					'complete',
					() => {
						if (!probed.__contention) return;
						probed.__contention.ended = performance.now();
						probed.__contention.epochEnded = Date.now();
					},
					{ once: true }
				);
				transaction.addEventListener(
					'abort',
					() => {
						if (!probed.__contention) return;
						probed.__contention.aborted = true;
						probed.__contention.ended = performance.now();
						probed.__contention.epochEnded = Date.now();
					},
					{ once: true }
				);
			}
			const stall = state.stallMs;
			if (stall > 0) {
				state.stallMs = 0;
				const started = performance.now();
				while (performance.now() - started < stall) {
					/* Explicit persistence-stall control. */
				}
				state.stallIntervals.push(performance.now() - started);
				if (probed.__contention) {
					probed.__contention.stalledMs += stall;
				}
			}
			state.puts.push({
				id: typeof row.id === 'string' ? row.id : '',
				length: typeof row.content === 'string' ? row.content.length : 0,
				started: performance.now(),
				epochStarted: Date.now(),
				stalledMs: stall
			});
			return originalPut.call(this, row as never, key);
		} as typeof IDBObjectStore.prototype.put;

		state.arm = () => {
			const element = document.querySelector('.cm-content');
			if (!element) throw new Error('Missing CodeMirror input target.');
			const view =
				(
					element as HTMLElement & {
						cmView?: { view?: { state: { doc: { length: number } } } };
						cmTile?: { root?: { view?: { state: { doc: { length: number } } } } };
					}
				).cmView?.view ??
				(
					element as never as {
						cmTile?: { root?: { view?: { state: { doc: { length: number } } } } };
					}
				).cmTile?.root?.view;
			if (!view?.state?.doc) throw new Error('Missing CodeMirror view.');
			const sample: Record<string, unknown> = {
				started: null,
				dispatch: null,
				frame: null,
				queue: null,
				handlerProxy: null,
				trusted: false,
				inputType: null,
				targetIsEditor: false
			};
			state.current = sample;
			const listener = (event: Event) => {
				const input = event as InputEvent;
				const started = performance.now();
				sample.started = started;
				sample.trusted = input.isTrusted;
				sample.inputType = input.inputType;
				sample.targetIsEditor =
					input.target instanceof Element && !!input.target.closest('.cm-content');
				if (state.inputStallMs > 0) {
					const stall = state.inputStallMs;
					state.inputStallMs = 0;
					const stallStarted = performance.now();
					while (performance.now() - stallStarted < stall) {
						/* Explicit input-stage stall control. */
					}
					state.inputStallIntervals.push(performance.now() - stallStarted);
				}
				queueMicrotask(() => {
					sample.dispatch = performance.now() - started;
				});
				setTimeout(() => {
					sample.queue = performance.now() - started;
				}, 0);
				requestAnimationFrame(() =>
					requestAnimationFrame(() => {
						sample.frame = performance.now() - started;
					})
				);
				element.addEventListener(
					'input',
					() => {
						sample.handlerProxy = performance.now() - started;
					},
					{ capture: true, once: true }
				);
			};
			element.addEventListener('beforeinput', listener, { capture: true, once: true });
		};
	});
}

async function reloadApp(page: Page): Promise<void> {
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor({ timeout: 30_000 });
	await page.locator('.cm-content').first().waitFor({ timeout: 30_000 });
}

async function editorText(page: Page): Promise<string> {
	return page
		.locator('.cm-content')
		.first()
		.evaluate((element) => {
			const view =
				(
					element as HTMLElement & {
						cmView?: { view?: { state: { doc: { toString(): string } } } };
						cmTile?: { root?: { view?: { state: { doc: { toString(): string } } } } };
					}
				).cmView?.view ??
				(
					element as never as {
						cmTile?: { root?: { view?: { state: { doc: { toString(): string } } } } };
					}
				).cmTile?.root?.view;
			if (!view?.state?.doc) throw new Error('The full CodeMirror document is unavailable.');
			return view.state.doc.toString();
		});
}

async function placeCaret(page: Page, offset: number): Promise<void> {
	await page
		.locator('.cm-content')
		.first()
		.evaluate((element, position) => {
			const host = element as HTMLElement & {
				cmView?: { view?: { dispatch: (value: unknown) => void; focus: () => void } };
				cmTile?: {
					root?: { view?: { dispatch: (value: unknown) => void; focus: () => void } };
				};
			};
			const view = host.cmView?.view ?? host.cmTile?.root?.view;
			if (!view) throw new Error('Missing CodeMirror view.');
			view.dispatch({ selection: { anchor: position }, scrollIntoView: true });
			view.focus();
		}, offset);
}

async function storedText(page: Page, id: string): Promise<string> {
	return page.evaluate(
		(rowId) =>
			new Promise<string>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const row = database.transaction('drafts').objectStore('drafts').get(rowId);
					row.onsuccess = () => {
						database.close();
						resolve((row.result as { content?: string } | undefined)?.content ?? '');
					};
					row.onerror = () => {
						database.close();
						reject(row.error);
					};
				};
			}),
		id
	);
}

async function typeBurst(
	page: Page,
	count: number,
	spacingMs: number,
	phase: string,
	start: string,
	offset: number
): Promise<{ expected: string; samples: ContentionSample[] }> {
	const samples: ContentionSample[] = [];
	let expected = start;
	for (let index = 0; index < count; index += 1) {
		const at = offset + index;
		const base = expected;
		await page.evaluate(() => {
			window.__saveContention.arm?.();
		});
		await page.keyboard.insertText('x');
		await page.waitForFunction(() => window.__saveContention.current?.frame !== null);
		const observed = await page.evaluate(() => {
			const sample = window.__saveContention.current as Record<string, unknown>;
			return {
				inputToFrameMs: Number(sample.frame),
				inputDispatchMs: Number(sample.dispatch),
				queueDelayMs: Number(sample.queue),
				handlerProxyMs: Number(sample.handlerProxy),
				trusted: sample.trusted === true,
				inputType: String(sample.inputType ?? ''),
				targetIsEditor: sample.targetIsEditor === true
			};
		});
		expected = expected.slice(0, at) + 'x' + expected.slice(at);
		samples.push({
			index,
			phase,
			baseRevision: digest(base),
			acceptedSpan: { from: at, to: at, insert: 'x' },
			resultRevision: digest(expected),
			...observed
		});
		if (index + 1 < count) await page.waitForTimeout(spacingMs);
	}
	return { expected, samples };
}

async function measuresSince(page: Page, since: number) {
	return page.evaluate(
		({ names, from }) =>
			names.flatMap((name) =>
				performance
					.getEntriesByType('measure')
					.filter((entry) => entry.name === name && entry.startTime >= from)
					.map((entry) => ({ name, duration: entry.duration }))
			),
		{ names: OBSERVED_METRICS as unknown as string[], from: since }
	);
}

function artifact(info: TestInfo, payload: Record<string, unknown>): Record<string, unknown> {
	const metadata = info.config.metadata as {
		source?: string;
		sourceTree?: string;
		workingDiffSha256?: string;
		untracked?: Array<{ path: string; sha256: string }>;
		command?: string[];
		environment?: Record<string, unknown>;
	};
	const version =
		typeof payload.browserVersion === 'string' ? payload.browserVersion : 'unavailable';
	return {
		schema: saveContentionSchema,
		generatedAt: new Date().toISOString(),
		project: info.project.name,
		browser: {
			project: info.project.name,
			version
		},
		contract: revisionSpanContract,
		source: {
			revision: metadata.source,
			tree: metadata.sourceTree,
			diffSha256: metadata.workingDiffSha256,
			untrackedSha256: Object.fromEntries(
				(metadata.untracked ?? []).map((entry) => [entry.path, entry.sha256])
			)
		},
		command: metadata.command,
		environment: metadata.environment,
		environmentMatrix: contentionEnvironment(info.project.name),
		unsupported: unsupportedMetrics,
		...payload
	};
}

async function attach(info: TestInfo, name: string, payload: Record<string, unknown>) {
	const body = JSON.stringify(artifact(info, payload), null, 2);
	const directory = join('/srv/dev/cache/tmp/opencode/i327-evidence', info.project.name);
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, `${info.title.replaceAll(/[^a-z0-9]+/gi, '-').slice(0, 60)}-${name}`),
		body
	);
	await info.attach(name, {
		body,
		contentType: 'application/json'
	});
}

async function seedMain(page: Page, content: string): Promise<void> {
	await seed(
		page,
		[
			{
				id: MAIN_ID,
				name: 'contention.md',
				content,
				order: 0,
				open: true,
				createdAt: 1,
				updatedAt: 1
			}
		],
		MAIN_ID
	);
	await reloadApp(page);
	expect(await editorText(page)).toBe(content);
}

test.beforeEach(async ({ page }) => {
	await installProbe(page);
	await resetAppState(page, { mode: 'source' });
});

test('resumes a burst during an injected slow save and keeps exact bytes', async ({
	page
}, info) => {
	test.setTimeout(180_000);
	const fixture = largeNote(1_000_000, '1 MiB');
	await seedMain(page, fixture);
	const offset = Math.floor(fixture.length * 0.5);

	// Baseline burst: no injection, existing product behavior.
	await placeCaret(page, offset);
	const baselineStart = await page.evaluate(() => performance.now());
	const baseline = await typeBurst(page, 8, 45, 'baseline', fixture, offset);
	const fixtureAfterBaseline = baseline.expected;
	const baselineMeasures = await measuresSince(page, baselineStart);

	// Stalled burst: a 600 ms one-shot synchronous persistence stall models a
	// slow write on a large note and guarantees that the next burst arrives
	// while the save is active. This is a control, not a product timing claim.
	// Place the caret first: focus work differs by engine and must not consume
	// the one-shot stall. The first stalled key starts the save timer. The
	// remaining keys arrive after that timer has entered the stalled write.
	await placeCaret(page, offset + 8);
	await page.evaluate(() => {
		window.__saveContention.stallMs = 600;
	});
	const stalledStart = await page.evaluate(() => performance.now());
	const burstStartEpoch = Date.now();
	const firstStalled = await typeBurst(
		page,
		1,
		0,
		'stalled-save',
		fixtureAfterBaseline,
		offset + 8
	);
	await page.waitForTimeout(450);
	const restStalled = await typeBurst(
		page,
		7,
		45,
		'stalled-save',
		firstStalled.expected,
		offset + 9
	);
	const burstEndEpoch = Date.now();
	const stalled = {
		expected: restStalled.expected,
		samples: [...firstStalled.samples, ...restStalled.samples]
	};
	// A quiet period must persist the final accepted revision.
	await expect.poll(() => storedText(page, MAIN_ID), { timeout: 30_000 }).toBe(stalled.expected);
	const stalledMeasures = await measuresSince(page, stalledStart);
	const probe = await page.evaluate(() => ({
		transactions: window.__saveContention.transactions,
		puts: window.__saveContention.puts,
		stallIntervals: window.__saveContention.stallIntervals,
		longTasks: window.__saveContention.longTasks,
		longTasksSupported: window.__saveContention.longTasksSupported
	}));
	const stored = await storedText(page, MAIN_ID);
	const editor = await editorText(page);
	const expected = stalled.expected;
	const samples = [...baseline.samples, ...stalled.samples];
	const overlapping = probe.transactions.filter(
		(transaction) =>
			transaction.epochStarted <= burstEndEpoch &&
			(transaction.epochEnded === undefined || transaction.epochEnded >= burstStartEpoch)
	);
	const injected = probe.transactions.filter((transaction) => transaction.stalledMs > 0);

	await attach(info, 'save-contention.json', {
		browserVersion: await page.context().browser()?.version(),
		method: {
			workload: 'two bursts of eight characters, 45 ms spacing, mid-document',
			startBoundary: 'trusted beforeinput capture',
			frameBoundary: 'second animation frame opportunity',
			saveBoundary: 'first drafts put to transaction complete',
			injection: '600 ms synchronous stall inside the observed drafts put',
			injectionReason:
				'Guarantees a burst during an active save. It is not a product timing claim.',
			warmupExcluded: false
		},
		fixture: {
			id: MAIN_ID,
			bytes: Buffer.byteLength(fixture),
			sha256: digest(fixture),
			generator: 'largeNote(1_000_000)'
		},
		samples,
		summary: {
			all: {
				inputToFrameMs: summarize(samples.map((sample) => sample.inputToFrameMs)),
				inputDispatchMs: summarize(samples.map((sample) => sample.inputDispatchMs)),
				queueDelayMs: summarize(samples.map((sample) => sample.queueDelayMs)),
				handlerProxyMs: summarize(samples.map((sample) => sample.handlerProxyMs))
			},
			baseline: {
				inputToFrameMs: summarize(baseline.samples.map((sample) => sample.inputToFrameMs)),
				queueDelayMs: summarize(baseline.samples.map((sample) => sample.queueDelayMs)),
				handlerProxyMs: summarize(baseline.samples.map((sample) => sample.handlerProxyMs))
			},
			stalledSave: {
				inputToFrameMs: summarize(stalled.samples.map((sample) => sample.inputToFrameMs)),
				queueDelayMs: summarize(stalled.samples.map((sample) => sample.queueDelayMs)),
				handlerProxyMs: summarize(stalled.samples.map((sample) => sample.handlerProxyMs))
			}
		},
		save: {
			transactions: probe.transactions,
			puts: probe.puts,
			stallIntervals: probe.stallIntervals,
			overlappingBursts: overlapping.length,
			injectedStalls: injected.length,
			naturalSaves: probe.transactions.filter((transaction) => transaction.stalledMs === 0).length
		},
		publication: { baseline: baselineMeasures, stalled: stalledMeasures },
		longTasks: {
			supported: probe.longTasksSupported,
			values: probe.longTasks
		},
		durable: {
			expectedBytes: Buffer.byteLength(expected),
			expectedSha256: digest(expected),
			editorSha256: digest(editor),
			storedSha256: digest(stored),
			resultMatchesDurable: digest(expected) === digest(stored),
			editorMatchesDurable: digest(editor) === digest(stored)
		},
		evidence: {
			tested: 'desktop browser project in this run',
			notTested: 'installed PWA, physical iPhone/iPad and optimized native clients'
		}
	});

	// Measurement contract: raw samples, denominators and revisions are present.
	expect(samples).toHaveLength(16);
	for (const sample of samples) {
		expect(sample.baseRevision).toMatch(/^[a-f0-9]{64}$/);
		expect(sample.resultRevision).toMatch(/^[a-f0-9]{64}$/);
		expect(sample.trusted).toBe(true);
		expect(sample.inputType).toMatch(/^insert(Text|CompositionText)$/);
		expect(sample.targetIsEditor).toBe(true);
		expect(sample.inputToFrameMs).toBeGreaterThanOrEqual(0);
		expect(Number.isFinite(sample.queueDelayMs)).toBe(true);
		expect(Number.isFinite(sample.handlerProxyMs)).toBe(true);
	}
	expect(summarize(samples.map((sample) => sample.inputToFrameMs)).denominator).toBe(16);
	expect(probe.stallIntervals).toHaveLength(1);
	expect(injected).toHaveLength(1);
	expect(overlapping.length).toBeGreaterThan(0);
	expect(digest(editor)).toBe(digest(expected));
	expect(digest(stored)).toBe(digest(expected));
});

test('keeps exact bytes across a Read switch during pending publication', async ({
	page
}, info) => {
	test.setTimeout(120_000);
	const fixture = largeNote(240_000, '240 KiB');
	await seedMain(page, fixture);
	const offset = Math.floor(fixture.length * 0.3);
	await placeCaret(page, offset);
	const typed = await typeBurst(page, 5, 35, 'mode-switch', fixture, offset);
	const switchStarted = Date.now();

	// Switch before the 400 ms save delay ends. The source must survive the
	// publication cancellation and the Read mount.
	await page.locator('button[data-mode="read"]').click();
	await page.locator('.mdsh-read').waitFor({ timeout: 20_000 });
	await expect.poll(() => storedText(page, MAIN_ID), { timeout: 30_000 }).toBe(typed.expected);
	const stored = await storedText(page, MAIN_ID);
	await page.locator('button[data-mode="source"]').click();
	await page.locator('.cm-content').first().waitFor({ timeout: 20_000 });
	const editor = await editorText(page);
	const expected = typed.expected;
	await attach(info, 'save-contention-mode-switch.json', {
		browserVersion: await page.context().browser()?.version(),
		method: 'five characters, 35 ms spacing, then Read before the save delay ends',
		fixture: { bytes: Buffer.byteLength(fixture), sha256: digest(fixture) },
		samples: typed.samples,
		summary: { inputToFrameMs: summarize(typed.samples.map((sample) => sample.inputToFrameMs)) },
		switchEpoch: switchStarted,
		durable: {
			expectedSha256: digest(expected),
			editorSha256: digest(editor),
			storedSha256: digest(stored)
		}
	});
	expect(digest(editor)).toBe(digest(expected));
	expect(digest(stored)).toBe(digest(expected));
	expect(digest(editor)).toBe(digest(stored));
});

test('keeps exact bytes for both notes across a file switch with a pending save', async ({
	page
}, info) => {
	test.setTimeout(120_000);
	const main = largeNote(240_000, 'main');
	const other = largeNote(240_000, 'other');
	await seed(
		page,
		[
			{
				id: MAIN_ID,
				name: 'main.md',
				content: main,
				order: 0,
				open: true,
				createdAt: 1,
				updatedAt: 1
			},
			{
				id: OTHER_ID,
				name: 'other.md',
				content: other,
				order: 1,
				open: true,
				createdAt: 1,
				updatedAt: 1
			}
		],
		MAIN_ID
	);
	await reloadApp(page);
	expect(await editorText(page)).toBe(main);
	const offset = Math.floor(main.length * 0.7);
	await placeCaret(page, offset);
	const typed = await typeBurst(page, 5, 35, 'file-switch', main, offset);

	await page.locator(`aside button[data-file-id="${OTHER_ID}"]`).click();
	await page.waitForFunction(
		(expected) => {
			const element = document.querySelector('.cm-content');
			const view =
				(element as never as { cmView?: { view?: { state: { doc: { toString(): string } } } } })
					.cmView?.view ??
				(
					element as never as {
						cmTile?: { root?: { view?: { state: { doc: { toString(): string } } } } };
					}
				).cmTile?.root?.view;
			return view?.state?.doc?.toString() === expected;
		},
		other,
		{ timeout: 20_000 }
	);
	await expect.poll(() => storedText(page, MAIN_ID), { timeout: 30_000 }).toBe(typed.expected);
	const mainStored = await storedText(page, MAIN_ID);
	const otherStored = await storedText(page, OTHER_ID);
	await page.locator(`aside button[data-file-id="${MAIN_ID}"]`).click();
	await page.waitForTimeout(300);
	const restored = await editorText(page);
	const expected = typed.expected;
	await attach(info, 'save-contention-file-switch.json', {
		browserVersion: await page.context().browser()?.version(),
		method: 'five characters, 35 ms spacing, then select the other note before the save delay ends',
		fixture: {
			main: { bytes: Buffer.byteLength(main), sha256: digest(main) },
			other: { bytes: Buffer.byteLength(other), sha256: digest(other) }
		},
		samples: typed.samples,
		durable: {
			expectedSha256: digest(expected),
			mainStoredSha256: digest(mainStored),
			otherStoredSha256: digest(otherStored),
			restoredEditorSha256: digest(restored)
		}
	});
	expect(digest(mainStored)).toBe(digest(expected));
	expect(digest(otherStored)).toBe(digest(other));
	expect(digest(restored)).toBe(digest(expected));
});

test('detects a deliberate CPU stall at the input stage', async ({ page }, info) => {
	test.setTimeout(120_000);
	const fixture = largeNote(240_000, 'cpu-control');
	await seedMain(page, fixture);
	await page.evaluate(() => {
		window.__saveContention.inputStallMs = 120;
	});
	await placeCaret(page, 100);
	const typed = await typeBurst(page, 1, 0, 'cpu-control', fixture, 100);
	const sample = typed.samples[0];
	const intervals = await page.evaluate(() => window.__saveContention.inputStallIntervals);
	await attach(info, 'save-contention-cpu-control.json', {
		browserVersion: await page.context().browser()?.version(),
		method: 'one 120 ms busy wait inside the probe beforeinput capture listener',
		sample,
		stallIntervals: intervals,
		detected: sample.inputToFrameMs >= 80
	});
	expect(intervals).toHaveLength(1);
	expect(sample.inputToFrameMs).toBeGreaterThanOrEqual(80);
});

test('detects a deliberate durable projection mismatch', async ({ page }, info) => {
	test.setTimeout(120_000);
	const fixture = largeNote(240_000, 'persistence-control');
	await seedMain(page, fixture);
	const offset = 120;
	await placeCaret(page, offset);
	const typed = await typeBurst(page, 1, 0, 'persistence-control', fixture, offset);
	await page.evaluate(() => {
		window.__saveContention.corruptNextPut = true;
	});
	const afterCorruption = await typeBurst(
		page,
		1,
		0,
		'persistence-control',
		typed.expected,
		offset + 1
	);
	// The deliberately corrupted write must become durable before the next
	// edit. A normal write after it must replace the wrong bytes.
	const corruptedExpected = `${afterCorruption.expected}#`;
	await expect.poll(() => storedText(page, MAIN_ID), { timeout: 30_000 }).toBe(corruptedExpected);
	const storedCorrupted = await storedText(page, MAIN_ID);
	const detected = digest(storedCorrupted) !== digest(afterCorruption.expected);
	const recoveredTyped = await typeBurst(
		page,
		1,
		0,
		'persistence-control',
		afterCorruption.expected,
		offset + 2
	);
	await expect
		.poll(() => storedText(page, MAIN_ID), { timeout: 30_000 })
		.toBe(recoveredTyped.expected);
	const recovered = await storedText(page, MAIN_ID);
	const recoveredExpected = digest(recovered) === digest(recoveredTyped.expected);
	await attach(info, 'save-contention-persistence-control.json', {
		browserVersion: await page.context().browser()?.version(),
		method: 'one deliberately corrupted drafts.content write, then one normal write',
		corruptingPut: await page.evaluate(() => window.__saveContention.corruptions),
		expectedSha256: digest(afterCorruption.expected),
		corruptedStoredSha256: digest(storedCorrupted),
		recoveredStoredSha256: digest(recovered),
		recoveryExpectedSha256: digest(recoveredTyped.expected),
		detected,
		recovered: recoveredExpected
	});
	expect(detected).toBe(true);
	expect(recoveredExpected).toBe(true);
});

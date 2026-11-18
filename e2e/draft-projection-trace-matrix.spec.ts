import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { resetAppState, createFirstFile } from './helpers';

// Trace matrix for issue 574 criterion 3.
//
// One changed-document save runs several stages on the UI thread. This file
// separates them on the `performance` clock and records the delay of the next
// accepted key:
//   snapshot   `mdsh:document-serialization`
//   hook CPU   `mdsh:draft-metadata` and `mdsh:draft-manifest`
//   read       `mdsh:draft-read`
//   clone      `mdsh:draft-clone` (sync put call, includes the hook and clone)
//   write      `mdsh:draft-write` (put request settled)
//   commit     `mdsh:draft-commit` (put settled to transaction complete)
//   history    `mdsh:history`
//   input      `beforeinput` start and the second animation frame
//
// The matrix covers a burst and 250, 500 and 1100 ms spaced edits, with zero,
// one and four embedded images and four project assets. The values are local
// Chromium evidence for frame scheduling. They are not a physical display, an
// installed PWA or a native WebView result.

test.use({ locale: 'en-US', reducedMotion: 'reduce', trace: 'off' });

const NOTE_CHARS = 1024 * 1024;
const IMAGE_PAYLOAD = 'A'.repeat(256 * 1024);
const PROJECT_ASSET_BYTES = 256 * 1024;
const PROJECT_ID = 'trace-project';
const ARTIFACT_DIRECTORY = '/srv/dev/cache/tmp/opencode/i574-trace';

const TRACE_NAMES = [
	'mdsh:document-serialization',
	'mdsh:document-derived',
	'mdsh:document-storage',
	'mdsh:draft-read',
	'mdsh:draft-put',
	'mdsh:draft-write',
	'mdsh:draft-commit',
	'mdsh:draft-manifest',
	'mdsh:draft-metadata',
	'mdsh:history'
] as const;

interface Span {
	name: string;
	start: number;
	end: number;
	duration: number;
	detail: Record<string, unknown> | null;
}

interface KeySample {
	started: number;
	inputType: string | null;
	frame: number | null;
}

interface ProbeState {
	keys: KeySample[];
	puts: Array<{ started: number; duration: number; chars: number }>;
	longTasks: Array<{ start: number; duration: number }>;
	longTasksSupported: boolean;
}

interface AssetVariant {
	id: string;
	images: number;
	project: boolean;
}

interface Workload {
	id: string;
	keys: number;
	spacing: number;
}

const VARIANTS: AssetVariant[] = [
	{ id: 'plain-0', images: 0, project: false },
	{ id: 'image-1', images: 1, project: false },
	{ id: 'image-4', images: 4, project: false },
	{ id: 'project-4', images: 4, project: true }
];

const WORKLOADS: Workload[] = [
	{ id: 'burst-45ms', keys: 12, spacing: 45 },
	{ id: 'spaced-250ms', keys: 6, spacing: 250 },
	{ id: 'spaced-500ms', keys: 6, spacing: 500 },
	{ id: 'spaced-1100ms', keys: 5, spacing: 1100 }
];

function digest(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

/** Four project assets carry the same payload as one embedded image. */
function imageReference(index: number, project: boolean): string {
	if (project) return `![project image ${index}](../assets/p${index}.png)`;
	return `![image ${index}](data:image/png;base64,${IMAGE_PAYLOAD})`;
}

/**
 * Builds one note with a final plain body line. Images sit before that line so
 * an edit in the line must not scan the image region.
 */
function noteSource(variant: AssetVariant): string {
	const head = '# Autosave trace\n\n';
	const tail = '\n\nBody text.\n';
	const images =
		variant.images > 0
			? `\n${Array.from({ length: variant.images }, (_, index) => imageReference(index, variant.project)).join('\n\n')}\n`
			: '';
	const line = 'Plain body prose keeps one line of the durable source under a local edit. \n';
	const budget = Math.max(0, NOTE_CHARS - head.length - tail.length - images.length);
	const prose = line.repeat(Math.ceil(budget / line.length)).slice(0, budget);
	return head + prose + images + tail;
}

async function installProbe(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const state = {
			keys: [] as Array<{
				started: number;
				inputType: string | null;
				frame: number | null;
			}>,
			puts: [] as Array<{ started: number; duration: number; chars: number }>,
			longTasks: [] as Array<{ start: number; duration: number }>,
			longTasksSupported: false
		};
		Object.defineProperty(window, '__traceProbe', { value: state, configurable: true });
		const originalPut = IDBObjectStore.prototype.put;
		IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
			const started = performance.now();
			const request = originalPut.call(this, value as never, key);
			const duration = performance.now() - started;
			if (this.name === 'drafts') {
				const row = value as { content?: string } | undefined;
				state.puts.push({
					started,
					duration,
					chars: typeof row?.content === 'string' ? row.content.length : 0
				});
			}
			return request;
		} as typeof IDBObjectStore.prototype.put;
		document.addEventListener(
			'beforeinput',
			(event) => {
				const target = event.target;
				if (!(target instanceof Element) || !target.closest('.cm-content')) return;
				const started = performance.now();
				const sample = {
					started,
					inputType: (event as InputEvent).inputType ?? null,
					frame: null as number | null
				};
				state.keys.push(sample);
				requestAnimationFrame(() =>
					requestAnimationFrame(() => {
						sample.frame = performance.now() - started;
					})
				);
			},
			true
		);
		if (typeof PerformanceObserver !== 'undefined') {
			try {
				state.longTasksSupported = PerformanceObserver.supportedEntryTypes.includes('longtask');
				if (state.longTasksSupported) {
					new PerformanceObserver((list) => {
						for (const entry of list.getEntries())
							state.longTasks.push({ start: entry.startTime, duration: entry.duration });
					}).observe({ type: 'longtask', buffered: false });
				}
			} catch {
				// The engine does not expose long-task entries.
			}
		}
	});
}

async function resetProbe(page: Page): Promise<void> {
	await page.evaluate(() => {
		const probe = (window as unknown as { __traceProbe: ProbeState }).__traceProbe;
		probe.keys.length = 0;
		probe.puts.length = 0;
		probe.longTasks.length = 0;
		performance.clearMeasures();
	});
}

async function readProbe(page: Page): Promise<ProbeState> {
	return page.evaluate(() => {
		const probe = (window as unknown as { __traceProbe: ProbeState }).__traceProbe;
		return {
			keys: probe.keys.map((key) => ({ ...key })),
			puts: probe.puts.map((put) => ({ ...put })),
			longTasks: probe.longTasks.map((task) => ({ ...task })),
			longTasksSupported: probe.longTasksSupported
		};
	});
}

async function readSpans(page: Page, since: number): Promise<Span[]> {
	return page.evaluate(
		({ names, from }) => {
			const allowed = new Set(names);
			return performance
				.getEntriesByType('measure')
				.filter((entry) => entry.startTime >= from && allowed.has(entry.name))
				.map((entry) => ({
					name: entry.name,
					start: entry.startTime,
					end: entry.startTime + entry.duration,
					duration: entry.duration,
					detail: ((entry as PerformanceMeasure).detail as Record<string, unknown>) ?? null
				}))
				.sort((left, right) => left.start - right.start);
		},
		{ names: TRACE_NAMES as unknown as string[], from: since }
	);
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

async function storedText(page: Page): Promise<string> {
	return page.evaluate(
		() =>
			new Promise<string>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const cursor = database.transaction('drafts').objectStore('drafts').openCursor();
					cursor.onerror = () => {
						database.close();
						reject(cursor.error);
					};
					cursor.onsuccess = () => {
						const row = cursor.result?.value as { content?: string } | undefined;
						database.close();
						resolve(row?.content ?? '');
					};
				};
			})
	);
}

async function activeFileId(page: Page): Promise<string> {
	return page.evaluate(
		() =>
			new Promise<string>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					if (!database.objectStoreNames.contains('drafts')) {
						database.close();
						reject(new Error('draft store missing'));
						return;
					}
					const cursor = database.transaction('drafts').objectStore('drafts').openCursor();
					cursor.onerror = () => {
						database.close();
						reject(cursor.error);
					};
					cursor.onsuccess = () => {
						const row = cursor.result?.value as { id?: string } | undefined;
						database.close();
						if (row?.id) resolve(row.id);
						else reject(new Error('draft row missing'));
					};
				};
			})
	);
}

/** Writes the project row and four asset rows before the draft write. */
async function seedProject(page: Page): Promise<void> {
	await page.evaluate(
		async ({ projectId, bytes }) => {
			const payload = new Uint8Array(bytes);
			payload.fill(0x41);
			await new Promise<void>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const transaction = database.transaction(['projects', 'projectAssets'], 'readwrite');
					transaction.objectStore('projects').put({
						id: projectId,
						name: 'Trace project',
						createdAt: 1,
						updatedAt: 1
					});
					for (let index = 0; index < 4; index += 1) {
						transaction.objectStore('projectAssets').put({
							id: `trace-asset-${index}`,
							projectId,
							path: `assets/p${index}.png`,
							mime: 'image/png',
							data: payload.slice(),
							bytes
						});
					}
					transaction.oncomplete = () => {
						database.close();
						resolve();
					};
					transaction.onerror = () => reject(transaction.error);
					transaction.onabort = () => reject(transaction.error);
				};
			});
		},
		{ projectId: PROJECT_ID, bytes: PROJECT_ASSET_BYTES }
	);
}

/** Seeds the large note through the real hooks, then reloads to a clean state. */
async function seedNote(page: Page, id: string, variant: AssetVariant): Promise<string> {
	const content = noteSource(variant);
	await page.evaluate(
		async ({ draftId, text, project, projectId }) => {
			await (
				window as unknown as {
					__MDSH_PROJECTION_PROBE__: {
						seed(row: {
							id: string;
							name: string;
							content: string;
							updatedAt: number;
							projectId?: string;
							relativePath?: string;
						}): Promise<void>;
					};
				}
			).__MDSH_PROJECTION_PROBE__.seed({
				id: draftId,
				name: project ? 'trace.md' : 'large-note.md',
				content: text,
				updatedAt: Date.now(),
				...(project ? { projectId, relativePath: 'notes/trace.md' } : {})
			});
		},
		{ draftId: id, text: content, project: variant.project, projectId: PROJECT_ID }
	);
	await page.reload();
	await expect(page.locator('.cm-content').first()).toBeVisible({ timeout: 60_000 });
	await expect.poll(() => editorText(page)).toBe(content);
	return content;
}

/** Places the caret before the final newline of the plain body line. */
async function placeCaretAtFinalBodyLine(page: Page): Promise<void> {
	const editor = page.locator('.cm-content').first();
	await editor.click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.press('ArrowLeft');
}

/**
 * Types one workload. The marker is a letter, so the expected source is exact.
 * Returns the accepted key samples and the source before and after.
 */
async function runWorkload(
	page: Page,
	workload: Workload
): Promise<{ before: string; after: string; keys: KeySample[] }> {
	const before = await editorText(page);
	await placeCaretAtFinalBodyLine(page);
	await resetProbe(page);
	const firstKeyIndex = 0;
	for (let index = 0; index < workload.keys; index += 1) {
		if (index > firstKeyIndex) await page.waitForTimeout(workload.spacing);
		await page.keyboard.insertText('z');
	}
	const after = await editorText(page);
	await expect.poll(() => storedText(page), { timeout: 30_000 }).toBe(after);
	// Let the last history and projection work settle before the next workload.
	await page.waitForTimeout(700);
	const probe = await readProbe(page);
	return { before, after, keys: probe.keys };
}

interface SaveRow {
	storage: Span;
	snapshot: Span | null;
	derived: Span | null;
	history: Span | null;
	hook: { manifest: Span[]; metadata: Span[] };
	read: Span | null;
	/** Synchronous IDBObjectStore.put call, which clones the row. */
	clone: { started: number; duration: number; chars: number } | null;
	put: Span | null;
	write: Span | null;
	commit: Span | null;
	hookCpuMs: number;
	modes: string[];
	reasons: string[];
	nextInputDelayMs: number | null;
}

/** Groups the measured stages by the durable save that contains them. */
function buildSaves(spans: Span[], keys: KeySample[], puts: ProbeState['puts']): SaveRow[] {
	const byName = (name: string) => spans.filter((span) => span.name === name);
	const stages = byName('mdsh:document-storage');
	const usedSnapshots = new Set<Span>();
	const usedHistory = new Set<Span>();
	const usedPuts = new Set<ProbeState['puts'][number]>();
	return stages.map((storage) => {
		const inside = (span: Span) => span.start >= storage.start - 8 && span.end <= storage.end + 8;
		const snapshotCandidates = byName('mdsh:document-serialization').filter(
			(span) => !usedSnapshots.has(span) && span.end <= storage.start + 8
		);
		const snapshot = snapshotCandidates.at(-1) ?? null;
		if (snapshot) usedSnapshots.add(snapshot);
		const historyCandidates = byName('mdsh:history').filter(
			(span) =>
				!usedHistory.has(span) &&
				span.start >= storage.start - 600 &&
				span.start <= storage.end + 600
		);
		const history =
			historyCandidates.sort(
				(left, right) =>
					Math.abs(left.start - storage.start) - Math.abs(right.start - storage.start)
			)[0] ?? null;
		if (history) usedHistory.add(history);
		const clone =
			puts
				.filter(
					(put) =>
						!usedPuts.has(put) && put.started >= storage.start - 8 && put.started <= storage.end + 8
				)
				.at(-1) ?? null;
		if (clone) usedPuts.add(clone);
		const manifest = byName('mdsh:draft-manifest').filter(inside);
		const metadata = byName('mdsh:draft-metadata').filter(inside);
		const nextKey = keys.find((key) => key.started > storage.end);
		return {
			storage,
			snapshot,
			derived: byName('mdsh:document-derived').filter(inside).at(-1) ?? null,
			history,
			hook: { manifest, metadata },
			read: byName('mdsh:draft-read').filter(inside).at(-1) ?? null,
			clone,
			put: byName('mdsh:draft-put').filter(inside).at(-1) ?? null,
			write: byName('mdsh:draft-write').filter(inside).at(-1) ?? null,
			commit: byName('mdsh:draft-commit').filter(inside).at(-1) ?? null,
			hookCpuMs:
				manifest.reduce((total, span) => total + span.duration, 0) +
				metadata.reduce((total, span) => total + span.duration, 0),
			modes: [...manifest, ...metadata].map((span) => String(span.detail?.mode ?? '')),
			reasons: [...manifest, ...metadata].map((span) => String(span.detail?.reason ?? '')),
			nextInputDelayMs: nextKey ? nextKey.started - storage.end : null
		};
	});
}

async function attachEvidence(
	info: TestInfo,
	name: string,
	payload: Record<string, unknown>
): Promise<void> {
	const metadata = info.config.metadata as {
		source?: string;
		sourceTree?: string;
		workingDiffSha256?: string;
		untracked?: Array<{ path: string; sha256: string }>;
		command?: string[];
		environment?: Record<string, unknown>;
	};
	const body = JSON.stringify(
		{
			schema: 'deckmark-draft-projection-trace/v1',
			generatedAt: new Date().toISOString(),
			project: info.project.name,
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
			...payload
		},
		null,
		2
	);
	mkdirSync(ARTIFACT_DIRECTORY, { recursive: true });
	const title = info.title.replaceAll(/[^a-z0-9]+/gi, '-').slice(0, 60);
	writeFileSync(join(ARTIFACT_DIRECTORY, `${title}-${name}`), body);
	await info.attach(name, { body, contentType: 'application/json' });
}

for (const variant of VARIANTS) {
	test(`separates durable save stages for ${variant.id}`, async ({ page }, info) => {
		test.setTimeout(600_000);
		await installProbe(page);
		await resetAppState(page, { mode: 'source' });
		if (variant.project) await seedProject(page);
		// The first file must exist so the seed row is the active document.
		await createFirstFile(page);
		await expect.poll(() => activeFileId(page).catch(() => ''), { timeout: 10_000 }).not.toBe('');
		const activeId = await activeFileId(page);
		const content = await seedNote(page, activeId, variant);
		await page.evaluate(() => {
			performance.clearMeasures();
		});

		const runs: Array<Record<string, unknown>> = [];
		const savesPerRun: SaveRow[][] = [];
		for (const workload of WORKLOADS) {
			const state = await runWorkload(page, workload);
			const spans = await readSpans(page, 0);
			const probe = await readProbe(page);
			const saves = buildSaves(spans, state.keys, probe.puts);
			savesPerRun.push(saves);
			const gaps = state.keys.slice(1).map((key, index) => ({
				from: index,
				to: index + 1,
				startToStartMs: key.started - state.keys[index]!.started,
				requestedMs: workload.spacing
			}));
			runs.push({
				workload: workload.id,
				requestedSpacingMs: workload.spacing,
				requestedKeys: workload.keys,
				acceptedKeys: state.keys.length,
				sourceBefore: { chars: state.before.length, sha256: digest(state.before) },
				sourceAfter: { chars: state.after.length, sha256: digest(state.after) },
				addedChars: state.after.length - state.before.length,
				keys: state.keys,
				puts: probe.puts,
				gaps,
				saves,
				spans,
				longTasks: probe.longTasks,
				longTasksSupported: probe.longTasksSupported
			});
		}

		const stored = await storedText(page);
		const editor = await editorText(page);
		await attachEvidence(info, `draft-projection-trace-${variant.id}.json`, {
			browserVersion: await page.context().browser()?.version(),
			fixture: {
				variant: variant.id,
				images: variant.images,
				project: variant.project,
				projectAssetBytes: variant.project ? PROJECT_ASSET_BYTES : 0,
				chars: content.length,
				sha256: digest(content)
			},
			result: {
				durableChars: stored.length,
				durableSha256: digest(stored),
				editorChars: editor.length,
				editorSha256: digest(editor),
				exactBytes: stored === editor
			},
			method: {
				stageClock: 'performance.now()',
				snapshotBoundary: 'mdsh:document-serialization',
				hookBoundary: 'Dexie updating hook measures',
				readBoundary: 'drafts.get request, inside one readwrite transaction',
				cloneBoundary: 'synchronous IDBObjectStore.put call, which clones the row',
				putBoundary: 'Dexie drafts.put call before the request is built',
				writeBoundary: 'drafts.put request settled',
				commitBoundary: 'put settled to transaction complete',
				historyBoundary: 'recordVersion transaction body',
				inputBoundary: 'trusted beforeinput capture and second animation frame',
				nextInputDelay: 'first key start after the storage end minus the storage end',
				spacedEditSpacing: 'between the starts of two consecutive keys'
			},
			runs
		});

		// Every changed save must report the separated stages. A missing stage
		// means the trace does not attribute that cost.
		for (const saves of savesPerRun) {
			expect(saves.length, 'a changed workload must write at least once').toBeGreaterThan(0);
			expect(
				saves.some((save) => save.modes.includes('incremental')),
				'a changed workload must use the incremental projection'
			).toBe(true);
			for (const save of saves) {
				if (!save.modes.every((mode) => mode === 'reused')) {
					expect(save.snapshot, 'snapshot stage').not.toBeNull();
				}
				expect(save.read, 'IndexedDB read stage').not.toBeNull();
				expect(save.clone, 'IndexedDB clone stage').not.toBeNull();
				expect(save.put, 'Dexie put call stage').not.toBeNull();
				expect(save.write, 'IndexedDB write stage').not.toBeNull();
				expect(save.commit, 'commit stage').not.toBeNull();
				expect(save.history, 'history stage').not.toBeNull();
				expect(save.hook.metadata.length + save.hook.manifest.length).toBeGreaterThan(0);
				expect(save.modes).not.toContain('full');
			}
		}

		// The last durable bytes must equal the accepted editor bytes for every
		// workload, with no lost or duplicated input.
		expect(stored).toBe(editor);
		expect(editor.length).toBe(
			content.length + WORKLOADS.reduce((total, workload) => total + workload.keys, 0)
		);
	});
}

test('detects a complete projection on a structural edit control', async ({ page }, info) => {
	test.setTimeout(600_000);
	await installProbe(page);
	await resetAppState(page, { mode: 'source' });
	await createFirstFile(page);
	await expect.poll(() => activeFileId(page).catch(() => ''), { timeout: 10_000 }).not.toBe('');
	const activeId = await activeFileId(page);
	const variant = { id: 'control-image-4', images: 4, project: false };
	const content = await seedNote(page, activeId, variant);
	await page.evaluate(() => performance.clearMeasures());

	// A new wiki target is structural. The complete projection must run.
	await page.locator('.cm-content').first().click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.insertText('\n[[Control target]]\n');
	const expected = await editorText(page);
	await expect.poll(() => storedText(page), { timeout: 30_000 }).toBe(expected);
	expect(expected.startsWith(content)).toBe(true);
	expect(expected).toContain('[[Control target]]');
	await page.waitForTimeout(700);
	const spans = await readSpans(page, 0);
	const probe = await readProbe(page);
	const saves = buildSaves(spans, [], probe.puts);
	expect(saves.length).toBeGreaterThan(0);
	const full = saves.filter((save) => save.modes.includes('full'));
	expect(full.length, 'the control must report a complete projection').toBeGreaterThan(0);
	const metadata = spans.filter((span) => span.name === 'mdsh:draft-metadata');
	expect(
		metadata.some((span) => Number(span.detail?.bytes ?? 0) >= content.length),
		'the complete projection must read the whole source'
	).toBe(true);
	for (const save of full) {
		expect(save.snapshot).not.toBeNull();
		expect(save.read).not.toBeNull();
		expect(save.write).not.toBeNull();
		expect(save.commit).not.toBeNull();
	}

	await attachEvidence(info, 'draft-projection-trace-control.json', {
		browserVersion: await page.context().browser()?.version(),
		fixture: {
			variant: variant.id,
			images: variant.images,
			chars: content.length,
			sha256: digest(content)
		},
		expected: { chars: expected.length, sha256: digest(expected) },
		saves,
		spans
	});
});

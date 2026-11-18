import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resetAppState } from './helpers';
import { computeStats } from '../src/lib/stats-count';

// #369 - One accepted edit span must serve metadata and statistics.
//
// The producer publishes the exact changed span of the source that it already
// accepted. The metadata index and the statistics runtime must reuse that
// record. Neither consumer may compare the complete previous and next strings
// again, and a small edit must not resend the complete source.

const WARMUP = 'W';
const EDIT = 'x';
const THRESHOLD_NOTE_BYTES = 320 * 1024;

interface MetadataRequestRecord {
	at: number;
	id: string;
	kind: string;
	sourceBytes: number;
	editBytes: number;
	edits: number;
}

interface StatsPostRecord {
	at: number;
	text: number | null;
	patch: boolean;
	spans: number;
	patchBytes: number;
	mode: string;
}

interface MetadataResponseRecord {
	revision: number;
	documentRevision: number;
	mode: string;
	incremental: boolean;
}

interface WorkerProbeState {
	metadata: MetadataRequestRecord[];
	responses: MetadataResponseRecord[];
	stats: StatsPostRecord[];
	counters: Record<string, number>;
}

async function installWorkerProbe(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const state = {
			metadata: [] as unknown[],
			responses: [] as unknown[],
			stats: [] as unknown[],
			counters: {} as Record<string, number>
		};
		Object.assign(window, { __derivedSpanProbe: state });
		window.addEventListener('deckmark:editor-perf', (event) => {
			const detail = (event as CustomEvent).detail as { kind?: string; name?: string };
			if (detail?.kind !== 'counter' || !detail.name) return;
			state.counters[detail.name] = (state.counters[detail.name] ?? 0) + 1;
		});
		const NativeWorker = window.Worker;
		window.Worker = class extends NativeWorker {
			private readonly probeUrl = '';
			private readonly probeName = '';
			constructor(url: string | URL, options?: WorkerOptions) {
				super(url, options);
				this.probeUrl = String(url);
				this.probeName = options?.name ?? '';
			}
			override postMessage(message: unknown, transfer?: Transferable[]): void {
				const request = message as {
					id?: string;
					kind?: string;
					source?: { content?: string };
					edits?: Array<{ insert: string }>;
					token?: number;
					text?: string;
					patch?: { spans?: Array<{ insert?: string }>; baseRevision?: number };
					mode?: string;
				};
				if (this.probeName === 'metadata' || this.probeUrl.includes('metadata')) {
					if (request && typeof request.id === 'string' && 'kind' in request) {
						state.metadata.push({
							at: performance.now(),
							id: request.id,
							kind: request.kind ?? 'full',
							sourceBytes: request.source?.content?.length ?? 0,
							edits: request.edits?.length ?? 0,
							editBytes: request.edits?.reduce((total, edit) => total + edit.insert.length, 0) ?? 0
						});
					}
					this.addEventListener('message', (event) => {
						const response = event.data as MetadataResponseRecord;
						if (typeof response?.documentRevision !== 'number') return;
						state.responses.push({
							revision: response.revision,
							documentRevision: response.documentRevision,
							mode: response.mode,
							incremental: response.incremental
						});
					});
				}
				if (this.probeUrl.includes('stats.worker')) {
					state.stats.push({
						at: performance.now(),
						mode: typeof request?.mode === 'string' ? request.mode : 'document',
						text: typeof request?.text === 'string' ? request.text.length : null,
						patch: Boolean(request?.patch),
						spans: request?.patch?.spans?.length ?? 0,
						patchBytes:
							request?.patch?.spans?.reduce(
								(total, span) => total + (span.insert?.length ?? 0),
								0
							) ?? 0
					});
				}
				super.postMessage(message, ...(transfer ?? []));
			}
		} as unknown as typeof Worker;
	});
}

async function readProbe(page: Page): Promise<WorkerProbeState> {
	return page.evaluate(() => {
		const state = (window as unknown as { __derivedSpanProbe: WorkerProbeState })
			.__derivedSpanProbe;
		return {
			metadata: [...state.metadata],
			responses: [...state.responses],
			stats: [...state.stats],
			counters: { ...state.counters }
		};
	});
}

async function resetProbe(page: Page): Promise<void> {
	await page.evaluate(() => {
		const state = (
			window as unknown as {
				__derivedSpanProbe: {
					metadata: unknown[];
					responses: unknown[];
					stats: unknown[];
					counters: Record<string, number>;
				};
			}
		).__derivedSpanProbe;
		state.metadata.length = 0;
		state.responses.length = 0;
		state.stats.length = 0;
		for (const name of Object.keys(state.counters)) delete state.counters[name];
		performance.clearMeasures('mdsh:stats-count');
		performance.clearMarks('mdsh:derived-edit');
	});
}

interface StatsCountDetail {
	mode: string;
	source: string;
	reason?: string;
	spans?: number;
	deltaBytes?: number;
}

async function readStatsCounts(page: Page): Promise<StatsCountDetail[]> {
	return page.evaluate(() =>
		performance
			.getEntriesByName('mdsh:stats-count')
			.map((entry) => (entry as PerformanceMeasure).detail as StatsCountDetail)
	);
}

async function readDerivedEdits(page: Page): Promise<unknown[]> {
	return page.evaluate(() =>
		performance
			.getEntriesByName('mdsh:derived-edit')
			.map((entry) => (entry as PerformanceMeasure).detail)
	);
}

interface SeedRow {
	id: string;
	name: string;
	content: string;
	order: number;
}

async function seedLibrary(page: Page, rows: SeedRow[], activeId: string): Promise<void> {
	await page.evaluate(
		async ({ rows: library, activeId: active }) => {
			await new Promise<void>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const transaction = database.transaction('drafts', 'readwrite');
					const store = transaction.objectStore('drafts');
					for (const row of library) {
						store.put({
							...row,
							createdAt: 1_700_000_000_000,
							updatedAt: 1_700_000_000_000,
							open: true
						});
					}
					transaction.oncomplete = () => {
						database.close();
						resolve();
					};
					transaction.onerror = () => reject(transaction.error);
				};
			});
			localStorage.setItem('mdsh:activeId', active);
		},
		{ rows, activeId }
	);
}

async function activeContent(page: Page, id: string): Promise<string> {
	return page.evaluate(async (fileId) => {
		return new Promise<string>((resolve, reject) => {
			const request = indexedDB.open('mdsh');
			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				const database = request.result;
				const read = database.transaction('drafts').objectStore('drafts').get(fileId);
				read.onsuccess = () => {
					resolve((read.result as { content?: string } | undefined)?.content ?? '');
					database.close();
				};
				read.onerror = () => {
					reject(read.error);
					database.close();
				};
			};
		});
	}, id);
}

/** Plain prose note. `link` adds link syntax that disables the plain count. */
function noteFixture(tag: string, bodyBytes: number, link?: string): string {
	const line = 'Ordinary body text for the shared span note.\n';
	const body = line.repeat(Math.ceil(bodyBytes / line.length));
	const linkLine = link ? `See ${link}.\n\n` : '';
	return `---\ntags: ${tag}\n---\n# ${tag}\n\n${linkLine}${body}\nEditable tail line`;
}

interface FreshOptions {
	/** Durable length that the edit must reach. */
	chars?: number;
	/** Durable length that the edit must leave behind. */
	changedFrom?: number;
}

async function waitForStatsFresh(
	page: Page,
	id: string,
	options: FreshOptions = {}
): Promise<void> {
	const status = page.getByTestId('document-stats');
	mkdirSync('review-reports/i369', { recursive: true });
	try {
		await expect
			.poll(
				async () => {
					// Read the durable row on every poll. The 400 ms save can
					// finish after the publication that this check waits for.
					const expected = computeStats(await activeContent(page, id));
					if (options.chars !== undefined && expected.chars !== options.chars) return false;
					if (options.changedFrom !== undefined && expected.chars === options.changedFrom)
						return false;
					const text = await status.innerText();
					return (
						text.includes(`${expected.words} mots`) &&
						text.includes(`${expected.chars} car.`) &&
						text.includes(`${expected.lines} lignes`)
					);
				},
				{ timeout: 30_000 }
			)
			.toBe(true);
	} catch (error) {
		writeFileSync(
			'review-reports/i369/stats-mismatch.json',
			JSON.stringify(
				{
					id,
					expected: computeStats(await activeContent(page, id)),
					status: await status.innerText(),
					probe: await readProbe(page)
				},
				null,
				2
			)
		);
		throw error;
	}
}

/** Waits until the metadata Worker answered the latest request. */
async function waitForMetadataReply(page: Page): Promise<void> {
	await expect
		.poll(async () => (await readProbe(page)).responses.length, { timeout: 30_000 })
		.toBeGreaterThan(0);
}

async function attachEvidence(
	info: TestInfo,
	payload: Record<string, unknown>,
	page: Page
): Promise<void> {
	const body = JSON.stringify(
		{
			command: info.config.metadata.command,
			source: info.config.metadata.source,
			workingDiffSha256: info.config.metadata.workingDiffSha256,
			environment: info.config.metadata.environment,
			node: info.config.metadata.nodeVersion,
			browser: info.project.name,
			browserVersion: page.context().browser()?.version(),
			status: info.status,
			...payload
		},
		null,
		2
	);
	mkdirSync('review-reports/i369', { recursive: true });
	const local = `review-reports/i369/${info.title.replaceAll(/[^a-z0-9]+/gi, '-')}.json`;
	writeFileSync(local, body);
	await info.attach('derived-state-spans.json', { body, contentType: 'application/json' });
	await info.attach('derived-state-spans.png', {
		body: await page.screenshot({ fullPage: true }),
		contentType: 'image/png'
	});
}

async function openNote(page: Page, id: string, mode: 'source' | 'wysiwyg'): Promise<void> {
	await page.locator(`aside button[data-file-id="${id}"]`).click();
	if (mode === 'source') {
		await expect(page.locator('.cm-content').first()).toBeVisible();
		return;
	}
	// A note above the render limit opens in Source and needs one confirmation.
	await page.locator('[data-mode="wysiwyg"]').click();
	const confirm = page.getByRole('button', { name: 'Afficher le document', exact: true });
	if (await confirm.count()) await confirm.click();
	await expect(page.locator('.ProseMirror').first()).toBeVisible({ timeout: 90_000 });
}

async function typeAtEnd(page: Page, mode: 'source' | 'wysiwyg', text: string): Promise<void> {
	const root = mode === 'source' ? '.cm-content' : '.ProseMirror';
	await page.locator(root).first().click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.insertText(text);
}

async function typeAtStart(page: Page, mode: 'source' | 'wysiwyg', text: string): Promise<void> {
	const root = mode === 'source' ? '.cm-content' : '.ProseMirror';
	await page.locator(root).first().click();
	// The first body line, after the front matter and the heading. An edit
	// inside the front matter is a structural change, not a plain edit.
	await page.keyboard.press('ControlOrMeta+Home');
	for (let step = 0; step < 5; step += 1) await page.keyboard.press('ArrowDown');
	await page.keyboard.press('Home');
	await page.keyboard.insertText(text);
}

test.describe('Authoritative derived-state spans', () => {
	test.use({ locale: 'fr-FR', reducedMotion: 'reduce' });

	test('a rendered plain edit sends one span to metadata and statistics', async ({
		page
	}, info) => {
		test.setTimeout(240_000);
		await installWorkerProbe(page);
		await resetAppState(page, { mode: 'wysiwyg' });
		const id = 'rendered-spans';
		const content = noteFixture('rendered-span', THRESHOLD_NOTE_BYTES);
		await seedLibrary(page, [{ id, name: 'rendered-spans.md', content, order: 0 }], id);
		await page.reload();
		await openNote(page, id, 'wysiwyg');
		await waitForStatsFresh(page, id);

		// The first publication establishes both Worker baselines.
		await typeAtEnd(page, 'wysiwyg', WARMUP);
		await waitForStatsFresh(page, id, { chars: content.length + WARMUP.length });
		await waitForMetadataReply(page);
		await resetProbe(page);

		await typeAtEnd(page, 'wysiwyg', EDIT);
		await waitForStatsFresh(page, id, {
			chars: content.length + WARMUP.length + EDIT.length
		});
		await waitForMetadataReply(page);

		const probe = await readProbe(page);
		const counts = await readStatsCounts(page);
		const derived = await readDerivedEdits(page);
		const expected = computeStats(await activeContent(page, id));
		await attachEvidence(
			info,
			{
				fixture: {
					id,
					bytes: content.length,
					sha256: createHash('sha256').update(content).digest('hex'),
					mode: 'wysiwyg',
					edit: EDIT
				},
				probe,
				counts,
				derived,
				expected
			},
			page
		);

		const metadataDelta = probe.metadata.filter((request) => request.kind === 'delta');
		expect(metadataDelta.length, 'the rendered edit must send a metadata delta').toBeGreaterThan(0);
		expect(
			probe.metadata.every((request) => request.sourceBytes === 0),
			'a rendered plain edit must not resend the source'
		).toBe(true);
		const stats = probe.stats.filter((post) => post.mode === 'document');
		expect(stats.length, 'the statistics Worker must receive jobs').toBeGreaterThan(0);
		expect(
			stats.every((post) => post.text === null),
			'a rendered plain edit must not resend the complete text'
		).toBe(true);
		expect(stats.at(-1)?.spans, 'the statistics job must carry the accepted span').toBe(1);
		expect(stats.at(-1)?.patchBytes, 'the patch must stay small').toBeLessThan(1_024);
		expect(
			counts.some((count) => count.source === 'span'),
			'the statistics Worker must accept the shared span'
		).toBe(true);
		expect(
			counts.some((count) => count.source === 'diff'),
			'the consumer must not compare the complete strings again'
		).toBe(false);
		expect(derived.length, 'the producer must publish its accepted span').toBeGreaterThan(0);
	});

	test('a source plain edit shares the accepted change span with statistics', async ({
		page
	}, info) => {
		test.setTimeout(240_000);
		await installWorkerProbe(page);
		await resetAppState(page, { mode: 'source' });
		const id = 'source-spans';
		const content = noteFixture('source-span', THRESHOLD_NOTE_BYTES);
		await seedLibrary(page, [{ id, name: 'source-spans.md', content, order: 0 }], id);
		await page.reload();
		await openNote(page, id, 'source');
		await waitForStatsFresh(page, id);
		await typeAtEnd(page, 'source', WARMUP);
		await waitForStatsFresh(page, id, { chars: content.length + WARMUP.length });
		await waitForMetadataReply(page);

		const positions = ['start', 'middle', 'end'] as const;
		const samples: Array<{
			position: string;
			metadata: MetadataRequestRecord[];
			stats: StatsPostRecord[];
			counts: StatsCountDetail[];
		}> = [];
		for (const position of positions) {
			await resetProbe(page);
			if (position === 'start') await typeAtStart(page, 'source', EDIT);
			else if (position === 'end') await typeAtEnd(page, 'source', EDIT);
			else {
				const source = page.locator('.cm-content').first();
				await source.click();
				await page.keyboard.press('ControlOrMeta+End');
				// Move the caret away from both ends without a document scan.
				for (let step = 0; step < 6; step += 1) await page.keyboard.press('PageUp');
				await page.keyboard.insertText(EDIT);
			}
			await waitForStatsFresh(page, id, {
				chars: content.length + WARMUP.length + (samples.length + 1) * EDIT.length
			});
			await waitForMetadataReply(page);
			const probe = await readProbe(page);
			samples.push({
				position,
				metadata: probe.metadata,
				stats: probe.stats.filter((post) => post.mode === 'document'),
				counts: await readStatsCounts(page)
			});
		}

		const expected = computeStats(await activeContent(page, id));
		await attachEvidence(info, { fixture: { id, bytes: content.length }, samples, expected }, page);

		for (const sample of samples) {
			expect(
				sample.metadata.some((request) => request.kind === 'delta'),
				`${sample.position}: metadata must receive the delta`
			).toBe(true);
			expect(
				sample.metadata.every((request) => request.sourceBytes === 0),
				`${sample.position}: metadata must not receive the source`
			).toBe(true);
			expect(
				sample.stats.every((post) => post.text === null),
				`${sample.position}: statistics must not receive the text`
			).toBe(true);
			expect(
				sample.stats.some((post) => post.spans === 1),
				`${sample.position}: statistics must receive the accepted span`
			).toBe(true);
			expect(
				sample.counts.some((count) => count.source === 'span'),
				`${sample.position}: the count must reuse unaffected ranges`
			).toBe(true);
			expect(
				sample.counts.some((count) => count.source === 'diff'),
				`${sample.position}: the consumer must not compare the strings`
			).toBe(false);
		}
	});

	test('structural edits and undo stay exact and report the full fallback', async ({
		page
	}, info) => {
		test.setTimeout(240_000);
		await installWorkerProbe(page);
		await resetAppState(page, { mode: 'wysiwyg' });
		const id = 'structural-spans';
		const content = noteFixture('structural-span', THRESHOLD_NOTE_BYTES, '[[target]]');
		await seedLibrary(
			page,
			[
				{ id, name: 'structural-spans.md', content, order: 0 },
				{ id: 'target', name: 'target.md', content: '# Target\n', order: 1 }
			],
			id
		);
		await page.reload();
		await openNote(page, id, 'wysiwyg');
		await waitForStatsFresh(page, id);
		await resetProbe(page);

		// A Markdown input rule converts this text into a heading. The line no
		// longer counts as plain prose, so the counters must take the full path.
		await page.locator('.ProseMirror').first().click();
		await page.keyboard.press('ControlOrMeta+End');
		await page.keyboard.press('Enter');
		await page.keyboard.insertText('# Structural heading');
		await waitForStatsFresh(page, id, { changedFrom: content.length });
		await expect(
			page
				.locator('aside')
				.getByRole('button', { name: 'Filtrer par tag structural-span', exact: true })
		).toBeVisible({ timeout: 20_000 });

		const structuralCounts = await readStatsCounts(page);
		const structuralContent = await activeContent(page, id);

		// Undo returns to the accepted baseline. The counters and the metadata
		// must stay exact instead of publishing a stale value.
		await page.keyboard.press('ControlOrMeta+z');
		await page.keyboard.press('ControlOrMeta+z');
		await waitForStatsFresh(page, id, { chars: content.length });
		const restored = await activeContent(page, id);

		const probe = await readProbe(page);
		await attachEvidence(
			info,
			{
				fixture: { id, bytes: content.length },
				structuralContentBytes: structuralContent.length,
				restoredBytes: restored.length,
				restoredMatchesAccepted: restored === content,
				structuralCounts,
				counts: await readStatsCounts(page),
				probe
			},
			page
		);

		expect(structuralContent.length, 'the heading must add bytes').toBeGreaterThan(content.length);
		expect(
			structuralCounts.some((count) => count.count === 'full' && count.source !== 'span'),
			'a structural edit must record its full recount'
		).toBe(true);
		expect(
			structuralCounts
				.filter((count) => count.count === 'full')
				.every((count) => typeof count.reason === 'string' && count.reason.length > 0),
			'every full recount must record its reason'
		).toBe(true);
		expect(restored, 'undo must restore the exact accepted source').toBe(content);
	});
});

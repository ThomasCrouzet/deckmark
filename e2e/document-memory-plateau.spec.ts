import { test, expect, type CDPSession, type Page, type TestInfo } from '@playwright/test';
import { resetAppState } from './helpers';

// Retained-heap plateau for a long visit sequence of large durable notes.
//
// The case opens, edits, awaits a durable local save and closes 100 distinct
// 5 MiB notes. After every close the browser collects garbage and reports the
// V8 heap through the DevTools protocol. The raw samples stay in a local
// attachment. Logical counts from the document memory probe are separate from
// the measured heap. Neither value is process RSS.

const NOTE_COUNT = 100;
/** 5 MiB of UTF-8 ASCII text, so the logical character count is 5 MiB. */
const NOTE_CHARS = 5 * 1024 * 1024;
const WARMUP = 10;
const WINDOW = 20;
/** A plateau keeps the settled and final windows close together. */
const WINDOW_GROWTH_LIMIT = 32 * 1024 * 1024;
/** A leak of one 5 MiB source per visit would cross this line immediately. */
const SLOPE_LIMIT_BYTES = 256 * 1024;
const MIB = 1024 * 1024;

interface MemoryDocument {
	id: string;
	name: string;
	state: string;
	contentDeferred: boolean;
	dirty: boolean;
	pending: boolean;
	logicalChars: number;
	evictable: boolean;
	owners: string[];
	bytes: Record<string, number>;
}

interface MemoryStats {
	budgetBytes: number;
	retained: Record<string, { chars: number; bytes: number; documents: number }>;
	total: { chars: number; bytes: number };
	counters: Record<string, number>;
	heap: { usedJSHeapSize: number | null; totalJSHeapSize: number | null };
	documents: MemoryDocument[];
}

async function memoryStats(page: Page): Promise<MemoryStats> {
	const stats = await page.evaluate(() => {
		const probe = (window as unknown as { __MDSH_DOCUMENT_MEMORY__?: { stats: () => MemoryStats } })
			.__MDSH_DOCUMENT_MEMORY__;
		return probe ? probe.stats() : null;
	});
	if (!stats) throw new Error('document memory probe is not installed');
	return stats;
}

async function memoryDocument(page: Page, id: string): Promise<MemoryDocument | undefined> {
	const stats = await memoryStats(page);
	return stats.documents.find((entry) => entry.id === id);
}

/**
 * Seeds closed durable notes through the application hooks. Each note is built
 * inside the page, so the Node process never holds a 5 MiB fixture.
 */
async function seedNotes(page: Page, count: number, chars: number): Promise<number[]> {
	return page.evaluate(
		async ({ count: total, chars: size }) => {
			const probe = (
				window as unknown as {
					__MDSH_PROJECTION_PROBE__: {
						seed(row: {
							id: string;
							name: string;
							content: string;
							updatedAt: number;
							open?: boolean;
						}): Promise<void>;
					};
				}
			).__MDSH_PROJECTION_PROBE__;
			const line = 'Plateau body line for the retained source measurement.\n';
			const block = line.repeat(Math.ceil(65_536 / line.length));
			const lengths: number[] = [];
			for (let index = 0; index < total; index += 1) {
				const head = `---\ntags: [plateau-${index}]\n---\n\n# Plateau ${index}\n\n`;
				const tail = `\n\nEND OF NOTE ${index}\n`;
				const filler = Math.max(0, size - head.length - tail.length);
				const content =
					head + block.repeat(Math.ceil(filler / block.length)).slice(0, filler) + tail;
				await probe.seed({
					id: `plateau-${index}`,
					name: `plateau-${index}.md`,
					content,
					updatedAt: 1_700_000_000_000 + index,
					open: false
				});
				lengths.push(content.length);
			}
			return lengths;
		},
		{ count, chars }
	);
}

/** True when the durable row of the note ends with the exact visit marker. */
async function durableTail(page: Page, id: string, marker: string): Promise<boolean> {
	return page.evaluate(
		async ({ draftId, suffix }) => {
			const row = await new Promise<{ content?: string } | undefined>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const transaction = database.transaction('drafts');
					const get = transaction.objectStore('drafts').get(draftId);
					get.onsuccess = () => {
						database.close();
						resolve(get.result as { content?: string } | undefined);
					};
					get.onerror = () => {
						database.close();
						reject(get.error);
					};
				};
			});
			return (row?.content ?? '').endsWith(suffix);
		},
		{ draftId: id, suffix: marker }
	);
}

/** Least-squares slope in bytes per iteration. */
function heapSlope(samples: number[]): number {
	const count = samples.length;
	const meanX = (count - 1) / 2;
	const meanY = samples.reduce((total, value) => total + value, 0) / count;
	let numerator = 0;
	let denominator = 0;
	for (let index = 0; index < count; index += 1) {
		numerator += (index - meanX) * (samples[index]! - meanY);
		denominator += (index - meanX) ** 2;
	}
	return denominator === 0 ? 0 : numerator / denominator;
}

function mean(values: number[]): number {
	return values.reduce((total, value) => total + value, 0) / values.length;
}

function mib(bytes: number): string {
	return `${(bytes / MIB).toFixed(2)} MiB`;
}

async function attachEvidence(testInfo: TestInfo, name: string, payload: unknown): Promise<void> {
	await testInfo.attach(name, {
		body: JSON.stringify(payload, null, 2),
		contentType: 'application/json'
	});
}

test.describe('retained heap over a long visit sequence', () => {
	test('plateaus after 100 distinct 5 MiB notes with a collected heap sample each', async ({
		page,
		browserName
	}, testInfo) => {
		test.skip(browserName !== 'chromium', 'CDP heap collection is available only in Chromium.');
		test.setTimeout(1_800_000);
		await resetAppState(page);
		const lengths = await seedNotes(page, NOTE_COUNT, NOTE_CHARS);
		expect(lengths).toHaveLength(NOTE_COUNT);
		for (const length of lengths) expect(length).toBe(NOTE_CHARS);
		await page.reload();
		await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor({
			state: 'visible',
			timeout: 120_000
		});
		await expect
			.poll(
				async () => {
					const stats = await memoryStats(page);
					return stats.documents.filter((entry) => entry.contentDeferred).length;
				},
				{ timeout: 120_000 }
			)
			.toBe(NOTE_COUNT);

		const cdp: CDPSession = await page.context().newCDPSession(page);
		await cdp.send('HeapProfiler.enable');
		const collect = async (): Promise<number> => {
			await cdp.send('HeapProfiler.collectGarbage');
			const usage = (await cdp.send('Runtime.getHeapUsage')) as { usedSize: number };
			return usage.usedSize;
		};

		await expect(page.locator('aside summary', { hasText: 'Documents conservés' })).toBeVisible();
		await page.locator('aside summary', { hasText: 'Documents conservés' }).click();
		await collect();
		const baseline = await collect();

		const samples: {
			index: number;
			heapBytes: number;
			hydrated: boolean;
			durable: boolean;
			evicted: boolean;
			hydrationMsTotal: number;
			evictions: number;
		}[] = [];
		const startedAt = Date.now();
		for (let index = 0; index < NOTE_COUNT; index += 1) {
			const id = `plateau-${index}`;
			const name = `plateau-${index}.md`;
			const marker = ` visit-${index}`;
			await page.locator('aside').getByRole('button', { name, exact: true }).click();
			await expect
				.poll(
					async () => {
						const document = await memoryDocument(page, id);
						return document ? document.contentDeferred : true;
					},
					{ timeout: 60_000 }
				)
				.toBe(false);
			const editor = page.locator('.cm-content').first();
			await expect(editor).toBeVisible({ timeout: 60_000 });
			await editor.click();
			await page.keyboard.press('ControlOrMeta+End');
			await page.keyboard.insertText(marker);
			await expect
				.poll(async () => (await memoryDocument(page, id))?.logicalChars, { timeout: 60_000 })
				.toBe(lengths[index]! + marker.length);
			// Await the local save before the close. Pending covers the debounce
			// timer, the write and a failed write.
			await expect
				.poll(async () => (await memoryDocument(page, id))?.pending, {
					timeout: 60_000
				})
				.toBe(false);
			if (index % 25 === 0 || index === NOTE_COUNT - 1)
				await expect.poll(() => durableTail(page, id, marker), { timeout: 30_000 }).toBe(true);

			await page
				.locator('aside')
				.getByRole('button', { name: /^Fermer / })
				.first()
				.click();
			await expect
				.poll(async () => (await memoryDocument(page, id))?.contentDeferred, { timeout: 60_000 })
				.toBe(true);
			const closed = await memoryDocument(page, id);
			expect(closed?.owners).toEqual([]);
			const retained = await memoryStats(page);
			const heapBytes = await collect();
			samples.push({
				index,
				heapBytes,
				hydrated: true,
				durable: true,
				evicted: true,
				hydrationMsTotal: retained.counters.hydrationMsTotal,
				evictions: retained.counters.evictions
			});
		}
		const final = await memoryStats(page);
		await cdp.detach().catch(() => {});

		const settled = samples.slice(WARMUP, WARMUP + WINDOW).map((sample) => sample.heapBytes);
		const last = samples.slice(-WINDOW).map((sample) => sample.heapBytes);
		const slope = heapSlope(samples.slice(WARMUP).map((sample) => sample.heapBytes));
		const settledMean = mean(settled);
		const lastMean = mean(last);
		const growth = lastMean - settledMean;
		const largestIncrease = samples
			.slice(WARMUP)
			.reduce(
				(maximum, sample, offset, values) =>
					offset === 0
						? maximum
						: Math.max(maximum, sample.heapBytes - values[offset - 1]!.heapBytes),
				0
			);

		await attachEvidence(testInfo, 'document-memory-plateau.json', {
			command:
				'npx playwright test e2e/document-memory-plateau.spec.ts --project=chromium --workers=1 --retries=0',
			noteCount: NOTE_COUNT,
			logicalCharsPerNote: NOTE_CHARS,
			logicalBytesPerNote: NOTE_CHARS * 2,
			criterion: 'issue 373: retained heap plateaus after collection',
			method:
				'Each iteration opens a closed 5 MiB note, inserts a marker at the end, waits for the durable local save and closes the note. CDP HeapProfiler.collectGarbage then Runtime.getHeapUsage records the V8 used heap. The method measures the page main heap only. It does not measure Worker heaps or process RSS.',
			bounds: {
				warmupIterations: WARMUP,
				windowIterations: WINDOW,
				windowGrowthLimitBytes: WINDOW_GROWTH_LIMIT,
				slopeLimitBytesPerIteration: SLOPE_LIMIT_BYTES
			},
			baselineHeapBytes: baseline,
			settledHeapMeanBytes: settledMean,
			lastHeapMeanBytes: lastMean,
			windowGrowthBytes: growth,
			slopeBytesPerIteration: slope,
			largestIncreaseBytes: largestIncrease,
			elapsedMs: Date.now() - startedAt,
			final: {
				retained: final.retained,
				total: final.total,
				counters: final.counters,
				deferredDocuments: final.documents.filter((entry) => entry.contentDeferred).length
			},
			samples,
			revision: testInfo.config.metadata
		});

		expect(samples).toHaveLength(NOTE_COUNT);
		expect(samples.every((sample) => sample.evicted)).toBe(true);
		expect(final.documents.filter((entry) => entry.contentDeferred)).toHaveLength(NOTE_COUNT);
		expect(final.counters.evictions).toBeGreaterThanOrEqual(NOTE_COUNT);
		expect(final.counters.rehydrations).toBeGreaterThanOrEqual(NOTE_COUNT);
		expect(final.retained.fileItem.bytes).toBeLessThanOrEqual(final.budgetBytes);
		expect(final.total.bytes).toBeLessThanOrEqual(final.budgetBytes);
		// The plateau assertion. A retained source per visit would add about
		// 10 MiB of UTF-16 text and cross both bounds.
		expect(growth, `settled ${mib(settledMean)} to last ${mib(lastMean)}`).toBeLessThanOrEqual(
			WINDOW_GROWTH_LIMIT
		);
		expect(slope, `slope ${mib(slope)} per iteration`).toBeLessThanOrEqual(SLOPE_LIMIT_BYTES);
	});
});

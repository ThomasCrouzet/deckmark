import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { MIXED_MARKERS, mixedNote } from '../scripts/benchmark-fixtures/mixed.mjs';
import { resetAppState } from './helpers';
import { enableTypewriter, installTypewriterProbe } from './typewriter-helpers';

const counterKey = 'deckmark:editor-perf-counters';
const largeId = 'perf-large';
const sourceId = 'perf-source';
const mixedId = 'perf-mixed-600k';
const mixedTableMarker = MIXED_MARKERS.table;
// The first key after the editor opens pays one-time work. Issue #769 records
// 99 to 104 ms for it on GitHub-hosted runners (run 45081399330). Main run
// 45887085504 records 63 to 69 ms. The budget is close to twice the largest
// value. Warm keys keep the 100 ms p95 budget.
const COLD_KEY_BUDGET_MS = 200;

// DOM trace snapshots distort input timings on multi-megabyte documents.
test.use({ locale: 'en-US', reducedMotion: 'reduce', trace: 'off' });

type Counters = Record<string, number>;

async function installCounters(page: Page) {
	await page.addInitScript((key) => {
		window.addEventListener('deckmark:editor-perf', (event) => {
			const detail = (event as CustomEvent<{ kind: string; name: string }>).detail;
			if (detail.kind !== 'counter') return;
			const counts = JSON.parse(sessionStorage.getItem(key) ?? '{}') as Record<string, number>;
			counts[detail.name] = (counts[detail.name] ?? 0) + 1;
			sessionStorage.setItem(key, JSON.stringify(counts));
		});
	}, counterKey);
}

async function readCounters(page: Page): Promise<Counters> {
	return page.evaluate((key) => {
		const counts = JSON.parse(sessionStorage.getItem(key) ?? '{}') as Record<string, number>;
		counts.sourceGuardConversion = performance.getEntriesByName('mdsh:source-guard').length;
		counts.sourceChangeConversion = performance.getEntriesByName('mdsh:source-change').length;
		counts.sourceFullRebuild = performance.getEntriesByName('mdsh:source-full-rebuild').length;
		counts.sourceBufferApply = performance.getEntriesByName('mdsh:source-buffer-apply').length;
		counts.sourceNativeApply = performance.getEntriesByName('mdsh:source-native-apply').length;
		counts.sourceNativeReject = performance.getEntriesByName('mdsh:source-native-reject').length;
		counts.sourceStringPublish = performance.getEntriesByName('mdsh:source-string-publish').length;
		return counts;
	}, counterKey);
}

function delta(before: Counters, after: Counters): Counters {
	const result: Counters = {};
	for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
		result[name] = (after[name] ?? 0) - (before[name] ?? 0);
	}
	return result;
}

async function seedNote(page: Page, id: string, content: string) {
	await page.evaluate(
		async ({ id: rowId, content: rowContent }) => {
			await new Promise<void>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const transaction = database.transaction('drafts', 'readwrite');
					transaction.objectStore('drafts').put({
						id: rowId,
						name: `${rowId}.md`,
						content: rowContent,
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
			localStorage.setItem('mdsh:activeId', rowId);
			localStorage.setItem('mdsh:locale', 'en');
		},
		{ id, content }
	);
}

async function storedContent(page: Page, id: string): Promise<string> {
	return page.evaluate(
		(rowId) =>
			new Promise<string>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const transaction = database.transaction('drafts');
					const get = transaction.objectStore('drafts').get(rowId);
					get.onsuccess = () => {
						database.close();
						resolve((get.result as { content?: string } | undefined)?.content ?? '');
					};
					get.onerror = () => reject(get.error);
				};
			}),
		id
	);
}

type SaveDiagnostics = {
	storedLength: number;
	storedTail: string;
	typedIndex: number;
	saveStatus: string;
	storage: Array<{ name: string; start: number; duration: number }>;
	now: number;
};

/** Reads the durable row, the status bar and the storage spans for evidence. */
async function saveDiagnostics(page: Page, id: string, typed: string): Promise<SaveDiagnostics> {
	const stored = await storedContent(page, id);
	const view = await page.evaluate(() => ({
		saveStatus: (document.querySelector('#app-statusbar')?.textContent ?? '')
			.replace(/\s+/g, ' ')
			.trim(),
		now: performance.now(),
		storage: performance
			.getEntries()
			.filter(
				(entry) => entry.name.startsWith('mdsh:draft-') || entry.name === 'mdsh:document-storage'
			)
			.map((entry) => ({ name: entry.name, start: entry.startTime, duration: entry.duration }))
			.slice(-12)
	}));
	return {
		storedLength: stored.length,
		storedTail: stored.slice(-(typed.length + 200)),
		typedIndex: stored.indexOf(typed),
		...view
	};
}

/**
 * Waits until the typed text is the end of the durable note, then checks that
 * the status bar reports a finished save. The attachment keeps the wait time,
 * the stored tail and the status bar text. A failure then shows a slow write
 * (text absent) or a misplaced caret (text present but not at the end).
 */
async function expectTypedAtEnd(
	page: Page,
	info: TestInfo,
	id: string,
	typed: string,
	timeout: number
) {
	const startedAt = Date.now();
	let failure: unknown = null;
	try {
		await expect
			.poll(async () => (await storedContent(page, id)).trimEnd().endsWith(typed), { timeout })
			.toBe(true);
		await expect(page.getByTestId('save-state')).toContainText('saved');
	} catch (error) {
		failure = error;
	}
	const evidence = {
		waitedMs: Date.now() - startedAt,
		atEnd: failure === null,
		...(await saveDiagnostics(page, id, typed))
	};
	await info.attach('save-diagnostics.json', {
		body: JSON.stringify(evidence, null, 2),
		contentType: 'application/json'
	});
	console.log('[save]', JSON.stringify(evidence));
	if (failure !== null) throw failure;
}

function largeNote(bytes: number): string {
	const paragraph =
		'Local benchmark text keeps the same words in every run. The editor reads Markdown, while the preview draws a table and a diagram. ';
	let content = '# Performance note\n\n';
	let section = 0;
	while (content.length < bytes) {
		content += `## Section ${section}\n\n${paragraph.repeat(4)}\n\n`;
		section += 1;
	}
	return content;
}

function maxLineLength(text: string): number {
	let longest = 0;
	let start = 0;
	for (let index = 0; index <= text.length; index++) {
		const code = text.charCodeAt(index);
		if (index < text.length && code !== 10 && code !== 13) continue;
		longest = Math.max(longest, index - start);
		if (code === 13 && text.charCodeAt(index + 1) === 10) index++;
		start = index + 1;
	}
	return longest;
}

function hugeFenceNote(): string {
	const fence = '`'.repeat(20_000);
	const body = 'needle ' + 'x'.repeat(100_000);
	return `# Huge fence\n\n${fence}\ntext\n${body}\n${fence}\n`;
}

async function attachCounters(info: TestInfo, before: Counters, after: Counters) {
	await info.attach('editor-perf-counters.json', {
		body: JSON.stringify({ before, after, delta: delta(before, after) }, null, 2),
		contentType: 'application/json'
	});
}

test.beforeEach(async ({ page }) => {
	await installCounters(page);
	await resetAppState(page, { mode: 'source' });
});

test.afterEach(async ({ page }, info) => {
	await info.attach('result.json', {
		body: JSON.stringify(
			{
				command: info.config.metadata.command,
				source: info.config.metadata.source,
				workingDiffSha256: info.config.metadata.workingDiffSha256,
				environment: info.config.metadata.environment,
				browser: info.project.name,
				status: info.status
			},
			null,
			2
		),
		contentType: 'application/json'
	});
	await info.attach('final.png', { body: await page.screenshot(), contentType: 'image/png' });
});

for (const bytes of [4_000, 1_000_000, 5_000_000]) {
	test(`typewriter bounds wrapped caret work on ${bytes} bytes`, async ({ page }, info) => {
		test.setTimeout(90_000);
		const content = largeNote(bytes);
		await seedNote(page, sourceId, content);
		await page.evaluate(() => localStorage.setItem('mdsh:locale', 'fr'));
		await page.reload();
		await expect(page.locator('.cm-content')).toBeVisible({ timeout: 30_000 });
		await enableTypewriter(page);
		await installTypewriterProbe(page);
		const cdp = await page.context().newCDPSession(page);
		await cdp.send('Performance.enable');
		const before = await cdp.send('Performance.getMetrics');
		const samples = [];
		for (let run = 0; run < 5; run += 1) {
			await page.evaluate(
				async (select) => {
					window.typewriterProbe.burst(40, select);
					await window.typewriterProbe.settle();
				},
				run % 2 === 0
			);
			samples.push(await page.evaluate(() => window.typewriterProbe.sample()));
		}
		const intervals = samples.flatMap((sample) => sample.frames).sort((a, b) => a - b);
		const after = await cdp.send('Performance.getMetrics');
		await info.attach('typewriter-performance.json', {
			body: JSON.stringify(
				{
					fixture: {
						generator: 'largeNote',
						bytes: Buffer.byteLength(content),
						sha256: createHash('sha256').update(content).digest('hex')
					},
					browser: page.context().browser()?.version(),
					layoutMetrics: { before: before.metrics, after: after.metrics },
					method:
						'Five same-task 40-key bursts. Twenty animation frame intervals per burst. Reduced motion. No timing budget change.',
					p50: intervals[Math.ceil(intervals.length * 0.5) - 1],
					p95: intervals[Math.ceil(intervals.length * 0.95) - 1],
					samples
				},
				null,
				2
			),
			contentType: 'application/json'
		});
		for (const sample of samples) {
			expect.soft(sample.maxPending).toBeLessThanOrEqual(2);
			expect.soft(sample.centerHeads.length).toBeLessThanOrEqual(1);
			expect.soft(sample.centerHeads.every((head) => head === sample.head)).toBe(true);
			expect.soft(Math.abs(sample.centerError ?? Infinity)).toBeLessThanOrEqual(3);
		}
		expect(await storedContent(page, sourceId)).toBe(content);
	});
}

test('ordinary visual typing avoids full-document validation', async ({ page }, info) => {
	test.setTimeout(120_000);
	const content = largeNote(240_000);
	await seedNote(page, largeId, content);
	await page.evaluate(() => localStorage.setItem('mdsh:mode', 'wysiwyg'));
	await page.reload();
	const visual = page.locator('.ProseMirror');
	await expect(visual).toBeVisible({ timeout: 60_000 });
	await visual.click();
	await page.keyboard.press('ControlOrMeta+End');
	const typed = 'abcdefghijklmnopqrst';
	const before = await readCounters(page);
	for (const character of typed) await page.keyboard.insertText(character);
	await page.waitForTimeout(700);
	const after = await readCounters(page);
	await attachCounters(info, before, after);
	const change = delta(before, after);
	expect
		.soft(change.noteTypeFallback ?? 0, 'ordinary edits must not serialize in filterTransaction')
		.toBe(0);
	expect
		.soft(change.noteTypeFast ?? 0, 'ordinary edits must take the structural fast path')
		.toBeGreaterThanOrEqual(typed.length);
	expect
		.soft(change.markdownUpdatedGuardSerialization ?? 0, 'the listener must not re-serialize')
		.toBe(0);
	await expectTypedAtEnd(page, info, largeId, typed, 20_000);
});

test('visual boundary keys move and extend the caret in a long note', async ({ page }, info) => {
	test.setTimeout(120_000);
	await seedNote(page, largeId, largeNote(240_000));
	await page.evaluate(() => localStorage.setItem('mdsh:mode', 'wysiwyg'));
	await page.reload();
	const visual = page.locator('.ProseMirror');
	await expect(visual).toBeVisible({ timeout: 60_000 });
	await visual.click();
	await page.keyboard.press('ControlOrMeta+Home');
	await page.keyboard.insertText('Top ');
	await expectStoredStart(page, info, '# Top Performance note');
	await page.keyboard.press('ControlOrMeta+Shift+End');
	await page.keyboard.insertText('Only');
	await expect
		.poll(async () => (await storedContent(page, largeId)).trim(), { timeout: 20_000 })
		.toMatch(/^# Top Only$/);
});

async function expectStoredStart(page: Page, info: TestInfo, start: string) {
	try {
		await expect
			.poll(async () => (await storedContent(page, largeId)).startsWith(start), {
				timeout: 20_000
			})
			.toBe(true);
	} finally {
		await info.attach('stored-head.md', {
			body: (await storedContent(page, largeId)).slice(0, 200),
			contentType: 'text/markdown'
		});
	}
}

test('new visual paragraphs avoid full-document validation on Enter', async ({ page }, info) => {
	test.setTimeout(120_000);
	const content = largeNote(240_000);
	await seedNote(page, largeId, content);
	await page.evaluate(() => localStorage.setItem('mdsh:mode', 'wysiwyg'));
	await page.reload();
	await openVisualEditor(page);
	const last = page.locator('.ProseMirror > p').last();
	await expect(last).toBeVisible({ timeout: 60_000 });
	await last.click();
	await page.keyboard.press('ControlOrMeta+End');
	const before = await readCounters(page);
	await page.keyboard.press('Enter');
	await page.keyboard.insertText('New paragraph text.');
	await page.waitForTimeout(700);
	const after = await readCounters(page);
	await attachCounters(info, before, after);
	const change = delta(before, after);
	expect
		.soft(change.noteTypeFallback ?? 0, 'a paragraph split and its text must stay local')
		.toBe(0);
	expect
		.soft(change.noteTypeFast ?? 0, 'the new paragraph must take the fast path')
		.toBeGreaterThan(0);
	expect
		.soft(change.markdownIncrementalFallback ?? 0, 'a new paragraph must stay incremental')
		.toBe(0);
	expect
		.soft(change.markdownIncrementalBlock ?? 0, 'the publish must update blocks, not the note')
		.toBeGreaterThan(0);
	await expect
		.poll(async () => (await storedContent(page, largeId)).includes('New paragraph text.'), {
			timeout: 20_000
		})
		.toBe(true);
});

async function openVisualEditor(page: Page) {
	await page.locator('[data-mode=wysiwyg]').click();
	const dialog = page.getByRole('dialog', {
		name: /Render this large document|Afficher ce document volumineux/
	});
	await dialog.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
	if (await dialog.isVisible().catch(() => false)) {
		await dialog.getByRole('button', { name: /Render document|Afficher le document/ }).click();
	}
	await expect(page.locator('.ProseMirror')).toHaveAttribute('contenteditable', 'true', {
		timeout: 180_000
	});
}

test('visual heading input does not validate the full document for an id update', async ({
	page
}, info) => {
	test.setTimeout(120_000);
	await seedNote(page, largeId, largeNote(240_000));
	await page.reload();
	await openVisualEditor(page);
	const heading = page.locator('.ProseMirror h1').first();
	await heading.click();
	await page.keyboard.press('Home');
	const before = await readCounters(page);
	await page.keyboard.type('Heading ');
	await expect(heading).toHaveAttribute('id', 'heading-performance-note');
	await attachCounters(info, before, await readCounters(page));
	expect(delta(before, await readCounters(page)).noteTypeFallback ?? 0).toBe(0);
	await expect.poll(() => storedContent(page, largeId)).toContain('# Heading Performance note');
});

async function installVisualInputProbe(page: Page) {
	await page.locator('.ProseMirror').evaluate((element) => {
		const samples: number[] = [];
		const longTasks: number[] = [];
		const stages: Record<string, number[]> = {};
		window.addEventListener('deckmark:editor-perf', (event) => {
			const detail = (event as CustomEvent<{ kind: string; name: string; value?: number }>).detail;
			if (detail.kind !== 'duration' || detail.value === undefined) return;
			(stages[detail.name] ??= []).push(detail.value);
		});
		(element as HTMLElement).addEventListener(
			'beforeinput',
			() => {
				const started = performance.now();
				requestAnimationFrame(() =>
					requestAnimationFrame(() => samples.push(performance.now() - started))
				);
			},
			true
		);
		if (typeof PerformanceObserver !== 'undefined') {
			try {
				new PerformanceObserver((list) => {
					for (const entry of list.getEntries()) longTasks.push(entry.duration);
				}).observe({ type: 'longtask', buffered: false });
			} catch {
				// The engine does not expose long-task entries.
			}
		}
		(window as unknown as { __visualInputProbe: unknown }).__visualInputProbe = {
			samples,
			longTasks,
			stages
		};
	});
}

test('rendered heading ids follow duplicate edits and undo', async ({ page }) => {
	await seedNote(page, largeId, '# Twin\n\n# Twin\n\nTail\n');
	await page.reload();
	await openVisualEditor(page);
	const headings = page.locator('.ProseMirror h1');
	await expect(headings.nth(1)).toHaveAttribute('id', 'twin-#2');
	await headings.first().click();
	await page.keyboard.press('Home');
	await page.keyboard.type('New ');
	await expect(headings.first()).toHaveAttribute('id', 'new-twin');
	await expect(headings.nth(1)).toHaveAttribute('id', 'twin');
	await page.keyboard.press('ControlOrMeta+z');
	await expect(headings.first()).toHaveText('Twin');
	await expect(headings.nth(1)).toHaveAttribute('id', 'twin-#2');
});

test('large rendered native caret keeps inline marks and an immediate outgoing edit', async ({
	page
}, info) => {
	test.setTimeout(120_000);
	const content = '# Marks\n\nBefore `inline` after **bold**.\n\n' + largeNote(300_000);
	await seedNote(page, largeId, content);
	await page.reload();
	await openVisualEditor(page);
	const visual = page.locator('.ProseMirror');
	await visual
		.locator('code')
		.first()
		.evaluate((code) => {
			const range = document.createRange();
			range.selectNodeContents(code);
			range.collapse(false);
			(code.closest('[contenteditable]') as HTMLElement).focus();
			window.getSelection()?.removeAllRanges();
			window.getSelection()?.addRange(range);
		});
	await page.keyboard.press('ArrowRight');
	await page.keyboard.type('X');
	await expect(visual.locator('code').first()).toHaveText('inline');
	await expect(visual.locator('p').first()).toHaveText('Before inline Xafter bold.');
	await page.keyboard.press('ControlOrMeta+z');
	await expect(visual.locator('p').first()).toHaveText('Before inline after bold.');
	await page.keyboard.press('ControlOrMeta+Shift+z');
	await expect(visual.locator('p').first()).toHaveText('Before inline Xafter bold.');
	await page.locator('[data-mode=source]').click();
	const expected = content.replace(' after ', ' Xafter ');
	await expect
		.poll(async () => (await storedContent(page, largeId)) === expected, { timeout: 30_000 })
		.toBe(true);
	await info.attach('native-caret-source.md', {
		body: await storedContent(page, largeId),
		contentType: 'text/markdown'
	});
});

async function readVisualInputProbe(
	page: Page
): Promise<{ samples: number[]; longTasks: number[]; stages: Record<string, number[]> }> {
	return page.evaluate(
		() =>
			(
				window as unknown as {
					__visualInputProbe: {
						samples: number[];
						longTasks: number[];
						stages: Record<string, number[]>;
					};
				}
			).__visualInputProbe
	);
}

function percentile(values: readonly number[], ratio: number): number {
	if (!values.length) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.ceil(sorted.length * ratio) - 1]!;
}

test('large rendered note keeps keystrokes interactive at the start and end', async ({
	page
}, info) => {
	test.setTimeout(300_000);
	const content = largeNote(5_000_000);
	await seedNote(page, largeId, content);
	await page.reload();
	await openVisualEditor(page);
	const visual = page.locator('.ProseMirror');
	await expect(visual).toBeVisible({ timeout: 180_000 });
	await installVisualInputProbe(page);
	const countersBefore = await readCounters(page);
	const typed = 'abcdefghijklmnopqrstuvwxyz0123456789';
	const positions: Record<string, number[]> = {};
	const positionTasks: Record<string, number[]> = {};
	const navigationTasks: number[] = [];
	for (const position of ['start', 'end'] as const) {
		const block = position === 'start' ? visual.locator('h1').first() : visual.locator('p').last();
		await block.click();
		await page.keyboard.press(position === 'start' ? 'Home' : 'End');
		// Warm the caret, layout and one publish before measuring steady typing.
		// The first key after a long scroll is a navigation cost, not input lag.
		await page.keyboard.insertText('warm');
		// A 5 MB document can keep painting after the caret jump. Let that
		// navigation cost finish before the steady typing samples start.
		await page.waitForTimeout(2_000);
		navigationTasks.push(...(await readVisualInputProbe(page)).longTasks);
		await page.evaluate(() => {
			const probe = (
				window as unknown as { __visualInputProbe: { samples: number[]; longTasks: number[] } }
			).__visualInputProbe;
			probe.samples.length = 0;
			probe.longTasks.length = 0;
		});
		for (const character of typed) {
			const recorded = await page.evaluate(
				() =>
					(window as unknown as { __visualInputProbe: { samples: number[] } }).__visualInputProbe
						.samples.length
			);
			await page.keyboard.insertText(character);
			// Wait for this key's two-frame sample before the next key. A fixed
			// delay can let a second input overlap the pending frames, which
			// doubles one sample and attributes the queue to the previous key.
			await page.waitForFunction(
				(count) =>
					(window as unknown as { __visualInputProbe: { samples: number[] } }).__visualInputProbe
						.samples.length > count,
				recorded,
				{ timeout: 5_000 }
			);
		}
		await page.waitForTimeout(600);
		positions[position] = (await readVisualInputProbe(page)).samples;
		positionTasks[position] = (await readVisualInputProbe(page)).longTasks;
		await page.evaluate(() => {
			(
				window as unknown as { __visualInputProbe: { longTasks: number[] } }
			).__visualInputProbe.longTasks.length = 0;
		});
	}
	const countersAfter = await readCounters(page);
	const counterDelta = delta(countersBefore, countersAfter);
	await attachCounters(info, countersBefore, countersAfter);
	const probe = await readVisualInputProbe(page);
	probe.samples = Object.values(positions).flat();
	probe.longTasks = Object.values(positionTasks).flat();
	const p50 = percentile(probe.samples, 0.5);
	const p95 = percentile(probe.samples, 0.95);
	const longestTask = probe.longTasks.length ? Math.max(...probe.longTasks) : 0;
	const stageSummary = Object.fromEntries(
		Object.entries(probe.stages).map(([name, values]) => [
			name,
			{ count: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95) }
		])
	);
	console.log(
		'[perf] visual large',
		JSON.stringify({
			samples: probe.samples,
			p50,
			p95,
			longestTask,
			stages: stageSummary,
			counters: counterDelta
		})
	);
	await info.attach('visual-large-input.json', {
		body: JSON.stringify(
			{
				fixture: {
					generator: 'largeNote',
					bytes: Buffer.byteLength(content),
					sha256: createHash('sha256').update(content).digest('hex')
				},
				method:
					'36 trusted insertText events at the start and 36 at the end. Each sample is beforeinput to the second animation frame. Long tasks are engine-reported.',
				samples: probe.samples,
				positions,
				positionTasks,
				navigationTasks,
				browser: page.context().browser()?.version(),
				longTasks: probe.longTasks,
				stages: stageSummary,
				counters: counterDelta,
				p50,
				p95,
				longestTask
			},
			null,
			2
		),
		contentType: 'application/json'
	});
	expect(probe.samples.length).toBeGreaterThanOrEqual(72);
	expect(p95, 'rendered keystrokes must stay interactive on a 5 MB note').toBeLessThan(100);
	expect(
		longestTask,
		'autosave and reconciliation must not add long main-thread tasks'
	).toBeLessThan(250);
	await expect
		.poll(async () => (await storedContent(page, largeId)).length, { timeout: 30_000 })
		.toBe(content.length + typed.length * 2 + 8);
});

test('large rendered note stays interactive while autosave runs between keys', async ({
	page
}, info) => {
	test.setTimeout(180_000);
	const content = largeNote(1_000_000);
	await seedNote(page, largeId, content);
	await page.reload();
	await openVisualEditor(page);
	const visual = page.locator('.ProseMirror');
	await expect(visual).toBeVisible({ timeout: 120_000 });
	await installVisualInputProbe(page);
	await visual.click();
	await page.keyboard.press('ControlOrMeta+End');
	const typed = 'abcdefghij';
	for (const character of typed) {
		await page.keyboard.insertText(character);
		// Long enough for the 400 ms autosave and a quiet-period publish to run.
		await page.waitForTimeout(1_100);
	}
	// Check durability first. A latency miss must not hide a lost write.
	await expectTypedAtEnd(page, info, largeId, typed, 30_000);
	const probe = await readVisualInputProbe(page);
	// The first key pays the cold path: first layout, first publish and module
	// load. It has its own budget. The nine warm keys keep the 100 ms p95 gate.
	const [coldKey = Infinity, ...warmKeys] = probe.samples;
	const p95 = percentile(warmKeys, 0.95);
	const longestTask = probe.longTasks.length ? Math.max(...probe.longTasks) : 0;
	const stageSummary = Object.fromEntries(
		Object.entries(probe.stages).map(([name, values]) => [
			name,
			{ count: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95) }
		])
	);
	console.log(
		'[perf] visual autosave',
		JSON.stringify({ samples: probe.samples, coldKey, p95, longestTask, stages: stageSummary })
	);
	await info.attach('visual-autosave-input.json', {
		body: JSON.stringify(
			{
				fixture: {
					generator: 'largeNote',
					bytes: Buffer.byteLength(content),
					sha256: createHash('sha256').update(content).digest('hex')
				},
				method:
					'Ten trusted insertText events spaced 1.1 s apart so the autosave, version history and quiet-period reconciliation run between keys.',
				samples: probe.samples,
				coldKey,
				warmKeys,
				coldBudgetMs: COLD_KEY_BUDGET_MS,
				longTasks: probe.longTasks,
				stages: stageSummary,
				p95,
				longestTask
			},
			null,
			2
		),
		contentType: 'application/json'
	});
	expect(probe.samples.length).toBeGreaterThanOrEqual(typed.length);
	expect(warmKeys.length).toBeGreaterThanOrEqual(typed.length - 1);
	expect(coldKey, 'the first keystroke must stay inside the cold budget').toBeLessThan(
		COLD_KEY_BUDGET_MS
	);
	expect(p95, 'autosave must not make the next keystroke slow').toBeLessThan(100);
	expect(longestTask, 'autosave must not create a long main-thread task').toBeLessThan(250);
});

type MixedPublishSample = {
	frameMs: number;
	publishMs: number | null;
	publishBlockMs: number;
	routeReasons: string[];
	changed: boolean;
};

/**
 * Record the publication that follows one table-cell key. The long-task
 * observer is installed once. The gate value is the longest task that starts
 * after the gated animation frame and ends before the next key.
 */
async function installMixedPublishProbe(page: Page) {
	await page.addInitScript(() => {
		type Event = {
			kind: string;
			name?: string;
			value?: number;
			start?: number;
			end?: number;
		};
		const probe = {
			events: [] as Event[],
			longTasks: [] as Array<{ start: number; duration: number }>
		};
		const windowWithProbe = window as unknown as {
			__mixedProbe: typeof probe;
			__mixedKey: (text: string) => Promise<MixedPublishSample>;
			__MDSH_EDITOR_PERF__: boolean;
		};
		windowWithProbe.__mixedProbe = probe;
		windowWithProbe.__MDSH_EDITOR_PERF__ = true;
		window.addEventListener('deckmark:editor-perf', (event) => {
			probe.events.push((event as CustomEvent<Event>).detail);
		});
		const supported =
			typeof PerformanceObserver === 'function' &&
			Array.isArray(PerformanceObserver.supportedEntryTypes) &&
			PerformanceObserver.supportedEntryTypes.includes('longtask');
		if (supported) {
			new PerformanceObserver((list) => {
				for (const entry of list.getEntries()) {
					probe.longTasks.push({ start: entry.startTime, duration: entry.duration });
				}
			}).observe({ type: 'longtask', buffered: false });
		}
		windowWithProbe.__mixedKey = (text: string) =>
			new Promise<MixedPublishSample>((resolve) => {
				const root = document.querySelector('.ProseMirror');
				if (!root) {
					resolve({
						frameMs: -1,
						publishMs: null,
						publishBlockMs: -1,
						routeReasons: [],
						changed: false
					});
					return;
				}
				const eventStart = probe.events.length;
				const taskStart = probe.longTasks.length;
				const before = root.textContent?.length ?? 0;
				const startedAt = performance.now();
				document.execCommand('insertText', false, text);
				requestAnimationFrame(() => {
					const frameAt = performance.now();
					const frameMs = frameAt - startedAt;
					const finish = () => {
						// PerformanceObserver callbacks are queued tasks.
						setTimeout(() => {
							const events = probe.events.slice(eventStart);
							const publish = events.find(
								(event) =>
									event.kind === 'duration' &&
									event.name === 'markdownPublish' &&
									(event.start ?? 0) >= startedAt - 50
							);
							const windowEnd = publish?.end ?? performance.now();
							const tasks = probe.longTasks
								.slice(taskStart)
								.filter(
									(task) => task.start + task.duration > frameAt && task.start <= windowEnd + 100
								);
							resolve({
								frameMs,
								publishMs: publish?.value ?? null,
								publishBlockMs: tasks.length ? Math.max(...tasks.map((task) => task.duration)) : 0,
								routeReasons: events
									.filter(
										(event) => event.kind === 'counter' && (event.name ?? '').includes('FullReason')
									)
									.map((event) => event.name ?? ''),
								changed: (root.textContent?.length ?? 0) > before
							});
						}, 40);
					};
					const deadline = frameAt + 6_000;
					const poll = () => {
						const found = probe.events
							.slice(eventStart)
							.some((event) => event.kind === 'duration' && event.name === 'markdownPublish');
						if (found || performance.now() > deadline) {
							finish();
							return;
						}
						setTimeout(poll, 20);
					};
					poll();
				});
			});
	});
}

async function placeCaretInMixedTable(page: Page): Promise<boolean> {
	return page.evaluate((marker) => {
		const root = document.querySelector('.ProseMirror');
		if (!root) return false;
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		let found: Node | null = null;
		let node: Node | null;
		while ((node = walker.nextNode())) {
			if (node.textContent?.includes(marker)) {
				found = node;
				break;
			}
		}
		if (!found?.textContent) return false;
		const offset = found.textContent.indexOf(marker) + marker.length;
		const range = document.createRange();
		range.setStart(found, offset);
		range.collapse(true);
		found.parentElement?.scrollIntoView({ block: 'center' });
		(root as HTMLElement).focus();
		const selection = window.getSelection();
		if (!selection) return false;
		selection.removeAllRanges();
		selection.addRange(range);
		return Boolean(found.parentElement?.closest('td'));
	}, mixedTableMarker);
}

test('mixed 600 KB table cell publish', async ({ page }, info) => {
	// The reported note shape: a padded table, a long list and six base64
	// images. Pre-fix, one cell key still triggers a whole-document restore.
	test.setTimeout(240_000);
	const content = mixedNote({
		label: '600k',
		targetBytes: 600_000,
		imageLineChars: [90_000, 70_000, 60_000, 50_000, 40_000, 30_000]
	});
	await seedNote(page, mixedId, content);
	await page.evaluate(() => localStorage.setItem('mdsh:mode', 'wysiwyg'));
	await installMixedPublishProbe(page);
	await page.reload();
	await openVisualEditor(page);
	await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 120_000 });
	expect(await placeCaretInMixedTable(page), 'the caret must land in a table cell').toBe(true);
	await page.waitForTimeout(1_000);
	await page.evaluate(() =>
		(window as unknown as { __mixedKey: (text: string) => Promise<MixedPublishSample> }).__mixedKey(
			'w'
		)
	);
	const samples: MixedPublishSample[] = [];
	for (let key = 0; key < 10; key += 1) {
		samples.push(
			await page.evaluate(
				(text) =>
					(
						window as unknown as {
							__mixedKey: (value: string) => Promise<MixedPublishSample>;
						}
					).__mixedKey(text),
				`k${key % 10}`
			)
		);
	}
	const publishBlock = Math.max(...samples.map((sample) => sample.publishBlockMs));
	const routeReasons = [...new Set(samples.flatMap((sample) => sample.routeReasons))];
	await info.attach('mixed-table-cell-publish.json', {
		body: JSON.stringify(
			{
				fixture: {
					generator: 'mixedNote',
					bytes: Buffer.byteLength(content),
					sha256: createHash('sha256').update(content).digest('hex'),
					maxLineChars: Math.max(...content.split('\n').map((line) => line.length))
				},
				method:
					'Ten keys in one padded table cell. Each sample is the longest long task that starts after the input animation frame and ends before the next key.',
				browser: page.context().browser()?.version(),
				samples,
				publishBlock,
				routeReasons
			},
			null,
			2
		),
		contentType: 'application/json'
	});
	expect(
		samples.every((sample) => sample.publishMs !== null && sample.changed),
		'every key must publish a change'
	).toBe(true);
	expect(publishBlock, 'a table cell key must not block the main thread for 250 ms').toBeLessThan(
		250
	);
});

test('ordinary source typing keeps CRLF bytes without rebuilding the full source', async ({
	page
}, info) => {
	test.setTimeout(60_000);
	const initial = '\uFEFF# Source bytes\r\n\r\nOriginal paragraph.\r\n';
	await seedNote(page, sourceId, initial);
	await page.evaluate(() => localStorage.setItem('mdsh:typewriter', '1'));
	await page.reload();
	const source = page.locator('.cm-content');
	await expect(source).toBeVisible({ timeout: 30_000 });
	await source.click();
	await page.keyboard.press('ControlOrMeta+End');
	const typed = 'abcdefghijklmnopqrst';
	const before = await readCounters(page);
	for (const character of typed) await page.keyboard.insertText(character);
	await page.waitForTimeout(500);
	const after = await readCounters(page);
	await attachCounters(info, before, after);
	const change = delta(before, after);
	console.log('[perf] source ordinary typing', JSON.stringify(change));
	expect
		.soft(change.sourceGuardConversion ?? 0, 'the change filter must not rebuild the full source')
		.toBe(0);
	expect
		.soft(change.sourceFullRebuild ?? 0, 'ordinary typing must not rebuild the full raw source')
		.toBe(0);
	expect
		.soft(change.sourceBufferApply ?? 0, 'each accepted change updates the incremental buffer')
		.toBeGreaterThanOrEqual(typed.length);
	expect
		.soft(change.sourceNativeApply ?? 0, 'each accepted change uses the native store revision')
		.toBeGreaterThanOrEqual(typed.length);
	expect
		.soft(change.sourceStringPublish ?? 0, 'the native path must not publish a string per key')
		.toBe(0);
	expect
		.soft(change.sourceChangeConversion ?? 0, 'raw snapshots are coalesced, not one per keypress')
		.toBeLessThanOrEqual(typed.length);
	await expect
		.poll(async () => (await storedContent(page, sourceId)) === `${initial}${typed}`, {
			timeout: 20_000
		})
		.toBe(true);
	const stored = await storedContent(page, sourceId);
	await info.attach('stored.md', { body: stored, contentType: 'text/markdown' });
});

test('removing a fence cannot reveal a presentation marker in a note', async ({ page }, info) => {
	test.setTimeout(60_000);
	const marker = '<!-- mdsh-presentation\n{}\n-->';
	const initial = `# Fenced marker\n\n\`\`\`\n${marker}\n\`\`\`\n`;
	await seedNote(page, sourceId, initial);
	await page.reload();
	const source = page.locator('.cm-content');
	await expect(source).toBeVisible({ timeout: 30_000 });
	await source.click();
	await page.keyboard.press('ControlOrMeta+Home');
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('Shift+End');
	await page.keyboard.press('Backspace');
	await expect(page.getByRole('alert')).toContainText('cannot become a presentation');
	const stored = await storedContent(page, sourceId);
	await info.attach('fenced-marker.md', { body: stored, contentType: 'text/markdown' });
	expect(stored).toBe(initial);
});

async function seedNamed(page: Page, id: string, name: string, content: string) {
	await page.evaluate(
		async ({ id: rowId, name: rowName, content: rowContent }) => {
			await new Promise<void>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const transaction = database.transaction('drafts', 'readwrite');
					transaction.objectStore('drafts').put({
						id: rowId,
						name: rowName,
						content: rowContent,
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
			localStorage.setItem('mdsh:activeId', rowId);
			localStorage.setItem('mdsh:locale', 'en');
		},
		{ id, name, content }
	);
}

async function storedRow(page: Page, id: string): Promise<{ content: string; open?: boolean }> {
	return page.evaluate(
		(rowId) =>
			new Promise<{ content: string; open?: boolean }>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const transaction = database.transaction('drafts');
					const get = transaction.objectStore('drafts').get(rowId);
					get.onsuccess = () => {
						database.close();
						resolve(
							(get.result as { content?: string; open?: boolean } | undefined) ?? { content: '' }
						);
					};
					get.onerror = () => reject(get.error);
				};
			}),
		id
	);
}

async function cmText(page: Page): Promise<string> {
	return page
		.locator('.cm-content')
		.first()
		.evaluate((root) =>
			Array.from(root.querySelectorAll('.cm-line'))
				.map((line) => line.textContent ?? '')
				.join('\n')
		);
}

async function forceNativeConflict(page: Page, external: string, fileId: string): Promise<boolean> {
	return page.evaluate(
		({ text, id }) => {
			const seam = (
				window as unknown as {
					__mdshTest?: { forceNativeConflict: (external: string, fileId?: string) => boolean };
				}
			).__mdshTest;
			return seam ? seam.forceNativeConflict(text, id) : false;
		},
		{ text: external, id: fileId }
	);
}

async function exerciseRejectedNativeBase(page: Page, info: TestInfo, id: string, name: string) {
	const initial = name.endsWith('.md') ? '# Conflict\r\n\r\nBase.\r\n' : 'const base = 1;\n';
	await seedNamed(page, id, name, initial);
	await page.reload();
	const editor = page.locator('.cm-content').first();
	await expect(editor).toBeVisible({ timeout: 30_000 });
	await editor.click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.insertText('local');
	await expect.poll(async () => (await storedRow(page, id)).content).toContain('local');

	const forced = await forceNativeConflict(page, 'external-authoritative\n', id);
	expect(forced, 'native conflict seam is available').toBe(true);
	await page.keyboard.insertText('X');
	await expect(page.getByRole('alert').first()).toBeVisible({ timeout: 10_000 });
	await expect.poll(() => cmText(page)).toContain('localX');

	await page.waitForTimeout(700);
	expect((await storedRow(page, id)).content).toBe('external-authoritative\n');

	await page.locator('aside li button[aria-label^="Close "]').click({ force: true });
	await expect(page.getByRole('alert').first()).toBeVisible();
	expect((await storedRow(page, id)).open).not.toBe(false);

	await info.attach('native-conflict.json', {
		body: JSON.stringify(
			{
				fileId: id,
				editorText: await cmText(page),
				stored: await storedRow(page, id),
				command: info.config.metadata.command,
				source: info.config.metadata.source
			},
			null,
			2
		),
		contentType: 'application/json'
	});
}

test('issue 326 keeps a huge fence editable and restores Markdown syntax', async ({
	page
}, info: TestInfo) => {
	test.setTimeout(180_000);
	const initial = hugeFenceNote();
	await seedNote(page, sourceId, initial);
	await page.reload();
	const source = page.locator('.cm-content');
	await expect(source).toBeVisible({ timeout: 60_000 });
	const status = page.getByTestId('source-highlight-status');
	await expect(status).toBeVisible();
	await expect(status).toHaveAttribute('data-degraded', 'true');

	await source.click();
	await page.keyboard.press('ControlOrMeta+f');
	await page.keyboard.type('needle');
	await expect(page.locator('.cm-searchMatch')).toHaveCount(1);
	await page.keyboard.press('Escape');

	await source.click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.insertText('END');
	await expect.poll(() => storedContent(page, sourceId), { timeout: 30_000 }).toBe(`${initial}END`);
	await page.keyboard.press('ControlOrMeta+z');
	await expect.poll(() => storedContent(page, sourceId), { timeout: 30_000 }).toBe(initial);
	await expect(status).toBeVisible();

	const downloadPromise = page.waitForEvent('download');
	await page.getByRole('button', { name: 'Export', exact: true }).click();
	const download = await downloadPromise;
	const exported = await readFile((await download.path())!, 'utf8');
	expect(exported).toBe(initial);

	await source.click();
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.insertText('# Short note\n\nRecovered.\n');
	await expect(status).toHaveCount(0, { timeout: 10_000 });
	await expect
		.poll(() => storedContent(page, sourceId), { timeout: 30_000 })
		.toBe('# Short note\n\nRecovered.\n');
	await expect.poll(() => page.locator('.cm-content .cm-line span').count()).toBeGreaterThan(0);

	await info.attach('huge-fence.json', {
		body: JSON.stringify(
			{
				fixture: {
					bytes: Buffer.byteLength(initial, 'utf8'),
					codeUnits: initial.length,
					maxLine: maxLineLength(initial),
					sha256: createHash('sha256').update(initial, 'utf8').digest('hex')
				},
				exportedBytes: Buffer.byteLength(exported, 'utf8'),
				exportedSha256: createHash('sha256').update(exported, 'utf8').digest('hex'),
				recovered: '# Short note\n\nRecovered.\n'
			},
			null,
			2
		),
		contentType: 'application/json'
	});
});

test('a rejected native base keeps local work and cancels close for a note', async ({
	page
}, info) => {
	test.setTimeout(90_000);
	await exerciseRejectedNativeBase(page, info, 'conflict-source', 'conflict-source.md');
});

test('a rejected native base keeps local work and cancels close for a code file', async ({
	page
}, info) => {
	test.setTimeout(90_000);
	await exerciseRejectedNativeBase(page, info, 'conflict-code', 'conflict-code.js');
});

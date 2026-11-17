import { createHash } from 'node:crypto';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { resetAppState } from './helpers';

// Mixed-format publication stall attribution for issue 569.
//
// The note keeps realistic inline formatting, lists, a table and one noisy
// image. The probe records every accepted input event, the observed gap
// between two events, the painted frame after each key and the product stage
// durations. Publication that runs while input resumes shows as a raised
// between-event delay, not only as one slow frame.
//
// Budgets: each engine long task above 100 ms must overlap a named stage
// window, a long resume wait must fall inside the complete source restore, and
// the durable save stages must stay below the 250 ms long-task budget. The
// resume delay itself is recorded evidence and stays a measured incident.

test.use({ locale: 'en-US', reducedMotion: 'reduce', trace: 'off' });

const noteId = 'stall-attribution';
const targetLine = 'Target ends here. **Bold** [link](https://e.test/t) `code`.';
const burstSpacing = 45;
// The note keeps representative mixed formatting and one photographic image.
// A local diagnostic can lower the size to separate probe cost from editor cost.
const textChars = Number(process.env.STALL_TEXT_CHARS ?? 240_000);
const imageWidth = Number(process.env.STALL_IMAGE_WIDTH ?? 320);
const imageHeight = Number(process.env.STALL_IMAGE_HEIGHT ?? 240);

type KeySample = { started: number; stamp: number; inputType: string | null; frame: number | null };
type StageSample = { name: string; start: number; end: number; value: number; span: boolean };
type LongTask = { start: number; duration: number };
type Probe = {
	keys: KeySample[];
	stages: StageSample[];
	longTasks: LongTask[];
	counters: Record<string, number>;
};
type Fixture = { content: string; imageUri: string; imageBytes: number };

type Session = { name: string; pause: number; keys: number; spacing: number };

const sessions: Session[] = [
	{ name: 'pause-300', pause: 300, keys: 1, spacing: 0 },
	{ name: 'pause-500', pause: 500, keys: 1, spacing: 0 },
	{ name: 'pause-800', pause: 800, keys: 1, spacing: 0 },
	{ name: 'pause-1200', pause: 1200, keys: 1, spacing: 0 },
	{ name: 'resume-burst', pause: 240, keys: 4, spacing: 40 }
];

async function seedNote(page: Page, textChars: number): Promise<Fixture> {
	return page.evaluate(
		async ({ rowId, target, width, height, chars }) => {
			/** A seeded noise field gives a photographic payload, not a flat colour. */
			const drawNoise = (imageWidth: number, imageHeight: number): string => {
				const canvas = document.createElement('canvas');
				canvas.width = imageWidth;
				canvas.height = imageHeight;
				const context = canvas.getContext('2d');
				if (!context) throw new Error('no 2d context');
				const image = context.createImageData(imageWidth, imageHeight);
				let seed = 0x2f6f4f;
				for (let index = 0; index < image.data.length; index += 4) {
					seed = (seed * 1_103_515_245 + 12_345) >>> 0;
					image.data[index] = seed & 0xff;
					image.data[index + 1] = (seed >>> 8) & 0xff;
					image.data[index + 2] = (seed >>> 16) & 0xff;
					image.data[index + 3] = 255;
				}
				context.putImageData(image, 0, 0);
				return canvas.toDataURL('image/png');
			};
			const imageUri = drawNoise(width, height);
			const imageBytes = Math.ceil((imageUri.length * 3) / 4);
			let content = '# Mixed format baseline\n\n';
			let section = 0;
			while (content.length < chars) {
				content += `## Section ${section}\n\n`;
				content += `${'Ordinary sentence with words that stay the same. '.repeat(4)}\n\n`;
				content += `**Bold claim ${section}** and [a reference link ${section}](https://example.test/ref/${section}) with \`inline code ${section}\` stays exact.\n\n`;
				content += `- first item ${section}\n- second item ${section}\n\n`;
				if (section === 0) content += `![Noisy photograph](${imageUri})\n\n`;
				if (section % 25 === 0)
					content += `| column | value |\n| --- | --- |\n| row ${section} | ${section * 7} |\n\n`;
				section += 1;
			}
			content += `## Target\n\n${target}\n\n### Tail\n\nTail paragraph for the caret.\n`;
			await new Promise<void>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const transaction = database.transaction('drafts', 'readwrite');
					transaction.objectStore('drafts').put({
						id: rowId,
						name: `${rowId}.md`,
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
			localStorage.setItem('mdsh:activeId', rowId);
			localStorage.setItem('mdsh:locale', 'en');
			return { content, imageUri, imageBytes };
		},
		{ rowId: noteId, target: targetLine, width: imageWidth, height: imageHeight, chars: textChars }
	);
}

async function storedContent(page: Page): Promise<string> {
	return page.evaluate(
		(rowId) =>
			new Promise<string>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const get = database.transaction('drafts').objectStore('drafts').get(rowId);
					get.onsuccess = () => {
						database.close();
						resolve((get.result as { content?: string } | undefined)?.content ?? '');
					};
					get.onerror = () => reject(get.error);
				};
			}),
		noteId
	);
}

async function openVisualEditor(page: Page) {
	await page.locator('[data-mode=wysiwyg]').click();
	const dialog = page.getByRole('dialog', { name: /Render this large document/ });
	await dialog.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
	if (await dialog.isVisible().catch(() => false)) {
		await dialog.getByRole('button', { name: /Render document/ }).click();
	}
	await expect(page.locator('.ProseMirror')).toHaveAttribute('contenteditable', 'true', {
		timeout: 180_000
	});
}

async function installProbe(page: Page) {
	await page.locator('.ProseMirror').evaluate((element) => {
		const probe = {
			keys: [] as {
				started: number;
				stamp: number;
				inputType: string | null;
				frame: number | null;
			}[],
			stages: [] as {
				name: string;
				start: number;
				end: number;
				value: number;
				span: boolean;
			}[],
			longTasks: [] as { start: number; duration: number }[],
			counters: {} as Record<string, number>
		};
		window.addEventListener(
			'deckmark:editor-perf',
			(event) => {
				const detail = (
					event as CustomEvent<{
						kind: string;
						name: string;
						value?: number;
						start?: number;
						end?: number;
					}>
				).detail;
				if (detail.kind === 'counter') {
					probe.counters[detail.name] = (probe.counters[detail.name] ?? 0) + 1;
					return;
				}
				if (detail.kind !== 'duration' || detail.value === undefined) return;
				const end = detail.end ?? performance.now();
				probe.stages.push({
					name: detail.name,
					start: detail.start ?? end - detail.value,
					end,
					value: detail.value,
					span: detail.start !== undefined
				});
			},
			true
		);
		element.addEventListener(
			'beforeinput',
			(event) => {
				const started = performance.now();
				const sample = {
					started,
					stamp: (event as InputEvent).timeStamp,
					inputType: (event as InputEvent).inputType ?? null,
					frame: null as number | null
				};
				probe.keys.push(sample);
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
				new PerformanceObserver((list) => {
					for (const entry of list.getEntries())
						probe.longTasks.push({ start: entry.startTime, duration: entry.duration });
				}).observe({ type: 'longtask', buffered: false });
			} catch {
				// The engine does not expose long-task entries.
			}
		}
		(window as unknown as { __stallProbe: typeof probe }).__stallProbe = probe;
	});
}

async function resetProbe(page: Page) {
	await page.evaluate(() => {
		const probe = (window as unknown as { __stallProbe: Probe }).__stallProbe;
		probe.keys.length = 0;
		probe.stages.length = 0;
		probe.longTasks.length = 0;
	});
}

async function readProbe(page: Page): Promise<Probe> {
	return page.evaluate(() => {
		const probe = (window as unknown as { __stallProbe: Probe }).__stallProbe;
		return {
			keys: probe.keys.map((key) => ({ ...key })),
			stages: probe.stages.map((stage) => ({ ...stage })),
			longTasks: probe.longTasks.map((task) => ({ ...task })),
			counters: { ...probe.counters }
		};
	});
}

async function measureMeasures(
	page: Page
): Promise<Record<string, { count: number; max: number }>> {
	return page.evaluate(() => {
		const names = [
			'mdsh:document-serialization',
			'mdsh:document-derived',
			'mdsh:document-storage',
			'mdsh:draft-manifest',
			'mdsh:draft-metadata'
		];
		const result: Record<string, { count: number; max: number }> = {};
		for (const name of names) {
			const entries = performance.getEntriesByName(name, 'measure');
			result[name] = {
				count: entries.length,
				max: entries.reduce((longest, entry) => Math.max(longest, entry.duration), 0)
			};
		}
		return result;
	});
}

function percentile(values: readonly number[], ratio: number): number {
	if (!values.length) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.ceil(sorted.length * ratio) - 1] ?? 0;
}

/** Total time inside at least one stage that reported its own boundary times. */
function coveredBySpans(from: number, to: number, stages: readonly StageSample[]): number {
	const intervals = stages
		.filter((stage) => stage.span)
		.map((stage) => [Math.max(from, stage.start), Math.min(to, stage.end)] as const)
		.filter(([start, end]) => end > start)
		.sort((left, right) => left[0] - right[0]);
	let total = 0;
	let cursor = from;
	for (const [start, end] of intervals) {
		const begin = Math.max(start, cursor);
		if (end <= begin) continue;
		total += end - begin;
		cursor = end;
	}
	return total;
}

/**
 * Long tasks with less than half of their duration inside a named stage that
 * reported both boundary times. A duration alone cannot place the stage on the
 * timeline.
 */
function unattributed(longTasks: readonly LongTask[], stages: readonly StageSample[]): LongTask[] {
	return longTasks
		.filter((task) => task.duration >= 100)
		.filter(
			(task) => coveredBySpans(task.start, task.start + task.duration, stages) < task.duration * 0.5
		);
}

async function attachEvidence(info: TestInfo, payload: Record<string, unknown>): Promise<void> {
	await info.attach('editor-publish-stall.json', {
		body: JSON.stringify(payload, null, 2),
		contentType: 'application/json'
	});
}

test('attributes a resumed keystroke to the publication stage', async ({ page }, info) => {
	test.setTimeout(420_000);
	await resetAppState(page, { mode: 'source' });
	const fixture = await seedNote(page, textChars);
	await page.reload();
	await openVisualEditor(page);
	const visual = page.locator('.ProseMirror');
	await expect(visual).toBeVisible({ timeout: 180_000 });
	await expect
		.poll(() =>
			page.locator('.milkdown-image-block img').evaluateAll((images) =>
				images.every((image) => {
					const target = image as HTMLImageElement;
					return target.complete && target.naturalWidth > 0;
				})
			)
		)
		.toBe(true);
	const target = visual.locator('p', { hasText: 'Target ends here.' }).first();
	await target.click({ position: { x: 4, y: 8 } });
	await page.keyboard.press('End');
	await installProbe(page);

	// Warmup publication and save complete before the measured sessions.
	await page.keyboard.insertText('warm');
	await page.waitForTimeout(2_500);
	await resetProbe(page);

	const resumeChars = ['Q', 'R', 'V', 'W', 'X'];
	const burstChars = ['a', 'b', 'c'];
	let typed = 'warm';
	const perSession: {
		name: string;
		pause: number;
		resumeDelay: number;
		resumeFrame: number | null;
		keys: number;
	}[] = [];
	const allDelays: number[] = [];
	for (const [index, session] of sessions.entries()) {
		const resumeChar = resumeChars[index] ?? 'Z';
		for (const character of burstChars) {
			await page.keyboard.insertText(character);
			await page.waitForTimeout(burstSpacing);
		}
		typed += burstChars.join('');
		await page.waitForTimeout(session.pause);
		const firstResume = await page.evaluate(() => {
			const probe = (window as unknown as { __stallProbe: Probe }).__stallProbe;
			return probe.keys.length;
		});
		await page.keyboard.insertText(resumeChar);
		typed += resumeChar;
		for (let extra = 1; extra < session.keys; extra += 1) {
			await page.waitForTimeout(session.spacing);
			const character = resumeChars[(index + extra) % resumeChars.length] ?? 'Y';
			await page.keyboard.insertText(character);
			typed += character;
		}
		// Every second frame sample must arrive before the next session.
		await page.waitForFunction(
			({ expected }) =>
				(window as unknown as { __stallProbe: Probe }).__stallProbe.keys.every(
					(key) => key.frame !== null
				) && (window as unknown as { __stallProbe: Probe }).__stallProbe.keys.length >= expected,
			{ expected: firstResume + session.keys },
			{ timeout: 60_000 }
		);
		const gaps = await page.evaluate(
			({ from, burst, pause, spacing }) => {
				const probe = (window as unknown as { __stallProbe: Probe }).__stallProbe;
				const keys = probe.keys.slice(from);
				return keys.slice(1).map((key, position) => {
					const index = position + 1;
					const expected = index === burst ? pause : spacing;
					const previous = keys[position]?.started ?? key.started;
					return {
						delay: key.started - previous - expected,
						frame: key.frame,
						resume: index >= burst,
						from: previous,
						to: key.started
					};
				});
			},
			{
				from: firstResume - burstChars.length,
				burst: burstChars.length,
				pause: session.pause,
				spacing: session.spacing
			}
		);
		const first = gaps.find((gap) => gap.resume) ?? { delay: 0, frame: null, from: 0, to: 0 };
		perSession.push({
			name: session.name,
			pause: session.pause,
			resumeDelay: first.delay,
			resumeFrame: first.frame,
			keys: gaps.length + 1,
			waitFrom: Math.round(first.to - first.delay),
			waitTo: Math.round(first.to)
		});
		for (const gap of gaps.filter((entry) => entry.resume)) allDelays.push(gap.delay);
		// Let the publication and the durable save that follow this session finish.
		await page.waitForTimeout(1_800);
	}

	const probe = await readProbe(page);
	const measures = await measureMeasures(page);
	const fullRestores = probe.stages.filter((stage) => stage.name === 'sourceFidelityFull');
	const longestRestore = fullRestores.reduce((longest, stage) => Math.max(longest, stage.value), 0);
	const uncovered = unattributed(probe.longTasks, probe.stages);
	const resumeDelays = allDelays.map((delay) => Math.round(delay * 100) / 100);
	const maxResumeDelay = resumeDelays.length ? Math.max(...resumeDelays) : 0;
	// A resume that waits at least the long-task budget must wait inside the
	// named restore stage. A new cause must fail this check, not pass as noise.
	const restoreSpans = probe.stages.filter(
		(stage) => stage.name === 'restoreMarkdown' && stage.span
	);
	const reproduced = perSession.filter((session) => session.resumeDelay >= 250);
	const unexplained = reproduced.filter((session) => {
		const from = session.waitTo - session.resumeDelay;
		const covered = coveredBySpans(from, session.waitTo, restoreSpans);
		return covered < session.resumeDelay * 0.5;
	});
	const saveStages = [
		measures['mdsh:document-storage'],
		measures['mdsh:draft-manifest'],
		measures['mdsh:draft-metadata']
	];
	const longestSaveStage = Math.max(...saveStages.map((stage) => stage?.max ?? 0));
	const saveStageCount = saveStages.reduce((total, stage) => total + (stage?.count ?? 0), 0);

	// The saved row must keep the exact target line, the typed run, the image
	// identity and the table content.
	const expectedTarget = `${targetLine}${typed}`;
	let saved = '';
	await expect
		.poll(
			async () => {
				saved = await storedContent(page);
				return saved;
			},
			{ timeout: 60_000 }
		)
		.toContain(expectedTarget);
	expect(saved).toContain(`![Noisy photograph](${fixture.imageUri})`);
	expect(saved).toContain('| row 0 | 0 |');
	expect(saved).toContain('**Bold claim 0** and [a reference link 0](https://example.test/ref/0)');
	const savedLengthDelta = saved.length - fixture.content.length;
	expect(savedLengthDelta).toBe(typed.length);

	const caret = await page.evaluate(() => {
		const view = (
			window as unknown as {
				__MDSH_EDITOR_VIEW__?: {
					state: {
						selection: {
							$from: {
								parentOffset: number;
								parent: {
									textBetween: (from: number, to: number, blockSeparator?: string) => string;
								};
							};
						};
					};
				};
			}
		).__MDSH_EDITOR_VIEW__;
		if (!view) return null;
		const from = view.state.selection.$from;
		return from.parent.textBetween(Math.max(0, from.parentOffset - 40), from.parentOffset, '');
	});
	expect(caret, 'the caret must stay after the accepted input').not.toBeNull();
	expect(caret ?? '').toContain(typed.slice(-12));

	const imageDigest = createHash('sha256').update(fixture.imageUri).digest('hex');
	console.log(
		'[stall]',
		JSON.stringify({
			bytes: Buffer.byteLength(fixture.content),
			imageBytes: fixture.imageBytes,
			sessions: perSession,
			maxResumeDelay,
			fullRestores: fullRestores.length,
			longestRestore,
			longTasks: probe.longTasks.length,
			unattributed: uncovered.length
		})
	);
	await attachEvidence(info, {
		fixture: {
			generator: 'editor-publish-stall.seedNote',
			textChars,
			bytes: Buffer.byteLength(fixture.content),
			sha256: createHash('sha256').update(fixture.content).digest('hex'),
			image: {
				width: imageWidth,
				height: imageHeight,
				encodedBytes: fixture.imageBytes,
				sha256: imageDigest
			}
		},
		method:
			'Three trusted insertText events at 45 ms spacing, then one accepted key after the stated pause. The delay is the observed handler-entry gap between accepted input events minus the requested pause.',
		keys: probe.keys,
		sessions: perSession,
		resumeDelays,
		maxResumeDelay,
		stages: Object.fromEntries(
			[...new Set(probe.stages.map((stage) => stage.name))].map((name) => {
				const values = probe.stages
					.filter((stage) => stage.name === name)
					.map((stage) => stage.value);
				return [
					name,
					{
						count: values.length,
						p50: percentile(values, 0.5),
						p95: percentile(values, 0.95),
						max: Math.max(...values),
						spans: probe.stages.filter((stage) => stage.name === name && stage.span).length
					}
				];
			})
		),
		fullRestores: fullRestores.length,
		longestRestore,
		longTasks: probe.longTasks,
		unattributedLongTasks: uncovered,
		reproduced: reproduced.map((session) => session.name),
		unexplainedResumes: unexplained.map((session) => session.name),
		saveStages: { longest: longestSaveStage, count: saveStageCount },
		counters: probe.counters,
		measures,
		savedBytes: Buffer.byteLength(saved),
		browser: page.context().browser()?.version()
	});
	await info.attach('saved-note.md', { body: saved, contentType: 'text/markdown' });

	// The mixed-format edit must actually reach the complete source restore.
	expect(
		fullRestores.length,
		'the mixed-format note must reach the full restore stage'
	).toBeGreaterThan(0);
	expect(
		longestRestore,
		'the full restore must be long enough to appear in a trace'
	).toBeGreaterThan(50);

	// A long task must stay attributable to a named stage that reported its own
	// start and end time.
	expect(uncovered, 'each long task must overlap a named stage window').toEqual([]);

	// Any resume that waits at least the long-task budget must wait inside the
	// complete source restore. The delay stays recorded evidence; the fix for it
	// belongs to the source restore owner and not to this measurement.
	expect(unexplained, 'a long resume wait must fall inside the restore stage').toEqual([]);

	// The durable save stages must stay below the long-task budget in this
	// scenario, so a save is not the cause of the input delay.
	expect(saveStageCount, 'the durable save stages must run in this workflow').toBeGreaterThan(0);
	expect(longestSaveStage, 'a durable save stage must not block input').toBeLessThan(250);

	// Undo must remove the typed run and keep the exact original line.
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if ((await storedContent(page)) === fixture.content) break;
		await page.keyboard.press('Control+z');
		await page.waitForTimeout(300);
	}
	await expect.poll(async () => storedContent(page), { timeout: 60_000 }).toBe(fixture.content);
});

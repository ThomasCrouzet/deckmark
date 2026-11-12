import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { resetAppState } from './helpers';

// Image-heavy typing attribution for issue 569.
//
// Each scenario keeps the Markdown text generator and the 200 ms publish and
// 400 ms save delays of the product. The probe measures the beforeinput to the
// second painted frame interval, so a slow image decode or layout pass shows as
// input latency instead of a hidden task.
test.use({ locale: 'en-US', reducedMotion: 'reduce', trace: 'off' });

const counterKey = 'deckmark:image-perf-counters';

type Counters = Record<string, number>;

type StageSamples = Record<string, number[]>;

type ImageSpec = {
	width: number;
	height: number;
	variant: 'detail' | 'solid';
};

type Scenario = {
	name: string;
	images: ImageSpec[];
	project: { count: number; image: ImageSpec } | null;
	textBytes: number;
};

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
		const media = (
			window as unknown as {
				__MDSH_PROJECT_MEDIA__?: { stats: () => Record<string, number> };
			}
		).__MDSH_PROJECT_MEDIA__;
		if (media) {
			const stats = media.stats() as Record<string, number>;
			for (const name of [
				'contextReads',
				'assetReads',
				'assetIndexBuilds',
				'assetKeysVisited',
				'decodeCalls',
				'imageCacheHits',
				'imageCacheMisses'
			])
				counts[`projectMedia.${name}`] = stats[name] ?? 0;
		}
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

/**
 * Builds one deterministic note in the page. Data URIs stay in the page so a
 * multi-megabyte fixture never crosses the Playwright bridge twice.
 */
async function seedScenario(
	page: Page,
	id: string,
	scenario: Scenario
): Promise<{ content: string; imageBytes: number[] }> {
	return page.evaluate(
		async ({ rowId, images, project, textBytes }) => {
			const draw = (spec: { width: number; height: number; variant: string }, seed = 0): string => {
				const canvas = document.createElement('canvas');
				canvas.width = spec.width;
				canvas.height = spec.height;
				const context = canvas.getContext('2d')!;
				if (spec.variant === 'solid') {
					context.fillStyle = '#2f6f4f';
					context.fillRect(0, 0, spec.width, spec.height);
				} else {
					const gradient = context.createLinearGradient(0, 0, spec.width, spec.height);
					gradient.addColorStop(0, '#123');
					gradient.addColorStop(1, '#fed');
					context.fillStyle = gradient;
					context.fillRect(0, 0, spec.width, spec.height);
					const columns = 12;
					const rows = 8;
					for (let row = 0; row < rows; row += 1) {
						for (let column = 0; column < columns; column += 1) {
							context.fillStyle = `hsl(${(row * 37 + column * 13 + seed * 29) % 360} 60% 50%)`;
							context.fillRect(
								(column * spec.width) / columns,
								(row * spec.height) / rows,
								spec.width / columns - 2,
								spec.height / rows - 2
							);
						}
					}
				}
				return canvas.toDataURL('image/png');
			};
			const paragraph =
				'Local benchmark text keeps the same words in every run. The editor reads Markdown, while the preview draws a table and a diagram. ';
			const dataUris = images.map((image, index) => draw(image, index));
			const imageBytes = dataUris.map((uri) => Math.ceil((uri.length * 3) / 4));
			const projectAssets: { path: string; data: Uint8Array }[] = [];
			if (project) {
				const uri = draw(project.image);
				const bytes = Uint8Array.from(atob(uri.split(',')[1]!), (character) =>
					character.charCodeAt(0)
				);
				for (let index = 0; index < project.count; index += 1)
					projectAssets.push({ path: `assets/benchmark-${index}.png`, data: bytes });
			}
			let content = '# Image input latency\n\n';
			let section = 0;
			let inlineIndex = 0;
			let projectIndex = 0;
			while (
				content.length < textBytes ||
				inlineIndex < dataUris.length ||
				projectIndex < projectAssets.length
			) {
				content += `## Section ${section}\n\n${paragraph.repeat(3)}\n\n`;
				if (inlineIndex < dataUris.length) {
					content += `Paragraph before image ${inlineIndex}.\n\n![Benchmark image ${inlineIndex}](${dataUris[inlineIndex]})\n\nParagraph after image ${inlineIndex}.\n\n`;
					inlineIndex += 1;
				} else if (projectIndex < projectAssets.length) {
					content += `Paragraph before project image ${projectIndex}.\n\n![Benchmark project image ${projectIndex}](../assets/benchmark-${projectIndex}.png)\n\nParagraph after project image ${projectIndex}.\n\n`;
					projectIndex += 1;
				}
				section += 1;
			}
			content += '# Tail\n\nFinal paragraph for the caret.\n';
			await new Promise<void>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const transaction = database.transaction(
						['projects', 'drafts', 'projectAssets'],
						'readwrite'
					);
					if (projectAssets.length) {
						transaction.objectStore('projects').put({
							id: 'image-perf-project',
							name: 'Image perf project',
							createdAt: 1,
							updatedAt: 1
						});
					}
					projectAssets.forEach((asset, index) => {
						transaction.objectStore('projectAssets').put({
							id: `image-perf-asset-${index}`,
							projectId: 'image-perf-project',
							path: asset.path,
							mime: 'image/png',
							data: asset.data
						});
					});
					transaction.objectStore('drafts').put({
						id: rowId,
						name: `${rowId}.md`,
						content,
						...(projectAssets.length
							? { projectId: 'image-perf-project', relativePath: 'notes/latency.md' }
							: {}),
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
			return { content, imageBytes };
		},
		{
			rowId: id,
			images: scenario.images,
			project: scenario.project,
			textBytes: scenario.textBytes
		}
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
					const get = database.transaction('drafts').objectStore('drafts').get(rowId);
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

async function installInputProbe(page: Page) {
	await page.locator('.ProseMirror').evaluate((element) => {
		const samples: number[] = [];
		const longTasks: number[] = [];
		const stages: Record<string, number[]> = {};
		// Product stage durations arrive as kind: 'duration' events. They stay
		// outside the gated sample list and only describe the work around a key.
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
		(window as unknown as { __imageInputProbe: unknown }).__imageInputProbe = {
			samples,
			longTasks,
			stages
		};
	});
}

async function readInputProbe(
	page: Page
): Promise<{ samples: number[]; longTasks: number[]; stages: StageSamples }> {
	return page.evaluate(
		() =>
			(
				window as unknown as {
					__imageInputProbe: { samples: number[]; longTasks: number[]; stages: StageSamples };
				}
			).__imageInputProbe
	);
}

async function heap(page: Page): Promise<Record<string, number | boolean>> {
	return page.evaluate(() => {
		const memory = (performance as unknown as { memory?: Record<string, number> }).memory;
		if (!memory) return { supported: false };
		return {
			supported: true,
			usedJSHeapSize: memory.usedJSHeapSize ?? 0,
			totalJSHeapSize: memory.totalJSHeapSize ?? 0
		};
	});
}

function percentile(values: readonly number[], ratio: number): number {
	if (!values.length) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.ceil(sorted.length * ratio) - 1]!;
}

/** Summarize product stage durations without mixing them into the gated samples. */
function summarizeStages(
	stages: StageSamples
): Record<string, { count: number; p50: number; p95: number }> {
	return Object.fromEntries(
		Object.entries(stages).map(([name, values]) => [
			name,
			{ count: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95) }
		])
	);
}

async function typeAndSample(page: Page, characters: number): Promise<void> {
	const probeCount = async () =>
		page.evaluate(
			() =>
				(window as unknown as { __imageInputProbe: { samples: number[] } }).__imageInputProbe
					.samples.length
		);
	const typed = 'abcdefghijklmnopqrstuvwxyz0123456789';
	for (let index = 0; index < characters; index += 1) {
		const recorded = await probeCount();
		await page.keyboard.insertText(typed[index % typed.length]!);
		await page.waitForFunction(
			({ count }) =>
				(window as unknown as { __imageInputProbe: { samples: number[] } }).__imageInputProbe
					.samples.length > count,
			{ count: recorded },
			{ timeout: 10_000 }
		);
	}
}

const detail = (width: number, height: number): ImageSpec => ({ width, height, variant: 'detail' });

const scenarios: Scenario[] = [
	{ name: 'text-only', images: [], project: null, textBytes: 1_000_000 },
	{ name: 'inline-1-small', images: [detail(320, 240)], project: null, textBytes: 1_000_000 },
	{
		name: 'inline-4',
		images: Array.from({ length: 4 }, () => detail(1600, 1200)),
		project: null,
		textBytes: 900_000
	},
	{
		name: 'inline-12',
		images: Array.from({ length: 12 }, () => detail(1200, 900)),
		project: null,
		textBytes: 900_000
	},
	{
		name: 'near-limit-1',
		images: [{ width: 6000, height: 5000, variant: 'solid' }],
		project: null,
		textBytes: 900_000
	},
	{
		name: 'project-4',
		images: [],
		project: { count: 4, image: detail(1600, 1200) },
		textBytes: 900_000
	}
];

for (const scenario of scenarios) {
	test(`image typing attribution: ${scenario.name}`, async ({ page }, info) => {
		test.setTimeout(420_000);
		await installCounters(page);
		await resetAppState(page, { mode: 'source' });
		const fixture = await seedScenario(page, 'image-perf', scenario);
		await page.reload();
		await openVisualEditor(page);
		const visual = page.locator('.ProseMirror');
		await expect(visual).toBeVisible({ timeout: 180_000 });
		// Steady typing starts after every image decode. A mount decode is not a
		// keystroke cost, and a slow frame during it would attribute the decode
		// to the first typed character.
		const imageCount = await page.locator('.milkdown-image-block img').count();
		if (imageCount)
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
		await page.waitForTimeout(400);
		await installInputProbe(page);
		const countersBefore = await readCounters(page);
		const heapBefore = await heap(page);
		const positions: Record<string, number[]> = {};
		const positionTasks: Record<string, number[]> = {};
		const positionStages: Record<string, StageSamples> = {};
		for (const position of ['start', 'end'] as const) {
			const block =
				position === 'start' ? visual.locator('h1').first() : visual.locator('p').last();
			await block.click();
			await page.keyboard.press(position === 'start' ? 'Home' : 'End');
			await page.keyboard.insertText('warm');
			await page.waitForTimeout(1_200);
			await page.evaluate(() => {
				const probe = (
					window as unknown as {
						__imageInputProbe: {
							samples: number[];
							longTasks: number[];
							stages: Record<string, number[]>;
						};
					}
				).__imageInputProbe;
				probe.samples.length = 0;
				probe.longTasks.length = 0;
				for (const values of Object.values(probe.stages)) values.length = 0;
			});
			await typeAndSample(page, 30);
			await page.waitForTimeout(700);
			const measured = await readInputProbe(page);
			positions[position] = measured.samples;
			positionTasks[position] = measured.longTasks;
			positionStages[position] = measured.stages;
		}
		const countersAfter = await readCounters(page);
		const counterDelta = delta(countersBefore, countersAfter);
		const heapAfter = await heap(page);
		const probe = await readInputProbe(page);
		probe.samples = Object.values(positions).flat();
		probe.longTasks = Object.values(positionTasks).flat();
		const p50 = percentile(probe.samples, 0.5);
		const p95 = percentile(probe.samples, 0.95);
		const longestTask = probe.longTasks.length ? Math.max(...probe.longTasks) : 0;
		const samplesAtOrAbove100 = probe.samples.filter((value) => value >= 100).length;
		const allStages = Object.values(positionStages).reduce<StageSamples>((all, stages) => {
			for (const [name, values] of Object.entries(stages)) (all[name] ??= []).push(...values);
			return all;
		}, {});
		const stageSummary = summarizeStages(allStages);
		const positionStageSummary = Object.fromEntries(
			Object.entries(positionStages).map(([position, stages]) => [
				position,
				summarizeStages(stages)
			])
		);
		const typedTail = 'abcdefghijklmnopqrstuvwxyz0123';
		let saved = '';
		await expect
			.poll(
				async () => {
					saved = await storedContent(page, 'image-perf');
					return saved;
				},
				{ timeout: 30_000 }
			)
			.toContain(typedTail);
		const imageSummary = [
			...scenario.images.map((image, index) => ({
				kind: 'inline',
				width: image.width,
				height: image.height,
				variant: image.variant,
				encodedBytes: fixture.imageBytes[index] ?? null
			})),
			...(scenario.project
				? [
						{
							kind: 'project',
							count: scenario.project.count,
							width: scenario.project.image.width,
							height: scenario.project.image.height,
							variant: scenario.project.image.variant
						}
					]
				: [])
		];
		const fixtureSummary = {
			generator: 'image-input-latency.seedScenario',
			bytes: Buffer.byteLength(fixture.content),
			sha256: createHash('sha256').update(fixture.content).digest('hex'),
			images: imageSummary
		};
		console.log(
			'[perf] image typing',
			JSON.stringify({
				scenario: scenario.name,
				p50,
				p95,
				samplesAtOrAbove100,
				longestTask,
				samples: probe.samples,
				stages: stageSummary,
				counters: counterDelta
			})
		);
		await info.attach('image-input-latency.json', {
			body: JSON.stringify(
				{
					fixture: fixtureSummary,
					method:
						'Thirty trusted insertText events at the start and thirty at the end. Each sample is beforeinput to the second animation frame. Long tasks are engine-reported.',
					stageMethod:
						'Product duration events are recorded by name. They stay outside the gated p50 and p95 and describe the work around a position.',
					scenario: scenario.name,
					positions,
					positionTasks,
					positionStages: positionStageSummary,
					samples: probe.samples,
					longTasks: probe.longTasks,
					p50,
					p95,
					samplesAtOrAbove100,
					longestTask,
					stages: stageSummary,
					counters: counterDelta,
					heap: { before: heapBefore, after: heapAfter },
					savedBytes: Buffer.byteLength(saved),
					browser: page.context().browser()?.version()
				},
				null,
				2
			),
			contentType: 'application/json'
		});
		expect(probe.samples.length).toBeGreaterThanOrEqual(60);
		await info.attach('saved-note.md', { body: saved, contentType: 'text/markdown' });
		expect(p95, 'image typing must stay inside the visual typing budget').toBeLessThan(100);
		expect(longestTask, 'image work must not create a long main-thread task').toBeLessThan(250);
		const savedImages = (saved.match(/data:image\/png;base64,/g) ?? []).length;
		const savedProjects = (saved.match(/\.\.\/assets\/benchmark-\d+\.png/g) ?? []).length;
		expect(
			scenario.project ? savedProjects : savedImages,
			'the saved note must keep every image reference'
		).toBe(scenario.project ? scenario.project.count : scenario.images.length);
		if (scenario.project) expect(saved).toContain('![Benchmark project image 0]');
		else if (scenario.images.length) expect(saved).toContain('![Benchmark image 0]');
	});
}

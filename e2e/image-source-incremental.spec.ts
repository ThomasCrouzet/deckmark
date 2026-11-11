import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createFirstFile, resetAppState, writeSourceContent } from './helpers';
import { exportSource } from './source-fidelity-harness';

const counterKey = 'deckmark:editor-perf-counters';
const stageKey = 'deckmark:editor-perf-stages';

type Counters = Record<string, number>;

// The publish path is a frame-sensitive workflow. Keep tracing off so the
// counter deltas describe one ordinary edit.
test.use({ locale: 'en-US', reducedMotion: 'reduce', trace: 'off' });

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
		return JSON.parse(sessionStorage.getItem(key) ?? '{}') as Record<string, number>;
	}, counterKey);
}

async function installStageProbe(page: Page) {
	await page.addInitScript((key) => {
		const stages: Record<string, number[]> = {};
		window.addEventListener('deckmark:editor-perf', (event) => {
			const detail = (event as CustomEvent<{ kind: string; name: string; value?: number }>).detail;
			if (detail.kind !== 'duration' || detail.value === undefined) return;
			(stages[detail.name] ??= []).push(detail.value);
			sessionStorage.setItem(key, JSON.stringify(stages));
		});
	}, stageKey);
}

async function readStagePercentiles(page: Page): Promise<Record<string, StageSummary>> {
	const stages = await page.evaluate((key) => {
		return JSON.parse(sessionStorage.getItem(key) ?? '{}') as Record<string, number[]>;
	}, stageKey);
	const summary: Record<string, StageSummary> = {};
	for (const [name, values] of Object.entries(stages)) {
		if (values.length === 0) continue;
		const sorted = [...values].sort((left, right) => left - right);
		summary[name] = {
			samples: values.length,
			p50: sorted[Math.ceil(sorted.length * 0.5) - 1]!,
			p95: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
			max: sorted[sorted.length - 1]!
		};
	}
	return summary;
}

interface StageSummary {
	samples: number;
	p50: number;
	p95: number;
	max: number;
}

async function storedContent(page: Page): Promise<string> {
	return page.evaluate(
		() =>
			new Promise<string>((resolve, reject) => {
				const id = localStorage.getItem('mdsh:activeId') ?? '';
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const transaction = database.transaction('drafts');
					const get = transaction.objectStore('drafts').get(id);
					get.onsuccess = () => {
						database.close();
						resolve((get.result as { content?: string } | undefined)?.content ?? '');
					};
					get.onerror = () => reject(get.error);
				};
			})
	);
}

/** The palette is a lazy chunk. Retry once if its module load fails. */
async function stableExport(page: Page): Promise<string> {
	try {
		return await exportSource(page);
	} catch {
		await page.keyboard.press('Escape');
		return exportSource(page);
	}
}

function delta(before: Counters, after: Counters): Counters {
	const result: Counters = {};
	for (const name of new Set([...Object.keys(before), ...Object.keys(after)]))
		result[name] = (after[name] ?? 0) - (before[name] ?? 0);
	return result;
}

async function attachEvidence(info: TestInfo, name: string, payload: Record<string, unknown>) {
	await info.attach(`${name}.json`, {
		body: JSON.stringify(payload, null, 2),
		contentType: 'application/json'
	});
}

/**
 * A deterministic, valid PNG payload. Random pixels keep the Base64 large, so
 * the fixture reaches the megabyte note size of the reported case.
 */
async function largePng(page: Page, side = 420): Promise<string> {
	const dataUri = await page.evaluate((width) => {
		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = width;
		const context = canvas.getContext('2d')!;
		const image = context.createImageData(width, width);
		let seed = 987654321;
		for (let index = 0; index < image.data.length; index += 4) {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			image.data[index] = seed & 255;
			image.data[index + 1] = (seed >>> 8) & 255;
			image.data[index + 2] = (seed >>> 16) & 255;
			image.data[index + 3] = 255;
		}
		context.putImageData(image, 0, 0);
		return canvas.toDataURL('image/png');
	}, side);
	return dataUri.slice(dataUri.indexOf(',') + 1);
}

/**
 * One large embedded image with a caption and a non-default ratio. The second
 * copy repeats the same source so occurrence-aware identity stays in play.
 */
function imageFixture(payload: string): string {
	const image = `![Figure one](data:image/png;base64,${payload})`;
	const repeat = `![Figure one](data:image/png;base64,${payload})`;
	return [
		'Opening paragraph before the image.',
		'',
		image,
		'<!-- mdsh:image ratio=1.50 -->',
		'',
		'Paragraph after the image.',
		'',
		repeat,
		'',
		'Closing paragraph.'
	].join('\n');
}

/** A note above 256 KiB asks for render confirmation before Edit mounts. */
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

test.beforeEach(async ({ page }) => {
	await installCounters(page);
	await installStageProbe(page);
	await resetAppState(page);
	await createFirstFile(page);
});

test('typing a new paragraph next to an embedded image stays on the scoped paths', async ({
	page
}, info) => {
	test.setTimeout(240_000);
	const payload = await largePng(page);
	const source = `${imageFixture(payload)}\n`;
	await writeSourceContent(page, source);
	await openVisualEditor(page);
	const editor = page.locator('.ProseMirror');
	const target = editor.locator('p', { hasText: 'Paragraph after the image.' });
	await target.click();
	await page.keyboard.press('End');
	const before = await readCounters(page);
	await page.keyboard.press('Enter');
	// Let the 200 ms quiet-period publish the empty paragraph before typing.
	await page.waitForTimeout(400);
	const savedAt = Date.now();
	await page.keyboard.insertText('New line.');
	await expect
		.poll(async () => (await storedContent(page)).includes('New line.'), {
			timeout: 20_000,
			intervals: [250, 500, 1_000]
		})
		.toBe(true);
	const saveLatencyMs = Date.now() - savedAt;
	await page.waitForTimeout(400);
	const change = delta(before, await readCounters(page));
	const expected = source.replace(
		'Paragraph after the image.',
		'Paragraph after the image.\n\nNew line.'
	);
	const exported = await stableExport(page);
	const stages = await readStagePercentiles(page);
	await attachEvidence(info, 'image-adjacent-publish', {
		noteBytes: source.length,
		embeddedImageBytes: payload.length,
		counters: change,
		stages,
		savedBytes: (await storedContent(page)).length,
		saveLatencyMs,
		method:
			'Enter in the paragraph after a 20 KB embedded image, 400 ms quiet period, then type. Counter deltas come from deckmark:editor-perf and stage samples are raw milliseconds for this run.'
	});
	await info.attach('expected.md', { body: expected, contentType: 'text/markdown' });
	await info.attach('exported.md', { body: exported, contentType: 'text/markdown' });

	expect(change.markdownIncrementalFallback ?? 0, 'a split beside an image is local').toBe(0);
	expect(
		change.sourceFidelityFull ?? 0,
		`source restoration stays scoped ${JSON.stringify(change)}`
	).toBe(0);
	expect(change.imageMarkdownFull ?? 0, 'the image scan must not rerun').toBe(0);
	expect(change.imageMarkdownScoped ?? 0, 'the image round trip splices').toBeGreaterThan(0);
	expect(change.sourceFidelityScoped ?? 0, 'the fidelity layer splices').toBeGreaterThan(0);
	expect(exported).toBe(expected);

	// Undo must return the exact original bytes, including image identity.
	await editor.click();
	await page.keyboard.press('ControlOrMeta+z');
	await page.keyboard.press('ControlOrMeta+z');
	await page.waitForTimeout(700);
	const undone = await stableExport(page);
	await info.attach('undone.md', { body: undone, contentType: 'text/markdown' });
	expect(undone, 'undo keeps the original image bytes').toBe(source);
});

test('appending text after a trailing embedded image stays on the scoped paths', async ({
	page
}, info) => {
	test.setTimeout(240_000);
	const payload = await largePng(page, 150);
	const source = `Opening paragraph.\n\n![Figure one](data:image/png;base64,${payload})\n`;
	await writeSourceContent(page, source);
	await openVisualEditor(page);
	const editor = page.locator('.ProseMirror');
	await editor.click();
	await page.keyboard.press('ControlOrMeta+End');
	const before = await readCounters(page);
	await page.keyboard.press('Enter');
	await page.waitForTimeout(400);
	const savedAt = Date.now();
	await page.keyboard.insertText('After the image.');
	await expect
		.poll(async () => (await storedContent(page)).includes('After the image.'), {
			timeout: 20_000,
			intervals: [250, 500, 1_000]
		})
		.toBe(true);
	const saveLatencyMs = Date.now() - savedAt;
	await page.waitForTimeout(400);
	const change = delta(before, await readCounters(page));
	const expected = `${source}\nAfter the image.\n`;
	const exported = await stableExport(page);
	const stages = await readStagePercentiles(page);
	await attachEvidence(info, 'image-trailing-append', {
		noteBytes: source.length,
		embeddedImageBytes: payload.length,
		counters: change,
		stages,
		savedBytes: (await storedContent(page)).length,
		saveLatencyMs,
		method:
			'Caret at the end after a 20 KB embedded image, Enter, 400 ms quiet period, then type. Counter deltas come from deckmark:editor-perf and stage samples are raw milliseconds for this run.'
	});
	await info.attach('expected.md', { body: expected, contentType: 'text/markdown' });
	await info.attach('exported.md', { body: exported, contentType: 'text/markdown' });

	expect(change.markdownIncrementalFallback ?? 0, 'an append after an image is local').toBe(0);
	expect(
		change.sourceFidelityFull ?? 0,
		`source restoration stays scoped ${JSON.stringify(change)}`
	).toBe(0);
	expect(change.imageMarkdownFull ?? 0, 'the image scan must not rerun').toBe(0);
	expect(change.imageMarkdownScoped ?? 0, 'the image round trip splices').toBeGreaterThan(0);
	expect(change.sourceFidelityScoped ?? 0, 'the fidelity layer splices').toBeGreaterThan(0);
	expect(exported).toBe(expected);
});

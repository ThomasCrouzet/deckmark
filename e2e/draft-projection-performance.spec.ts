import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { createFirstFile, resetAppState, writeSourceContent } from './helpers';

// Image-rich notes carry their pixels in a `data:` URI inside the Markdown
// source. A routine save with unchanged source must not hash, scan links or
// UTF-8 encode that source again. The instrumented build reports one measure
// for each durable projection decision, with the reused flag and scanned bytes.

const IMAGE_BYTES = 256 * 1024;

function imageNote(images: number): string {
	const data = 'A'.repeat(IMAGE_BYTES);
	const body = Array.from(
		{ length: images },
		(_, index) => `![image ${index}](data:image/png;base64,${data})`
	).join('\n\n');
	return `# Durable projection\n\n${body}\n\nBody text.\n`;
}

interface ProjectionMeasure {
	duration: number;
	reused: boolean;
	bytes: number;
	mode: string;
}

// A large note whose final plain line is the edit target. Data URIs sit between
// the prose and that line so an unchanged image region must not be scanned.
function largeNote(chars: number, images: number): string {
	const head = '# Durable projection\n\n';
	const tail = '\n\nBody text.\n';
	const imageBlock = Array.from(
		{ length: images },
		(_, index) => `\n![image ${index}](data:image/png;base64,${'A'.repeat(IMAGE_BYTES)})\n`
	).join('');
	const line =
		'Plain body prose keeps one line of the durable source under a local edit. '.repeat(3) + '\n';
	const proseBudget = Math.max(0, chars - head.length - tail.length - imageBlock.length);
	const prose = line.repeat(Math.ceil(proseBudget / line.length)).slice(0, proseBudget);
	return head + prose + imageBlock + tail;
}

/**
 * Writes a large row through the application hooks, then reloads. A keyboard
 * insert of many lines is slower than the measurement and would dominate it.
 */
async function seedLargeNote(page: Page, id: string, content: string): Promise<void> {
	await page.evaluate(
		async ({ draftId, text }) => {
			const probe = (
				window as unknown as {
					__MDSH_PROJECTION_PROBE__: {
						seed(row: {
							id: string;
							name: string;
							content: string;
							updatedAt: number;
						}): Promise<void>;
					};
				}
			).__MDSH_PROJECTION_PROBE__;
			await probe.seed({
				id: draftId,
				name: 'large-note.md',
				content: text,
				updatedAt: Date.now()
			});
		},
		{ draftId: id, text: content }
	);
	await page.reload();
	await expect(page.locator('.cm-content').first()).toBeVisible({ timeout: 60_000 });
	await expect.poll(async () => (await readProjection(page, id))?.content).toBe(content);
}

/** Moves the caret to the end of the final plain line. */
async function placeCaretAtFinalBodyLine(page: Page): Promise<void> {
	const editor = page.locator('.cm-content').first();
	await editor.click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.press('ArrowLeft');
}

async function readProjection(page: Page, id: string): Promise<Record<string, unknown> | null> {
	return page.evaluate(
		(draftId) =>
			new Promise<Record<string, unknown> | null>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const cursor = database
						.transaction('drafts')
						.objectStore('drafts')
						.openCursor(IDBKeyRange.only(draftId));
					cursor.onerror = () => {
						database.close();
						reject(cursor.error);
					};
					cursor.onsuccess = () => {
						resolve((cursor.result?.value as Record<string, unknown> | undefined) ?? null);
						database.close();
					};
				};
			}),
		id
	);
}

/** Recomputes the complete projection from the durable row. Test build only. */
async function recomputeProjection(
	page: Page,
	id: string
): Promise<{ metadata: string; manifest: string; contentLength: number } | null> {
	return page.evaluate(
		(draftId) =>
			(
				window as unknown as {
					__MDSH_PROJECTION_PROBE__: {
						recompute(nextId: string): Promise<{
							metadata: string;
							manifest: string;
							contentLength: number;
						} | null>;
					};
				}
			).__MDSH_PROJECTION_PROBE__.recompute(draftId),
		id
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

async function readOnlyDraft(page: Page): Promise<Record<string, unknown>> {
	return page.evaluate(
		() =>
			new Promise<Record<string, unknown>>((resolve, reject) => {
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
						const row = cursor.result?.value as Record<string, unknown> | undefined;
						if (!row) {
							database.close();
							reject(new Error('draft row missing'));
							return;
						}
						resolve(row);
						database.close();
					};
				};
			})
	);
}

async function waitForSavedProjection(page: Page, contentLength: number): Promise<void> {
	await expect
		.poll(async () => {
			const row = await readOnlyDraft(page).catch(() => null);
			if (!row || typeof row.content !== 'string') return false;
			return row.content.length === contentLength && Boolean(row.manifest) && Boolean(row.metadata);
		})
		.toBe(true);
}

async function clearMeasures(page: Page): Promise<void> {
	await page.evaluate(() => performance.clearMeasures());
}

async function readMeasures(page: Page, name: string): Promise<ProjectionMeasure[]> {
	return page.evaluate((measureName) => {
		return performance.getEntriesByName(measureName).map((entry) => {
			const detail = (entry as PerformanceMeasure).detail as
				{ reused?: boolean; bytes?: number; mode?: string } | undefined;
			return {
				duration: entry.duration,
				reused: Boolean(detail?.reused),
				bytes: Number(detail?.bytes ?? 0),
				mode: String(detail?.mode ?? ((detail?.reused ?? false) ? 'reused' : 'full'))
			};
		});
	}, name);
}

async function attachEvidence(
	testInfo: TestInfo,
	name: string,
	payload: Record<string, unknown>
): Promise<void> {
	await testInfo.attach(name, {
		body: JSON.stringify(payload, null, 2),
		contentType: 'application/json'
	});
}

for (const images of [0, 1, 4]) {
	test(`reuses the durable projection for an unchanged save with ${images} image(s)`, async ({
		page
	}, testInfo) => {
		await resetAppState(page);
		await createFirstFile(page);
		const content = imageNote(images);
		await writeSourceContent(page, content);
		await waitForSavedProjection(page, content.length);
		await clearMeasures(page);

		// Closing the tab changes only `open`. The source, name and kind stay the
		// same, so both projections can reuse their durable values.
		await page
			.locator('aside')
			.getByRole('button', { name: /^Fermer / })
			.first()
			.click();
		await expect.poll(async () => (await readOnlyDraft(page)).open).toBe(false);
		await page.waitForTimeout(700);

		const manifest = await readMeasures(page, 'mdsh:draft-manifest');
		const metadata = await readMeasures(page, 'mdsh:draft-metadata');
		const storage = await readMeasures(page, 'mdsh:document-storage');
		const row = await readOnlyDraft(page);
		await attachEvidence(testInfo, `draft-projection-reuse-${images}.json`, {
			contentLength: content.length,
			images,
			savedRevision: row.updatedAt,
			manifest,
			metadata,
			storage
		});

		expect(manifest.length, 'the close write must update the manifest key').toBeGreaterThan(0);
		expect(manifest.every((entry) => entry.reused)).toBe(true);
		expect(manifest.every((entry) => entry.bytes === 0)).toBe(true);
		expect(metadata.length, 'the close write must report its metadata decision').toBeGreaterThan(0);
		expect(metadata.every((entry) => entry.reused)).toBe(true);
		expect(metadata.every((entry) => entry.bytes === 0)).toBe(true);

		// The reused slots must still describe the durable row.
		const manifestKey = JSON.parse(String(row.manifest)) as unknown[];
		expect(manifestKey[8]).toBe('note');
		expect(manifestKey[13]).toBe(content.length);
	});
}

test('recomputes the metadata projection when the source changes', async ({ page }, testInfo) => {
	await resetAppState(page);
	await createFirstFile(page);
	const before = '---\ntitle: Before\n---\n\n# Before\n';
	await writeSourceContent(page, before);
	await waitForSavedProjection(page, before.length);
	await expect
		.poll(async () => String((await readOnlyDraft(page)).metadata ?? ''))
		.toContain('Before');
	await clearMeasures(page);

	const after = '---\ntitle: After\n---\n\n# After\n\n[[Later target]]\n';
	await writeSourceContent(page, after);
	await expect
		.poll(async () => String((await readOnlyDraft(page)).metadata ?? ''))
		.toContain('Later target');
	const metadata = await readMeasures(page, 'mdsh:draft-metadata');
	await attachEvidence(testInfo, 'draft-projection-recompute.json', {
		contentLength: after.length,
		metadata
	});

	expect(metadata.some((entry) => !entry.reused && entry.bytes > 0)).toBe(true);
	expect(metadata.every((entry) => entry.reused || entry.bytes > 0)).toBe(true);

	// The changed projection must keep the exact durable revision.
	const row = await readOnlyDraft(page);
	const metadataKey = JSON.parse(String(row.metadata)) as unknown[];
	expect(metadataKey[3]).toBe(after.length);
	expect(metadataKey[4]).toBe('After');
	expect(metadataKey[7]).toEqual(['Later target']);
});

// A one-character edit on an unchanged large source must not run a complete
// projection scan. The bound is far below the source size and above the line
// that holds the caret.
const INCREMENTAL_SCAN_LIMIT = 8 * 1024;

for (const variant of [
	{ sizeMiB: 1, images: 0 },
	{ sizeMiB: 1, images: 4 },
	{ sizeMiB: 4, images: 4 }
]) {
	test(`projects a one-character plain edit incrementally at ${variant.sizeMiB} MiB with ${variant.images} image(s)`, async ({
		page
	}, testInfo) => {
		test.setTimeout(300_000);
		await resetAppState(page);
		await createFirstFile(page);
		const id = await activeFileId(page);
		const content = largeNote(variant.sizeMiB * 1024 * 1024, variant.images);
		await seedLargeNote(page, id, content);
		const before = await readOnlyDraft(page);
		await clearMeasures(page);

		await placeCaretAtFinalBodyLine(page);
		await page.keyboard.type('Z');
		const edited = `${content.slice(0, content.length - 1)}Z\n`;
		await expect.poll(async () => (await readProjection(page, id))?.content).toBe(edited);
		await page.waitForTimeout(700);

		const manifest = await readMeasures(page, 'mdsh:draft-manifest');
		const metadata = await readMeasures(page, 'mdsh:draft-metadata');
		const storage = await readMeasures(page, 'mdsh:document-storage');
		const row = (await readProjection(page, id)) ?? {};
		const recomputed = await recomputeProjection(page, id);
		await attachEvidence(
			testInfo,
			`draft-projection-incremental-${variant.sizeMiB}-${variant.images}.json`,
			{
				contentLength: content.length,
				images: variant.images,
				beforeRevision: before.updatedAt,
				savedRevision: row.updatedAt,
				manifest,
				metadata,
				storage,
				recomputedExact: Boolean(recomputed)
			}
		);

		const incremental = metadata.filter((entry) => entry.mode === 'incremental');
		expect(
			incremental.length,
			'the changed write must report an incremental decision'
		).toBeGreaterThan(0);
		expect(metadata.every((entry) => entry.mode !== 'full')).toBe(true);
		expect(incremental.every((entry) => entry.bytes <= INCREMENTAL_SCAN_LIMIT)).toBe(true);
		expect(incremental.every((entry) => entry.bytes < content.length / 32)).toBe(true);
		expect(manifest.every((entry) => entry.mode !== 'full')).toBe(true);
		expect(
			manifest
				.filter((entry) => entry.mode !== 'reused')
				.every((entry) => entry.bytes <= INCREMENTAL_SCAN_LIMIT)
		).toBe(true);

		// The incremental key must equal the complete projection of the exact row.
		expect(recomputed).not.toBeNull();
		expect(String(row.metadata)).toBe(recomputed!.metadata);
		expect(String(row.manifest)).toBe(recomputed!.manifest);
		expect(row.content).toBe(edited);
	});
}

test('keeps the complete projection path for a structural edit as the control', async ({
	page
}, testInfo) => {
	test.setTimeout(300_000);
	await resetAppState(page);
	await createFirstFile(page);
	const id = await activeFileId(page);
	const content = largeNote(1024 * 1024, 0);
	await seedLargeNote(page, id, content);
	await clearMeasures(page);

	await page.locator('.cm-content').first().click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.insertText('\n[[Control target]]\n');
	await expect
		.poll(async () => String((await readProjection(page, id))?.content))
		.toContain('[[Control target]]');
	const row = (await readProjection(page, id)) ?? {};
	const metadata = await readMeasures(page, 'mdsh:draft-metadata');
	const manifest = await readMeasures(page, 'mdsh:draft-manifest');
	const recomputed = await recomputeProjection(page, id);
	await attachEvidence(testInfo, 'draft-projection-full-control.json', {
		contentLength: content.length,
		metadata,
		manifest
	});

	// The structural edit adds a wiki target, so the complete scanner runs and
	// reads the whole source. The plain edit above stays far below this cost.
	const full = metadata.filter((entry) => entry.mode === 'full');
	expect(full.length).toBeGreaterThan(0);
	expect(full.every((entry) => entry.bytes >= content.length)).toBe(true);
	expect(String(row.metadata)).toBe(recomputed!.metadata);
	expect(JSON.parse(String(row.metadata))[7]).toEqual(['Control target']);
});

test('keeps the exact projection across a structural edit, undo and redo', async ({
	page
}, testInfo) => {
	await resetAppState(page);
	await createFirstFile(page);
	const seed =
		'---\ntitle: Exact title\ntags: [alpha, beta]\n---\n\n# Exact title\n\n[[First target]]\n\n<!-- mdsh-block:part -->\n\nPlain body text.\n';
	await writeSourceContent(page, seed);
	await waitForSavedProjection(page, seed.length);
	const id = await activeFileId(page);
	const seeded = await readOnlyDraft(page);
	expect(JSON.parse(String(seeded.metadata))[4]).toBe('Exact title');

	await clearMeasures(page);
	await placeCaretAtFinalBodyLine(page);
	await page.keyboard.type('Z');
	const plain = `${seed.slice(0, seed.length - 1)}Z\n`;
	await expect.poll(async () => (await readProjection(page, id))?.content).toBe(plain);
	let recomputed = await recomputeProjection(page, id);
	expect(String((await readProjection(page, id))?.metadata)).toBe(recomputed!.metadata);
	expect(metadataModes(await readMeasures(page, 'mdsh:draft-metadata'))).toContain('incremental');

	// A new heading and a new wiki target are structural. Both must run the
	// complete projection and keep the title, tags, markers and both targets.
	const structuralTail = '\n# Second heading\n\n[[Second target]]\n';
	await page.locator('.cm-content').first().click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.insertText(structuralTail);
	await expect
		.poll(async () => String((await readProjection(page, id))?.content))
		.toContain('[[Second target]]');
	const structural = String((await readProjection(page, id))?.content);
	expect(structural.startsWith(plain.slice(0, -1))).toBe(true);
	expect(structural).toContain('# Second heading');
	expect(structural.length).toBeGreaterThan(plain.length);
	let row = (await readProjection(page, id)) ?? {};
	const key = JSON.parse(String(row.metadata)) as unknown[];
	recomputed = await recomputeProjection(page, id);
	expect(key[4]).toBe('Exact title');
	expect(key[6]).toEqual(['alpha', 'beta']);
	expect(key[7]).toEqual(['First target', 'Second target']);
	expect(key[8]).toBe(1);
	expect(key[3]).toBe(structural.length);
	expect(String(row.metadata)).toBe(recomputed!.metadata);
	expect(String(row.manifest)).toBe(recomputed!.manifest);

	// Undo restores the previous source. The projection must describe the
	// restored bytes exactly, not the bytes that the structural edit produced.
	await page.locator('.cm-content').first().click();
	await page.keyboard.press('ControlOrMeta+z');
	await expect.poll(async () => (await readProjection(page, id))?.content).toBe(plain);
	row = (await readProjection(page, id)) ?? {};
	recomputed = await recomputeProjection(page, id);
	expect(String(row.metadata)).toBe(recomputed!.metadata);
	expect(String(row.manifest)).toBe(recomputed!.manifest);
	expect(JSON.parse(String(row.metadata))[7]).toEqual(['First target']);

	// The writing shortcuts map redo to Ctrl+Y outside macOS.
	await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y');
	await expect.poll(async () => (await readProjection(page, id))?.content).toBe(structural);
	row = (await readProjection(page, id)) ?? {};
	recomputed = await recomputeProjection(page, id);
	expect(String(row.metadata)).toBe(recomputed!.metadata);
	expect(String(row.manifest)).toBe(recomputed!.manifest);
	expect(JSON.parse(String(row.metadata))[7]).toEqual(['First target', 'Second target']);

	await attachEvidence(testInfo, 'draft-projection-structural-exact.json', {
		seedLength: seed.length,
		structuralLength: structural.length,
		contentLength: row.content?.toString().length,
		metadata: row.metadata,
		manifest: row.manifest,
		recomputed
	});
});

test('commits the exact projection on an immediate close after a plain edit', async ({
	page
}, testInfo) => {
	test.setTimeout(300_000);
	await resetAppState(page);
	await createFirstFile(page);
	const id = await activeFileId(page);
	const content = largeNote(1024 * 1024, 4);
	await seedLargeNote(page, id, content);
	await clearMeasures(page);

	await placeCaretAtFinalBodyLine(page);
	await page.keyboard.type('Q');
	const expected = `${content.slice(0, content.length - 1)}Q\n`;
	// Close immediately: the pending debounce is flushed by the close path.
	await page
		.locator('aside')
		.getByRole('button', { name: /^Fermer / })
		.first()
		.click();
	await expect
		.poll(async () => {
			const row = await readProjection(page, id);
			return row && row.open === false ? row.content : null;
		})
		.toBe(expected);

	const row = (await readProjection(page, id)) ?? {};
	const recomputed = await recomputeProjection(page, id);
	const manifest = await readMeasures(page, 'mdsh:draft-manifest');
	const metadata = await readMeasures(page, 'mdsh:draft-metadata');
	await attachEvidence(testInfo, 'draft-projection-immediate-close.json', {
		contentLength: expected.length,
		manifest,
		metadata,
		savedRevision: row.updatedAt,
		open: row.open
	});

	expect(row.open).toBe(false);
	expect(String(row.metadata)).toBe(recomputed!.metadata);
	expect(String(row.manifest)).toBe(recomputed!.manifest);
	expect(JSON.parse(String(row.manifest))[13]).toBe(expected.length);
	expect(metadataModes(metadata)).toContain('incremental');
	expect(
		manifest
			.filter((entry) => entry.mode !== 'reused')
			.every((entry) => entry.bytes <= INCREMENTAL_SCAN_LIMIT)
	).toBe(true);
});

function metadataModes(measures: ProjectionMeasure[]): string[] {
	return measures.map((entry) => entry.mode);
}

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
				{ reused?: boolean; bytes?: number } | undefined;
			return {
				duration: entry.duration,
				reused: Boolean(detail?.reused),
				bytes: Number(detail?.bytes ?? 0)
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

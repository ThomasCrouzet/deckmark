import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createFirstFile, resetAppState, writeSourceContent } from './helpers';

// Issue #345 coordinates one accepted source revision record. The merged
// `source-edit.ts` contract is the record for rendered publications. This case
// also covers Source and Code edits, which now report the same record in the
// `portable-source` space. The instrumented build exposes the last 100 records
// as `window.__MDSH_REVISION_CONTRACT__`.
//
// The assertions check the contract, not a latency budget:
// - a portable-source span is exact and can reconstruct the published text;
// - a coalesced source burst keeps a linked chain of exact spans;
// - a structural source edit stays exact;
// - a rendered edit reports a valid record in its own coordinate space;
// - the durable bytes equal the accepted revision.

const PARAGRAPH =
	'Paragraph with **bold** words, a [link](https://example.com/target), and `inline code`.\n';
const SENTINEL = 'Tail sentinel.\n';
const FIXTURE =
	'# Revision contract\n\nOpening **bold** text with a [link](https://example.com) and `code`.\n\n' +
	PARAGRAPH.repeat(1800) +
	'\n' +
	SENTINEL;

interface ContractRecord {
	fileId: string;
	baseGeneration: number;
	generation: number;
	kind: 'insert' | 'replace' | 'full';
	space: 'editor-markdown' | 'portable-source';
	previousFrom: number;
	previousTo: number;
	nextFrom: number;
	nextTo: number;
	previousLength: number | null;
	nextLength: number | null;
	exact: boolean | null;
}

interface DraftRow {
	id: string;
	name: string;
	content: string;
	open?: boolean;
}

async function draft(page: Page): Promise<DraftRow> {
	return page.evaluate(
		() =>
			new Promise<DraftRow>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const get = database.transaction('drafts').objectStore('drafts').getAll();
					get.onerror = () => reject(get.error);
					get.onsuccess = () => {
						database.close();
						const row = get.result[0] as DraftRow | undefined;
						if (row) resolve(row);
						else reject(new Error('draft row missing'));
					};
				};
			})
	);
}

async function records(page: Page): Promise<ContractRecord[]> {
	return page.evaluate(() => {
		const probe = (
			window as unknown as {
				__MDSH_REVISION_CONTRACT__?: { records: ContractRecord[]; clear: () => void };
			}
		).__MDSH_REVISION_CONTRACT__;
		return probe ? probe.records : [];
	});
}

async function clearRecords(page: Page): Promise<void> {
	await expect
		.poll(() =>
			page.evaluate(() =>
				Boolean(
					(
						window as unknown as {
							__MDSH_REVISION_CONTRACT__?: { clear: () => void };
						}
					).__MDSH_REVISION_CONTRACT__
				)
			)
		)
		.toBe(true);
	await page.evaluate(() => {
		(
			window as unknown as { __MDSH_REVISION_CONTRACT__: { clear: () => void } }
		).__MDSH_REVISION_CONTRACT__.clear();
	});
}

async function waitForRecord(
	page: Page,
	predicate: (record: ContractRecord) => boolean
): Promise<ContractRecord> {
	let found: ContractRecord | null = null;
	await expect
		.poll(async () => {
			const all = await records(page);
			found = all.findLast(predicate) ?? null;
			return found;
		})
		.not.toBeNull();
	return found!;
}

async function savedContent(page: Page, expectedLength: number): Promise<string> {
	await expect
		.poll(async () => (await draft(page).catch(() => null))?.content.length ?? -1)
		.toBe(expectedLength);
	return (await draft(page)).content;
}

function assertPortableSpan(record: ContractRecord): void {
	expect(record.space, JSON.stringify(record)).toBe('portable-source');
	expect(record.kind, JSON.stringify(record)).not.toBe('full');
	expect(record.exact, JSON.stringify(record)).toBe(true);
	expect(record.previousFrom).toBeLessThanOrEqual(record.previousTo);
	expect(record.nextFrom).toBeLessThanOrEqual(record.nextTo);
	expect(record.nextTo - record.nextFrom).toBeGreaterThan(0);
	expect(record.previousLength).not.toBeNull();
	expect(record.nextLength).not.toBeNull();
}

async function attach(
	testInfo: TestInfo,
	name: string,
	payload: Record<string, unknown>
): Promise<void> {
	const body = JSON.stringify(payload, null, 2);
	// Keep a file after a passing run. An attachment alone is not retained when
	// the case passes, so the local evidence would otherwise be lost.
	await writeFile(testInfo.outputPath(name), body, 'utf8');
	await testInfo.attach(name, { body, contentType: 'application/json' });
}

test.afterEach(async ({ page, browser }, testInfo) => {
	const row = await draft(page).catch(() => null);
	await attach(testInfo, 'revision-contract.json', {
		command:
			'npx playwright test e2e/revision-contract.spec.ts --project=chromium --workers=1 --retries=0',
		source: testInfo.config.metadata,
		browser: browser.version(),
		fixture: {
			length: FIXTURE.length,
			sha256: createHash('sha256').update(FIXTURE, 'utf8').digest('hex')
		},
		records: await records(page).catch(() => []),
		saved: row ? { length: row.content.length, tail: row.content.slice(-80) } : null
	});
});

test('a source edit publishes one exact portable-source record', async ({ page }, testInfo) => {
	await resetAppState(page);
	await createFirstFile(page);
	await writeSourceContent(page, FIXTURE);
	expect((await draft(page)).content).toBe(FIXTURE);
	await clearRecords(page);

	const source = page.locator('.cm-content').first();
	await source.click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.insertText('Z');

	const record = await waitForRecord(
		page,
		(entry) =>
			entry.space === 'portable-source' &&
			entry.nextLength === FIXTURE.length + 1 &&
			entry.previousLength === FIXTURE.length
	);
	assertPortableSpan(record);
	expect(record.kind).toBe('insert');
	expect(record.previousFrom).toBe(FIXTURE.length);
	expect(record.previousTo).toBe(FIXTURE.length);
	expect(record.nextFrom).toBe(FIXTURE.length);
	expect(record.nextTo).toBe(FIXTURE.length + 1);
	expect(record.generation).toBeGreaterThan(record.baseGeneration);

	const saved = await savedContent(page, FIXTURE.length + 1);
	expect(saved).toBe(`${FIXTURE}Z`);
	await attach(testInfo, 'source-single-edit.json', { record, savedLength: saved.length });
});

test('a coalesced source burst keeps a chain of exact records', async ({ page }, testInfo) => {
	await resetAppState(page);
	await createFirstFile(page);
	await writeSourceContent(page, FIXTURE);
	await clearRecords(page);

	const source = page.locator('.cm-content').first();
	await source.click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.type('abcde', { delay: 15 });

	// Under load the 100 ms publication timer can split the burst into two
	// accepted revisions. Both must stay exact, and their spans must add up to
	// the five inserted characters.
	const saved = await savedContent(page, FIXTURE.length + 5);
	const seen = await records(page);
	expect(seen.length).toBeGreaterThan(0);
	expect(seen[0]!.previousLength).toBe(FIXTURE.length);
	expect(seen.at(-1)!.nextLength).toBe(FIXTURE.length + 5);
	for (const entry of seen) assertPortableSpan(entry);
	for (let index = 1; index < seen.length; index++) {
		expect(seen[index]!.previousLength).toBe(seen[index - 1]!.nextLength);
	}
	expect(seen.reduce((sum, entry) => sum + (entry.nextTo - entry.nextFrom), 0)).toBe(5);
	expect(saved).toBe(`${FIXTURE}abcde`);
	await attach(testInfo, 'source-burst.json', { records: seen, savedLength: saved.length });
});

test('a structural source change reports an exact portable-source record', async ({
	page
}, testInfo) => {
	await resetAppState(page);
	await createFirstFile(page);
	await writeSourceContent(page, FIXTURE);
	await clearRecords(page);

	const source = page.locator('.cm-content').first();
	await source.click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.press('Enter');
	await page.keyboard.insertText('next');

	const record = await waitForRecord(
		page,
		(entry) =>
			entry.space === 'portable-source' &&
			entry.nextLength === FIXTURE.length + 5 &&
			entry.previousLength === FIXTURE.length
	);
	assertPortableSpan(record);
	expect(record.nextTo - record.nextFrom).toBe(5);
	const saved = await savedContent(page, FIXTURE.length + 5);
	expect(saved).toBe(`${FIXTURE}\nnext`);
	await attach(testInfo, 'source-structural.json', { record, savedLength: saved.length });
});

test('a rendered edit reports a valid record in its own space', async ({ page }, testInfo) => {
	test.setTimeout(120_000);
	await resetAppState(page);
	await createFirstFile(page);
	await writeSourceContent(page, FIXTURE);

	await page.locator('button[data-mode="wysiwyg"]').click();
	const visual = page.locator('.ProseMirror');
	await expect(visual).toContainText('Tail sentinel.', { timeout: 30_000 });

	// A mount boundary can publish its own revision. Start the measurement after
	// the rendered editor is stable.
	await page.waitForTimeout(1_200);
	await clearRecords(page);
	await visual.click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.insertText('Q');

	const record = await waitForRecord(page, (entry) => entry.space === 'editor-markdown');
	expect(['insert', 'replace', 'full']).toContain(record.kind);
	expect(record.previousFrom).toBeGreaterThanOrEqual(0);
	expect(record.previousTo).toBeGreaterThanOrEqual(record.previousFrom);
	expect(record.nextFrom).toBeGreaterThanOrEqual(0);
	expect(record.nextTo).toBeGreaterThanOrEqual(record.nextFrom);

	const saved = await (async () => {
		await expect
			.poll(async () => (await draft(page).catch(() => null))?.content.length ?? -1)
			.toBeGreaterThan(FIXTURE.length);
		return draft(page);
	})();
	expect(saved.content.includes('Q')).toBe(true);
	await attach(testInfo, 'rendered-edit.json', {
		record,
		kind: record.kind,
		savedLength: saved.content.length
	});
});

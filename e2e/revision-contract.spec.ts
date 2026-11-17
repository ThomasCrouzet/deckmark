import { createHash } from 'node:crypto';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createFirstFile, resetAppState, writeSourceContent } from './helpers';

// Issue #345 defines one accepted source revision record. Every consumer must be
// able to use the exact changed spans, or see an explicit reason why it needs a
// full snapshot. The instrumented build exposes the records as
// `window.__MDSH_REVISION_CONTRACT__`.
//
// The assertions below check the contract, not a latency budget:
// - exact spans reconstruct the published source without a new full diff;
// - a coalesced source burst stays exact;
// - a rendered edit never reports spans that do not reconstruct its source;
// - the durable bytes equal the accepted revision.

const PARAGRAPH =
	'Paragraph with **bold** words, a [link](https://example.com/target), and `inline code`.\n';
const SENTINEL = 'Tail sentinel.\n';
const FIXTURE =
	'# Revision contract\n\nOpening **bold** text with a [link](https://example.com) and `code`.\n\n' +
	PARAGRAPH.repeat(1800) +
	'\n' +
	SENTINEL;

type SpanReason =
	'text-only' | 'structured-edit' | 'span-count-limit' | 'span-byte-limit' | 'compose-failed';

interface ContractRecord {
	fileId: string;
	baseGeneration: number;
	generation: number;
	kind: 'text' | 'codemirror' | 'prosemirror' | 'structured';
	baseLength: number;
	textLength: number;
	spanCount: number | null;
	spanBytes: number | null;
	inserted: number | null;
	reason: SpanReason | null;
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

function assertExact(record: ContractRecord): void {
	expect(record.reason, JSON.stringify(record)).toBeNull();
	expect(record.exact, JSON.stringify(record)).toBe(true);
	expect(record.spanCount).toBeGreaterThan(0);
	expect(record.spanBytes).toBeLessThan(record.baseLength);
	expect(record.inserted).toBeGreaterThan(0);
	expect(record.textLength).toBeGreaterThan(0);
}

async function attach(
	testInfo: TestInfo,
	name: string,
	payload: Record<string, unknown>
): Promise<void> {
	await testInfo.attach(name, {
		body: JSON.stringify(payload, null, 2),
		contentType: 'application/json'
	});
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

test('a source edit publishes one exact revision record', async ({ page }, testInfo) => {
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
		(entry) => entry.textLength === FIXTURE.length + 1 && entry.baseLength === FIXTURE.length
	);
	assertExact(record);
	expect(record.kind).toBe('codemirror');
	expect(record.spanCount).toBe(1);
	expect(record.inserted).toBe(1);
	expect(record.generation).toBeGreaterThan(record.baseGeneration);

	const saved = await savedContent(page, FIXTURE.length + 1);
	expect(saved).toBe(`${FIXTURE}Z`);
	await attach(testInfo, 'source-single-edit.json', { record, savedLength: saved.length });
});

test('a coalesced source burst keeps one exact record', async ({ page }, testInfo) => {
	await resetAppState(page);
	await createFirstFile(page);
	await writeSourceContent(page, FIXTURE);
	await clearRecords(page);

	const source = page.locator('.cm-content').first();
	await source.click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.type('abcde', { delay: 15 });

	const record = await waitForRecord(
		page,
		(entry) => entry.textLength === FIXTURE.length + 5 && entry.baseLength === FIXTURE.length
	);
	assertExact(record);
	const seen = await records(page);
	expect(seen.length).toBeGreaterThan(0);
	for (const entry of seen) assertExact(entry);
	expect(seen.reduce((sum, entry) => sum + (entry.inserted ?? 0), 0)).toBe(5);

	const saved = await savedContent(page, FIXTURE.length + 5);
	expect(saved).toBe(`${FIXTURE}abcde`);
	await attach(testInfo, 'source-burst.json', { record, records: seen, savedLength: saved.length });
});

test('a structural source change reports exact spans', async ({ page }, testInfo) => {
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
		(entry) => entry.textLength === FIXTURE.length + 5 && entry.baseLength === FIXTURE.length
	);
	assertExact(record);
	const saved = await savedContent(page, FIXTURE.length + 5);
	expect(saved).toBe(`${FIXTURE}\nnext`);
	await attach(testInfo, 'source-structural.json', { record, savedLength: saved.length });
});

test('a rendered edit reports exact spans or an explicit reason', async ({ page }, testInfo) => {
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

	const record = await waitForRecord(
		page,
		(entry) => entry.kind === 'text' && entry.textLength > FIXTURE.length
	);
	if (record.reason === null) assertExact(record);
	else {
		expect([
			'text-only',
			'structured-edit',
			'span-count-limit',
			'span-byte-limit',
			'compose-failed'
		]).toContain(record.reason);
		expect(record.exact).toBeNull();
	}
	const saved = await draft(page);
	expect(saved.content.endsWith('Q')).toBe(true);
	await attach(testInfo, 'rendered-edit.json', {
		record,
		reason: record.reason,
		savedLength: saved.content.length
	});
});

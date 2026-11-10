import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { resetAppState } from './helpers';
import { databaseState, importBackup } from './storage-evidence';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

const sentinelBody = 'SENTINEL_DOCUMENT_BODY_4c1f';
const sentinelName = 'SENTINEL_FILE_NAME_77a2.md';
const sessionValue = 'sentinel_session_value_5b8d';

interface DiagnosticsProbe {
	deferredBefore: number;
	deferredAfter: number;
	residentCharsBefore: number;
	residentCharsAfter: number;
	scanned: number;
	documents: number;
	complete: boolean;
	elapsedMs: number;
}

async function setEnglish(page: Page): Promise<void> {
	await page.evaluate(() => localStorage.setItem('mdsh:locale', 'en'));
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
}

async function openEnglish(page: Page): Promise<void> {
	await resetAppState(page);
	await setEnglish(page);
}

function closeNote(index: number) {
	return {
		id: `diagnostics-${index}`,
		name: `Diagnostics ${index}.md`,
		content: `# Diagnostics ${index}\n\n${'body line for the diagnostics scan\n'.repeat(
			index === 12 ? 40_000 : index === 13 ? 200_000 : 12_000
		)}`,
		createdAt: 1_700_000_000_000,
		updatedAt: 1_700_000_000_000,
		order: index,
		open: index === 0,
		kind: 'note' as const
	};
}

function expectedStats(rows: ReturnType<typeof closeNote>[]) {
	let totalBytes = 0;
	let totalLines = 0;
	for (const row of rows) {
		totalBytes += Buffer.byteLength(row.content, 'utf8');
		totalLines += row.content.length === 0 ? 0 : row.content.split('\n').length;
	}
	return { documents: rows.length, totalBytes, totalLines, kinds: { note: rows.length } };
}

async function openDiagnostics(page: Page): Promise<void> {
	await page.keyboard.press('ControlOrMeta+Shift+p');
	await page.getByRole('combobox').fill('Report a problem');
	await page.keyboard.press('Enter');
	await expect(page.getByTestId('diagnostics-section')).toBeVisible();
	await expect(page.getByTestId('diagnostics-description')).toBeVisible();
}

test('builds, previews and downloads an identical secret-safe report', async ({ page }, info) => {
	await openEnglish(page);
	await page.locator('input[type="file"][accept*="text/markdown"]').setInputFiles({
		name: sentinelName,
		mimeType: 'text/markdown',
		buffer: Buffer.from(`# ${sentinelBody}\n\n${sentinelBody}\n`)
	});
	await expect(page.locator('.cm-content')).toContainText(sentinelBody);
	await page.evaluate((key) => sessionStorage.setItem('mdsh:ai-key', key), sessionValue);
	await openDiagnostics(page);
	await page.getByTestId('diagnostics-description').fill('The export button did nothing.');
	await page.getByTestId('diagnostics-include-stats').check();

	const requests: string[] = [];
	page.on('request', (request) => requests.push(request.url()));
	await page.getByTestId('diagnostics-build').click();
	const preview = page.getByTestId('diagnostics-preview');
	await expect(preview).toBeVisible({ timeout: 10_000 });
	const text = (await preview.textContent()) ?? '';
	expect(text).toContain('deckmark-diagnostics');
	expect(text).toContain('"documents": 1');
	expect(text).not.toContain(sentinelBody);
	expect(text).not.toContain(sentinelName);
	expect(text).not.toContain('SENTINEL_FILE_NAME_77a2');
	expect(text).not.toContain(sessionValue);
	expect(requests).toEqual([]);

	const [download] = await Promise.all([
		page.waitForEvent('download'),
		page.getByTestId('diagnostics-download').click()
	]);
	const path = await download.path();
	expect(path).toBeTruthy();
	const downloaded = await readFile(path!, 'utf8');
	expect(downloaded).toBe(text);
	expect(downloaded).not.toContain(sessionValue);

	await info.attach('diagnostics-preview.json', { body: text, contentType: 'application/json' });
	await info.attach('diagnostics-downloaded.json', {
		body: downloaded,
		contentType: 'application/json'
	});
});

test('cancel leaves no report and no download', async ({ page }) => {
	await openEnglish(page);
	await openDiagnostics(page);
	await page.getByTestId('diagnostics-description').fill('Temporary description');
	await page.getByTestId('diagnostics-build').click();
	await expect(page.getByTestId('diagnostics-preview')).toBeVisible();
	await page.getByTestId('diagnostics-cancel').click();
	await expect(page.getByTestId('diagnostics-preview')).toHaveCount(0);
	await expect(page.getByTestId('diagnostics-open')).toBeVisible();
});

test('counts deferred document statistics without hydrating closed bodies', async ({
	page
}, info) => {
	test.setTimeout(120_000);
	await resetAppState(page);
	const rows = Array.from({ length: 14 }, (_, index) => closeNote(index));
	await importBackup(page, {
		format: 'mdsh-backup',
		schemaVersion: 1,
		exportedAt: 1_700_000_000_000,
		drafts: rows,
		workspaces: [],
		templates: []
	});
	await expect.poll(async () => (await databaseState(page)).drafts.length).toBe(rows.length);
	await page.keyboard.press('Escape');
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor({
		state: 'visible',
		timeout: 15_000
	});
	await setEnglish(page);
	await openDiagnostics(page);
	await page.getByTestId('diagnostics-include-stats').check();
	await page.getByTestId('diagnostics-build').click();
	const preview = page.getByTestId('diagnostics-preview');
	await expect(preview).toBeVisible({ timeout: 90_000 });
	const text = (await preview.textContent()) ?? '';
	const report = JSON.parse(text) as {
		documentStats: {
			documents: number;
			totalBytes: number;
			totalLines: number;
			kinds: Record<string, number>;
			complete: boolean;
		};
	};
	expect(report.documentStats).toMatchObject(expectedStats(rows));
	expect(report.documentStats.complete).toBe(true);
	expect(text).not.toContain('body line for the diagnostics scan');
	expect(text).not.toContain('Diagnostics 0.md');

	const probe = await page.evaluate(
		() =>
			(window as unknown as { __MDSH_DIAGNOSTICS__?: DiagnosticsProbe }).__MDSH_DIAGNOSTICS__ ??
			null
	);
	expect(probe).not.toBeNull();
	expect(probe!.deferredBefore).toBeGreaterThan(0);
	expect(probe!.deferredAfter).toBe(probe!.deferredBefore);
	expect(probe!.residentCharsAfter).toBe(probe!.residentCharsBefore);
	expect(probe!.scanned).toBe(rows.length);

	await info.attach('diagnostics-library-scan.json', {
		body: JSON.stringify(
			{
				fixture: {
					documents: rows.length,
					bytes: report.documentStats.totalBytes,
					lines: report.documentStats.totalLines
				},
				probe,
				expected: expectedStats(rows)
			},
			null,
			2
		),
		contentType: 'application/json'
	});
});

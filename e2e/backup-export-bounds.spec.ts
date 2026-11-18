import { expect, test, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { resetAppState } from './helpers';

// Bounded backup and export evidence.
//
// The profile seeds a supported corpus directly in IndexedDB, runs a real
// manual backup from the Settings dialog, and records:
// - the backup pipeline counters from the instrumented build,
// - the longest main-thread task during the operation,
// - typing and navigation while the operation runs,
// - cancellation before any output is published,
// - cancellation of a library ZIP and a documentation site ZIP.
//
// It does not prove native WebView, physical memory pressure or installed PWA
// behavior. See docs/TESTING.md.

test.use({ serviceWorkers: 'block' });

const MIB = 1024 * 1024;
const CORPUS_MIB = Number(process.env.MDSH_BACKUP_CORPUS_MIB ?? '16');

interface CorpusPlan {
	textMiB: number;
	rows: number;
	assets: number;
	assetBytes: number;
	projectDocuments: number;
	/** Flat open-file rows, outside the project tree. */
	openFiles: number;
}

interface SeededCorpus {
	rows: number;
	assets: number;
	assetBytes: number;
	projectId: string;
	markerDraftId: string;
}

async function seedCorpus(page: Page, plan: CorpusPlan): Promise<SeededCorpus> {
	return page.evaluate(async (spec) => {
		const connection = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open('mdsh');
			request.onerror = () => reject(request.error);
			request.onsuccess = () => resolve(request.result);
		});
		const stores = [
			'drafts',
			'projects',
			'projectAssets',
			'snippets',
			'comments',
			'workspaces',
			'templates'
		];
		const now = Date.now();
		const projectId = 'corpus-project';
		const chars = Math.round(spec.textMiB * 1024 * 1024);
		const perRow = Math.floor(chars / spec.rows);
		const filler = (seed: number) => {
			let state = (seed * 2654435761) >>> 0;
			const parts: string[] = [];
			for (let index = 0; index < perRow; index += 64) {
				const line: string[] = [];
				for (let offset = 0; offset < 64 && index + offset < perRow; offset++) {
					state = (state * 1664525 + 1013904223) >>> 0;
					line.push(String.fromCharCode(97 + (state % 26)));
				}
				parts.push(line.join(''));
			}
			return parts.join('\n');
		};
		const transaction = connection.transaction(stores, 'readwrite');
		const store = (name: string) => transaction.objectStore(name);
		for (let index = 0; index < spec.rows; index++) {
			const projectScoped = index < spec.projectDocuments;
			store('drafts').put({
				id: `corpus-${index}`,
				name: `Corpus ${index}.md`,
				content: `# Corpus ${index}\n\n${filler(index + 1)}`,
				...(projectScoped
					? { projectId, relativePath: `notes/corpus-${index}.md` }
					: { origin: 'created' as const }),
				createdAt: now,
				updatedAt: now,
				order: index,
				// The last two non-project rows stay open. Project documents appear
				// in the project tree, so the flat open-file list must not contain
				// them for the selection workflow.
				open: index >= spec.rows - spec.openFiles && index >= spec.projectDocuments
			});
		}
		store('projects').put({
			id: projectId,
			name: 'Corpus project',
			createdAt: now,
			updatedAt: now
		});
		for (let index = 0; index < spec.assets; index++) {
			const data = new Uint8Array(spec.assetBytes);
			for (let offset = 0; offset < data.length; offset++) data[offset] = (offset + index) % 251;
			store('projectAssets').put({
				id: `asset-${index}`,
				projectId,
				path: `assets/asset-${index}.bin`,
				mime: 'application/octet-stream',
				data
			});
		}
		for (let index = 0; index < 3; index++) {
			store('snippets').put({
				id: `snippet-${index}`,
				title: `Snippet ${index}`,
				code: `console.log(${index});\n${'// bounded snippet\n'.repeat(256)}`,
				language: 'plain',
				tags: ['corpus'],
				favorite: index === 0,
				createdAt: now,
				updatedAt: now
			});
		}
		store('templates').put({
			id: 'template-corpus',
			name: 'Corpus template',
			content: `# Template\n\n${'template line\n'.repeat(512)}`,
			builtin: false,
			createdAt: now,
			updatedAt: now
		});
		for (let index = 0; index < 5; index++) {
			store('comments').put({
				id: `comment-${index}`,
				draftId: 'corpus-0',
				quote: 'Corpus',
				from: 0,
				to: 6,
				body: `Comment ${index}`,
				author: 'Reviewer',
				status: index % 2 === 0 ? 'open' : 'resolved',
				createdAt: now,
				updatedAt: now
			});
		}
		store('workspaces').put({
			id: 'workspace-corpus',
			name: 'Corpus workspace',
			fileIds: ['corpus-0', 'corpus-1'],
			activeId: 'corpus-0',
			createdAt: now,
			updatedAt: now
		});
		await new Promise<void>((resolve, reject) => {
			transaction.oncomplete = () => resolve();
			transaction.onerror = () => reject(transaction.error);
			transaction.onabort = () => reject(transaction.error);
		});
		connection.close();
		return {
			rows: spec.rows,
			assets: spec.assets,
			assetBytes: spec.assetBytes,
			projectId,
			markerDraftId: 'corpus-0'
		};
	}, plan);
}

async function waitForReady(page: Page) {
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor({
		state: 'visible',
		timeout: 30_000
	});
	// The projection backfill writes derived keys after boot. Let it finish so
	// its work cannot be counted as export work.
	await page.waitForTimeout(1000);
}

async function openSettings(page: Page) {
	await page.keyboard.press('ControlOrMeta+,');
	await expect(page.getByRole('dialog', { name: 'Réglages' })).toBeVisible();
}

function spinner(page: Page) {
	return page.locator('[role="status"]').filter({ has: page.locator('.spinner') });
}

async function startPlainBackup(page: Page): Promise<void> {
	await openSettings(page);
	await page.getByRole('button', { name: 'Exporter une sauvegarde', exact: true }).click();
}

interface PipelineRun {
	kind: string;
	completed: boolean;
	cancelled: boolean;
	batches: number;
	yields: number;
	rows: number;
	maxBatchRows: number;
	maxLiveAssetBytes: number;
	serializedChars: number;
	maxChunkChars: number;
	joinedCopyChars: number;
	maxPercent: number;
	progressEvents: number;
	timings: Record<string, number>;
}

async function pipelineRuns(page: Page): Promise<PipelineRun[]> {
	return page.evaluate(() => {
		const probe = (
			window as unknown as {
				__MDSH_EXPORT_PIPELINE__?: { runs(): PipelineRun[] };
			}
		).__MDSH_EXPORT_PIPELINE__;
		return probe ? probe.runs() : [];
	});
}

interface ExportProfile {
	kind: string;
	phase: string;
	duration: number;
}

async function exportProfiles(page: Page): Promise<ExportProfile[]> {
	return page.evaluate(() =>
		performance.getEntriesByName('mdsh:export-profile', 'measure').map((entry) => {
			const detail = (entry as PerformanceEntry & { detail?: Record<string, unknown> }).detail;
			return {
				kind: String(detail?.kind ?? ''),
				phase: String(detail?.phase ?? ''),
				duration: entry.duration
			};
		})
	);
}

async function installLongTaskProbe(page: Page): Promise<void> {
	await page.evaluate(() => {
		const host = window as unknown as {
			__MDSH_LONG_TASKS__?: number[];
			__MDSH_LONG_TASK_OBSERVER__?: PerformanceObserver;
		};
		host.__MDSH_LONG_TASK_OBSERVER__?.disconnect();
		host.__MDSH_LONG_TASKS__ = [];
		const observer = new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) host.__MDSH_LONG_TASKS__!.push(entry.duration);
		});
		observer.observe({ type: 'longtask', buffered: false });
		host.__MDSH_LONG_TASK_OBSERVER__ = observer;
	});
}

async function longTasks(page: Page): Promise<number[]> {
	return page.evaluate(
		() => (window as unknown as { __MDSH_LONG_TASKS__?: number[] }).__MDSH_LONG_TASKS__ ?? []
	);
}

async function setPipelineDelay(page: Page, milliseconds: number): Promise<void> {
	await page.evaluate((value) => {
		(
			window as unknown as { __MDSH_EXPORT_PIPELINE_DELAY_MS__?: number }
		).__MDSH_EXPORT_PIPELINE_DELAY_MS__ = value;
	}, milliseconds);
}

async function readDownload(download: import('@playwright/test').Download): Promise<Buffer> {
	const stream = await download.createReadStream();
	const chunks: Buffer[] = [];
	for await (const chunk of stream!) chunks.push(chunk);
	return Buffer.concat(chunks);
}

test('bounds backup collection and encoding while typing stays usable', async ({ page }, info) => {
	test.setTimeout(180_000);
	await resetAppState(page);
	const plan: CorpusPlan = {
		textMiB: CORPUS_MIB,
		rows: 120,
		assets: 4,
		assetBytes: 384 * 1024,
		projectDocuments: 3,
		openFiles: 2
	};
	const corpus = await seedCorpus(page, plan);
	await page.reload();
	await waitForReady(page);
	await expect(page.locator('.cm-content').first()).toBeVisible({ timeout: 20_000 });

	// A long operation must still yield between bounded batches. The delay
	// makes the yield points observable without changing product behavior.
	await setPipelineDelay(page, 40);
	await installLongTaskProbe(page);

	const pendingDownload = page.waitForEvent('download', { timeout: 120_000 });
	await startPlainBackup(page);
	await expect(spinner(page)).toBeVisible({ timeout: 10_000 });
	await page.keyboard.press('Escape');

	// Typing and navigation continue while the export runs.
	const typingStarted = Date.now();
	await page.locator('.cm-content').first().click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.type('\n\nThe editor stayed usable during the export.');
	await expect(page.locator('.cm-content').first()).toContainText(
		'The editor stayed usable during the export.'
	);
	const typingElapsedMs = Date.now() - typingStarted;

	const download = await pendingDownload;
	const buffer = await readDownload(download);
	await expect(spinner(page)).toHaveCount(0, { timeout: 30_000 });
	await expect(
		page.getByRole('status').filter({ hasText: 'Sauvegarde exportée.' }).last()
	).toBeVisible();

	const tasks = await longTasks(page);
	const runs = await pipelineRuns(page);
	const run = runs.find((candidate) => candidate.kind === 'backup');
	expect(run, 'the instrumented backup pipeline must publish its counters').toBeTruthy();

	const parsed = JSON.parse(buffer.toString('utf8')) as {
		format: string;
		drafts: Array<{ id: string; content: string }>;
		projectAssets: Array<{ id: string; data: string }>;
		snippets?: unknown[];
		comments?: unknown[];
	};
	expect(parsed.format).toBe('mdsh-backup');
	expect(parsed.drafts).toHaveLength(corpus.rows);
	expect(parsed.projectAssets).toHaveLength(corpus.assets);
	expect(parsed.snippets).toHaveLength(3);
	expect(parsed.comments).toHaveLength(5);
	// Exact binary bytes survive the conversion.
	const firstAsset = parsed.projectAssets[0]!;
	const decoded = Buffer.from(firstAsset.data, 'base64');
	expect(decoded).toHaveLength(corpus.assetBytes);
	for (const offset of [0, 1, 250, 4095, corpus.assetBytes - 1]) {
		expect(decoded[offset]).toBe(offset % 251);
	}

	// The serialized text is produced once. Its characters equal the exact
	// downloaded bytes because the corpus is ASCII.
	expect(run!.serializedChars).toBe(buffer.byteLength);
	expect(run!.joinedCopyChars).toBe(0);
	expect(run!.completed).toBe(true);
	expect(run!.cancelled).toBe(false);
	// Bounded batches and one raw asset row at a time.
	expect(run!.batches).toBeGreaterThan(4);
	expect(run!.maxBatchRows).toBeLessThanOrEqual(32);
	expect(run!.maxLiveAssetBytes).toBeLessThanOrEqual(corpus.assetBytes);
	expect(run!.maxChunkChars).toBeLessThanOrEqual(2 * MIB);
	expect(run!.yields).toBeGreaterThanOrEqual(3);
	expect(run!.maxPercent).toBe(100);
	expect(run!.progressEvents).toBeGreaterThan(4);
	// One bounded task per batch or item. The budget is documented in
	// docs/TESTING.md and excludes the Playwright process itself.
	expect(Math.max(0, ...tasks)).toBeLessThanOrEqual(250);
	expect(typingElapsedMs).toBeLessThan(5000);

	const metricsPath = info.outputPath('backup-export-bounds.json');
	await writeFile(
		metricsPath,
		JSON.stringify(
			{
				command:
					'npx playwright test e2e/backup-export-bounds.spec.ts --project=chromium --workers=1 --retries=0',
				corpusMiB: CORPUS_MIB,
				corpus,
				downloadBytes: buffer.byteLength,
				typingElapsedMs,
				longTasks: tasks,
				run
			},
			null,
			2
		)
	);
	await info.attach('backup-export-bounds.json', {
		path: metricsPath,
		contentType: 'application/json'
	});
	const path = info.outputPath('corpus-backup.json');
	await download.saveAs(path);
	await info.attach('corpus-backup.json', { path, contentType: 'application/json' });
});

test('a corpus over the backup limit publishes no file and reports failure', async ({
	page
}, info) => {
	test.setTimeout(300_000);
	await resetAppState(page);
	// 64 MiB of text exceeds the 64 MiB backup text limit after the JSON and
	// line-ending escaping. The operation must fail before any output.
	const corpus = await seedCorpus(page, {
		textMiB: 64,
		rows: 120,
		assets: 0,
		assetBytes: 0,
		projectDocuments: 0,
		openFiles: 1
	});
	await page.reload();
	await waitForReady(page);
	await expect(page.locator('.cm-content').first()).toBeVisible({ timeout: 20_000 });

	let downloads = 0;
	page.on('download', () => downloads++);
	await startPlainBackup(page);
	await expect(
		page.getByRole('alert').filter({ hasText: "L'export de la sauvegarde a échoué." }).last()
	).toBeVisible({ timeout: 240_000 });
	await expect(page.getByText('Sauvegarde exportée.')).toHaveCount(0);
	await page.waitForTimeout(1_000);
	expect(downloads, 'a backup over the limit must publish no file').toBe(0);

	const runs = await pipelineRuns(page);
	const completed = runs.filter((candidate) => candidate.kind === 'backup' && candidate.completed);
	expect(completed, 'a rejected corpus must not report a completed backup run').toHaveLength(0);

	const limitPath = info.outputPath('backup-limit.json');
	await writeFile(
		limitPath,
		JSON.stringify(
			{
				corpusMiB: 64,
				corpus,
				downloads,
				completedRuns: completed.length,
				runs: runs.filter((candidate) => candidate.kind === 'backup')
			},
			null,
			2
		)
	);
	await info.attach('backup-limit.json', { path: limitPath, contentType: 'application/json' });
});

test('cancellation publishes no backup and preserves the corpus', async ({ page }, info) => {
	test.setTimeout(180_000);
	await resetAppState(page);
	const corpus = await seedCorpus(page, {
		textMiB: Math.min(CORPUS_MIB, 8),
		rows: 60,
		assets: 3,
		assetBytes: 256 * 1024,
		projectDocuments: 2,
		openFiles: 2
	});
	await page.reload();
	await waitForReady(page);
	await expect(page.locator('.cm-content').first()).toBeVisible({ timeout: 20_000 });

	await setPipelineDelay(page, 80);
	let downloads = 0;
	page.on('download', () => downloads++);
	await startPlainBackup(page);
	await expect(spinner(page)).toBeVisible({ timeout: 10_000 });
	await page.getByRole('button', { name: 'Annuler l’export' }).click();
	await expect(spinner(page)).toHaveCount(0, { timeout: 10_000 });
	await page.waitForTimeout(1500);
	expect(downloads).toBe(0);
	await expect(page.getByText('Sauvegarde exportée.')).toHaveCount(0);
	await expect(page.getByText("L'export de la sauvegarde a échoué.")).toHaveCount(0);

	const runs = await pipelineRuns(page);
	const cancelled = runs.filter((candidate) => candidate.kind === 'backup').at(-1);
	expect(cancelled?.cancelled).toBe(true);
	expect(cancelled?.completed).toBe(false);

	// The corpus is unchanged and a second export succeeds.
	await page.keyboard.press('Escape');
	await setPipelineDelay(page, 0);
	await installLongTaskProbe(page);
	const pendingDownload = page.waitForEvent('download', { timeout: 120_000 });
	await startPlainBackup(page);
	const buffer = await readDownload(await pendingDownload);
	const parsed = JSON.parse(buffer.toString('utf8')) as {
		drafts: Array<{ id: string }>;
		projectAssets: Array<{ id: string }>;
	};
	expect(parsed.drafts).toHaveLength(corpus.rows);
	expect(parsed.projectAssets).toHaveLength(corpus.assets);
	expect(downloads).toBe(1);

	const cancellationPath = info.outputPath('backup-cancellation.json');
	await writeFile(
		cancellationPath,
		JSON.stringify(
			{
				corpusMiB: Math.min(CORPUS_MIB, 8),
				corpus,
				downloads,
				cancelled,
				tasks: await longTasks(page)
			},
			null,
			2
		)
	);
	await info.attach('backup-cancellation.json', {
		path: cancellationPath,
		contentType: 'application/json'
	});
});

test('library ZIP cancellation publishes no archive', async ({ page }, info) => {
	test.setTimeout(120_000);
	await resetAppState(page);
	const corpus = await seedCorpus(page, {
		textMiB: 8,
		rows: 40,
		assets: 2,
		assetBytes: 256 * 1024,
		projectDocuments: 2,
		openFiles: 8
	});
	await page.reload();
	await waitForReady(page);
	await setPipelineDelay(page, 200);
	let downloads = 0;
	page.on('download', () => downloads++);

	const openRows = page.locator('aside .mdsh-file-row button[data-file-id]');
	await expect(openRows).toHaveCount(8);
	for (let index = 0; index < 8; index++) {
		await openRows.nth(index).click({ modifiers: ['Control'] });
	}
	await expect(page.locator('aside [aria-label="Actions sur la sélection"]')).toBeVisible();
	await page
		.locator('aside [aria-label="Actions sur la sélection"]')
		.getByRole('button', { name: /ZIP/ })
		.click();
	await expect(spinner(page)).toBeVisible({ timeout: 10_000 });
	await page.getByRole('button', { name: 'Annuler l’export' }).click();
	await expect(spinner(page)).toHaveCount(0, { timeout: 10_000 });
	await page.waitForTimeout(1500);
	expect(downloads).toBe(0);

	await setPipelineDelay(page, 0);
	const zipPath = info.outputPath('selection.zip');
	const retriedDownload = page.waitForEvent('download', { timeout: 120_000 });
	await page
		.locator('aside [aria-label="Actions sur la sélection"]')
		.getByRole('button', { name: /ZIP/ })
		.click();
	const download = await retriedDownload;
	await download.saveAs(zipPath);
	expect(downloads).toBe(1);
	const stream = await download.createReadStream();
	const chunks: Buffer[] = [];
	for await (const chunk of stream!) chunks.push(chunk);
	const buffer = Buffer.concat(chunks);
	expect(buffer.subarray(0, 2).toString('latin1')).toBe('PK');

	const zipMetricsPath = info.outputPath('library-zip-cancellation.json');
	await writeFile(
		zipMetricsPath,
		JSON.stringify({ corpus, downloads, bytes: buffer.byteLength }, null, 2)
	);
	await info.attach('library-zip-cancellation.json', {
		path: zipMetricsPath,
		contentType: 'application/json'
	});
	await info.attach('selection.zip', { path: zipPath, contentType: 'application/zip' });
});

test('JSON and encrypted backups profile collection, encoding and encryption', async ({
	page
}, info) => {
	test.setTimeout(240_000);
	await resetAppState(page);
	const corpus = await seedCorpus(page, {
		textMiB: 8,
		rows: 60,
		assets: 3,
		assetBytes: 256 * 1024,
		projectDocuments: 2,
		openFiles: 2
	});
	await page.reload();
	await waitForReady(page);
	await expect(page.locator('.cm-content').first()).toBeVisible({ timeout: 20_000 });
	await installLongTaskProbe(page);

	const plainPending = page.waitForEvent('download', { timeout: 180_000 });
	await openSettings(page);
	await page.getByRole('button', { name: 'Exporter une sauvegarde', exact: true }).click();
	const plainBytes = await readDownload(await plainPending);
	expect((JSON.parse(plainBytes.toString('utf8')) as { format?: string }).format).toBe(
		'mdsh-backup'
	);
	const plainRun = (await pipelineRuns(page)).filter((run) => run.kind === 'backup').at(-1);
	expect(plainRun, 'the plain backup must publish its pipeline counters').toBeTruthy();
	expect(plainRun!.completed).toBe(true);
	expect(plainRun!.timings.collect ?? 0, 'plain collection time must be separate').toBeGreaterThan(
		0
	);
	expect(plainRun!.timings.encode ?? 0, 'plain encoding time must be separate').toBeGreaterThan(0);
	expect(plainRun!.timings.encrypt, 'the plain path must not report encryption').toBeUndefined();
	expect(plainRun!.joinedCopyChars, 'the plain path must not join a second copy').toBe(0);

	const passphrase = 'bounded-export-profile';
	const pendingDownload = page.waitForEvent('download', { timeout: 180_000 });
	await page.getByRole('button', { name: 'Exporter (chiffré)…', exact: true }).click();
	for (const name of ['Chiffrer la sauvegarde', 'Confirmer la phrase secrète']) {
		const prompt = page.getByRole('dialog', { name, exact: true });
		await prompt.locator('input[type=password]').fill(passphrase);
		await prompt.getByRole('button', { name: 'OK', exact: true }).click();
	}
	const download = await pendingDownload;
	const buffer = await readDownload(download);
	await page.keyboard.press('Escape');

	const envelope = JSON.parse(buffer.toString('utf8')) as {
		alg?: string;
		kdf?: string;
		ct?: string;
	};
	expect(envelope.alg).toBe('AES-GCM');
	expect(envelope.kdf).toBe('PBKDF2-SHA256');
	expect((envelope.ct ?? '').length).toBeGreaterThan(0);

	const encryptedRun = (await pipelineRuns(page)).filter((run) => run.kind === 'backup').at(-1);
	expect(encryptedRun, 'the encrypted backup must publish its pipeline counters').toBeTruthy();
	expect(encryptedRun!.completed).toBe(true);
	expect(encryptedRun!.timings.collect ?? 0, 'collection time must be separate').toBeGreaterThan(0);
	expect(encryptedRun!.timings.encode ?? 0, 'encoding time must be separate').toBeGreaterThan(0);
	expect(encryptedRun!.timings.encrypt ?? 0, 'encryption time must be separate').toBeGreaterThan(0);
	expect(
		encryptedRun!.joinedCopyChars,
		'AES-GCM must count its contiguous plaintext copy'
	).toBeGreaterThan(0);
	expect(encryptedRun!.serializedChars).toBeGreaterThan(0);
	const tasks = await longTasks(page);

	const profilePath = info.outputPath('encrypted-backup-profile.json');
	await writeFile(
		profilePath,
		JSON.stringify(
			{
				command:
					'npx playwright test e2e/backup-export-bounds.spec.ts --project=chromium --workers=1 --retries=0 --grep encrypted',
				corpus,
				plainDownloadBytes: plainBytes.byteLength,
				encryptedDownloadBytes: buffer.byteLength,
				envelope: {
					alg: envelope.alg,
					kdf: envelope.kdf,
					ciphertextChars: envelope.ct?.length ?? 0
				},
				plainRun,
				encryptedRun,
				longTasks: tasks
			},
			null,
			2
		)
	);
	await info.attach('encrypted-backup-profile.json', {
		path: profilePath,
		contentType: 'application/json'
	});
});

test('archive phase profiles separate planning and rendering from compression', async ({
	page
}, info) => {
	test.setTimeout(300_000);
	await resetAppState(page);
	const corpus = await seedCorpus(page, {
		textMiB: 8,
		rows: 40,
		assets: 3,
		assetBytes: 256 * 1024,
		projectDocuments: 3,
		openFiles: 6
	});
	await page.reload();
	await waitForReady(page);
	await expect(page.locator('.cm-content').first()).toBeVisible({ timeout: 20_000 });
	await installLongTaskProbe(page);

	const phases = (profiles: ExportProfile[], kind: string) =>
		profiles
			.filter((profile) => profile.kind === kind)
			.reduce<Record<string, number>>((totals, profile) => {
				totals[profile.phase] = (totals[profile.phase] ?? 0) + profile.duration;
				return totals;
			}, {});

	// Library ZIP: text entries and the outer archive.
	const openRows = page.locator('aside .mdsh-file-row button[data-file-id]');
	await expect(openRows).toHaveCount(6);
	for (let index = 0; index < 6; index++) {
		await openRows.nth(index).click({ modifiers: ['Control'] });
	}
	await expect(page.locator('aside [aria-label="Actions sur la sélection"]')).toBeVisible();
	const libraryDownload = page.waitForEvent('download', { timeout: 180_000 });
	await page
		.locator('aside [aria-label="Actions sur la sélection"]')
		.getByRole('button', { name: /ZIP/ })
		.click();
	const libraryBytes = await readDownload(await libraryDownload);
	expect(libraryBytes.subarray(0, 2).toString('latin1')).toBe('PK');
	const profiles = await exportProfiles(page);
	const libraryPhases = phases(profiles, 'library-zip');
	expect(libraryPhases.plan ?? 0, 'library planning time must be recorded').toBeGreaterThan(0);
	expect(libraryPhases.compress ?? 0, 'library compression time must be recorded').toBeGreaterThan(
		0
	);
	expect(libraryPhases.write ?? 0, 'library write time must be recorded').toBeGreaterThan(0);

	// Project ZIP: documents and binary assets.
	await page.getByTestId('projects-open').click();
	const projects = page.getByRole('dialog', { name: 'Projets Markdown' });
	await expect(projects).toBeVisible();
	await projects.locator('select').selectOption(corpus.projectId);
	const projectDownload = page.waitForEvent('download', { timeout: 180_000 });
	await projects.getByRole('button', { name: 'Exporter le projet' }).click();
	const projectBytes = await readDownload(await projectDownload);
	expect(projectBytes.subarray(0, 2).toString('latin1')).toBe('PK');
	const projectPhases = phases(await exportProfiles(page), 'project-zip');
	expect(projectPhases.plan ?? 0, 'project planning time must be recorded').toBeGreaterThan(0);
	expect(projectPhases.compress ?? 0, 'project compression time must be recorded').toBeGreaterThan(
		0
	);
	await page.keyboard.press('Escape');

	// Documentation site ZIP: planning and rendering before archive assembly.
	await page.getByTestId('projects-open').click();
	await expect(projects).toBeVisible();
	await projects.locator('select').selectOption(corpus.projectId);
	await projects.getByRole('button', { name: 'Exporter le site de documentation' }).click();
	const panel = page.getByTestId('docs-site-panel');
	await expect(panel.getByTestId('docs-site-run')).toBeVisible();
	const docsDownload = page.waitForEvent('download', { timeout: 180_000 });
	await panel.getByTestId('docs-site-run').click();
	const docsBytes = await readDownload(await docsDownload);
	expect(docsBytes.subarray(0, 2).toString('latin1')).toBe('PK');
	const docsProfiles = await exportProfiles(page);
	const docsPhases = phases(docsProfiles, 'docs-site');
	expect(docsPhases.plan ?? 0, 'docs-site planning time must be recorded').toBeGreaterThan(0);
	expect(docsPhases.render ?? 0, 'docs-site rendering time must be recorded').toBeGreaterThan(0);
	expect(docsPhases.write ?? 0, 'docs-site entry assembly time must be recorded').toBeGreaterThan(
		0
	);
	expect(docsPhases.compress ?? 0, 'docs-site compression time must be recorded').toBeGreaterThan(
		0
	);

	const tasks = await longTasks(page);
	const profilePath = info.outputPath('archive-phase-profiles.json');
	await writeFile(
		profilePath,
		JSON.stringify(
			{
				command:
					'npx playwright test e2e/backup-export-bounds.spec.ts --project=chromium --workers=1 --retries=0 --grep archive',
				corpus,
				libraryBytes: libraryBytes.byteLength,
				projectBytes: projectBytes.byteLength,
				docsSiteBytes: docsBytes.byteLength,
				phases: {
					library: libraryPhases,
					project: projectPhases,
					docsSite: docsPhases
				},
				profiles: profiles.filter(
					(profile) => profile.kind === 'library-zip' || profile.kind === 'project-zip'
				),
				longTasks: tasks
			},
			null,
			2
		)
	);
	await info.attach('archive-phase-profiles.json', {
		path: profilePath,
		contentType: 'application/json'
	});
});

test('documentation site cancellation publishes no archive', async ({ page }, info) => {
	test.setTimeout(180_000);
	await resetAppState(page);
	await seedCorpus(page, {
		textMiB: 4,
		rows: 20,
		assets: 2,
		assetBytes: 128 * 1024,
		projectDocuments: 6,
		openFiles: 1
	});
	await page.reload();
	await waitForReady(page);
	await setPipelineDelay(page, 200);
	let downloads = 0;
	page.on('download', () => downloads++);

	await page.getByTestId('projects-open').click();
	const projects = page.getByRole('dialog', { name: 'Projets Markdown' });
	await expect(
		projects.getByRole('button', { name: 'Exporter le site de documentation' })
	).toBeVisible();
	await projects.getByRole('button', { name: 'Exporter le site de documentation' }).click();
	const panel = page.getByTestId('docs-site-panel');
	await expect(panel.getByTestId('docs-site-run')).toBeVisible();
	await panel.getByTestId('docs-site-run').click();
	await expect(panel.getByTestId('docs-site-busy')).toBeVisible({ timeout: 15_000 });
	await panel.getByTestId('docs-site-cancel').click();
	await expect(panel.getByTestId('docs-site-cancelled')).toBeVisible();
	await page.waitForTimeout(1500);
	expect(downloads).toBe(0);

	await setPipelineDelay(page, 0);
	const retriedDownload = page.waitForEvent('download', { timeout: 120_000 });
	await panel.getByTestId('docs-site-run').click();
	const download = await retriedDownload;
	const zipPath = info.outputPath('docs-site.zip');
	await download.saveAs(zipPath);
	expect(downloads).toBe(1);
	const stream = await download.createReadStream();
	const chunks: Buffer[] = [];
	for await (const chunk of stream!) chunks.push(chunk);
	const buffer = Buffer.concat(chunks);
	expect(buffer.subarray(0, 2).toString('latin1')).toBe('PK');

	const metricsPath = info.outputPath('docs-site-cancellation.json');
	await writeFile(metricsPath, JSON.stringify({ downloads, bytes: buffer.byteLength }, null, 2));
	await info.attach('docs-site-cancellation.json', {
		path: metricsPath,
		contentType: 'application/json'
	});
	await info.attach('docs-site.zip', { path: zipPath, contentType: 'application/zip' });
});

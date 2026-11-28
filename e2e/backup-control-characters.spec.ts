import { createHash } from 'node:crypto';
import { test, expect, type Download, type Page, type TestInfo } from '@playwright/test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetAppState, switchToSource } from './helpers';

// Risks (review findings DATA-02 and DATA-03):
// - One control character such as ESC in a stored note blocks every backup,
//   encrypted backup, scheduled backup and project ZIP export, and the toast
//   does not name a cause or a document.
// - A backup limit (64 MiB, 3,000 documents, 16 MiB per document) fails with
//   one generic toast. The user cannot tell which limit or which document.
// - The library grows past a limit with no earlier warning.
//
// The cases seed rows in IndexedDB, run the real Settings and Projects flows,
// and read the exported bytes and the restored rows.

const MIB = 1024 * 1024;
const stamp = 1_725_000_000_000;
const passphrase = 'control-character-passphrase';
const ESC = '\u001b';
const FF = '\u000c';
const BS = '\u0008';
const VT = '\u000b';
const terminalLog = `build log: ${ESC}[31mERROR${ESC}[0m failed\n${FF}page two${BS}${VT}end\n`;

interface SeedRow {
	id: string;
	name: string;
	content: string;
	projectId?: string;
	relativePath?: string;
}

interface StoredRow {
	id: string;
	name: string;
	content: string;
}

async function attach(info: TestInfo, name: string, value: unknown) {
	await info.attach(name, {
		body: JSON.stringify(value, null, 2),
		contentType: 'application/json'
	});
}

async function downloadBytes(download: Download): Promise<Buffer> {
	const stream = await download.createReadStream();
	const chunks: Buffer[] = [];
	for await (const chunk of stream!) chunks.push(chunk);
	return Buffer.concat(chunks);
}

function sha256(value: string | Buffer): string {
	return createHash('sha256').update(value).digest('hex');
}

/** Writes raw rows, as a library that already holds these notes. */
async function seedRows(page: Page, rows: SeedRow[], bigBytes?: Record<string, number>) {
	await page.evaluate(
		async ({ seed, big, at }) => {
			await new Promise<void>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const transaction = database.transaction(['drafts', 'projects'], 'readwrite');
					const projects = new Set<string>();
					seed.forEach((row, index) => {
						const extra = big[row.id] ?? 0;
						const filler = extra ? `${'x'.repeat(extra - 1)}\n` : '';
						transaction.objectStore('drafts').put({
							...row,
							content: row.content + filler,
							createdAt: at,
							updatedAt: at,
							order: index,
							open: index === 0
						});
						if (row.projectId) projects.add(row.projectId);
					});
					for (const id of projects)
						transaction.objectStore('projects').put({
							id,
							name: 'Control project',
							createdAt: at,
							updatedAt: at
						});
					transaction.oncomplete = () => {
						database.close();
						resolve();
					};
					transaction.onerror = () => reject(transaction.error);
				};
			});
		},
		{ seed: rows, big: bigBytes ?? {}, at: stamp }
	);
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
}

async function storedRows(page: Page): Promise<StoredRow[]> {
	return page.evaluate(
		() =>
			new Promise<StoredRow[]>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const read = database.transaction('drafts').objectStore('drafts').getAll();
					read.onsuccess = () => {
						database.close();
						resolve(
							(read.result as StoredRow[])
								.map(({ id, name, content }) => ({ id, name, content }))
								.sort((a, b) => a.id.localeCompare(b.id))
						);
					};
					read.onerror = () => reject(read.error);
				};
			})
	);
}

async function openSettings(page: Page) {
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	await page.keyboard.press('ControlOrMeta+,');
	await expect(page.getByRole('dialog', { name: /^(Réglages|Settings)$/ })).toBeVisible();
}

async function exportBackup(page: Page, encrypted = false): Promise<Buffer> {
	await openSettings(page);
	const pending = page.waitForEvent('download', { timeout: 20_000 });
	if (encrypted) {
		await page.getByRole('button', { name: 'Exporter (chiffré)…', exact: true }).click();
		for (const name of ['Chiffrer la sauvegarde', 'Confirmer la phrase secrète']) {
			const prompt = page.getByRole('dialog', { name, exact: true });
			await prompt.locator('input[type=password]').fill(passphrase);
			await prompt.getByRole('button', { name: 'OK', exact: true }).click();
		}
	} else {
		await page.getByRole('button', { name: 'Exporter une sauvegarde', exact: true }).click();
	}
	const bytes = await downloadBytes(await pending);
	await page.keyboard.press('Escape');
	return bytes;
}

async function exportBackupError(page: Page): Promise<string> {
	await openSettings(page);
	await page.getByRole('button', { name: 'Exporter une sauvegarde', exact: true }).click();
	const alert = page.getByRole('alert').filter({ hasText: 'échoué' });
	await expect(alert.first()).toBeVisible({ timeout: 60_000 });
	const text = ((await alert.first().textContent()) ?? '').replace(/\s+/g, ' ').trim();
	await page.keyboard.press('Escape');
	return text;
}

async function restore(page: Page, buffer: Buffer, encrypted = false) {
	await openSettings(page);
	// Playwright refuses an in-memory buffer above 50 MB. A file path has no such limit.
	const directory = await mkdtemp(join(tmpdir(), 'mdsh-control-'));
	const path = join(directory, 'control.json');
	await writeFile(path, buffer);
	await page.locator('input[type=file][accept*="json"]').setInputFiles(path);
	if (encrypted) {
		const prompt = page.getByRole('dialog', { name: 'Sauvegarde chiffrée' });
		await prompt.locator('input[type=password]').fill(passphrase);
		await prompt.getByRole('button', { name: 'OK', exact: true }).click();
	}
	const dialog = page.getByRole('dialog', { name: 'Restaurer la sauvegarde' });
	await dialog.getByRole('button', { name: 'Remplacer', exact: true }).click();
	await expect(dialog).toBeHidden({ timeout: 60_000 });
	await expect(
		page.getByRole('status').filter({ hasText: 'Sauvegarde restaurée' }).last()
	).toBeVisible({ timeout: 60_000 });
	await page.keyboard.press('Escape');
}

function backupWith(drafts: SeedRow[], extraBytes = 0) {
	return {
		format: 'mdsh-backup',
		schemaVersion: 2,
		exportedAt: stamp,
		drafts: drafts.map((row, index) => ({
			id: row.id,
			name: row.name,
			content: row.content + (extraBytes ? `${'x'.repeat(extraBytes - 1)}\n` : ''),
			createdAt: stamp,
			updatedAt: stamp,
			order: index,
			open: index === 0
		})),
		workspaces: [],
		templates: [],
		projects: [],
		projectAssets: []
	};
}

async function setLocale(page: Page, locale: 'en' | 'fr') {
	await page.evaluate((value) => localStorage.setItem('mdsh:locale', value), locale);
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
}

test.beforeEach(async ({ page }) => {
	// Long tasks show whether a check blocks the main thread.
	await page.addInitScript(() => {
		const tasks: Array<{ start: number; duration: number }> = [];
		(window as unknown as { __longTasks: typeof tasks }).__longTasks = tasks;
		try {
			new PerformanceObserver((list) => {
				for (const entry of list.getEntries())
					tasks.push({ start: entry.startTime, duration: entry.duration });
			}).observe({ type: 'longtask', buffered: true });
		} catch {
			// WebKit has no long task entries. The duration check below still applies.
		}
	});
	await resetAppState(page);
});

test('a note with ESC, form feed, backspace and vertical tab is backed up and restored exactly', async ({
	page
}, info) => {
	await seedRows(page, [
		{ id: 'log', name: 'build-log.md', content: terminalLog },
		{ id: 'plain', name: 'plain.md', content: '# Plain\n' }
	]);
	const before = await storedRows(page);

	const plain = await exportBackup(page);
	const parsed = JSON.parse(plain.toString('utf8')) as { drafts: StoredRow[] };
	expect(parsed.drafts.find((row) => row.id === 'log')?.content).toBe(terminalLog);
	// JSON carries the characters as escapes, not as raw control bytes.
	expect(plain.toString('utf8')).toContain('\\u001b[31mERROR');
	const encrypted = await exportBackup(page, true);
	expect(encrypted.toString('utf8')).not.toContain('build log');

	await resetAppState(page);
	await restore(page, plain);
	expect(await storedRows(page)).toEqual(before);

	await resetAppState(page);
	await restore(page, encrypted, true);
	expect(await storedRows(page)).toEqual(before);

	await attach(info, 'control-character-backup.json', {
		command:
			'npx playwright test e2e/backup-control-characters.spec.ts --project=chromium --workers=1 --retries=0',
		characters: ['U+001B', 'U+000C', 'U+0008', 'U+000B'],
		plainSha256: sha256(plain),
		encryptedSha256: sha256(encrypted),
		restoredRows: before.length
	});
});

test('a project ZIP export and import keep control characters', async ({ page }, info) => {
	await seedRows(page, [
		{
			id: 'p-log',
			name: 'log.md',
			content: terminalLog,
			projectId: 'control-project',
			relativePath: 'notes/log.md'
		},
		{
			id: 'p-readme',
			name: 'README.md',
			content: '# Control project\n',
			projectId: 'control-project',
			relativePath: 'README.md'
		}
	]);
	await page.getByTestId('projects-open').click();
	const panel = page.getByRole('dialog', { name: 'Projets Markdown' });
	const pending = page.waitForEvent('download', { timeout: 20_000 });
	await panel.getByRole('button', { name: 'Exporter le projet', exact: true }).click();
	const bytes = await downloadBytes(await pending);
	await info.attach('control-project.zip', { body: bytes, contentType: 'application/zip' });
	const { default: JSZip } = await import('jszip');
	const zip = await JSZip.loadAsync(bytes);
	expect(await zip.file('notes/log.md')!.async('string')).toBe(terminalLog);

	await resetAppState(page);
	await page.getByTestId('projects-open').click();
	await page
		.getByRole('dialog', { name: 'Projets Markdown' })
		.locator('input[type=file][accept=".zip"]')
		.setInputFiles({ name: 'control-project.zip', mimeType: 'application/zip', buffer: bytes });
	await expect(
		page
			.getByRole('dialog', { name: 'Projets Markdown' })
			.getByRole('button', { name: 'Ouvrir notes/log.md', exact: true })
	).toBeVisible();
	const rows = await storedRows(page);
	expect(rows.find((row) => row.name === 'log.md')?.content).toBe(terminalLog);
});

test('opening a file with ESC works and a file with NUL is still rejected as binary', async ({
	page
}) => {
	await page.locator('input[type="file"][accept*="text/markdown"]').setInputFiles([
		{ name: 'terminal.md', mimeType: 'text/markdown', buffer: Buffer.from(terminalLog, 'utf8') },
		{ name: 'binary.md', mimeType: 'text/markdown', buffer: Buffer.from('abc\u0000def', 'utf8') }
	]);
	// The import report names the rejected file and its cause. It lists no other file.
	await expect(page.getByText('binary.md: Fichier binaire ignoré')).toHaveCount(1);
	await expect(page.getByText('terminal.md: Fichier binaire ignoré')).toHaveCount(0);
	await expect
		.poll(async () => (await storedRows(page)).map((row) => row.name).sort())
		.toEqual(['terminal.md']);
	expect((await storedRows(page))[0]!.content).toBe(terminalLog);
});

test('a stored NUL names the document in the backup error, in French and English', async ({
	page
}, info) => {
	await seedRows(page, [
		{ id: 'ok', name: 'fine.md', content: '# Fine\n' },
		{ id: 'nul', name: 'Rapport binaire.md', content: 'a\u0000b\n' }
	]);
	const french = await exportBackupError(page);
	expect(french).toContain('a échoué');
	expect(french).toContain('Rapport binaire.md');
	expect(french).toContain('NUL');
	await setLocale(page, 'en');
	await openSettings(page);
	await page.getByRole('button', { name: 'Export a backup', exact: true }).click();
	const alert = page.getByRole('alert').filter({ hasText: 'Backup export failed.' });
	await expect(alert.first()).toBeVisible({ timeout: 30_000 });
	const english = ((await alert.first().textContent()) ?? '').replace(/\s+/g, ' ').trim();
	expect(english).toContain('Rapport binaire.md');
	expect(english).toContain('NUL');
	await attach(info, 'nul-error-messages.json', { french, english });
});

test('a backup limit error names the limit and the document', async ({ page }, info) => {
	test.setTimeout(240_000);
	await seedRows(
		page,
		[
			{ id: 'small', name: 'small.md', content: '# Small\n' },
			{ id: 'huge', name: 'Journal enorme.md', content: '# Huge\n' }
		],
		{ huge: 17 * MIB }
	);
	const oneDocument = await exportBackupError(page);
	expect(oneDocument).toContain('Journal enorme.md');
	expect(oneDocument).toContain('16 Mio');

	await resetAppState(page);
	const parts = ['Part 1.md', 'Part 2.md', 'Part 3.md', 'Part 4.md', 'Part 5.md'];
	await seedRows(
		page,
		parts.map((name, index) => ({ id: `part-${index}`, name, content: '# Part\n' })),
		Object.fromEntries(parts.map((_, index) => [`part-${index}`, 13 * MIB]))
	);
	const total = await exportBackupError(page);
	// 5 x 13 MiB is 65 MiB. The fifth document crosses the 64 MiB limit.
	expect(total).toContain('64 Mio');
	expect(total).toContain('Part 5.md');

	await resetAppState(page);
	await seedRows(
		page,
		Array.from({ length: 3001 }, (_, index) => ({
			id: `n-${String(index).padStart(4, '0')}`,
			name: `Note ${index}.md`,
			content: `# Note ${index}\n`
		}))
	);
	const count = await exportBackupError(page);
	expect(count).toContain('3001');
	expect(count).toMatch(/3[\s\u00a0\u202f]?000/);
	await attach(info, 'backup-limit-messages.json', { oneDocument, total, count });
});

test.describe('backup capacity warnings', () => {
	const warning = (text: string | RegExp) => (page: Page) =>
		page.getByRole('status').filter({ hasText: text });

	async function capacityMeasures(page: Page) {
		return page.evaluate(() =>
			performance.getEntriesByName('mdsh:backup-capacity').map((entry) => ({
				start: entry.startTime,
				ms: entry.duration,
				detail: (entry as PerformanceMeasure).detail
			}))
		);
	}
	test('warns at save time before the document limit and stays silent below it', async ({
		page
	}, info) => {
		test.setTimeout(240_000);
		// 2,399 documents is below 80 % of 3,000. One more reaches 2,400.
		const rows = Array.from({ length: 2399 }, (_, index) => ({
			id: `n-${String(index).padStart(4, '0')}`,
			name: `Note ${index}.md`,
			content: `# Note ${index}\n`
		}));
		await restore(page, Buffer.from(JSON.stringify(backupWith(rows))));
		await page.reload();
		await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
		await page.waitForTimeout(3000);
		await expect(warning(/documents/i)(page)).toHaveCount(0);

		await page.locator('aside button[aria-label^="Nouveau fichier"]').first().click();
		await page.getByTestId('create-note').click();
		await expect(warning(/2400/)(page).first()).toBeVisible({ timeout: 30_000 });
		const measures = await capacityMeasures(page);
		const longTasks = await page.evaluate(
			() =>
				(window as unknown as { __longTasks: Array<{ start: number; duration: number }> })
					.__longTasks
		);
		// A long task that overlaps a check belongs to the check or to concurrent work.
		const overlapping = longTasks.filter((task) =>
			measures.some(
				(measure) =>
					task.start < measure.start + measure.ms && measure.start < task.start + task.duration
			)
		);
		await attach(info, 'capacity-measures.json', {
			library: 2400,
			measures,
			longTasks,
			overlapping
		});
		expect(measures.length).toBeGreaterThan(0);
		// The read is asynchronous index key I/O. A check must not hold the main
		// thread beyond the 250 ms long task budget of docs/TESTING.md.
		for (const measure of measures) expect(measure.ms).toBeLessThan(1500);
		for (const task of overlapping) expect(task.duration).toBeLessThan(250);
	});

	test('typing does not run the capacity check per keystroke', async ({ page }, info) => {
		test.setTimeout(240_000);
		const rows = Array.from({ length: 2450 }, (_, index) => ({
			id: `n-${String(index).padStart(4, '0')}`,
			name: `Note ${index}.md`,
			content: `# Note ${index}\n`
		}));
		await restore(page, Buffer.from(JSON.stringify(backupWith(rows))));
		await page.reload();
		await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
		await expect(warning(/2450/)(page).first()).toBeVisible({ timeout: 30_000 });
		const before = (await capacityMeasures(page)).length;
		await page.locator('aside button[aria-label^="Nouveau fichier"]').first().click();
		await page.getByTestId('create-note').click();
		await switchToSource(page);
		const editor = page.locator('.cm-content').first();
		await editor.click();
		for (let index = 0; index < 40; index++) {
			await page.keyboard.type('a');
			await page.waitForTimeout(60);
		}
		await page.waitForTimeout(1500);
		const after = await capacityMeasures(page);
		await attach(info, 'typing-capacity-runs.json', {
			before,
			after: after.length,
			after_detail: after
		});
		// 40 keystrokes over about 2.4 s produce at most one extra check.
		expect(after.length - before).toBeLessThanOrEqual(1);
	});

	test('warns before one document or the whole text reaches the byte limit', async ({
		page
	}, info) => {
		test.setTimeout(300_000);
		const one = [{ id: 'big', name: 'Carnet long.md', content: '# Big\n' }];
		await restore(page, Buffer.from(JSON.stringify(backupWith(one, 13 * MIB))));
		await page.reload();
		await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
		const documentWarning = warning(/Carnet long\.md/)(page).first();
		await expect(documentWarning).toBeVisible({ timeout: 30_000 });
		const documentText = await documentWarning.textContent();

		await resetAppState(page);
		const many = Array.from({ length: 5 }, (_, index) => ({
			id: `part-${index}`,
			name: `Part ${index + 1}.md`,
			content: '# Part\n'
		}));
		await restore(page, Buffer.from(JSON.stringify(backupWith(many, 10.4 * MIB))));
		await page.reload();
		await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
		const totalWarning = warning(/64 Mio/)(page).first();
		await expect(totalWarning).toBeVisible({ timeout: 30_000 });
		await attach(info, 'capacity-warnings.json', {
			documentText,
			totalText: await totalWarning.textContent()
		});
	});
});

import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { openPalette, resetAppState, seedFiles, writeSourceContent } from './helpers';
import { databaseState, importBackup } from './storage-evidence';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

const files = [
	{
		name: 'Alpha',
		content: '---\ntitle: Alpha\ntags: [docs]\nstatus: active\npriority: 2\n---\n\n# Alpha\n'
	},
	{
		name: 'Beta',
		content: '---\ntitle: Beta\ntags: [review]\nstatus: done\npriority: 1\n---\n\n# Beta\n'
	},
	{
		name: 'Gamma',
		content: '---\ntitle: Gamma\ntags: [docs]\nstatus: active\npriority: 3\n---\n\n# Gamma\n'
	}
];

async function openCollection(page: Page) {
	await openPalette(page);
	await page
		.getByRole('dialog', { name: 'Palette de commandes' })
		.getByRole('option', { name: /vues tableau/i })
		.click();
	await expect(page.getByTestId('collection-panel')).toBeVisible();
	await expect(page.getByTestId('collection-table')).toBeVisible();
}

test('filters, sorts and groups note properties', async ({ page }, info: TestInfo) => {
	await resetAppState(page);
	await seedFiles(page, files);
	await openCollection(page);
	const table = page.getByTestId('collection-table');
	await expect(table).toContainText('Alpha');
	await expect(table).toContainText('Beta');
	await expect(table).toContainText('Gamma');

	await page.getByTestId('collection-filter').fill('docs');
	await expect(table).toContainText('Alpha');
	await expect(table).not.toContainText('Beta');
	await page.getByTestId('collection-filter').fill('');

	await page.getByTestId('collection-sort').selectOption('priority');
	await page.getByTestId('collection-direction').click();
	const firstRow = table.locator('tbody tr').first();
	await expect(firstRow).toContainText('Gamma');

	await page.getByTestId('collection-group').selectOption('status');
	await page.getByRole('button', { name: 'Tableau blanc' }).click();
	await expect(page.getByTestId('collection-board')).toContainText('active');
	await expect(page.getByTestId('collection-board')).toContainText('done');

	await page.getByRole('textbox', { name: 'Nom de la vue' }).fill('Active docs');
	await page.getByTestId('collection-save-view').click();
	await page.keyboard.press('Escape');
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	await openCollection(page);
	await expect(page.getByTestId('collection-views')).toContainText('Active docs');
	await page.getByTestId('collection-views').selectOption({ label: 'Active docs' });
	await expect(page.getByTestId('collection-filter')).toHaveValue('');

	await info.attach('collection-views.json', {
		body: JSON.stringify({ files: files.length, savedView: 'Active docs', grouped: true }),
		contentType: 'application/json'
	});
	await info.attach('collection-views.png', { body: await page.screenshot() });
});

test('opens a note from the table', async ({ page }) => {
	await resetAppState(page);
	await seedFiles(page, files);
	await openCollection(page);
	await page.getByTestId('collection-table').getByRole('button', { name: 'Beta' }).click();
	await expect(page.getByTestId('collection-panel')).toHaveCount(0);
	await expect(page.locator('.cm-content')).toContainText('# Beta');
});

const nonFiniteFiles = [
	{
		name: 'NaN',
		content: '---\ntitle: Not a number\nscore: .nan\n---\n\n# NaN\n'
	},
	{
		name: 'Positive',
		content: '---\ntitle: Positive infinite\nscore: .inf\n---\n\n# Positive\n'
	},
	{
		name: 'Negative',
		content: '---\ntitle: Negative infinite\nscore: -.inf\n---\n\n# Negative\n'
	}
];

test('sorts and filters non-finite YAML numbers after persistence', async ({
	page
}, info: TestInfo) => {
	const failures: string[] = [];
	page.on('pageerror', (error) => failures.push(error.message));
	await resetAppState(page);
	await seedFiles(page, nonFiniteFiles);
	await openCollection(page);
	const table = page.getByTestId('collection-table');
	for (const title of ['Not a number', 'Positive infinite', 'Negative infinite'])
		await expect(table).toContainText(title);

	await page.getByTestId('collection-sort').selectOption('score');
	const rows = table.locator('tbody tr');
	await expect(rows.first()).toContainText('Negative infinite');
	await expect(rows.first()).toContainText('-Infinity');
	await page.getByTestId('collection-direction').click();
	await expect(rows.first()).toContainText('Not a number');
	await expect(rows.first()).toContainText('NaN');
	await page.getByTestId('collection-filter').fill('positive');
	await expect(rows).toHaveCount(1);
	await expect(rows.first()).toContainText('Positive infinite');
	await page.getByTestId('collection-filter').fill('');

	await closeCollection(page);
	await openCollection(page);
	await page.getByTestId('collection-sort').selectOption('score');
	await expect(table.locator('tbody tr').first()).toContainText('Negative infinite');
	expect(failures.filter((message) => message.includes('toLowerCase'))).toEqual([]);
	await info.attach('collection-non-finite.json', {
		body: JSON.stringify({ files: nonFiniteFiles.length, failures }, null, 2),
		contentType: 'application/json'
	});
});

const FIELD_COUNT = 100;
const NOTE_COUNT = 3000;

function collectionFixture(now: number, noteCount: number, fieldCount: number) {
	const fields = Array.from({ length: fieldCount }, (_, index) => `field${index}`);
	const drafts = Array.from({ length: noteCount }, (_, index) => {
		const rows = fields.map((field, position) => `${field}: value ${index}-${position}`);
		return {
			id: `collection-perf-${index}`,
			name: `Note ${index}.md`,
			content: [
				'---',
				`title: Note ${index}`,
				...rows,
				`status: group-${index % 7}`,
				`priority: ${index === noteCount - 1 ? 999 : index % 13}`,
				`sequence: ${index}`,
				'---',
				'',
				`# Note ${index}`,
				// Keep the corpus above the 8 MiB inline budget so the reload
				// defers most bodies, as it does for a large real library.
				'Body text. '.repeat(300)
			].join('\n'),
			createdAt: now,
			updatedAt: now,
			order: index,
			open: index === 0
		};
	});
	return {
		format: 'mdsh-backup',
		schemaVersion: 1,
		exportedAt: now,
		drafts,
		workspaces: [
			{
				id: 'collection-perf-workspace',
				name: 'Collection',
				fileIds: [drafts[0]!.id],
				activeId: drafts[0]!.id,
				createdAt: now,
				updatedAt: now
			}
		],
		templates: []
	};
}

function largeCollectionFixture(now: number) {
	return collectionFixture(now, NOTE_COUNT, FIELD_COUNT);
}

async function closeCollection(page: Page) {
	await page
		.getByTestId('collection-panel')
		.getByRole('button', { name: 'Fermer' })
		.first()
		.click();
	await expect(page.getByTestId('collection-panel')).toHaveCount(0);
}

async function openLargeCollection(page: Page) {
	const started = Date.now();
	await openCollection(page);
	await expect(page.getByTestId('collection-table')).toBeVisible({ timeout: 180_000 });
	return Date.now() - started;
}

async function persistedProjectionCount(page: Page) {
	return page.evaluate(
		() =>
			new Promise<number>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const tx = database.transaction('metadata');
					const keys = tx.objectStore('metadata').getAllKeys();
					keys.onerror = () => {
						database.close();
						reject(keys.error);
					};
					keys.onsuccess = () => {
						database.close();
						resolve(
							keys.result.filter(
								(key) => typeof key === 'string' && key.startsWith('collection-row:')
							).length
						);
					};
				};
			})
	);
}

async function collectionProfile(page: Page) {
	return page.evaluate(
		() =>
			(
				window as unknown as {
					__mdshCollectionProfile?: Record<string, number>;
				}
			).__mdshCollectionProfile ?? null
	);
}

async function writeArtifact(name: string, value: unknown) {
	await mkdir('test-results', { recursive: true });
	await writeFile(
		`test-results/${name}`,
		JSON.stringify(
			{
				command:
					'npx playwright test e2e/collection-views.spec.ts --project=chromium --workers=1 --retries=0',
				sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
				environment: { node: process.version, platform: process.platform, arch: process.arch },
				...((value as Record<string, unknown>) ?? {})
			},
			null,
			2
		)
	);
}

async function collectionDom(page: Page) {
	return page.evaluate(() => {
		const table = document.querySelector('[data-testid="collection-table"]');
		return {
			rows: table?.querySelectorAll('tbody tr').length ?? 0,
			cells: table?.querySelectorAll('tbody td, tbody th').length ?? 0,
			headers: table?.querySelectorAll('thead th').length ?? 0,
			nodes: document.querySelectorAll('*').length
		};
	});
}

test('updates virtual row and column windows on container scroll', async ({
	page
}, info: TestInfo) => {
	test.setTimeout(180_000);
	await resetAppState(page);
	await importBackup(page, collectionFixture(Date.now(), 300, 60));
	await expect.poll(async () => (await databaseState(page)).drafts.length).toBe(300);
	await page.keyboard.press('Escape');
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	await openCollection(page);
	const table = page.getByTestId('collection-table');
	await page.getByTestId('collection-sort').selectOption('sequence');
	await expect(table.locator('tbody tr').first()).toContainText('Note 0');
	const body = page.locator('.collection-body');

	await body.evaluate((element) => {
		element.scrollTop = 150 * 30;
	});
	await expect(table).toContainText('Note 150');
	await expect(table).not.toContainText('Note 0');
	const middleDom = await collectionDom(page);

	await body.evaluate((element) => {
		element.scrollTop = element.scrollHeight;
	});
	await expect(table.locator('tbody tr').last()).toContainText('Note 299');
	await expect(table).not.toContainText('Note 0');
	const bottomDom = await collectionDom(page);

	const topHeaders = await table.locator('thead th').allTextContents();
	await body.evaluate((element) => {
		element.scrollLeft = 26 * 140;
	});
	await expect
		.poll(async () => (await table.locator('thead th').allTextContents()).includes('field32'))
		.toBe(true);
	const middleHeaders = await table.locator('thead th').allTextContents();

	await body.evaluate((element) => {
		element.scrollLeft = element.scrollWidth;
	});
	await expect
		.poll(async () => (await table.locator('thead th').allTextContents()).includes('status'))
		.toBe(true);
	const endHeaders = await table.locator('thead th').allTextContents();
	expect(endHeaders[0]).toBe(topHeaders[0]);
	expect(middleHeaders).not.toEqual(topHeaders);
	expect(endHeaders).not.toEqual(topHeaders);

	await page.setViewportSize({ width: 900, height: 640 });
	await expect
		.poll(async () => (await table.locator('thead th').allTextContents()).includes('status'))
		.toBe(true);
	expect((await collectionDom(page)).rows).toBeLessThanOrEqual(600);

	await page.getByTestId('collection-filter').fill('value 0-42');
	await expect(table).toContainText('Note 0');
	await expect(table.locator('tbody tr')).toHaveCount(1);
	expect(await body.evaluate((element) => element.scrollTop)).toBe(0);

	await writeArtifact('collection-scroll.json', {
		fixture: { notes: 300, fields: 60 },
		result: {
			rowHeight: 30,
			middleDom,
			bottomDom,
			topHeaders,
			middleHeaders,
			endHeaders
		}
	});
	await info.attach('collection-scroll.json', {
		body: JSON.stringify({ middleDom, bottomDom, middleHeaders, endHeaders }, null, 2),
		contentType: 'application/json'
	});
});

function missingBodyFixture(now: number) {
	const body = 'Body text. '.repeat(28_000);
	return collectionFixtureFromDrafts(
		now,
		Array.from({ length: 12 }, (_, index) => ({
			id: `missing-body-${index}`,
			name: `Missing ${index}.md`,
			content: `---\ntitle: Missing ${index}\nstatus: draft\n---\n\n# Missing ${index}\n\n${body}`,
			createdAt: now,
			updatedAt: now,
			order: index,
			open: index === 0
		}))
	);
}

function collectionFixtureFromDrafts(
	now: number,
	drafts: Array<Record<string, unknown> & { id: string; name: string }>
) {
	return {
		format: 'mdsh-backup',
		schemaVersion: 1,
		exportedAt: now,
		drafts,
		workspaces: [
			{
				id: 'collection-missing-workspace',
				name: 'Collection',
				fileIds: [drafts[0]!.id],
				activeId: drafts[0]!.id,
				createdAt: now,
				updatedAt: now
			}
		],
		templates: []
	};
}

test('reports a missing deferred body instead of showing an empty note', async ({
	page
}, info: TestInfo) => {
	test.setTimeout(180_000);
	const failures: string[] = [];
	page.on('pageerror', (error) => failures.push(error.message));
	await resetAppState(page);
	await importBackup(page, missingBodyFixture(Date.now()));
	await expect.poll(async () => (await databaseState(page)).drafts.length).toBe(12);
	await page.keyboard.press('Escape');
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	await page.evaluate(
		() =>
			new Promise<void>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const tx = database.transaction('drafts', 'readwrite');
					tx.objectStore('drafts').delete('missing-body-11');
					tx.oncomplete = () => {
						database.close();
						resolve();
					};
					tx.onabort = () => {
						database.close();
						reject(tx.error);
					};
				};
			})
	);
	await openCollection(page);
	const table = page.getByTestId('collection-table');
	await expect(page.getByTestId('collection-missing')).toContainText('1');
	await expect(table).toContainText('Missing 1');
	await expect(table).not.toContainText('Missing 11');
	await expect(table.locator('tbody tr')).toHaveCount(11);
	expect(failures).toEqual([]);
	await info.attach('collection-missing-body.json', {
		body: JSON.stringify({ notes: 12, removed: 'missing-body-11', shown: 11, failures }, null, 2),
		contentType: 'application/json'
	});
});

test('bounds a 3000-row, 100-column collection and reuses persisted metadata', async ({
	page
}, info: TestInfo) => {
	test.setTimeout(300_000);
	await resetAppState(page);
	const fixture = largeCollectionFixture(Date.now());
	await importBackup(page, fixture);
	await expect.poll(async () => (await databaseState(page)).drafts.length).toBe(NOTE_COUNT);
	await page.keyboard.press('Escape');
	// Reload so the library starts with deferred bodies, as it does after boot.
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();

	const firstOpenMs = await openLargeCollection(page);
	const firstProfile = await collectionProfile(page);
	const firstDom = await collectionDom(page);
	const table = page.getByTestId('collection-table');
	await expect(table.locator('tbody tr').first()).toContainText('Note 0');
	const body = page.locator('.collection-body');
	await page.getByTestId('collection-sort').selectOption('sequence');
	await expect(table.locator('tbody tr').first()).toContainText('Note 0');
	await body.evaluate((element) => {
		element.scrollTop = element.scrollHeight;
	});
	await expect(table.locator('tbody tr').last()).toContainText('Note 2999');
	await body.evaluate((element) => {
		element.scrollLeft = element.scrollWidth;
	});
	await expect
		.poll(async () => (await table.locator('thead th').allTextContents()).includes('status'))
		.toBe(true);
	const scrolledDom = await collectionDom(page);

	await page.getByTestId('collection-filter').fill('value 2999-42');
	await expect(table).toContainText('Note 2999');
	await expect(table.locator('tbody tr')).toHaveCount(1);
	await page.getByTestId('collection-filter').fill('');
	await page.getByTestId('collection-sort').selectOption('priority');
	await page.getByTestId('collection-direction').click();
	await expect(table.locator('tbody tr').first()).toContainText('Note 2999');
	await page.getByTestId('collection-group').selectOption('status');
	await page.getByRole('button', { name: 'Tableau blanc' }).click();
	const board = page.getByTestId('collection-board');
	await expect(board).toContainText('group-0');
	await expect(board).toContainText('group-6');
	const boardCards = await board.locator('.board-card').count();
	await closeCollection(page);
	const persistedRows = await persistedProjectionCount(page);

	const secondOpenMs = await openLargeCollection(page);
	const secondProfile = await collectionProfile(page);
	const secondDom = await collectionDom(page);
	await expect(table).toContainText('Note 0');

	expect(firstProfile?.bodyReads).toBeGreaterThan(0);
	expect(secondProfile?.bodyReads).toBe(0);
	expect(secondProfile?.reused).toBe(NOTE_COUNT);
	expect(firstDom.rows).toBeLessThanOrEqual(600);
	expect(firstDom.cells).toBeLessThanOrEqual(600 * 40);
	expect(secondDom.rows).toBeLessThanOrEqual(600);
	expect(boardCards).toBeLessThanOrEqual(600);
	expect(secondOpenMs).toBeLessThan(firstOpenMs);
	expect(persistedRows).toBe(NOTE_COUNT);

	const fixtureBytes = fixture.drafts.reduce((total, draft) => total + draft.content.length, 0);
	const result = {
		notes: NOTE_COUNT,
		fields: FIELD_COUNT,
		fixtureBytes,
		firstOpenMs,
		secondOpenMs,
		firstDom,
		secondDom,
		scrolledDom,
		firstProfile,
		secondProfile,
		boardCards,
		persistedRows
	};
	await writeArtifact('collection-scale.json', {
		fixture: { notes: NOTE_COUNT, columns: FIELD_COUNT + 3, fixtureBytes },
		result
	});
	await info.attach('collection-scale.json', {
		body: JSON.stringify(result, null, 2),
		contentType: 'application/json'
	});
});

test('cancels a pending collection load when the panel closes', async ({
	page
}, info: TestInfo) => {
	test.setTimeout(180_000);
	await resetAppState(page);
	await importBackup(page, largeCollectionFixture(Date.now()));
	await expect.poll(async () => (await databaseState(page)).drafts.length).toBe(NOTE_COUNT);
	await page.keyboard.press('Escape');
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	const failures: string[] = [];
	page.on('pageerror', (error) => failures.push(error.message));
	await openPalette(page);
	await page
		.getByRole('dialog', { name: 'Palette de commandes' })
		.getByRole('option', { name: /vues tableau/i })
		.click();
	await expect(page.getByTestId('collection-panel')).toBeVisible();
	await closeCollection(page);
	await page.waitForTimeout(1500);
	expect(failures).toEqual([]);
	await writeArtifact('collection-cancel.json', {
		fixture: { notes: NOTE_COUNT },
		result: { closed: true, pageErrors: failures }
	});
	await info.attach('collection-cancel.json', {
		body: JSON.stringify({ closed: true, pageErrors: failures }),
		contentType: 'application/json'
	});
});

test('reparses only the changed note after a collection edit', async ({ page }, info: TestInfo) => {
	await resetAppState(page);
	await seedFiles(page, files);
	await openCollection(page);
	await expect(page.getByTestId('collection-table')).toContainText('Gamma');
	await closeCollection(page);
	await writeSourceContent(
		page,
		'---\ntitle: Gamma renamed\ntags: [docs]\nstatus: active\npriority: 3\n---\n\n# Gamma\n'
	);
	await openCollection(page);
	const table = page.getByTestId('collection-table');
	await expect(table).toContainText('Gamma renamed');
	const profile = await collectionProfile(page);
	expect(profile?.parsed).toBe(1);
	expect(profile?.reused).toBe(2);
	await writeArtifact('collection-incremental.json', {
		fixture: { notes: files.length },
		result: { parsed: profile?.parsed, reused: profile?.reused }
	});
	await info.attach('collection-incremental.json', {
		body: JSON.stringify({ parsed: profile?.parsed, reused: profile?.reused }),
		contentType: 'application/json'
	});
});

test('backfills rows whose persisted collection projection is missing', async ({
	page
}, info: TestInfo) => {
	await resetAppState(page);
	await seedFiles(page, files);
	await openCollection(page);
	await expect(page.getByTestId('collection-table')).toContainText('Alpha');
	await closeCollection(page);
	await page.evaluate(
		() =>
			new Promise<void>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const tx = database.transaction('metadata', 'readwrite');
					tx.objectStore('metadata').clear();
					tx.oncomplete = () => {
						database.close();
						resolve();
					};
					tx.onabort = () => {
						database.close();
						reject(tx.error);
					};
				};
			})
	);
	await openCollection(page);
	const table = page.getByTestId('collection-table');
	await expect(table).toContainText('Alpha');
	await expect(table).toContainText('Beta');
	await expect(table).toContainText('Gamma');
	await info.attach('collection-backfill.json', {
		body: JSON.stringify({ projectionsCleared: true, rebuilt: 3 }),
		contentType: 'application/json'
	});
});

async function trackCollectionFailures(page: Page) {
	const failures: string[] = [];
	page.on('pageerror', (error) => failures.push(error.message));
	await page.addInitScript(() => {
		const state = window as unknown as { __mdshRejections?: string[] };
		state.__mdshRejections = [];
		window.addEventListener('unhandledrejection', (event) => {
			state.__mdshRejections?.push(String(event.reason));
		});
	});
	const rejections = () =>
		page.evaluate(
			() => (window as unknown as { __mdshRejections?: string[] }).__mdshRejections ?? []
		);
	return { failures, rejections };
}

test('keeps saved views consistent when localStorage rejects writes', async ({
	page
}, info: TestInfo) => {
	const { failures, rejections } = await trackCollectionFailures(page);
	await page.addInitScript(() => {
		const state = window as unknown as { __mdshFailViewWrites: boolean };
		state.__mdshFailViewWrites = false;
		const original = Storage.prototype.setItem;
		Storage.prototype.setItem = function (key, value) {
			if (state.__mdshFailViewWrites && key === 'mdsh:collection-views') {
				throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
			}
			return original.call(this, key, value);
		};
	});
	await resetAppState(page);
	await seedFiles(page, files);
	await openCollection(page);

	const field = page.getByRole('textbox', { name: 'Nom de la vue' });
	const selector = page.getByTestId('collection-views');
	const error = page.getByTestId('collection-views-error');
	const stored = () => page.evaluate(() => localStorage.getItem('mdsh:collection-views'));
	const setWriteFailure = (value: boolean) =>
		page.evaluate((failure) => {
			(window as unknown as { __mdshFailViewWrites: boolean }).__mdshFailViewWrites = failure;
		}, value);

	await field.fill('   ');
	await page.getByTestId('collection-save-view').click();
	await expect(selector.locator('option')).toHaveCount(1);
	expect(await stored()).toBeNull();

	await page.getByTestId('collection-filter').fill('docs');
	await page.getByTestId('collection-sort').selectOption('priority');
	await page.getByTestId('collection-direction').click();
	await page.getByTestId('collection-group').selectOption('status');
	await page.getByRole('button', { name: 'Tableau blanc' }).click();
	await expect(page.getByTestId('collection-board')).toBeVisible();
	await field.fill('Stable');
	await page.getByTestId('collection-save-view').click();
	await expect(selector).toContainText('Stable');
	const stableId = await selector.inputValue();
	expect(stableId).not.toBe('');
	const before = await stored();
	expect(JSON.parse(before ?? '[]')).toHaveLength(1);

	await setWriteFailure(true);
	await expect(error).toHaveCount(0);
	await selector.selectOption(stableId);
	const deleteButton = page.getByRole('button', { name: 'Supprimer la vue' });
	await expect(deleteButton).toBeVisible();
	await deleteButton.click();
	await expect(error).toBeVisible();
	await expect(error).toContainText('enregistr');
	await expect(selector.locator(`option[value="${stableId}"]`)).toHaveCount(1);
	await expect(selector).toHaveValue(stableId);
	expect(await stored()).toBe(before);

	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	await openCollection(page);
	await expect(error).toHaveCount(0);
	await setWriteFailure(true);
	await field.fill('Phantom');
	await page.getByTestId('collection-save-view').click();
	await expect(error).toBeVisible();
	await expect(error).toContainText('enregistr');
	await expect(selector).not.toContainText('Phantom');
	await expect(field).toHaveValue('Phantom');
	expect(await stored()).toBe(before);

	await field.fill('Rapid');
	await page.getByTestId('collection-save-view').dblclick();
	await expect(selector).not.toContainText('Rapid');
	expect(await stored()).toBe(before);

	await setWriteFailure(false);
	await page.getByTestId('collection-save-view').click();
	await expect(error).toHaveCount(0);
	await expect(selector).toContainText('Rapid');
	const after = JSON.parse((await stored()) ?? '[]') as Array<{ name: string }>;
	expect(after.map((view) => view.name)).toEqual(['Stable', 'Rapid']);

	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	await openCollection(page);
	const restored = page.getByTestId('collection-views');
	await expect(restored).toContainText('Stable');
	await expect(restored).toContainText('Rapid');
	await restored.selectOption({ label: 'Stable' });
	await expect(page.getByTestId('collection-filter')).toHaveValue('docs');
	await expect(page.getByTestId('collection-sort')).toHaveValue('priority');
	await expect(page.getByTestId('collection-direction')).toHaveText('Z-A');
	await expect(page.getByTestId('collection-group')).toHaveValue('status');
	await expect(page.getByTestId('collection-board')).toBeVisible();
	await expect(page.getByTestId('collection-table')).toHaveCount(0);

	expect(failures).toEqual([]);
	expect(await rejections()).toEqual([]);
	const result = {
		fixture: { notes: files.length },
		result: {
			storedBefore: JSON.parse(before ?? '[]'),
			storedAfter: after,
			pageErrors: failures,
			unhandledRejections: await rejections()
		}
	};
	await writeArtifact('collection-view-storage-failure.json', result);
	await info.attach('collection-view-storage-failure.json', {
		body: JSON.stringify(result, null, 2),
		contentType: 'application/json'
	});
});

test('does not overwrite unread saved views when reads fail', async ({ page }, info: TestInfo) => {
	const { failures, rejections } = await trackCollectionFailures(page);
	await page.addInitScript(() => {
		const state = window as unknown as {
			__mdshFailViewReads: boolean;
			__mdshOriginalGetItem: Storage['getItem'];
		};
		state.__mdshFailViewReads = sessionStorage.getItem('__mdshFailViewReads') === '1';
		const original = Storage.prototype.getItem;
		state.__mdshOriginalGetItem = original;
		Storage.prototype.getItem = function (key) {
			if (state.__mdshFailViewReads && key === 'mdsh:collection-views') {
				throw new DOMException('Access is denied.', 'SecurityError');
			}
			return original.call(this, key);
		};
	});
	await resetAppState(page);
	await seedFiles(page, files);
	await openCollection(page);

	const field = page.getByRole('textbox', { name: 'Nom de la vue' });
	const save = page.getByTestId('collection-save-view');
	const selector = page.getByTestId('collection-views');
	await field.fill('Existing');
	await save.click();
	await expect(selector).toContainText('Existing');
	const before = await page.evaluate(() => localStorage.getItem('mdsh:collection-views'));
	expect(JSON.parse(before ?? '[]')).toHaveLength(1);

	await page.evaluate(() => sessionStorage.setItem('__mdshFailViewReads', '1'));
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	await openCollection(page);
	await expect(page.getByTestId('collection-views-error')).toContainText('stockage');
	await expect(selector.locator('option')).toHaveCount(1);
	await expect(page.getByTestId('collection-table')).toContainText('Alpha');
	await expect(page.getByTestId('collection-table')).toContainText('Gamma');

	await field.fill('New');
	await save.click();
	await expect(page.getByTestId('collection-views-error')).toContainText('stockage');
	await expect(selector).not.toContainText('New');
	const unread = await page.evaluate(() =>
		(window as unknown as { __mdshOriginalGetItem: Storage['getItem'] }).__mdshOriginalGetItem.call(
			localStorage,
			'mdsh:collection-views'
		)
	);
	expect(unread).toBe(before);

	await page.evaluate(() => {
		(window as unknown as { __mdshFailViewReads: boolean }).__mdshFailViewReads = false;
		sessionStorage.setItem('__mdshFailViewReads', '0');
	});
	await save.click();
	await expect(page.getByTestId('collection-views-error')).toHaveCount(0);
	await expect(selector).toContainText('Existing');
	await expect(selector).toContainText('New');
	const after = await page.evaluate(() => localStorage.getItem('mdsh:collection-views'));
	const names = (JSON.parse(after ?? '[]') as Array<{ name: string }>).map((view) => view.name);
	expect(names).toEqual(['Existing', 'New']);

	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	await openCollection(page);
	await expect(page.getByTestId('collection-views')).toContainText('Existing');
	await expect(page.getByTestId('collection-views')).toContainText('New');
	expect(failures).toEqual([]);
	expect(await rejections()).toEqual([]);

	const result = {
		fixture: { notes: files.length },
		result: {
			readFailureShown: true,
			readOnlyTableRows: 3,
			storedBefore: JSON.parse(before ?? '[]'),
			storedAfter: names,
			pageErrors: failures,
			unhandledRejections: await rejections()
		}
	};
	await writeArtifact('collection-view-read-failure.json', result);
	await info.attach('collection-view-read-failure.json', {
		body: JSON.stringify(result, null, 2),
		contentType: 'application/json'
	});
});

test('does not overwrite a valid JSON non-array saved-view value', async ({
	page
}, info: TestInfo) => {
	const { failures, rejections } = await trackCollectionFailures(page);
	await resetAppState(page);
	await seedFiles(page, files);
	const raw = JSON.stringify({ format: 'foreign', entries: [{ id: 'kept', name: 'Kept' }] });
	await page.evaluate((value) => localStorage.setItem('mdsh:collection-views', value), raw);
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	await openCollection(page);

	const field = page.getByRole('textbox', { name: 'Nom de la vue' });
	const save = page.getByTestId('collection-save-view');
	const selector = page.getByTestId('collection-views');
	const error = page.getByTestId('collection-views-error');
	const stored = () => page.evaluate(() => localStorage.getItem('mdsh:collection-views'));

	await expect(error).toContainText('stockage');
	await expect(selector.locator('option')).toHaveCount(1);
	await expect(page.getByTestId('collection-table')).toContainText('Alpha');
	expect(await stored()).toBe(raw);

	await field.fill('New');
	await save.click();
	await expect(error).toContainText('stockage');
	await expect(selector).not.toContainText('New');
	expect(await stored()).toBe(raw);

	const existing = {
		id: 'kept',
		name: 'Kept',
		filter: '',
		sortKey: 'title',
		sortDirection: 'asc',
		groupKey: '',
		mode: 'table'
	};
	await page.evaluate(
		(value) => localStorage.setItem('mdsh:collection-views', JSON.stringify([value])),
		existing
	);
	await save.click();
	await expect(error).toHaveCount(0);
	await expect(selector).toContainText('Kept');
	await expect(selector).toContainText('New');
	const after = JSON.parse((await stored()) ?? '[]') as Array<{ name: string }>;
	expect(after.map((view) => view.name)).toEqual(['Kept', 'New']);

	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	await openCollection(page);
	await expect(page.getByTestId('collection-views')).toContainText('Kept');
	await expect(page.getByTestId('collection-views')).toContainText('New');
	expect(failures).toEqual([]);
	expect(await rejections()).toEqual([]);

	const result = {
		fixture: { notes: files.length, storedValue: raw },
		result: {
			nonArrayUnreadable: true,
			rawPreserved: true,
			repairedNames: after.map((view) => view.name),
			pageErrors: failures,
			unhandledRejections: await rejections()
		}
	};
	await writeArtifact('collection-view-non-array.json', result);
	await info.attach('collection-view-non-array.json', {
		body: JSON.stringify(result, null, 2),
		contentType: 'application/json'
	});
});

test('ignores duplicate stored view IDs', async ({ page }, info: TestInfo) => {
	const { failures, rejections } = await trackCollectionFailures(page);
	await resetAppState(page);
	await seedFiles(page, files);
	await page.evaluate(() => {
		const view = {
			filter: '',
			sortKey: 'title',
			sortDirection: 'asc',
			groupKey: '',
			mode: 'table'
		};
		localStorage.setItem(
			'mdsh:collection-views',
			JSON.stringify([
				{ ...view, id: 'duplicate', name: 'First copy' },
				{ ...view, id: 'duplicate', name: 'Second copy' },
				{ ...view, id: 'unique', name: 'Unique' }
			])
		);
	});
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	await openCollection(page);

	const selector = page.getByTestId('collection-views');
	await expect(selector.locator('option')).toHaveCount(3);
	await expect(selector).toContainText('First copy');
	await expect(selector).not.toContainText('Second copy');
	await selector.selectOption('unique');
	await page.getByRole('button', { name: 'Supprimer la vue' }).click();
	await expect(selector.locator('option')).toHaveCount(2);
	await expect(selector).toContainText('First copy');
	const after = await page.evaluate(() => localStorage.getItem('mdsh:collection-views'));
	const stored = JSON.parse(after ?? '[]') as Array<{ id: string; name: string }>;
	expect(stored).toHaveLength(1);
	expect(stored[0]?.name).toBe('First copy');
	expect(failures).toEqual([]);
	expect(await rejections()).toEqual([]);

	const result = {
		fixture: { notes: files.length, storedIds: ['duplicate', 'duplicate', 'unique'] },
		result: { rendered: 2, storedAfterDelete: stored, pageErrors: failures }
	};
	await writeArtifact('collection-view-duplicate-ids.json', result);
	await info.attach('collection-view-duplicate-ids.json', {
		body: JSON.stringify(result, null, 2),
		contentType: 'application/json'
	});
});

import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { openPalette, resetAppState, seedFiles } from './helpers';
import { databaseState, importBackup } from './storage-evidence';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

const oneNote = [
	{
		name: 'Alpha',
		content: '---\ntitle: Alpha\ntags: [docs]\nstatus: active\n---\n\n# Alpha\n'
	}
];

const A11Y_NOTE_COUNT = 260;
const A11Y_FIELD_COUNT = 55;
const a11yFields = Array.from(
	{ length: A11Y_FIELD_COUNT },
	(_, index) => `field${String(index).padStart(2, '0')}`
);
const a11yColumns = [...a11yFields, 'priority', 'sequence', 'status', 'title'].sort();

function a11yFixture(now: number) {
	const drafts = Array.from({ length: A11Y_NOTE_COUNT }, (_, index) => ({
		id: `collection-a11y-${index}`,
		name: `Note ${index}.md`,
		content: [
			'---',
			`title: Note ${index}`,
			...a11yFields.map((field, position) => `${field}: value ${index}-${position}`),
			`status: group-${index % 5}`,
			`priority: ${index % 11}`,
			`sequence: ${index}`,
			'---',
			'',
			`# Note ${index}`
		].join('\n'),
		createdAt: now,
		updatedAt: now,
		order: index,
		open: index === 0
	}));
	return {
		format: 'mdsh-backup',
		schemaVersion: 1,
		exportedAt: now,
		drafts,
		workspaces: [
			{
				id: 'collection-a11y-workspace',
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

async function openCollection(page: Page, english = false) {
	if (english) {
		await page.getByRole('button', { name: 'Command palette' }).click();
		const palette = page.getByRole('dialog', { name: 'Command palette' });
		await expect(palette).toBeVisible();
		await palette.getByRole('option', { name: /table and board views/i }).click();
	} else {
		await openPalette(page);
		await page
			.getByRole('dialog', { name: 'Palette de commandes' })
			.getByRole('option', { name: /vues tableau/i })
			.click();
	}
	await expect(page.getByTestId('collection-panel')).toBeVisible();
	await expect(page.getByTestId('collection-table')).toBeVisible();
}

async function writeArtifact(name: string, value: unknown) {
	await mkdir('test-results', { recursive: true });
	await writeFile(
		`test-results/${name}`,
		JSON.stringify(
			{
				command:
					'npx playwright test e2e/collection-accessibility.spec.ts --project=chromium --workers=1 --retries=0',
				sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
				environment: { node: process.version, platform: process.platform, arch: process.arch },
				...((value as Record<string, unknown>) ?? {})
			},
			null,
			2
		)
	);
}

test('keeps a persistent accessible name on the view name field', async ({
	page
}, info: TestInfo) => {
	await page.setViewportSize({ width: 520, height: 720 });
	await resetAppState(page);
	await seedFiles(page, oneNote);
	await openCollection(page);

	const field = page.getByLabel('Nom de la vue', { exact: true });
	await expect(field).toBeVisible();
	await expect(field).toHaveValue('');
	await expect
		.poll(() =>
			field.evaluate((element) =>
				Array.from(element.labels ?? []).map((label) => label.textContent?.trim())
			)
		)
		.toEqual(['Nom de la vue']);
	await expect(field).toHaveAccessibleName('Nom de la vue');

	await field.fill('Vue accessibilité');
	await expect(page.getByRole('textbox', { name: 'Nom de la vue' })).toHaveValue(
		'Vue accessibilité'
	);
	await page.getByTestId('collection-save-view').click();
	await expect(page.getByTestId('collection-views')).toContainText('Vue accessibilité');

	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	await openCollection(page);
	const restored = page.getByRole('textbox', { name: 'Nom de la vue' });
	await expect(restored).toBeVisible();
	await expect(restored).toHaveValue('');
	const selector = page.getByTestId('collection-views');
	await expect(selector).toContainText('Vue accessibilité');
	const saveButton = page.getByTestId('collection-save-view');
	const deleteButton = page.getByRole('button', { name: 'Supprimer la vue' });

	await selector.selectOption({ label: 'Vue accessibilité' });
	await expect(deleteButton).toBeVisible();
	await selector.focus();
	await page.keyboard.press('Tab');
	await expect(restored).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(saveButton).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(deleteButton).toBeFocused();

	const tableBounds = await field.evaluate((element) => {
		const rect = element.getBoundingClientRect();
		return { left: rect.left, right: rect.right, width: rect.width };
	});
	expect(tableBounds.left).toBeGreaterThanOrEqual(0);
	expect(tableBounds.right).toBeLessThanOrEqual(520);

	await page.setViewportSize({ width: 400, height: 720 });
	await page.getByRole('button', { name: 'Tableau blanc' }).click();
	await expect(page.getByTestId('collection-board')).toBeVisible();
	await expect(restored).toHaveAccessibleName('Nom de la vue');
	await selector.focus();
	await page.keyboard.press('Tab');
	await expect(restored).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(saveButton).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(deleteButton).toBeFocused();

	const boardBounds = await field.evaluate((element) => {
		const rect = element.getBoundingClientRect();
		return { left: rect.left, right: rect.right, width: rect.width };
	});
	expect(boardBounds.left).toBeGreaterThanOrEqual(0);
	expect(boardBounds.right).toBeLessThanOrEqual(400);

	// A 200 percent CSS zoom keeps the same focus order and a visible field.
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.evaluate(() => {
		document.documentElement.style.zoom = '2';
	});
	await expect(restored).toHaveAccessibleName('Nom de la vue');
	await selector.focus();
	await page.keyboard.press('Tab');
	await expect(restored).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(saveButton).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(deleteButton).toBeFocused();
	const zoomBounds = await field.evaluate((element) => {
		const rect = element.getBoundingClientRect();
		return { left: rect.left, right: rect.right, width: rect.width };
	});
	expect(zoomBounds.width).toBeGreaterThan(0);
	expect(zoomBounds.left).toBeGreaterThanOrEqual(0);
	expect(zoomBounds.right).toBeLessThanOrEqual(1280);

	// The table view keeps the same traversal at a narrow phone width.
	await page.evaluate(() => {
		document.documentElement.style.zoom = '';
	});
	await page.setViewportSize({ width: 375, height: 720 });
	await page.getByRole('button', { name: 'Tableau', exact: true }).click();
	await expect(page.getByTestId('collection-table')).toBeVisible();
	await selector.focus();
	await page.keyboard.press('Tab');
	await expect(restored).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(saveButton).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(deleteButton).toBeFocused();
	const narrowBounds = await field.evaluate((element) => {
		const rect = element.getBoundingClientRect();
		return { left: rect.left, right: rect.right, width: rect.width };
	});
	expect(narrowBounds.width).toBeGreaterThan(0);
	expect(narrowBounds.left).toBeGreaterThanOrEqual(0);
	expect(narrowBounds.right).toBeLessThanOrEqual(375);

	await writeArtifact('collection-view-name-label.json', {
		fixture: {
			notes: oneNote.length,
			tableViewport: '520x720',
			boardViewport: '400x720',
			narrowViewport: '375x720',
			zoom: '200 percent CSS zoom at 1280x900'
		},
		result: {
			accessibleName: 'Nom de la vue',
			tableTraversal: ['savedViews', 'viewName', 'saveView', 'deleteView'],
			boardTraversal: ['savedViews', 'viewName', 'saveView', 'deleteView'],
			zoomTraversal: ['savedViews', 'viewName', 'saveView', 'deleteView'],
			narrowTraversal: ['savedViews', 'viewName', 'saveView', 'deleteView'],
			tableBounds,
			boardBounds,
			zoomBounds,
			narrowBounds,
			restoredValue: await restored.inputValue()
		}
	});
	await info.attach('collection-view-name-label.json', {
		body: JSON.stringify({ tableBounds, boardBounds, zoomBounds, narrowBounds }, null, 2),
		contentType: 'application/json'
	});
});

test('keeps the view name label in English', async ({ page }, info: TestInfo) => {
	await resetAppState(page);
	await seedFiles(page, oneNote);
	await page.evaluate(() => localStorage.setItem('mdsh:locale', 'en'));
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	await openCollection(page, true);

	const field = page.getByLabel('View name', { exact: true });
	await expect(field).toBeVisible();
	await expect
		.poll(() =>
			field.evaluate((element) =>
				Array.from(element.labels ?? []).map((label) => label.textContent?.trim())
			)
		)
		.toEqual(['View name']);
	await expect(field).toHaveAccessibleName('View name');
	await field.fill('English view');
	await expect(page.getByRole('textbox', { name: 'View name' })).toHaveValue('English view');
	await page.getByTestId('collection-save-view').click();
	await expect(page.getByTestId('collection-views')).toContainText('English view');

	await info.attach('collection-view-name-label-en.json', {
		body: JSON.stringify({ accessibleName: 'View name', value: 'English view' }, null, 2),
		contentType: 'application/json'
	});
});

test('reports logical ARIA indices in the virtualized table', async ({ page }, info: TestInfo) => {
	test.setTimeout(180_000);
	const failures: string[] = [];
	page.on('pageerror', (error) => failures.push(error.message));
	await resetAppState(page);
	await importBackup(page, a11yFixture(Date.now()));
	await expect.poll(async () => (await databaseState(page)).drafts.length).toBe(A11Y_NOTE_COUNT);
	await page.keyboard.press('Escape');
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	await openCollection(page);

	const table = page.getByTestId('collection-table');
	await expect(table).toBeVisible({ timeout: 180_000 });
	await page.getByTestId('collection-sort').selectOption('sequence');
	await expect(table.locator('tbody tr').first()).toContainText('Note 0');

	await expect(table).toHaveAttribute('aria-rowcount', String(A11Y_NOTE_COUNT + 1));
	await expect(table).toHaveAttribute('aria-colcount', String(a11yColumns.length + 1));
	const headerRow = table.locator('thead tr');
	await expect(headerRow).toHaveAttribute('aria-rowindex', '1');

	const body = page.locator('.collection-body');
	await body.evaluate((element) => {
		element.scrollLeft = 26 * 140;
	});
	await expect
		.poll(async () => (await table.locator('thead th').allTextContents()).includes('field32'))
		.toBe(true);

	const headers = await table.locator('thead th').evaluateAll((cells) =>
		cells.map((cell) => ({
			text: cell.textContent?.trim() ?? '',
			index: cell.getAttribute('aria-colindex'),
			hidden: cell.getAttribute('aria-hidden')
		}))
	);
	expect(headers[0]?.index).toBe('1');
	const renderedHeaders = headers.slice(1).filter((header) => header.hidden !== 'true');
	const yamlHeaderIndices = renderedHeaders.map((header) => Number(header.index));
	const expectedHeaderIndices = renderedHeaders.map(
		(header) => 2 + a11yColumns.indexOf(header.text)
	);
	expect(renderedHeaders[0]?.text).not.toBe('field00');
	expect(yamlHeaderIndices).toEqual(expectedHeaderIndices);
	expect(yamlHeaderIndices[0]).toBeGreaterThan(2);
	expect(
		headers.filter((header) => header.hidden === 'true').every((header) => header.index === null)
	).toBe(true);

	const firstRowCells = await table
		.locator('tbody tr:not(.spacer)')
		.first()
		.evaluate((row) =>
			Array.from(row.children).map((cell) => ({
				index: cell.getAttribute('aria-colindex'),
				hidden: cell.getAttribute('aria-hidden')
			}))
		);
	const renderedCells = firstRowCells.filter((cell) => cell.hidden !== 'true');
	expect(renderedCells[0]?.index).toBe('1');
	expect(renderedCells.slice(1).map((cell) => Number(cell.index))).toEqual(yamlHeaderIndices);
	expect(
		firstRowCells.filter((cell) => cell.hidden === 'true').every((cell) => cell.index === null)
	).toBe(true);

	await body.evaluate((element) => {
		element.scrollTop = element.scrollHeight;
	});
	const rows = table.locator('tbody tr:not(.spacer)');
	await expect(rows.last()).toContainText('Note 259');
	await expect(headerRow).toHaveAttribute('aria-rowindex', '1');
	const rowData = await rows.evaluateAll((elements) =>
		elements.map((row) => ({
			index: row.getAttribute('aria-rowindex'),
			title: row.querySelector('th button')?.textContent?.trim() ?? ''
		}))
	);
	expect(rowData.length).toBeGreaterThan(10);
	for (const row of rowData) {
		const note = Number(row.title.replace('Note ', ''));
		expect(Number.isFinite(note)).toBe(true);
		expect(row.index).toBe(String(note + 2));
	}
	expect(Number(rowData[0]?.index)).toBeGreaterThan(200);

	const spacerRows = table.locator('tbody tr.spacer');
	for (let index = 0; index < (await spacerRows.count()); index += 1) {
		await expect(spacerRows.nth(index)).toHaveAttribute('aria-hidden', 'true');
		await expect(spacerRows.nth(index)).not.toHaveAttribute('aria-rowindex');
	}

	const snapshot = await table.ariaSnapshot();
	expect(snapshot).toContain('Note 259');

	await page.getByTestId('collection-filter').fill('value 0-0');
	await expect(table).toHaveAttribute('aria-rowcount', '2');
	await expect(headerRow).toHaveAttribute('aria-rowindex', '1');
	const filteredRows = table.locator('tbody tr:not(.spacer)');
	await expect(filteredRows).toHaveCount(1);
	await expect(filteredRows.first()).toHaveAttribute('aria-rowindex', '2');
	const filteredHeaders = await table.locator('thead th').evaluateAll((cells) =>
		cells.map((cell) => ({
			index: cell.getAttribute('aria-colindex'),
			hidden: cell.getAttribute('aria-hidden')
		}))
	);
	const filteredYaml = filteredHeaders.slice(1).filter((header) => header.hidden !== 'true');
	expect(filteredHeaders[0]?.index).toBe('1');
	expect(Number(filteredYaml[0]?.index)).toBe(2);

	await page.getByTestId('collection-filter').fill('');
	await expect(table).toHaveAttribute('aria-rowcount', String(A11Y_NOTE_COUNT + 1));
	await page.setViewportSize({ width: 900, height: 640 });
	await expect(headerRow).toHaveAttribute('aria-rowindex', '1');
	await expect(table).toHaveAttribute('aria-colcount', String(a11yColumns.length + 1));
	const resizedHeaders = await table.locator('thead th').evaluateAll((cells) =>
		cells.map((cell) => ({
			text: cell.textContent?.trim() ?? '',
			index: cell.getAttribute('aria-colindex'),
			hidden: cell.getAttribute('aria-hidden')
		}))
	);
	const resizedYaml = resizedHeaders.slice(1).filter((header) => header.hidden !== 'true');
	expect(resizedHeaders[0]?.index).toBe('1');
	expect(resizedYaml.map((header) => Number(header.index))).toEqual(
		resizedYaml.map((header) => 2 + a11yColumns.indexOf(header.text))
	);

	const visibleHeaders = () =>
		table.locator('thead th').evaluateAll((cells) =>
			cells
				.filter((cell) => cell.getAttribute('aria-hidden') !== 'true')
				.map((cell) => ({
					text: cell.textContent?.trim() ?? '',
					index: Number(cell.getAttribute('aria-colindex'))
				}))
		);
	const expectLogicalHeaderIndices = (headers: Array<{ text: string; index: number }>) => {
		expect(headers[0]?.index).toBe(1);
		expect(headers.slice(1).map((header) => header.index)).toEqual(
			headers.slice(1).map((header) => 2 + a11yColumns.indexOf(header.text))
		);
	};

	// Keep the logical indices correct when a resize and a sort follow an
	// off-screen column window. The earlier resize ran after the filter reset
	// the window to the first group.
	await body.evaluate((element) => {
		element.scrollLeft = 26 * 140;
	});
	await expect
		.poll(async () => (await table.locator('thead th').allTextContents()).includes('field32'))
		.toBe(true);
	const windowedHeaders = await visibleHeaders();
	expect(windowedHeaders.slice(1)[0]?.text).not.toBe('field00');
	expect(windowedHeaders.slice(1)[0]?.index).toBeGreaterThan(2);
	expectLogicalHeaderIndices(windowedHeaders);

	await page.setViewportSize({ width: 1280, height: 800 });
	const resizeAfterScroll = await visibleHeaders();
	expect(resizeAfterScroll.slice(1)[0]?.text).not.toBe('field00');
	expectLogicalHeaderIndices(resizeAfterScroll);
	await page.setViewportSize({ width: 640, height: 720 });
	const narrowAfterScroll = await visibleHeaders();
	expect(narrowAfterScroll.slice(1)[0]?.text).not.toBe('field00');
	expectLogicalHeaderIndices(narrowAfterScroll);

	await page.getByTestId('collection-sort').selectOption('field10');
	await expect
		.poll(async () => (await table.locator('thead th').allTextContents()).includes('field00'))
		.toBe(true);
	const sortedHeaders = await visibleHeaders();
	expectLogicalHeaderIndices(sortedHeaders);
	expect(sortedHeaders.slice(1)[0]?.index).toBe(2);
	await expect(table).toHaveAttribute('aria-rowcount', String(A11Y_NOTE_COUNT + 1));
	await expect(table.locator('tbody tr:not(.spacer)').first()).toHaveAttribute(
		'aria-rowindex',
		'2'
	);

	await body.evaluate((element) => {
		element.scrollLeft = element.scrollWidth;
	});
	await expect
		.poll(async () => (await table.locator('thead th').allTextContents()).includes('title'))
		.toBe(true);
	const rescrolledHeaders = await visibleHeaders();
	expectLogicalHeaderIndices(rescrolledHeaders);
	expect(rescrolledHeaders.slice(1)[0]?.text).not.toBe('field00');

	// Spacer cells and rows stay out of the accessibility tree and carry no
	// logical position or text.
	const spacerCells = await table.locator('th.spacer, td.spacer').evaluateAll((cells) =>
		cells.map((cell) => ({
			text: cell.textContent?.trim() ?? '',
			index: cell.getAttribute('aria-colindex'),
			hidden: cell.getAttribute('aria-hidden')
		}))
	);
	expect(spacerCells.length).toBeGreaterThan(0);
	for (const spacer of spacerCells) {
		expect(spacer.text).toBe('');
		expect(spacer.index).toBeNull();
		expect(spacer.hidden).toBe('true');
	}
	const spacerRowData = await table.locator('tr.spacer').evaluateAll((elements) =>
		elements.map((element) => ({
			text: element.textContent?.trim() ?? '',
			index: element.getAttribute('aria-rowindex'),
			hidden: element.getAttribute('aria-hidden')
		}))
	);
	for (const spacer of spacerRowData) {
		expect(spacer.text).toBe('');
		expect(spacer.index).toBeNull();
		expect(spacer.hidden).toBe('true');
	}

	const windowSnapshot = await table.ariaSnapshot();
	const snapshotHeaders = windowSnapshot
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.startsWith('- columnheader'))
		.map((line) => line.replace(/^- columnheader\s+/, '').replace(/^"|"$/g, ''));
	expect(snapshotHeaders).toEqual(rescrolledHeaders.map((header) => header.text));
	expect(snapshotHeaders).not.toContain('');
	expect(windowSnapshot).not.toContain('field00');

	// Keyboard activation opens the logical row that the virtual window shows.
	const headerRowIndex = await headerRow.getAttribute('aria-rowindex');
	const firstVisibleRow = table.locator('tbody tr:not(.spacer)').first();
	const firstVisibleTitle = (await firstVisibleRow.locator('th button').innerText()).trim();
	const firstVisibleNote = Number(firstVisibleTitle.replace('Note ', ''));
	expect(Number.isFinite(firstVisibleNote)).toBe(true);
	await expect(firstVisibleRow).toHaveAttribute('aria-rowindex', String(firstVisibleNote + 2));
	await expect(firstVisibleRow.locator('th[scope="row"]')).toHaveAttribute('aria-colindex', '1');
	const rowButton = firstVisibleRow.locator('th button');
	await rowButton.focus();
	await expect(rowButton).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(page.getByTestId('collection-panel')).toHaveCount(0);
	await expect(page.locator('.cm-content')).toContainText(`title: Note ${firstVisibleNote}`);
	expect(failures).toEqual([]);

	const result = {
		fixture: { notes: A11Y_NOTE_COUNT, fields: A11Y_FIELD_COUNT },
		result: {
			rowcount: A11Y_NOTE_COUNT + 1,
			colcount: a11yColumns.length + 1,
			headerRowIndex,
			firstRenderedYamlHeader: renderedHeaders[0]?.text,
			yamlHeaderIndices,
			rowSamples: rowData.slice(0, 3),
			rowWindowFirst: rowData[0]?.index,
			filteredRowcount: 2,
			filteredFirstColumnIndex: filteredYaml[0]?.index,
			resizedColumnCount: resizedHeaders.length,
			windowedHeaders,
			resizeAfterScroll,
			narrowAfterScroll,
			sortedHeaders,
			rescrolledHeaders,
			spacerCells: spacerCells.length,
			spacerRows: spacerRowData.length,
			snapshotHeaders,
			keyboardActivatedNote: firstVisibleNote,
			pageErrors: failures
		}
	};
	await writeArtifact('collection-aria-indices.json', result);
	await info.attach('collection-aria-indices.json', {
		body: JSON.stringify(result, null, 2),
		contentType: 'application/json'
	});
	await info.attach('collection-aria-tree.yaml', { body: snapshot, contentType: 'text/yaml' });
	await info.attach('collection-aria-window-tree.yaml', {
		body: windowSnapshot,
		contentType: 'text/yaml'
	});
});

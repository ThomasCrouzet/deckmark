import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resetAppState } from './helpers';
import { exportSource, importSource } from './source-fidelity-harness';

// Issue #572: an ordinary text edit inside one list item or one table cell must
// keep a bounded source restoration. A whole-source parse or normalization for
// that edit is the failure this case keeps.
//
// The same workflow proves the #569 correctness boundary: the saved and
// exported bytes, the embedded image identity, the caret, undo and redo, and
// the large-document confirmation stay identical to the accepted source.

interface EditRecord {
	documentId: string;
	revision: number;
	space: string;
	kind: string;
	previous: { from: number; to: number };
	next: { from: number; to: number };
}

interface StageRecord {
	name: string;
	value: number;
	start: number;
	end: number;
}

interface Probe {
	counters: Record<string, number>;
	stages: StageRecord[];
	edits: EditRecord[];
}

type Row = { content: string; length: number };

declare global {
	interface Window {
		__containerProbe?: Probe;
	}
}

const listTarget = 'List item 2100 keeps stable container words';
const tableTarget = 'stable cell 900 target middle word';

/** A 1x1 PNG that stays byte-identical through the edit. */
const image =
	'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const imageToken = `![Figure](${image})`;

/**
 * A note above the 256 Ki character confirmation threshold. The list and the
 * table are each large enough that a whole-container parse is visible in the
 * stage record. Filler prose keeps the document representative.
 */
function containerNote(): string {
	const lines: string[] = [
		'---',
		'title: Container source publication',
		'tags: [performance, container]',
		'---',
		'',
		'# Container note',
		'',
		'Opening paragraph keeps the first view stable.',
		'',
		imageToken,
		'',
		'## Large list',
		''
	];
	for (let index = 0; index < 3_000; index += 1) {
		lines.push(`- List item ${index} keeps stable container words in this note.`);
	}
	lines.push('', '## Wide table', '', '| key | value | note |', '| --- | --- | --- |');
	for (let index = 0; index < 1_400; index += 1) {
		lines.push(
			index === 900
				? `| row ${index} | value ${index} | stable cell ${index} target middle word |`
				: `| row ${index} | value ${index} | stable cell ${index} |`
		);
	}
	lines.push('', '## Filler');
	for (let index = 0; index < 1_600; index += 1) {
		lines.push('', `Filler paragraph ${index} keeps ordinary prose for the same viewport.`);
	}
	lines.push('', '## Tail', '', 'Tail paragraph keeps the caret target.');
	return `${lines.join('\n')}\n`;
}

async function installProbe(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const probe: Probe = { counters: {}, stages: [], edits: [] };
		(window as unknown as { __containerProbe: Probe }).__containerProbe = probe;
		const record = (name: string) => {
			probe.counters[name] = (probe.counters[name] ?? 0) + 1;
		};
		window.addEventListener(
			'deckmark:editor-perf',
			(event) => {
				const detail = (
					event as CustomEvent<{
						kind: string;
						name?: string;
						value?: number;
						start?: number;
						end?: number;
						edit?: EditRecord;
					}>
				).detail;
				if (detail.kind === 'counter') {
					record(detail.name ?? '');
					return;
				}
				if (detail.kind === 'edit') {
					if (detail.edit) probe.edits.push(detail.edit);
					return;
				}
				if (detail.kind !== 'duration' || detail.value === undefined) return;
				const end = detail.end ?? performance.now();
				probe.stages.push({
					name: detail.name ?? '',
					value: detail.value,
					start: detail.start ?? end - detail.value,
					end
				});
			},
			true
		);
		window.addEventListener(
			'deckmark:source-fidelity',
			(event) => {
				record(`sourceFidelityPath:${(event as CustomEvent<string>).detail}`);
			},
			true
		);
	});
}

async function resetProbe(page: Page): Promise<void> {
	await page.evaluate(() => {
		const probe = window.__containerProbe;
		if (!probe) return;
		probe.counters = {};
		probe.stages = [];
		probe.edits = [];
	});
}

async function readProbe(page: Page): Promise<Probe> {
	return page.evaluate(() => structuredClone(window.__containerProbe!));
}

async function storedRow(page: Page, name: string): Promise<Row> {
	return page.evaluate(
		(fileName) =>
			new Promise<Row>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const list = database.transaction('drafts').objectStore('drafts').getAll();
					list.onsuccess = () => {
						database.close();
						const row = (list.result as Array<{ name?: string; content?: string }>).find(
							(entry) => entry.name === fileName
						);
						const content = row?.content ?? '';
						resolve({ content, length: content.length });
					};
					list.onerror = () => {
						database.close();
						reject(list.error);
					};
				};
			}),
		name
	);
}

async function waitForDurable(page: Page, name: string, expected: string): Promise<void> {
	await expect
		.poll(async () => (await storedRow(page, name)).content, {
			timeout: 60_000,
			message: 'the durable row must hold the exact source'
		})
		.toBe(expected);
}

async function placeCaretAtEnd(page: Page, text: string): Promise<void> {
	const editor = page.locator('.ProseMirror');
	await editor.evaluate((root, target) => {
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		const nodes: Array<{ node: Node; from: number; to: number }> = [];
		let content = '';
		let node: Node | null;
		while ((node = walker.nextNode())) {
			const from = content.length;
			content += node.textContent;
			nodes.push({ node, from, to: content.length });
		}
		const index = content.indexOf(target);
		if (index < 0) throw new Error(`Target not found: ${target}`);
		const end = index + target.length;
		const last = nodes.find(({ from, to }) => from < end && to >= end)!;
		const range = document.createRange();
		range.setStart(last.node, end - last.from);
		range.collapse(true);
		(root as HTMLElement).focus();
		const selection = window.getSelection()!;
		selection.removeAllRanges();
		selection.addRange(range);
	}, text);
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			)
	);
	await expect
		.poll(() => page.evaluate(() => window.getSelection()?.isCollapsed ?? false))
		.toBe(true);
}

async function caretState(page: Page): Promise<{
	collapsed: boolean;
	inEditor: boolean;
	before: string;
	after: string;
}> {
	return page.evaluate(() => {
		const selection = window.getSelection();
		if (!selection) return { collapsed: false, inEditor: false, before: '', after: '' };
		const editor = document.querySelector('.ProseMirror');
		const node = selection.anchorNode;
		const text = node?.textContent ?? '';
		return {
			collapsed: selection.isCollapsed,
			inEditor: Boolean(editor && node && editor.contains(node)),
			before: text.slice(0, selection.anchorOffset),
			after: text.slice(selection.anchorOffset)
		};
	});
}

function imageIdentity(source: string): string | null {
	const match = /!\[[^\]]*\]\(([^)]*)\)/.exec(source);
	return match ? createHash('sha256').update(match[0]).digest('hex') : null;
}

async function stageTotal(probe: Probe, name: string): Promise<number> {
	return probe.stages
		.filter((stage) => stage.name === name)
		.reduce((total, stage) => total + stage.value, 0);
}

test.use({ locale: 'fr-FR', reducedMotion: 'reduce', trace: 'off', serviceWorkers: 'block' });

test('a list item and a table cell edit stay local and keep every byte', async ({ page }, info) => {
	test.slow();
	test.setTimeout(600_000);
	await installProbe(page);
	await resetAppState(page, { mode: 'source' });
	const source = containerNote();
	const fileName = 'container-note.md';
	await importSource(page, source, 'container-note');

	// A document above the confirmation threshold keeps its confirmation.
	await page.locator('[data-mode=wysiwyg]').click();
	const confirmation = page.getByRole('dialog', { name: 'Afficher ce document volumineux ?' });
	await expect(confirmation, 'the large-document confirmation must still appear').toBeVisible({
		timeout: 30_000
	});
	await confirmation.getByRole('button', { name: 'Afficher le document', exact: true }).click();
	await expect(page.locator('.ProseMirror')).toHaveAttribute('contenteditable', 'true', {
		timeout: 240_000
	});
	await resetProbe(page);

	const identity = imageIdentity(source);
	expect(identity, 'the fixture must carry one embedded image').not.toBeNull();

	// Edit one item of the large list.
	await placeCaretAtEnd(page, listTarget);
	await page.keyboard.insertText('X');
	const listEdited = source.replace(listTarget, `${listTarget}X`);
	await waitForDurable(page, fileName, listEdited);
	const listProbe = await readProbe(page);
	const listCaret = await caretState(page);
	const listStages = {
		scopeAttemptMs: await stageTotal(listProbe, 'sourceFidelityScopeAttempt'),
		fullMs: await stageTotal(listProbe, 'sourceFidelityFull'),
		restoreMs: await stageTotal(listProbe, 'restoreMarkdown')
	};
	expect(
		await page.getByRole('dialog').count(),
		'no extra confirmation may appear during the list edit'
	).toBe(0);

	// Undo must return the exact seed, and redo must return the exact edit.
	await page.keyboard.press('Control+z');
	await waitForDurable(page, fileName, source);
	await page.keyboard.press('Control+Shift+z');
	await waitForDurable(page, fileName, listEdited);

	// Edit one cell of the wide table.
	await placeCaretAtEnd(page, tableTarget);
	await page.keyboard.insertText('Y');
	const tableEdited = listEdited.replace(tableTarget, `${tableTarget}Y`);
	await waitForDurable(page, fileName, tableEdited);
	const tableProbe = await readProbe(page);
	const tableCaret = await caretState(page);
	const tableStages = {
		scopeAttemptMs: await stageTotal(tableProbe, 'sourceFidelityScopeAttempt'),
		fullMs: await stageTotal(tableProbe, 'sourceFidelityFull'),
		restoreMs: await stageTotal(tableProbe, 'restoreMarkdown')
	};
	expect(
		await page.getByRole('dialog').count(),
		'no extra confirmation may appear during the table edit'
	).toBe(0);

	const exported = await exportSource(page, fileName, 30_000);
	const exportedIdentity = imageIdentity(exported);

	// The mode switch must keep the accepted bytes and the caret target.
	await page.locator('[data-mode=source]').click();
	await expect(page.locator('.cm-content').first()).toBeVisible({ timeout: 60_000 });
	const afterSwitch = await exportSource(page, fileName, 30_000);

	const evidence = {
		schema: 'deckmark-container-source-publication/1',
		command: `npx playwright test e2e/container-source-publication.spec.ts --project=${info.project.name} --workers=1 --retries=0`,
		fixture: {
			name: fileName,
			chars: source.length,
			bytes: Buffer.byteLength(source),
			listItems: 3_000,
			tableRows: 1_400,
			embeddedImages: 1,
			imageSha256: identity
		},
		confirmation: { shown: true, accepted: true, extraDuringEdits: 0 },
		edits: [
			{
				id: 'list-edit',
				target: listTarget,
				inserted: 'X',
				route: listProbe.counters,
				stages: listStages,
				caret: listCaret,
				acceptedEdits: listProbe.edits,
				undoExact: true,
				redoExact: true
			},
			{
				id: 'table-edit',
				target: tableTarget,
				inserted: 'Y',
				route: tableProbe.counters,
				stages: tableStages,
				caret: tableCaret,
				acceptedEdits: tableProbe.edits
			}
		],
		bytes: {
			expectedChars: tableEdited.length,
			exportedChars: exported.length,
			exportedExact: exported === tableEdited,
			afterSwitchExact: afterSwitch === tableEdited,
			imageIdentityKept: exportedIdentity === identity
		},
		environments: [
			{
				id: 'source-only',
				status: 'not-tested',
				reason: 'This artifact records a browser run. The module source review is separate.'
			},
			{
				id: 'node-isolated',
				status: 'not-tested',
				reason:
					'npx vitest run src/lib/source-fidelity.test.ts --maxWorkers=1 records the bounded parser input.'
			},
			{
				id: 'desktop-browser',
				status: 'tested',
				reason: `Playwright project ${info.project.name}.`
			},
			{
				id: 'emulated-mobile',
				status: 'not-tested',
				reason: 'This case does not select a mobile project.'
			},
			{
				id: 'installed-pwa',
				status: 'not-tested',
				reason: 'Playwright does not install a PWA or reproduce its lifecycle.'
			},
			{
				id: 'physical-native',
				status: 'not-tested',
				reason: 'No physical iOS device and no optimized native WebView are attached.'
			}
		]
	};
	const reportPath = info.outputPath('container-source-publication.json');
	await writeFile(reportPath, JSON.stringify(evidence, null, 2));
	await info.attach('container-source-publication.json', {
		path: reportPath,
		contentType: 'application/json'
	});
	console.log(
		JSON.stringify({
			project: info.project.name,
			list: { route: listProbe.counters, stages: listStages },
			table: { route: tableProbe.counters, stages: tableStages },
			exportedExact: exported === tableEdited,
			imageIdentityKept: exportedIdentity === identity
		})
	);

	expect(
		listProbe.counters.sourceFidelityScoped ?? 0,
		'the list edit must stay local'
	).toBeGreaterThan(0);
	expect(
		listProbe.counters.sourceFidelityFull ?? 0,
		'the list edit must not parse the whole source'
	).toBe(0);
	expect(
		listProbe.counters['sourceFidelityPath:fullSerializer'] ?? 0,
		'the list edit must not use the full serializer fallback'
	).toBe(0);
	expect(
		listProbe.counters['sourceFidelityScopedContainer'] ?? 0,
		'the list edit must report the container route'
	).toBeGreaterThan(0);
	expect(
		tableProbe.counters.sourceFidelityScoped ?? 0,
		'the table edit must stay local'
	).toBeGreaterThan(0);
	expect(
		tableProbe.counters.sourceFidelityFull ?? 0,
		'the table edit must not parse the whole source'
	).toBe(0);
	expect(
		tableProbe.counters['sourceFidelityScopedContainer'] ?? 0,
		'the table edit must report the container route'
	).toBeGreaterThan(0);
	expect(listCaret, 'the caret must stay after the inserted list character').toMatchObject({
		collapsed: true,
		inEditor: true
	});
	expect(listCaret.before.endsWith('X'), 'the list caret must follow the inserted character').toBe(
		true
	);
	expect(tableCaret, 'the caret must stay after the inserted cell character').toMatchObject({
		collapsed: true,
		inEditor: true
	});
	expect(
		tableCaret.before.endsWith('Y'),
		'the table caret must follow the inserted character'
	).toBe(true);
	expect(exported, 'the exported source must keep every expected byte').toBe(tableEdited);
	expect(afterSwitch, 'the mode switch must keep every expected byte').toBe(tableEdited);
	expect(exportedIdentity, 'the image identity must stay unchanged').toBe(identity);
	expect(listProbe.edits.at(-1)?.space, 'the list edit must use one accepted span').toBe(
		'editor-markdown'
	);
	expect(tableProbe.edits.at(-1)?.space, 'the table edit must use one accepted span').toBe(
		'editor-markdown'
	);
});

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { resetAppState } from './helpers';

// Issue #709 (work item W1): a table-cell keystroke on a large note must keep
// the positional container route, the incremental serializer cache and the
// scoped image round trip. A whole-document restore for one character is the
// regression this case keeps.
//
// The generated note follows the reported shape: tables with padded cells and
// alignment markers, two adjacent bullet lists that force the serializer to
// alternate list markers, six embedded base64 images and dense prose.
//
// Budgets: publication p95 stays below 150 ms at 600 KB, no long task between
// keys exceeds 250 ms, and every key must report `sourceFidelityScoped`.
// The accepted source must stay byte-exact.

const noteId = 'table-publish-scope';
const target = 'stable cell 40 target words';
const keys = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];
const cadence = 350;
const publishP95Budget = 150;
const longTaskBudget = 250;

type StageSample = { name: string; value: number; start: number; end: number };
type LongTask = { start: number; end: number };
type Probe = {
	counters: Record<string, number>;
	stages: StageSample[];
	longTasks: LongTask[];
};

type Fixture = {
	content: string;
	chars: number;
	bytes: number;
	tableRows: number;
	images: { count: number; encodedBytes: number };
};

async function seedNote(page: Page): Promise<Fixture> {
	return page.evaluate(
		async ({ rowId, target }) => {
			/** A seeded noise field gives a photographic payload, not a flat colour. */
			const photo = (seedValue: number): string => {
				const canvas = document.createElement('canvas');
				canvas.width = 480;
				canvas.height = 360;
				const context = canvas.getContext('2d');
				if (!context) throw new Error('no 2d context');
				const image = context.createImageData(480, 360);
				let seed = seedValue;
				for (let index = 0; index < image.data.length; index += 4) {
					seed = (seed * 1_103_515_245 + 12_345) >>> 0;
					image.data[index] = seed & 0xff;
					image.data[index + 1] = (seed >>> 8) & 0xff;
					image.data[index + 2] = (seed >>> 16) & 0xff;
					image.data[index + 3] = 255;
				}
				context.putImageData(image, 0, 0);
				return canvas.toDataURL('image/jpeg', 0.6);
			};
			let content = '# Performance note\n\nOpening paragraph keeps ordinary prose.\n\n';
			let encodedBytes = 0;
			for (let index = 0; index < 6; index += 1) {
				const uri = photo(0x2f6f4f + index * 977);
				encodedBytes += Math.ceil((uri.length * 3) / 4);
				content += `![Captured screen ${index}](${uri})\n\n`;
			}
			// Two adjacent bullet lists: the source markers differ so the parse
			// keeps two blocks, and the serializer alternates the emitted marker.
			content += '## Lists\n\n';
			for (let index = 0; index < 120; index += 1) {
				content += `- List item ${index} keeps stable container words in this note.\n`;
			}
			content += '\n';
			for (let index = 0; index < 120; index += 1) {
				content += `* Second item ${index} keeps another stable container run.\n`;
			}
			content += '\n## Table\n\n';
			content +=
				'| key                  | value                               | note                     |\n';
			content +=
				'| :------------------- | :---------------------------------- | :----------------------- |\n';
			const tableRows = 70;
			for (let index = 0; index < tableRows; index += 1) {
				const cell = index === 40 ? target : `stable cell ${index}`;
				content += `| row ${index}             | value ${index}                           | ${cell.padEnd(25)}|\n`;
			}
			content += '\n## Filler\n\n';
			let section = 0;
			while (content.length < 600_000) {
				content += `### Section ${section}\n\n${'Ordinary sentence with words that stay the same. '.repeat(8)}\n\n`;
				section += 1;
			}
			content += '\n## Tail\n\nTail paragraph keeps the caret target.\n';
			await new Promise<void>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const transaction = database.transaction('drafts', 'readwrite');
					transaction.objectStore('drafts').put({
						id: rowId,
						name: `${rowId}.md`,
						content,
						createdAt: 1_700_000_000_000,
						updatedAt: 1_700_000_000_000,
						order: 0,
						open: true
					});
					transaction.oncomplete = () => {
						database.close();
						resolve();
					};
					transaction.onerror = () => reject(transaction.error);
				};
			});
			localStorage.setItem('mdsh:activeId', rowId);
			localStorage.setItem('mdsh:locale', 'en');
			return {
				content,
				chars: content.length,
				bytes: new TextEncoder().encode(content).length,
				tableRows,
				images: { count: 6, encodedBytes }
			};
		},
		{ rowId: noteId, target }
	);
}

async function installProbe(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const probe: Probe = { counters: {}, stages: [], longTasks: [] };
		(window as unknown as { __publishScopeProbe: Probe }).__publishScopeProbe = probe;
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
					}>
				).detail;
				if (detail.kind === 'counter') {
					const name = detail.name ?? '';
					probe.counters[name] = (probe.counters[name] ?? 0) + 1;
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
		if (typeof PerformanceObserver !== 'undefined') {
			try {
				new PerformanceObserver((list) => {
					for (const entry of list.getEntries())
						probe.longTasks.push({
							start: entry.startTime,
							end: entry.startTime + entry.duration
						});
				}).observe({ type: 'longtask', buffered: false });
			} catch {
				// The engine does not expose long-task entries.
			}
		}
	});
}

async function resetProbe(page: Page): Promise<void> {
	await page.evaluate(() => {
		const probe = (window as unknown as { __publishScopeProbe: Probe }).__publishScopeProbe;
		probe.counters = {};
		probe.stages = [];
		probe.longTasks = [];
	});
}

async function readProbe(page: Page): Promise<Probe> {
	return page.evaluate(() => {
		const probe = (window as unknown as { __publishScopeProbe: Probe }).__publishScopeProbe;
		return {
			counters: { ...probe.counters },
			stages: probe.stages.map((stage) => ({ ...stage })),
			longTasks: probe.longTasks.map((task) => ({ ...task }))
		};
	});
}

async function storedContent(page: Page, rowId = noteId): Promise<string> {
	return page.evaluate(
		(rowId) =>
			new Promise<string>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const get = database.transaction('drafts').objectStore('drafts').get(rowId);
					get.onsuccess = () => {
						database.close();
						resolve((get.result as { content?: string } | undefined)?.content ?? '');
					};
					get.onerror = () => reject(get.error);
				};
			}),
		rowId
	);
}

async function placeCaretAtCellEnd(page: Page, text = target): Promise<void> {
	await page.locator('.ProseMirror').evaluate((root, text) => {
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		let node: Node | null;
		while ((node = walker.nextNode())) {
			const value = node.textContent ?? '';
			const index = value.indexOf(text);
			if (index < 0) continue;
			const range = document.createRange();
			range.setStart(node, index + text.length);
			range.collapse(true);
			(root as HTMLElement).focus();
			const selection = window.getSelection()!;
			selection.removeAllRanges();
			selection.addRange(range);
			return;
		}
		throw new Error(`Target cell not found: ${text}`);
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

function percentile(values: readonly number[], ratio: number): number {
	if (!values.length) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.ceil(sorted.length * ratio) - 1] ?? 0;
}

function revision(): string {
	try {
		return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
	} catch {
		return 'unknown';
	}
}

async function attachArtifact(info: TestInfo, payload: Record<string, unknown>): Promise<void> {
	const path = info.outputPath('table-publish-scope.json');
	await writeFile(path, JSON.stringify(payload, null, 2));
	await info.attach('table-publish-scope.json', { path, contentType: 'application/json' });
}

test.use({ locale: 'en-US', reducedMotion: 'reduce', trace: 'off', serviceWorkers: 'block' });

test('a table cell edit stays scoped on a 600 KB note with images', async ({ page }, info) => {
	test.slow();
	test.setTimeout(600_000);
	await installProbe(page);
	await resetAppState(page, { mode: 'source' });
	const fixture = await seedNote(page);
	await page.reload();
	await page.locator('[data-mode=wysiwyg]').click();
	const dialog = page.getByRole('dialog', { name: /Render this large document/ });
	await dialog.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {});
	if (await dialog.isVisible().catch(() => false))
		await dialog.getByRole('button', { name: /Render document/ }).click();
	await expect(page.locator('.ProseMirror')).toHaveAttribute('contenteditable', 'true', {
		timeout: 300_000
	});
	await expect
		.poll(() =>
			page.locator('.milkdown-image-block img').evaluateAll((images) =>
				images.every((image) => {
					const target = image as HTMLImageElement;
					return target.complete && target.naturalWidth > 0;
				})
			)
		)
		.toBe(true);
	// Let the mount publication, the durable save and the layout settle so the
	// measured window holds only the typed keys.
	await page.waitForTimeout(2_500);
	await resetProbe(page);
	await placeCaretAtCellEnd(page);

	const from = await page.evaluate(() => performance.now());
	for (const [index, character] of keys.entries()) {
		await page.keyboard.insertText(character);
		if (index < keys.length - 1) await page.waitForTimeout(cadence);
	}
	await page.waitForTimeout(1_500);
	const to = await page.evaluate(() => performance.now());
	const typed = keys.join('');
	const expected = fixture.content.replace(target, `${target}${typed}`);

	await expect
		.poll(async () => storedContent(page), {
			timeout: 120_000,
			message: 'the durable row must keep every byte'
		})
		.toBe(expected);
	await page.waitForTimeout(500);
	const probe = await readProbe(page);

	const publications = probe.stages.filter((stage) => stage.name === 'markdownPublish');
	const publicationValues = publications.map((stage) => stage.value);
	const publicationP50 = percentile(publicationValues, 0.5);
	const publicationP95 = percentile(publicationValues, 0.95);
	const publicationMax = publicationValues.length ? Math.max(...publicationValues) : 0;
	const restoreValues = probe.stages
		.filter((stage) => stage.name === 'restoreMarkdown')
		.map((stage) => stage.value);
	const windowLongTasks = probe.longTasks.filter((task) => task.end >= from && task.start <= to);
	const longestTask = windowLongTasks.reduce(
		(longest, task) => Math.max(longest, task.end - task.start),
		0
	);
	const fullReasons = Object.keys(probe.counters).filter((name) =>
		name.startsWith('sourceFidelityFullReason:')
	);
	const caret = await page.evaluate(() => {
		const selection = window.getSelection();
		const node = selection?.anchorNode;
		const text = node?.textContent ?? '';
		return {
			collapsed: selection?.isCollapsed ?? false,
			inEditor: Boolean(document.querySelector('.ProseMirror')?.contains(node ?? null)),
			before: text.slice(0, selection?.anchorOffset ?? 0)
		};
	});

	const counters = probe.counters;
	const evidence = {
		schema: 'deckmark-table-publish-scope/1',
		command: `npx playwright test e2e/table-publish-scope.spec.ts --project=${info.project.name} --workers=1 --retries=0`,
		revision: revision(),
		environment: {
			project: info.project.name,
			browser: page.context().browser()?.version() ?? 'unknown',
			node: process.version,
			platform: process.platform,
			locale: 'en-US',
			mode: 'Edit'
		},
		fixture: {
			id: noteId,
			chars: fixture.chars,
			bytes: fixture.bytes,
			sha256: createHash('sha256').update(fixture.content).digest('hex'),
			tableRows: fixture.tableRows,
			images: fixture.images,
			shape:
				'padded table with alignment markers, two adjacent bullet lists, six base64 JPEG images, dense prose'
		},
		keys: { count: keys.length, cadenceMs: cadence, typed },
		results: {
			counters,
			fullFallbackReasons: fullReasons,
			publications: publicationValues.map((value) => Math.round(value * 10) / 10),
			publicationP50,
			publicationP95,
			publicationMax,
			restoreMax: restoreValues.length ? Math.max(...restoreValues) : 0,
			longTasks: windowLongTasks.map((task) => Math.round(task.end - task.start)),
			longestLongTask: longestTask,
			savedExact: true,
			savedBytes: Buffer.byteLength(expected),
			caret
		},
		budgets: { publishP95: publishP95Budget, longTask: longTaskBudget }
	};
	await attachArtifact(info, evidence);
	await info.attach('saved-note.md', { body: expected, contentType: 'text/markdown' });
	console.log(
		'[publish-scope]',
		JSON.stringify({
			chars: fixture.chars,
			counters,
			publicationP50,
			publicationP95,
			publicationMax,
			longestTask,
			longTasks: windowLongTasks.length
		})
	);

	// Every typed key must take the positional container route.
	expect(counters.sourceFidelityScoped ?? 0, 'each key must stay scoped').toBeGreaterThanOrEqual(
		keys.length
	);
	expect(counters.sourceFidelityFull ?? 0, 'no key may restore the whole source').toBe(0);
	expect(fullReasons, 'no key may report a whole-document fallback').toEqual([]);
	expect(
		counters.markdownIncrementalFallback ?? 0,
		'no key may collapse the incremental serializer cache'
	).toBe(0);
	expect(
		counters['sourceFidelityScopedContainer'] ?? 0,
		'the table route must run'
	).toBeGreaterThan(0);
	expect(
		counters['sourceFidelityScopedFence'] ?? 0,
		'a table cell is not a fenced code block'
	).toBe(0);
	expect(counters.imageMarkdownFull ?? 0, 'no key may re-fingerprint every embedded image').toBe(0);
	expect(publications.length, 'each key must publish').toBeGreaterThanOrEqual(keys.length);
	expect(publicationP95, 'publication p95 must stay below 150 ms at 600 KB').toBeLessThan(
		publishP95Budget
	);
	expect(longestTask, 'no long task between keys may exceed 250 ms').toBeLessThan(longTaskBudget);
	expect(caret.collapsed && caret.inEditor, 'the caret must stay in the edited cell').toBe(true);
	expect(caret.before.endsWith(typed), 'the caret must follow the typed run').toBe(true);
	expect(
		counters.sourceFidelityScopedHint ?? 0,
		'the edit hint must reach the restore'
	).toBeGreaterThan(0);
});

// Issue #709 (work item W1b): the mixed benchmark notes put a padded table
// directly before a prose line, with no blank line between them. The source
// parser reads that prose line as a one-cell table row, and the serializer
// pads the same row to the header column count. The container route must still
// accept the source form; it must not fall back to the whole document because
// one row holds fewer cells in the source than in the serializer output.
//
// The fixture keeps the padded 64-row table, the adjacent prose line and two
// embedded JPEG images. Four typed keys must all report the container route.

const adjacentId = 'table-publish-scope-adjacent-prose';
const adjacentTarget = 'Adjacent row caret anchor';
const adjacentKeys = ['A', 'B', 'C', 'D'];

async function seedAdjacentProseNote(page: Page): Promise<Fixture> {
	return page.evaluate(
		async ({ rowId, target }) => {
			const photo = (seedValue: number): string => {
				const canvas = document.createElement('canvas');
				canvas.width = 480;
				canvas.height = 360;
				const context = canvas.getContext('2d');
				if (!context) throw new Error('no 2d context');
				const image = context.createImageData(480, 360);
				let seed = seedValue;
				for (let index = 0; index < image.data.length; index += 4) {
					seed = (seed * 1_103_515_245 + 12_345) >>> 0;
					image.data[index] = seed & 0xff;
					image.data[index + 1] = (seed >>> 8) & 0xff;
					image.data[index + 2] = (seed >>> 16) & 0xff;
					image.data[index + 3] = 255;
				}
				context.putImageData(image, 0, 0);
				return canvas.toDataURL('image/jpeg', 0.6);
			};
			let content = '# Mixed note\n\nOpening paragraph keeps ordinary prose.\n\n';
			let encodedBytes = 0;
			for (let index = 0; index < 2; index += 1) {
				const uri = photo(0x51f2c1 + index * 733);
				encodedBytes += Math.ceil((uri.length * 3) / 4);
				content += `![Captured screen ${index}](${uri})\n\n`;
			}
			const header = ['Step', 'Owner', 'Recorded value', 'Note', 'State'];
			const tableRows = 64;
			const markerRow = 21;
			const body: string[][] = [];
			for (let index = 0; index < tableRows; index += 1) {
				body.push([
					String(index + 1),
					`team ${1 + (index % 4)}`,
					`${index}.4`,
					index === markerRow ? target : `row ${index + 1} detail ${index * 7}`,
					index % 3 === 0 ? 'open' : 'done'
				]);
			}
			// Pad every cell to a column width, exactly as the benchmark fixture
			// does. The editor serializer re-pads the changed row on each key.
			const widths = header.map((cell, column) =>
				Math.max(cell.length, ...body.map((row) => row[column]!.length))
			);
			const line = (cells: string[]) =>
				`| ${cells.map((cell, column) => cell.padEnd(widths[column]!)).join(' | ')} |`;
			content += '## Wide table\n\nEvery row below holds five cells.\n\n';
			content += `${[line(header), line(widths.map((width) => '-'.repeat(width))), ...body.map(line)].join('\n')}\n`;
			// The prose line directly after the table, with no blank separator.
			content += 'Values in the table above come from the same review pass.\n\n';
			content += '## Filler\n\n';
			let section = 0;
			while (content.length < 260_000) {
				content += `### Section ${section}\n\n${'Ordinary sentence with words that stay the same. '.repeat(8)}\n\n`;
				section += 1;
			}
			content += '\n## Tail\n\nTail paragraph keeps the caret target.\n';
			await new Promise<void>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const transaction = database.transaction('drafts', 'readwrite');
					transaction.objectStore('drafts').put({
						id: rowId,
						name: `${rowId}.md`,
						content,
						createdAt: 1_700_000_000_000,
						updatedAt: 1_700_000_000_000,
						order: 0,
						open: true
					});
					transaction.oncomplete = () => {
						database.close();
						resolve();
					};
					transaction.onerror = () => reject(transaction.error);
				};
			});
			localStorage.setItem('mdsh:activeId', rowId);
			localStorage.setItem('mdsh:locale', 'en');
			return {
				content,
				chars: content.length,
				bytes: new TextEncoder().encode(content).length,
				tableRows,
				images: { count: 2, encodedBytes }
			};
		},
		{ rowId: adjacentId, target: adjacentTarget }
	);
}

test('a padded table followed by prose keeps the container route', async ({ page }, info) => {
	test.slow();
	test.setTimeout(600_000);
	await installProbe(page);
	await resetAppState(page, { mode: 'source' });
	const fixture = await seedAdjacentProseNote(page);
	await page.reload();
	await page.locator('[data-mode=wysiwyg]').click();
	const dialog = page.getByRole('dialog', { name: /Render this large document/ });
	await dialog.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {});
	if (await dialog.isVisible().catch(() => false))
		await dialog.getByRole('button', { name: /Render document/ }).click();
	await expect(page.locator('.ProseMirror')).toHaveAttribute('contenteditable', 'true', {
		timeout: 300_000
	});
	await expect
		.poll(() =>
			page.locator('.milkdown-image-block img').evaluateAll((images) =>
				images.every((image) => {
					const target = image as HTMLImageElement;
					return target.complete && target.naturalWidth > 0;
				})
			)
		)
		.toBe(true);
	await page.waitForTimeout(2_500);
	await resetProbe(page);
	await placeCaretAtCellEnd(page, adjacentTarget);

	for (const [index, character] of adjacentKeys.entries()) {
		await page.keyboard.insertText(character);
		if (index < adjacentKeys.length - 1) await page.waitForTimeout(cadence);
	}
	await page.waitForTimeout(1_500);
	const typed = adjacentKeys.join('');
	const expected = fixture.content.replace(adjacentTarget, `${adjacentTarget}${typed}`);
	await expect
		.poll(async () => storedContent(page, adjacentId), {
			timeout: 120_000,
			message: 'the durable row must keep every byte'
		})
		.toBe(expected);
	await page.waitForTimeout(500);
	const probe = await readProbe(page);
	const counters = probe.counters;
	const fullReasons = Object.keys(counters).filter((name) =>
		name.startsWith('sourceFidelityFullReason:')
	);
	const publications = probe.stages.filter((stage) => stage.name === 'markdownPublish');
	const evidence = {
		schema: 'deckmark-table-publish-scope/1',
		case: 'adjacent prose after a padded table',
		command: `npx playwright test e2e/table-publish-scope.spec.ts --project=${info.project.name} --workers=1 --retries=0`,
		revision: revision(),
		environment: {
			project: info.project.name,
			browser: page.context().browser()?.version() ?? 'unknown',
			node: process.version,
			platform: process.platform,
			locale: 'en-US',
			mode: 'Edit'
		},
		fixture: {
			id: adjacentId,
			chars: fixture.chars,
			bytes: fixture.bytes,
			sha256: createHash('sha256').update(fixture.content).digest('hex'),
			tableRows: fixture.tableRows,
			images: fixture.images,
			shape: 'padded 64-row table with a prose line directly after it and two base64 JPEG images'
		},
		keys: { count: adjacentKeys.length, cadenceMs: cadence, typed },
		results: {
			counters,
			fullFallbackReasons: fullReasons,
			publications: publications.length,
			savedExact: true,
			savedBytes: Buffer.byteLength(expected)
		}
	};
	await attachArtifact(info, evidence);
	await info.attach('adjacent-saved-note.md', { body: expected, contentType: 'text/markdown' });
	console.log(
		'[publish-scope-adjacent]',
		JSON.stringify({ chars: fixture.chars, counters, publications: publications.length })
	);

	expect(counters.sourceFidelityScoped ?? 0, 'each key must stay scoped').toBeGreaterThanOrEqual(
		adjacentKeys.length
	);
	expect(counters.sourceFidelityFull ?? 0, 'no key may restore the whole source').toBe(0);
	expect(fullReasons, 'no key may report a whole-document fallback').toEqual([]);
	expect(
		counters['sourceFidelityScopedContainer'] ?? 0,
		'the table route must run'
	).toBeGreaterThan(0);
	expect(counters.imageMarkdownFull ?? 0, 'no key may re-fingerprint every embedded image').toBe(0);
	expect(publications.length, 'each key must publish').toBeGreaterThanOrEqual(adjacentKeys.length);
});

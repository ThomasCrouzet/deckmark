import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { resetAppState } from './helpers';
import { extractWikiLinkTargets } from '../src/lib/wiki-links';

const buildCounter = 'meta-index-rebuild';
const noteCount = 30;

type Counters = Record<string, number>;

interface SeedRow {
	id: string;
	name: string;
	content: string;
	order: number;
}

function noteId(index: number): string {
	return `note-${String(index).padStart(2, '0')}`;
}

function noteContent(index: number): string {
	const linkTarget = noteId((index + 1) % noteCount);
	return [
		'---',
		`tags: [tag-${String(index).padStart(2, '0')}]`,
		'---',
		`# ${noteId(index)}`,
		'',
		`See [[${linkTarget}]].`,
		''
	].join('\n');
}

function libraryFixture(): SeedRow[] {
	return Array.from({ length: noteCount }, (_, index) => ({
		id: noteId(index),
		name: `${noteId(index)}.md`,
		content: noteContent(index),
		order: index
	}));
}

async function readCounters(page: Page): Promise<Counters> {
	return page.evaluate(
		(name) => ({ [name]: performance.getEntriesByName(name).length }),
		buildCounter
	);
}

interface TransferRequest {
	at: number;
	id: string;
	keys: string;
	kind: string;
	sourceBytes: number;
	editBytes: number;
	totalBytes: number;
}

interface TransferResponse {
	at: number;
	id: string;
	mode: string;
	incremental: boolean;
	documentRevision: number;
	workerMs: number;
}

interface TransferState {
	requests: TransferRequest[];
	responses: TransferResponse[];
}

async function installTransferProbe(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const state = {
			requests: [] as unknown[],
			responses: [] as unknown[],
			workers: [] as Worker[]
		};
		Object.assign(window, { metadataTransfer: state });
		const NativeWorker = window.Worker;
		window.Worker = class extends NativeWorker {
			constructor(url: string | URL, options?: WorkerOptions) {
				super(url, options);
				if (options?.name !== 'metadata') return;
				state.workers.push(this);
				this.addEventListener('message', (event) => {
					state.responses.push({ at: performance.now(), ...event.data });
				});
			}
			override postMessage(message: unknown): void {
				if (!state.workers.includes(this)) return super.postMessage(message);
				const request = message as {
					id?: string;
					kind?: string;
					source?: { content?: string };
					edits?: Array<{ insert: string }>;
				};
				state.requests.push({
					at: performance.now(),
					id: request.id,
					keys: Object.keys(message as object).join(','),
					kind: request.kind ?? 'full',
					sourceBytes: request.source?.content?.length ?? 0,
					editBytes: request.edits?.reduce((total, edit) => total + edit.insert.length, 0) ?? 0,
					totalBytes: JSON.stringify(message).length
				});
				super.postMessage(message);
			}
		};
	});
}

async function readTransfer(page: Page): Promise<TransferState> {
	return page.evaluate(() => {
		const state = (
			window as unknown as {
				metadataTransfer: { requests: TransferRequest[]; responses: TransferResponse[] };
			}
		).metadataTransfer;
		return { requests: [...state.requests], responses: [...state.responses] };
	});
}

async function resetTransfer(page: Page): Promise<void> {
	await page.evaluate(() => {
		const state = (
			window as unknown as {
				metadataTransfer: { requests: unknown[]; responses: unknown[] };
			}
		).metadataTransfer;
		state.requests.length = 0;
		state.responses.length = 0;
	});
}

/** Large note with one embedded image and a plain editable tail line. */
function imageRichNote(tag: string, target: string): string {
	const base64 =
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
	const image = `![pixel](data:image/png;base64,${base64.repeat(8_000)})\n\n`;
	const body = 'Ordinary body text for the large note.\n'.repeat(8_000);
	return `---\ntags: [${tag}]\n---\n# ${tag}\n\nSee [[${target}]].\n\n${image}${body}Editable tail of ${tag}\n`;
}

async function openNote(page: Page, id: string): Promise<void> {
	await page.locator(`aside button[data-file-id="${id}"]`).click();
	await expect(page.locator('.cm-content').first()).toContainText(id, { timeout: 30_000 });
}

async function appendAtEnd(page: Page, text: string): Promise<void> {
	const source = page.locator('.cm-content').first();
	await source.click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.insertText(text);
}

function acceptedResponses(state: TransferState): number {
	return state.responses.filter((response) => response.mode !== 'rejected').length;
}

async function waitForResponse(page: Page, previous: number): Promise<void> {
	await expect
		.poll(async () => acceptedResponses(await readTransfer(page)), { timeout: 20_000 })
		.toBeGreaterThan(previous);
}

async function seedLibrary(page: Page, rows: SeedRow[]) {
	await page.evaluate(async (library) => {
		await new Promise<void>((resolve, reject) => {
			const request = indexedDB.open('mdsh');
			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				const database = request.result;
				const transaction = database.transaction('drafts', 'readwrite');
				const store = transaction.objectStore('drafts');
				for (const row of library) {
					store.put({
						...row,
						createdAt: 1_700_000_000_000,
						updatedAt: 1_700_000_000_000,
						open: true
					});
				}
				transaction.oncomplete = () => {
					database.close();
					resolve();
				};
				transaction.onerror = () => reject(transaction.error);
			};
		});
		localStorage.setItem('mdsh:activeId', library[0]!.id);
		localStorage.setItem('mdsh:locale', 'en');
		localStorage.setItem('mdsh:mode', 'source');
	}, rows);
}

async function attachEvidence(
	info: TestInfo,
	payload: Record<string, unknown>,
	page: Page
): Promise<void> {
	await info.attach('metadata-index-incremental.json', {
		body: JSON.stringify(
			{
				command: info.config.metadata.command,
				source: info.config.metadata.source,
				workingDiffSha256: info.config.metadata.workingDiffSha256,
				environment: info.config.metadata.environment,
				browser: info.project.name,
				status: info.status,
				...payload
			},
			null,
			2
		),
		contentType: 'application/json'
	});
	await info.attach('metadata-index-incremental.png', {
		body: await page.screenshot({ fullPage: true }),
		contentType: 'image/png'
	});
}

test.describe('Metadata index incremental update', () => {
	test.use({ locale: 'en-US', reducedMotion: 'reduce' });

	test.beforeEach(async ({ page }) => {
		await resetAppState(page, { mode: 'source' });
	});

	test('ordinary one MB input does not parse metadata in the input task', async ({
		page,
		context
	}, info) => {
		test.setTimeout(120_000);
		const content = '# Large note\n\nordinary body\n\n' + 'Plain body text.\n'.repeat(65_536);
		await seedLibrary(page, [{ id: 'large', name: 'large.md', content, order: 0 }]);
		await page.reload();
		const source = page.locator('.cm-content').first();
		await expect(source).toBeVisible({ timeout: 30_000 });
		await source.click();
		await page.keyboard.press('ControlOrMeta+Home');
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('End');
		const cdp = await context.newCDPSession(page);
		await cdp.send('Profiler.enable');
		await cdp.send('Profiler.start');
		const samples = [];
		for (let i = 0; i < 3; i++) {
			samples.push(
				await page.evaluate(async () => {
					performance.clearMarks('meta-index-parse');
					const started = performance.now();
					document.execCommand('insertText', false, 'x');
					await Promise.resolve();
					await Promise.resolve();
					return {
						durationMs: performance.now() - started,
						parses: performance.getEntriesByName('meta-index-parse').length
					};
				})
			);
		}
		const profile = await cdp.send('Profiler.stop');
		await info.attach('metadata-input.cpuprofile', {
			body: JSON.stringify(profile.profile),
			contentType: 'application/json'
		});
		await attachEvidence(info, { fixture: { content }, samples }, page);
		expect(samples.map((sample) => sample.parses)).toEqual([0, 0, 0]);
		await expect(source).toContainText('ordinary bodyxxx');
	});

	test('seeded structural edits keep visible tags and backlinks equal to full parsing', async ({
		page
	}, info) => {
		test.setTimeout(120_000);
		const fixture = libraryFixture().slice(0, 3);
		fixture[0]!.content = '# Start\n';
		await seedLibrary(page, fixture);
		await page.reload();
		const source = page.locator('.cm-content').first();
		await expect(source).toBeVisible({ timeout: 30_000 });
		const fragments = [
			'[[note-01]]',
			'```md\n[[note-01]]\n```',
			'`[[note-01]]`',
			'[[note-02|alias]]',
			'    [[note-01]]',
			'\\[[note-01]]',
			'[[note-01]] and [[note-02]]'
		];
		let seed = 307;
		const results = [];
		for (let step = 0; step < 12; step++) {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			const body = fragments[seed % fragments.length]!;
			const content = `---\ntitle: Title ${step}\ntags: [edit-${step}]\n---\n# H1 ${step}\n\n${body}\n`;
			await page.locator('aside button[data-file-id="note-00"]').click();
			await source.click();
			await page.keyboard.press('ControlOrMeta+a');
			await page.keyboard.insertText(content);
			await expect(
				page
					.locator('aside')
					.getByRole('button', { name: `Filter by tag edit-${step}`, exact: true })
			).toBeVisible();
			const targets = extractWikiLinkTargets(content);
			for (const target of ['note-01', 'note-02']) {
				await page.locator(`aside button[data-file-id="${target}"]`).click();
				const links = page.locator('aside [aria-label="Backlinks"]');
				if (targets.includes(target)) await expect(links).toContainText(`Title ${step}`);
				else
					await expect(
						links.getByRole('button', { name: `Open Title ${step}`, exact: true })
					).toHaveCount(0);
			}
			results.push({ seed, content, targets });
		}
		await attachEvidence(info, { seed: 307, results }, page);
	});

	test('a delayed worker result cannot replace newer edits after tab close', async ({
		page
	}, info) => {
		test.setTimeout(120_000);
		await page.addInitScript(() => {
			const state = {
				hold: false,
				messages: [] as MessageEvent[],
				workers: [] as Worker[],
				observations: [] as unknown[]
			};
			Object.assign(window, { metadataRace: state });
			const NativeWorker = window.Worker;
			window.Worker = class extends NativeWorker {
				constructor(url: string | URL, options?: WorkerOptions) {
					super(url, options);
					if (options?.name !== 'metadata' && !String(url).includes('metadata')) return;
					state.workers.push(this);
					this.addEventListener('message', (event) => {
						state.observations.push({ event: 'result', data: event.data, held: state.hold });
						if (!state.hold) return;
						event.stopImmediatePropagation();
						state.messages.push(event);
					});
				}
				override postMessage(message: unknown): void {
					state.observations.push({ event: 'request', data: message });
					super.postMessage(message);
				}
			};
		});
		const fixture = libraryFixture().slice(0, 3);
		await seedLibrary(page, fixture);
		await page.reload();
		const source = page.locator('.cm-content').first();
		await expect(source).toBeVisible({ timeout: 30_000 });
		await page.evaluate(() => {
			(window as unknown as { metadataRace: { hold: boolean } }).metadataRace.hold = true;
		});
		const edit = async (tag: string, target: string) => {
			await source.click();
			await page.keyboard.press('ControlOrMeta+a');
			await page.keyboard.insertText(`---\ntags: [${tag}]\n---\n# note-00\n\n[[${target}]]\n`);
		};
		await edit('obsolete', 'note-01');
		await expect
			.poll(() =>
				page.evaluate(
					() =>
						(window as unknown as { metadataRace: { messages: unknown[] } }).metadataRace.messages
							.length
				)
			)
			.toBeGreaterThan(0);
		await edit('latest', 'note-02');
		await page
			.locator('aside button[data-file-id="note-00"]')
			.locator('..')
			.getByRole('button', { name: /Close/ })
			.click();
		await page.evaluate(() => {
			const state = (
				window as unknown as {
					metadataRace: { hold: boolean; workers: Worker[]; messages: MessageEvent[] };
				}
			).metadataRace;
			state.hold = false;
			for (const event of state.messages.splice(0))
				state.workers[0]!.dispatchEvent(new MessageEvent('message', { data: event.data }));
		});
		await page.locator('aside button[data-file-id="note-02"]').click();
		await expect(page.locator('aside [aria-label="Backlinks"]')).toContainText('note-00');
		await page.locator('aside summary').filter({ hasText: 'Saved documents' }).click();
		await page.locator('aside').getByRole('button', { name: 'note-00.md', exact: true }).click();
		await expect(
			page.locator('aside').getByRole('button', { name: 'Filter by tag latest', exact: true })
		)
			.toBeVisible()
			.catch(async (error: unknown) => {
				const diagnostic = await page.evaluate(async () => {
					const state = (
						window as unknown as { metadataRace: { observations: unknown[]; messages: unknown[] } }
					).metadataRace;
					const stored = await new Promise<unknown>((resolve) => {
						const request = indexedDB.open('mdsh');
						request.onsuccess = () => {
							const db = request.result;
							const read = db.transaction('drafts').objectStore('drafts').get('note-00');
							read.onsuccess = () => {
								resolve(read.result);
								db.close();
							};
						};
					});
					return { observations: state.observations, held: state.messages.length, stored };
				});
				await info.attach('metadata-race-diagnostic.json', {
					body: JSON.stringify(diagnostic, null, 2),
					contentType: 'application/json'
				});
				throw error;
			});
		await expect(
			page.locator('aside').getByRole('button', { name: 'Filter by tag obsolete', exact: true })
		).toHaveCount(0);
		await attachEvidence(
			info,
			{ fixture, expected: { tag: 'latest', target: 'note-02', closedThenReopened: 'note-00' } },
			page
		);
	});

	test('a single note edit updates tags and backlinks without a full rebuild', async ({
		page
	}, info) => {
		test.setTimeout(120_000);
		const fixture = libraryFixture();
		await seedLibrary(page, fixture);
		await page.reload();

		const source = page.locator('.cm-content').first();
		await expect(source).toBeVisible({ timeout: 30_000 });
		await expect(source).toContainText('See [[note-01]].');

		const backlinks = page.locator('aside [aria-label="Backlinks"]');
		await expect(backlinks).toContainText('note-29');

		const tagFilter = (tag: string) =>
			page.locator('aside').getByRole('button', { name: `Filter by tag ${tag}` });
		await expect(tagFilter('tag-00')).toBeVisible();
		await expect(tagFilter('tag-29')).toBeVisible();

		const before = await readCounters(page);
		expect(
			before[buildCounter] ?? 0,
			'the initial library read must build the backlinks index'
		).toBeGreaterThan(0);
		const edits = {
			tag: 'tag-changed',
			link: '[[note-02]]'
		};
		const editedContent = [
			'---',
			`tags: [${edits.tag}]`,
			'---',
			'# note-00',
			'',
			`See ${edits.link}.`,
			''
		].join('\n');

		await source.click();
		await page.keyboard.press('ControlOrMeta+a');
		await page.keyboard.press('Delete');
		await page.keyboard.insertText(editedContent);
		await page.waitForTimeout(700);

		await expect(tagFilter('tag-00')).toHaveCount(0);
		await expect(tagFilter(edits.tag)).toBeVisible();
		await expect(source).toContainText('See [[note-02]].');

		await page.locator('aside button[data-file-id="note-01"]').click();
		await expect(page.locator('input[aria-label^="File name"]')).toHaveValue('note-01');
		await expect(backlinks).toHaveCount(0);

		await page.locator('aside button[data-file-id="note-02"]').click();
		await expect(page.locator('input[aria-label^="File name"]')).toHaveValue('note-02');
		await expect(backlinks).toContainText('note-00');
		await expect(backlinks).toContainText('note-01');

		const after = await readCounters(page);
		const delta = (after[buildCounter] ?? 0) - (before[buildCounter] ?? 0);
		const evidence = {
			fixture: {
				notes: noteCount,
				editedNote: 'note-00',
				oldTag: 'tag-00',
				newTag: edits.tag,
				oldLink: '[[note-01]]',
				newLink: edits.link
			},
			counters: { before, after, delta, buildCounter },
			tags: { removed: 'tag-00', added: edits.tag },
			backlinks: {
				'note-01': 0,
				'note-02': ['note-00', 'note-01']
			}
		};
		await attachEvidence(info, evidence, page);

		expect(delta, 'a single note edit must not rebuild the backlinks index').toBe(0);
	});

	test('a plain one-character edit transfers a delta and keeps both large baselines', async ({
		page
	}, info) => {
		test.setTimeout(180_000);
		await installTransferProbe(page);
		const fixture: SeedRow[] = [
			{
				id: 'large-a',
				name: 'large-a.md',
				content: imageRichNote('large-a', 'target-one'),
				order: 0
			},
			{
				id: 'large-b',
				name: 'large-b.md',
				content: imageRichNote('large-b', 'target-two'),
				order: 1
			},
			{ id: 'target-one', name: 'target-one.md', content: '# Target one\n', order: 2 },
			{ id: 'target-two', name: 'target-two.md', content: '# Target two\n', order: 3 }
		];
		await seedLibrary(page, fixture);
		await page.reload();
		await expect(page.locator('.cm-content').first()).toBeVisible({ timeout: 30_000 });
		const tagFilter = (tag: string) =>
			page.locator('aside').getByRole('button', { name: `Filter by tag ${tag}`, exact: true });
		await expect(tagFilter('large-a')).toBeVisible({ timeout: 30_000 });
		await expect(tagFilter('large-b')).toBeVisible({ timeout: 30_000 });

		// The first edit of each file has no Worker baseline yet. It establishes
		// the per-file baseline that the measured edits must reuse.
		const baseline: Record<string, number> = {};
		for (const id of ['large-a', 'large-b']) {
			await openNote(page, id);
			const before = acceptedResponses(await readTransfer(page));
			await appendAtEnd(page, 'x');
			await waitForResponse(page, before);
			baseline[id] = (await readTransfer(page)).requests.at(-1)?.sourceBytes ?? 0;
			await page.waitForTimeout(300);
		}

		const measured: Array<{ id: string; state: TransferState }> = [];
		for (const id of ['large-a', 'large-b', 'large-a']) {
			await resetTransfer(page);
			await openNote(page, id);
			const before = acceptedResponses(await readTransfer(page));
			await appendAtEnd(page, 'y');
			await waitForResponse(page, before);
			measured.push({ id, state: await readTransfer(page) });
			await page.waitForTimeout(300);
		}

		// The structural fallback replaces the whole body through the text path.
		await resetTransfer(page);
		await page.locator('.cm-content').first().click();
		await page.keyboard.press('ControlOrMeta+a');
		await page.keyboard.insertText(
			'---\ntags: [structural-a]\n---\n# Structural A\n\nSee [[target-two]].\n'
		);
		await expect(tagFilter('structural-a')).toBeVisible({ timeout: 30_000 });
		await expect(tagFilter('large-a')).toHaveCount(0);
		await expect(tagFilter('large-b')).toBeVisible();
		const structural = await readTransfer(page);
		const measures = await page.evaluate(() =>
			performance
				.getEntriesByName('mdsh:metadata-transfer')
				.map((entry) => (entry as PerformanceMeasure).detail)
		);
		const jobs = await page.evaluate(() =>
			performance
				.getEntriesByName('mdsh:metadata-job')
				.map((entry) => (entry as PerformanceMeasure).detail)
		);

		await page.locator('aside button[data-file-id="target-two"]').click();
		const backlinks = page.locator('aside [aria-label="Backlinks"]');
		await expect(backlinks).toContainText('Structural A');
		await expect(backlinks).toContainText('large-b');
		await page.locator('aside button[data-file-id="target-one"]').click();
		await expect(page.locator('aside [aria-label="Backlinks"]')).toHaveCount(0);

		await attachEvidence(
			info,
			{
				fixture: {
					notes: ['large-a', 'large-b'],
					sourceBytes: fixture.slice(0, 2).map((row) => row.content.length),
					embeddedImage: true
				},
				baseline,
				measured,
				structural,
				measures,
				jobs
			},
			page
		);

		for (const { id, state } of measured) {
			expect(state.requests, `${id} must send exactly one metadata job`).toHaveLength(1);
			const request = state.requests[0]!;
			expect(request.kind, `${id} must send a delta`).toBe('delta');
			expect(request.sourceBytes, `${id} must not copy the full source`).toBe(0);
			expect(request.totalBytes, `${id} delta must stay small`).toBeLessThan(4_096);
			expect(state.responses[0]?.mode, `${id} Worker must apply the delta`).toBe('delta');
			expect(state.responses[0]?.incremental, `${id} metadata must be reused`).toBe(true);
			expect(state.responses[0]?.workerMs, `${id} Worker CPU must be recorded`).toBeGreaterThan(0);
		}
		expect(
			measures.some((detail) => detail?.kind === 'delta' && detail?.sourceBytes === 0),
			'the transfer diagnostic must record the delta'
		).toBe(true);
		expect(
			jobs.some((detail) => detail?.mode === 'delta' && detail?.workerMs > 0),
			'the job diagnostic must record Worker CPU'
		).toBe(true);
		expect(
			structural.requests.some((request) => request.kind === 'full' && request.sourceBytes > 0),
			'a structural replacement must send one full snapshot'
		).toBe(true);
	});

	test('a pending write still refreshes metadata for the next edit', async ({ page }, info) => {
		test.setTimeout(120_000);
		const fixture = ['note-00', 'note-01', 'note-02', 'note-03'].map((id, index) => ({
			id,
			name: `${id}.md`,
			content: [
				'---',
				`tags: [tag-${String(index).padStart(2, '0')}]`,
				'---',
				`# ${id}`,
				'',
				index === 0 ? 'See [[note-01]].' : 'No outgoing link.',
				''
			].join('\n'),
			order: index
		}));
		await seedLibrary(page, fixture);
		await page.reload();
		const source = page.locator('.cm-content').first();
		await expect(source).toBeVisible({ timeout: 30_000 });
		// Freeze the save debounce so the pending state remains true across both
		// edits. The metadata signal must update the view without waiting for it.
		await page.clock.install();
		const tagFilter = (tag: string) =>
			page.locator('aside').getByRole('button', { name: `Filter by tag ${tag}` });
		await expect(tagFilter('tag-00')).toBeVisible();
		const edit = async (text: string) => {
			await source.click();
			await page.keyboard.press('ControlOrMeta+a');
			await page.keyboard.press('Delete');
			await page.keyboard.insertText(text);
		};
		await edit(
			['---', 'tags: [tag-one]', '---', '# note-00', '', 'See [[note-02]].', ''].join('\n')
		);
		await expect(tagFilter('tag-one')).toBeVisible({ timeout: 2_000 });
		await expect(page.locator('.title-save')).toHaveText('saving...');
		await edit(
			['---', 'tags: [tag-two]', '---', '# note-00', '', 'See [[note-03]].', ''].join('\n')
		);
		// The second edit happens while the first write is still pending. The tag
		// list and backlinks must change before the save clears the pending state.
		await expect(tagFilter('tag-two')).toBeVisible({ timeout: 350 });
		await expect(tagFilter('tag-one')).toHaveCount(0);
		await page.clock.runFor(700);
		await expect(page.locator('.title-save')).toHaveText('saved', { timeout: 10_000 });
		await page.locator('aside button[data-file-id="note-02"]').click();
		await expect(page.locator('aside [aria-label="Backlinks"]')).toHaveCount(0);
		await page.locator('aside button[data-file-id="note-03"]').click();
		await expect(page.locator('aside [aria-label="Backlinks"]')).toContainText('note-00');
		await attachEvidence(
			info,
			{
				fixture: {
					notes: fixture.length,
					editedNote: 'note-00',
					links: ['note-01', 'note-02', 'note-03']
				},
				tags: ['tag-00', 'tag-one', 'tag-two']
			},
			page
		);
	});
});

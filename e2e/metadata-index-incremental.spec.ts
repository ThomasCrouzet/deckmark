import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { resetAppState } from './helpers';

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

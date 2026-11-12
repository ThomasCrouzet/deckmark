import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { seedFiles, resetAppState } from './helpers';
import { importSource } from './source-fidelity-harness';

const STORAGE_KEY = 'mdsh:editor-view-state';

function longNote(label: string): string {
	return Array.from(
		{ length: 260 },
		(_, index) => `${label} section ${index}. ${'Reading position target. '.repeat(5)}`
	).join('\n\n');
}

async function activeFileId(page: Page): Promise<string> {
	const id = await page
		.locator('aside button[data-file-id][aria-current="true"]')
		.getAttribute('data-file-id');
	if (!id) throw new Error('The sidebar has no active file');
	return id;
}

async function frame(page: Page): Promise<void> {
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			)
	);
}

async function setReadScroll(page: Page, top: number): Promise<number> {
	const actual = await page.locator('.mdsh-read').evaluate(async (element, value) => {
		element.scrollTop = value;
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
		);
		return element.scrollTop;
	}, top);
	expect(actual).toBeGreaterThan(0);
	return actual;
}

async function readScroll(page: Page): Promise<number> {
	return page.locator('.mdsh-read').evaluate((element) => element.scrollTop);
}

async function savedReadTop(page: Page, fileId: string): Promise<number | null> {
	return page.evaluate(
		({ key, id }) => {
			const raw = sessionStorage.getItem(key);
			if (!raw) return null;
			const values = JSON.parse(raw) as {
				fileId: string;
				positions: { read?: { scrollTop: number } };
			}[];
			const entry = values.find((value) => value.fileId === id);
			const position = entry?.positions.read?.scrollTop;
			return typeof position === 'number' && Number.isFinite(position) ? position : null;
		},
		{ key: STORAGE_KEY, id: fileId }
	);
}

async function setVisibility(page: Page, state: 'hidden' | 'visible'): Promise<void> {
	await page.evaluate((visibility) => {
		Object.defineProperty(document, 'visibilityState', {
			configurable: true,
			get: () => visibility
		});
		document.dispatchEvent(new Event('visibilitychange'));
	}, state);
	await frame(page);
}

async function openReadMode(page: Page): Promise<void> {
	const read = page.locator('[data-mode="read"]');
	if (await read.count()) await read.click();
	await expect(page.locator('.mdsh-preview')).toBeVisible({ timeout: 30_000 });
	await frame(page);
}

async function openProjects(page: Page) {
	const dialog = page.getByRole('dialog', { name: 'Projets Markdown' });
	if (await dialog.isVisible().catch(() => false)) return dialog;
	await page.getByTestId('projects-open').click();
	return dialog;
}

async function importProject(page: Page, data: Buffer) {
	const panel = await openProjects(page);
	await panel.locator('input[type=file][accept=".zip"]').setInputFiles({
		name: 'Anchor.zip',
		mimeType: 'application/zip',
		buffer: data
	});
	return panel;
}

async function anchorProjectFixture(): Promise<Buffer> {
	const zip = new (await import('jszip')).default();
	zip.file('README.md', '# Handbook\n\n[Open target](target.md#target-heading)\n');
	const body = Array.from(
		{ length: 260 },
		(_, index) => `Target paragraph ${index}. ${'Anchor target text. '.repeat(5)}`
	).join('\n\n');
	zip.file('target.md', `# Target heading\n\n${body}\n\n## Deep section\n\n${body}\n`);
	return zip.generateAsync({ type: 'nodebuffer' });
}

test('an explicit project fragment anchor wins over a stale cached read offset', async ({
	page
}, info) => {
	test.setTimeout(120_000);
	await resetAppState(page);
	const fixture = await anchorProjectFixture();
	const panel = await importProject(page, fixture);
	await panel.getByRole('button', { name: 'Ouvrir target.md', exact: true }).click();
	await openReadMode(page);
	await expect(page.locator('#target-heading')).toBeVisible();
	const deep = await setReadScroll(page, 2400);
	expect(deep).toBeGreaterThan(1000);

	const reopened = await openProjects(page);
	await reopened.getByRole('button', { name: 'Ouvrir README.md', exact: true }).click();
	await expect(page.locator('.mdsh-preview')).toContainText('Handbook', { timeout: 30_000 });
	await page.locator('.mdsh-preview a').filter({ hasText: 'Open target' }).click();
	await expect(page.locator('.mdsh-preview')).toContainText('Target heading', { timeout: 30_000 });
	await expect(page.locator('#target-heading')).toBeVisible();
	await frame(page);
	const headingTop = await page
		.locator('#target-heading')
		.evaluate((element) => element.getBoundingClientRect().top);
	const settled = await readScroll(page);
	expect(headingTop).toBeGreaterThanOrEqual(0);
	expect(headingTop).toBeLessThan(120);
	expect(settled).toBeLessThan(deep - 500);

	await info.attach('read-project-anchor.json', {
		body: JSON.stringify({
			cachedDeepOffset: deep,
			settledOffset: settled,
			headingTop,
			fixture: {
				bytes: fixture.length,
				sha256: createHash('sha256').update(fixture).digest('hex')
			}
		}),
		contentType: 'application/json'
	});
});

test('saves a changed read position when the document becomes hidden without pagehide', async ({
	page
}, info) => {
	test.setTimeout(90_000);
	const content = longNote('Hidden lifecycle');
	await resetAppState(page);
	await seedFiles(page, [{ name: 'Hidden.md', content }]);
	await openReadMode(page);
	const id = await activeFileId(page);
	const top = await setReadScroll(page, 1800);
	expect(await savedReadTop(page, id)).toBeNull();

	await setVisibility(page, 'hidden');
	const saved = await savedReadTop(page, id);
	expect(saved).not.toBeNull();
	expect(Math.abs(saved! - top)).toBeLessThanOrEqual(1);

	// A repeat hidden event must keep the deep position.
	await setVisibility(page, 'hidden');
	expect(Math.abs((await savedReadTop(page, id))! - top)).toBeLessThanOrEqual(1);

	// A wake without user input must not move the document.
	await setVisibility(page, 'visible');
	expect(Math.abs((await readScroll(page)) - top)).toBeLessThanOrEqual(1);

	await info.attach('read-hidden.json', {
		body: JSON.stringify({
			fileId: id,
			requestedTop: top,
			savedTop: saved,
			storageKey: STORAGE_KEY,
			fixture: {
				bytes: Buffer.byteLength(content),
				sha256: createHash('sha256').update(content).digest('hex')
			}
		}),
		contentType: 'application/json'
	});
	await info.attach('read-hidden.png', { body: await page.screenshot() });
});

test('restores the saved read position after a reload that keeps sessionStorage', async ({
	page
}, info) => {
	test.setTimeout(90_000);
	const content = longNote('Reload lifecycle');
	await resetAppState(page);
	await seedFiles(page, [{ name: 'Reload.md', content }]);
	await openReadMode(page);
	const id = await activeFileId(page);
	const top = await setReadScroll(page, 2400);
	await setVisibility(page, 'hidden');
	expect(await savedReadTop(page, id)).not.toBeNull();

	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	await openReadMode(page);
	await expect.poll(() => readScroll(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(top - 2);
	const restored = await readScroll(page);
	expect(Math.abs(restored - top)).toBeLessThanOrEqual(2);
	await expect(page.locator('.mdsh-preview')).toContainText('Reload lifecycle section');

	await info.attach('read-reload.json', {
		body: JSON.stringify({
			fileId: id,
			savedTop: top,
			restoredTop: restored,
			sessionStorageSurvived: true,
			fixture: {
				bytes: Buffer.byteLength(content),
				sha256: createHash('sha256').update(content).digest('hex')
			}
		}),
		contentType: 'application/json'
	});
});

test('keeps the live read position through a same-file theme rerender', async ({ page }, info) => {
	test.setTimeout(90_000);
	const alpha = longNote('Alpha marker');
	const beta = longNote('Beta marker');
	await resetAppState(page);
	await seedFiles(page, [{ name: 'Alpha.md', content: alpha }]);
	await importSource(page, beta, 'Beta');
	await openReadMode(page);
	const betaId = await activeFileId(page);
	await expect(page.locator('.mdsh-preview')).toContainText('Beta marker');
	const cached = await setReadScroll(page, 700);

	await page.locator('aside button[data-file-id]').filter({ hasText: 'Alpha' }).click();
	await expect(page.locator('.mdsh-preview')).toContainText('Alpha marker', { timeout: 30_000 });
	await page.locator('aside button[data-file-id]').filter({ hasText: 'Beta' }).click();
	await expect(page.locator('.mdsh-preview')).toContainText('Beta marker', { timeout: 30_000 });
	await frame(page);
	const before = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
	const live = await setReadScroll(page, 2200);

	await page.getByTestId('theme-toggle').click();
	await expect
		.poll(() => page.evaluate(() => document.documentElement.getAttribute('data-theme')))
		.not.toBe(before);
	await expect.poll(() => readScroll(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(live - 2);
	const after = await readScroll(page);
	expect(Math.abs(after - live)).toBeLessThanOrEqual(2);

	await info.attach('read-same-file-rerender.json', {
		body: JSON.stringify({
			fileId: betaId,
			cachedTop: cached,
			liveTop: live,
			restoredTop: after,
			themeBefore: before,
			fixture: {
				alphaSha256: createHash('sha256').update(alpha).digest('hex'),
				betaSha256: createHash('sha256').update(beta).digest('hex')
			}
		}),
		contentType: 'application/json'
	});
});

test('keeps the deep cached position when the page hides before the restore frame', async ({
	page
}, info) => {
	test.setTimeout(120_000);
	const short = '# Short\n\nShort source note.';
	const target = longNote('R1 target marker');
	await resetAppState(page);
	await seedFiles(page, [
		{ name: 'Short.md', content: short },
		{ name: 'Target.md', content: target }
	]);
	await openReadMode(page);
	await expect(page.locator('.mdsh-preview')).toContainText('R1 target marker');
	const deep = await setReadScroll(page, 2600);
	expect(deep).toBeGreaterThan(1000);

	await page.locator('aside button[data-file-id]').filter({ hasText: 'Short' }).click();
	await expect(page.locator('.mdsh-preview')).toContainText('Short source note.', {
		timeout: 30_000
	});
	await page.evaluate((key) => {
		const scroller = document.querySelector<HTMLElement>('.mdsh-read');
		if (!scroller) throw new Error('Read scroller is missing');
		const state: {
			triggered: boolean;
			samples: {
				generation: string | null;
				scrollerTop: number | null;
				stored: number | null;
				activeFileId: string | null;
			}[];
			error: string | null;
		} = {
			triggered: false,
			samples: [],
			error: null
		};
		(window as Window & { __r1?: typeof state }).__r1 = state;
		const sample = () => {
			const article = document.querySelector<HTMLElement>('.mdsh-preview');
			if (!article?.textContent?.includes('R1 target marker')) return;
			state.triggered = true;
			Object.defineProperty(document, 'visibilityState', {
				configurable: true,
				get: () => 'hidden'
			});
			document.dispatchEvent(new Event('visibilitychange'));
			try {
				const active =
					document
						.querySelector('aside button[data-file-id][aria-current="true"]')
						?.getAttribute('data-file-id') ?? null;
				const raw = sessionStorage.getItem(key);
				const values = raw
					? (JSON.parse(raw) as {
							fileId: string;
							positions: { read?: { scrollTop: number } };
						}[])
					: [];
				state.samples.push({
					generation: article.dataset.renderGeneration ?? null,
					scrollerTop: scroller.scrollTop,
					stored:
						values.find((value) => value.fileId === active)?.positions.read?.scrollTop ?? null,
					activeFileId: active
				});
			} catch (error) {
				state.error = error instanceof Error ? error.message : String(error);
			}
		};
		const observer = new MutationObserver(sample);
		observer.observe(scroller, {
			childList: true,
			subtree: true,
			characterData: true,
			attributes: true,
			attributeFilter: ['data-render-generation']
		});
		(window as Window & { __r1Observer?: MutationObserver }).__r1Observer = observer;
	}, STORAGE_KEY);
	await page.locator('aside button[data-file-id]').filter({ hasText: 'Target' }).click();
	await expect
		.poll(
			() =>
				page.evaluate(
					() => (window as Window & { __r1?: { triggered: boolean } }).__r1?.triggered ?? false
				),
			{ timeout: 30_000 }
		)
		.toBe(true);
	await expect.poll(() => readScroll(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(deep - 2);
	const record = await page.evaluate(() => {
		(window as Window & { __r1Observer?: MutationObserver }).__r1Observer?.disconnect();
		return (
			window as Window & {
				__r1?: {
					triggered: boolean;
					samples: {
						generation: string | null;
						scrollerTop: number | null;
						stored: number | null;
						activeFileId: string | null;
					}[];
					error: string | null;
				};
			}
		).__r1;
	});
	expect(record?.error).toBeNull();
	expect(record?.samples.length).toBeGreaterThan(0);
	for (const sample of record!.samples) {
		expect(sample.activeFileId).toBeTruthy();
		expect(sample.stored).not.toBeNull();
		expect(Math.abs(sample.stored! - deep)).toBeLessThanOrEqual(1);
	}

	await page.evaluate(() => {
		Object.defineProperty(document, 'visibilityState', {
			configurable: true,
			get: () => 'visible'
		});
	});
	await expect.poll(() => readScroll(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(deep - 2);

	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	await openReadMode(page);
	await expect.poll(() => readScroll(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(deep - 2);

	await info.attach('read-pending-restore.json', {
		body: JSON.stringify({
			deepOffset: deep,
			samples: record?.samples,
			zeroStoredSamples: record?.samples.filter((sample) => sample.stored === 0).length ?? null,
			restoredAfterVisible: await readScroll(page),
			fixture: {
				shortBytes: Buffer.byteLength(short),
				targetBytes: Buffer.byteLength(target),
				targetSha256: createHash('sha256').update(target).digest('hex')
			}
		}),
		contentType: 'application/json'
	});
});

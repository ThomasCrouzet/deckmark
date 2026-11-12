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

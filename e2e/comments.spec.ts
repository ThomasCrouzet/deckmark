import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createFirstFile, openPalette, resetAppState, writeSourceContent } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

async function openComments(page: Page) {
	await openPalette(page);
	await page
		.getByRole('dialog', { name: 'Palette de commandes' })
		.getByRole('option', { name: /commentaires éditoriaux/i })
		.click();
	await expect(page.getByTestId('comments-panel')).toBeVisible();
}

async function addComment(page: Page, quote: string, body: string) {
	await page.getByTestId('comment-quote').fill(quote);
	await page.getByTestId('comment-body').fill(body);
	await page.getByTestId('comment-author').fill('Reviewer');
	await page.getByTestId('comment-add').click();
}

async function source(page: Page): Promise<string> {
	return page
		.locator('.cm-content .cm-line')
		.evaluateAll((lines) => lines.map((line) => line.textContent).join('\n'));
}

test('adds local comments without changing the Markdown and survives reload', async ({
	page
}, info: TestInfo) => {
	await resetAppState(page);
	await createFirstFile(page);
	const content = '# Guide\n\nUnique passage for review.\n\nSecond paragraph.';
	await writeSourceContent(page, content);
	await openComments(page);
	await addComment(page, 'Unique passage for review.', 'Please confirm this wording.');
	await expect(page.getByTestId('comments-panel')).toContainText('Please confirm this wording.');
	await expect(page.getByTestId('comments-panel')).toContainText('ancre valide');
	await expect(page.locator('.cm-content')).toContainText('Unique passage for review.');

	await page.getByRole('button', { name: 'Résoudre', exact: true }).click();
	await expect(page.getByTestId('comments-panel')).toContainText('résolu');
	await page.getByRole('button', { name: 'Rouvrir', exact: true }).click();
	await expect(page.getByTestId('comments-panel')).toContainText('ouvert');

	const downloadPromise = page.waitForEvent('download');
	await page.getByTestId('comments-export').click();
	const download = await downloadPromise;
	const report = JSON.parse(await readFile((await download.path())!, 'utf8')) as {
		comments: Array<{ anchor: { state: string } }>;
	};
	expect(report.comments).toHaveLength(1);
	expect(report.comments[0]?.anchor.state).toBe('attached');

	await page.keyboard.press('Escape');
	await expect(page.getByTestId('comments-panel')).toHaveCount(0);
	expect(await source(page)).toBe(content);

	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	await openComments(page);
	await expect(page.getByTestId('comments-panel')).toContainText('Please confirm this wording.');
	await info.attach('comments.json', {
		body: JSON.stringify({ report, sourceUnchanged: content }, null, 2),
		contentType: 'application/json'
	});
});

test('reports moved and detached anchors without guessing', async ({ page }, info: TestInfo) => {
	await resetAppState(page);
	await createFirstFile(page);
	await writeSourceContent(page, 'Alpha unique. Beta tail.');
	await openComments(page);
	await addComment(page, 'Alpha unique.', 'Anchor test.');
	await page.keyboard.press('Escape');

	await writeSourceContent(page, 'Intro. Alpha unique. Beta tail.');
	await openComments(page);
	await expect(page.getByTestId('comments-panel')).toContainText('ancre déplacée');
	await page.keyboard.press('Escape');

	await writeSourceContent(page, 'Alpha removed. Beta tail.');
	await openComments(page);
	await expect(page.getByTestId('comments-panel')).toContainText('ancre perdue');
	await info.attach('comments-anchors.json', {
		body: JSON.stringify({ moved: true, detached: true }),
		contentType: 'application/json'
	});
});

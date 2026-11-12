import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { openPalette, resetAppState, seedFiles } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

const oneNote = [
	{
		name: 'Alpha',
		content: '---\ntitle: Alpha\ntags: [docs]\nstatus: active\n---\n\n# Alpha\n'
	}
];

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
	await expect(page.getByTestId('collection-views')).toContainText('Vue accessibilité');

	await page.getByTestId('collection-views').focus();
	await page.keyboard.press('Tab');
	await expect(restored).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(page.getByTestId('collection-save-view')).toBeFocused();

	const bounds = await field.evaluate((element) => {
		const rect = element.getBoundingClientRect();
		return { left: rect.left, right: rect.right, width: rect.width };
	});
	expect(bounds.left).toBeGreaterThanOrEqual(0);
	expect(bounds.right).toBeLessThanOrEqual(520);

	await writeArtifact('collection-view-name-label.json', {
		fixture: { notes: oneNote.length, viewport: '520x720' },
		result: { accessibleName: 'Nom de la vue', bounds, restoredValue: await restored.inputValue() }
	});
	await info.attach('collection-view-name-label.json', {
		body: JSON.stringify({ bounds }, null, 2),
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

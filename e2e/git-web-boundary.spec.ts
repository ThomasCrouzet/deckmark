import { expect, test } from '@playwright/test';
import { resetAppState } from './helpers';

test('Web Light shows no Git action in the project panel', async ({ page }) => {
	await resetAppState(page);
	await page.getByTestId('projects-open').click();
	const panel = page.getByRole('dialog', { name: 'Projets Markdown' });
	await expect(panel).toBeVisible();

	await panel.getByRole('button', { name: 'Nouveau projet' }).click();
	const prompt = page.getByRole('dialog', { name: 'Nom du projet' });
	await prompt.getByRole('textbox').fill('Web boundary');
	await prompt.getByRole('button', { name: 'Nouveau projet' }).click();
	await expect(panel.getByRole('combobox')).toBeVisible();

	await expect(panel.getByTestId('project-git')).toHaveCount(0);
	await expect(panel.getByText('Modifications Git')).toHaveCount(0);
	expect(await page.evaluate(() => '__TAURI_INTERNALS__' in window)).toBe(false);
});

import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { resetAppState } from './helpers';

async function openProjectPrompt(page: Page) {
	await page.getByTestId('projects-open').click();
	const panel = page.getByRole('dialog', { name: 'Projets Markdown' });
	await expect(panel).toBeVisible();
	await panel.getByRole('button', { name: 'Nouveau projet' }).click();
	const prompt = page.getByRole('dialog', { name: 'Nom du projet' });
	await expect(prompt).toBeVisible();
	await expect(prompt.getByRole('textbox')).toBeFocused();
	return { panel, prompt };
}

async function projectNames(page: Page): Promise<string[]> {
	return page.evaluate(
		() =>
			new Promise<string[]>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					if (!database.objectStoreNames.contains('projects')) {
						database.close();
						resolve([]);
						return;
					}
					const rows = database.transaction('projects').objectStore('projects').getAll();
					rows.onerror = () => {
						database.close();
						reject(rows.error);
					};
					rows.onsuccess = () => {
						database.close();
						resolve((rows.result as Array<{ name: string }>).map((row) => row.name));
					};
				};
			})
	);
}

async function attach(info: TestInfo, name: string, value: unknown) {
	await info.attach(name, {
		body: JSON.stringify(value, null, 2),
		contentType: 'application/json'
	});
}

test('Enter on the focused Cancel button cancels a project prompt', async ({ page }, info) => {
	await resetAppState(page);
	const { panel, prompt } = await openProjectPrompt(page);
	const textbox = prompt.getByRole('textbox');
	await textbox.fill('Projet annulé');

	await page.keyboard.press('Tab');
	const cancel = prompt.getByRole('button', { name: 'Annuler', exact: true });
	await expect(cancel).toBeFocused();
	const cancelLabel = await cancel.textContent();
	await page.keyboard.press('Enter');

	await expect(prompt).toBeHidden();
	expect(await projectNames(page)).toEqual([]);
	await expect(panel).toBeVisible();
	await expect(panel.getByRole('button', { name: 'Nouveau projet' })).toBeFocused();
	await attach(info, 'prompt-cancel-enter.json', {
		cancelLabel,
		projects: await projectNames(page)
	});
});

test('Enter on the focused Close button cancels a project prompt', async ({ page }, info) => {
	await resetAppState(page);
	const { panel, prompt } = await openProjectPrompt(page);
	await prompt.getByRole('textbox').fill('Projet fermé');
	const close = prompt.getByRole('button', { name: 'Fermer' });
	await close.focus();
	await expect(close).toBeFocused();
	const closeLabel = await close.getAttribute('aria-label');
	await page.keyboard.press('Enter');

	await expect(prompt).toBeHidden();
	expect(await projectNames(page)).toEqual([]);
	await expect(panel.getByRole('button', { name: 'Nouveau projet' })).toBeFocused();
	await attach(info, 'prompt-close-enter.json', {
		closeLabel,
		projects: await projectNames(page)
	});
});

test('Enter in the prompt input confirms exactly one project', async ({ page }, info) => {
	await resetAppState(page);
	const { prompt } = await openProjectPrompt(page);
	await prompt.getByRole('textbox').fill('Projet confirmé');
	await prompt.getByRole('textbox').press('Enter');

	await expect(prompt).toBeHidden();
	await expect
		.poll(async () => (await projectNames(page)).filter((name) => name === 'Projet confirmé'))
		.toEqual(['Projet confirmé']);
	expect((await projectNames(page)).filter((name) => name === 'Projet confirmé')).toHaveLength(1);
	await attach(info, 'prompt-confirm-enter.json', { projects: await projectNames(page) });
	await info.attach('prompt-confirm-enter.png', { body: await page.screenshot() });
});

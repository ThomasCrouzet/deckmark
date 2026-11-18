import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { resetAppState, seedFiles } from './helpers';

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

test('Enter on the focused Confirm button creates exactly one project', async ({ page }, info) => {
	await resetAppState(page);
	const { prompt } = await openProjectPrompt(page);
	await prompt.getByRole('textbox').fill('Projet validé');
	const confirm = prompt.getByRole('button', { name: 'Nouveau projet', exact: true });
	const confirmLabel = await confirm.textContent();
	await confirm.focus();
	await expect(confirm).toBeFocused();
	await page.keyboard.press('Enter');

	await expect(prompt).toBeHidden();
	await expect
		.poll(async () => (await projectNames(page)).filter((name) => name === 'Projet validé'))
		.toEqual(['Projet validé']);
	expect((await projectNames(page)).filter((name) => name === 'Projet validé')).toHaveLength(1);
	await attach(info, 'prompt-confirm-button-enter.json', {
		confirmLabel,
		createdProjects: 1
	});
});

test('Enter on Cancel leaves a rename prompt without an effect', async ({ page }, info) => {
	await resetAppState(page);
	await seedFiles(page, [{ name: 'rename-source', content: '# Rename source' }]);
	const toolbar = page.locator('#app-toolbar input');
	await expect(toolbar).toHaveValue('rename-source');

	await page.keyboard.press('ControlOrMeta+Shift+P');
	const palette = page.getByRole('dialog', { name: 'Palette de commandes' });
	await expect(palette).toBeVisible();
	await palette.locator('input[type="text"]').fill('renommer');
	await expect(palette.getByRole('option').first()).toContainText('Renommer le document');
	await page.keyboard.press('Enter');

	const prompt = page.getByRole('dialog', { name: 'Nom du document' });
	await expect(prompt).toBeVisible();
	const textbox = prompt.getByRole('textbox');
	await expect(textbox).toBeFocused();
	await textbox.fill('renamed-target');
	await page.keyboard.press('Tab');
	const cancel = prompt.getByRole('button', { name: 'Annuler', exact: true });
	await expect(cancel).toBeFocused();
	await page.keyboard.press('Enter');

	await expect(prompt).toBeHidden();
	await expect(toolbar).toHaveValue('rename-source');
	await attach(info, 'prompt-rename-cancel-enter.json', {
		enteredName: 'renamed-target',
		activeNameAfterCancel: await toolbar.inputValue()
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

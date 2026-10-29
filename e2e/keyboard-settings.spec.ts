import { expect, test, type Page } from '@playwright/test';
import { createFirstFile, openPalette, resetAppState } from './helpers';

async function openSettings(page: Page) {
	await openPalette(page);
	await page.getByRole('combobox').fill('parametres');
	await page.getByRole('option').first().click();
	return page.getByRole('dialog', { name: 'Réglages', exact: true });
}

async function draftCount(page: Page): Promise<number> {
	return page.evaluate(
		() =>
			new Promise<number>((resolve, reject) => {
				const opening = indexedDB.open('mdsh');
				opening.onerror = () => reject(opening.error);
				opening.onsuccess = () => {
					const database = opening.result;
					if (!database.objectStoreNames.contains('drafts')) {
						database.close();
						resolve(0);
						return;
					}
					const request = database.transaction('drafts').objectStore('drafts').count();
					request.onerror = () => {
						database.close();
						reject(request.error);
					};
					request.onsuccess = () => {
						database.close();
						resolve(request.result);
					};
				};
			})
	);
}

async function savedMarkdown(page: Page): Promise<string[]> {
	return page.evaluate(
		() =>
			new Promise<string[]>((resolve, reject) => {
				const opening = indexedDB.open('mdsh');
				opening.onerror = () => reject(opening.error);
				opening.onsuccess = () => {
					const database = opening.result;
					const request = database.transaction('drafts').objectStore('drafts').getAll();
					request.onerror = () => {
						database.close();
						reject(request.error);
					};
					request.onsuccess = () => {
						database.close();
						resolve(request.result.map((row: { content: string }) => row.content.trim()));
					};
				};
			})
	);
}

test.beforeEach(async ({ page }) => {
	await resetAppState(page);
});

test('lists supported writing shortcuts with localized mode and platform labels', async ({
	page
}, testInfo) => {
	const dialog = await openSettings(page);
	await dialog.getByText('Raccourcis clavier', { exact: true }).click();

	const writing = dialog.getByRole('region', { name: 'Raccourcis d’écriture' });
	await expect(writing).toContainText('mode Éditer');
	await expect(writing).toContainText('mode Source');
	await expect(writing.locator('dt')).toHaveText([
		'Gras',
		'Italique',
		'Code en ligne',
		'Barré',
		'Paragraphe',
		'Titre 1',
		'Titre 2',
		'Titre 3',
		'Titre 4',
		'Titre 5',
		'Titre 6',
		'Citation',
		'Bloc de code',
		'Saut de ligne forcé',
		'Liste à puces',
		'Liste numérotée',
		'Insérer une indentation',
		'Nouvel élément de liste',
		'Indenter l’élément de liste',
		'Désindenter l’élément de liste',
		'Cellule de tableau suivante',
		'Cellule de tableau précédente',
		'Quitter le tableau',
		'Indenter la sélection',
		'Désindenter la sélection',
		'Déplacer la ligne vers le haut',
		'Déplacer la ligne vers le bas',
		'Copier la ligne vers le haut',
		'Copier la ligne vers le bas',
		'Aller à la ligne',
		'Sélectionner l’occurrence suivante',
		'Annuler',
		'Rétablir'
	]);

	const expected = await page.evaluate(() => {
		const mac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
		return {
			bold: mac ? '⌘B' : 'Ctrl+B',
			heading: mac ? '⌘⌥2' : 'Ctrl+Alt+2',
			bulletList: mac ? '⌘⌥8' : 'Ctrl+Alt+8',
			indentList: mac ? ['Tab', '⌘]'] : ['Tab', 'Ctrl+]'],
			moveLine: mac ? '⌥↑' : 'Alt+↑',
			undo: mac ? '⌘Z' : 'Ctrl+Z',
			redo: mac ? '⌘⇧Z' : 'Ctrl+Y'
		};
	});
	await expect(writing.locator('[data-writing-shortcut="bold"] kbd')).toHaveText(expected.bold);
	await expect(writing.locator('[data-writing-shortcut="heading-2"] kbd')).toHaveText(
		expected.heading
	);
	await expect(writing.locator('[data-writing-shortcut="bullet-list"] kbd')).toHaveText(
		expected.bulletList
	);
	await expect(writing.locator('[data-writing-shortcut="indent-list-item"] kbd')).toHaveText(
		expected.indentList
	);
	await expect(writing.locator('[data-writing-shortcut="move-line-up"] kbd')).toHaveText(
		expected.moveLine
	);
	await expect(writing.locator('[data-writing-shortcut="undo"] kbd')).toHaveText(expected.undo);
	await expect(writing.locator('[data-writing-shortcut="redo"] kbd')).toHaveText(expected.redo);

	await dialog.getByRole('button', { name: 'English', exact: true }).click();
	const englishDialog = page.getByRole('dialog', { name: 'Settings', exact: true });
	const englishWriting = englishDialog.getByRole('region', { name: 'Writing shortcuts' });
	await expect(englishWriting).toContainText('Edit mode');
	await expect(englishWriting).toContainText('Source mode');
	await expect(englishWriting.locator('dt')).toHaveText([
		'Bold',
		'Italic',
		'Inline code',
		'Strikethrough',
		'Paragraph',
		'Heading 1',
		'Heading 2',
		'Heading 3',
		'Heading 4',
		'Heading 5',
		'Heading 6',
		'Quote',
		'Code block',
		'Hard line break',
		'Bullet list',
		'Numbered list',
		'Insert indentation',
		'New list item',
		'Indent list item',
		'Outdent list item',
		'Next table cell',
		'Previous table cell',
		'Exit table',
		'Indent selection',
		'Outdent selection',
		'Move line up',
		'Move line down',
		'Copy line up',
		'Copy line down',
		'Go to line',
		'Select next occurrence',
		'Undo',
		'Redo'
	]);

	await testInfo.attach('writing-shortcuts', {
		body: JSON.stringify({ locale: 'en', shortcuts: expected }),
		contentType: 'application/json'
	});
});

test('applies documented formatting, block, and history shortcuts in Edit mode', async ({
	page
}, testInfo) => {
	await createFirstFile(page);
	await page.locator('button[data-mode="wysiwyg"]').click();
	const editor = page.locator('.ProseMirror');
	await expect(editor).toBeVisible({ timeout: 20_000 });
	await editor.click();
	await page.keyboard.insertText('Keyboard text');
	await page.waitForTimeout(600);
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.press('ControlOrMeta+b');
	await expect(editor.locator('strong')).toHaveText('Keyboard text');
	await page.waitForTimeout(600);

	await page.keyboard.press('ControlOrMeta+Alt+2');
	await expect(editor.locator('h2 strong')).toHaveText('Keyboard text');
	await expect.poll(() => savedMarkdown(page)).toEqual(['## **Keyboard text**']);

	await page.keyboard.press('ControlOrMeta+z');
	await expect(editor.locator('h2')).toHaveCount(0);
	await expect(editor.locator('p strong')).toHaveText('Keyboard text');
	await page.keyboard.press('ControlOrMeta+z');
	await expect(editor.locator('strong')).toHaveCount(0);
	await expect.poll(() => savedMarkdown(page)).toEqual(['Keyboard text']);

	await testInfo.attach('writing-shortcut-effects', {
		body: JSON.stringify({ bold: true, headingLevel: 2, undoSteps: 2, markdown: 'Keyboard text' }),
		contentType: 'application/json'
	});
});

test('persists a customized shortcut and executes it once after reload', async ({
	page
}, testInfo) => {
	let dialog = await openSettings(page);
	await dialog.getByText('Raccourcis clavier', { exact: true }).click();
	const binding = dialog.getByRole('textbox', {
		name: 'Raccourci pour Nouveau fichier',
		exact: true
	});
	await binding.focus();
	await page.keyboard.press('ControlOrMeta+;');
	const expectedShortcut = await page.evaluate(() =>
		/Mac|iPhone|iPad|iPod/i.test(navigator.platform) ? '⌘;' : 'Ctrl+;'
	);
	await expect(binding).toHaveValue(expectedShortcut);
	await dialog.getByRole('button', { name: 'Fermer', exact: true }).click();

	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	await page.keyboard.press('ControlOrMeta+;');
	await expect.poll(() => draftCount(page)).toBe(1);

	dialog = page.getByRole('dialog', { name: 'Réglages', exact: true });
	await page.getByRole('button', { name: 'Palette de commandes', exact: true }).focus();
	await page.keyboard.press('ControlOrMeta+,');
	await expect(dialog).toBeVisible();
	await dialog.getByText('Raccourcis clavier', { exact: true }).click();
	await expect(
		dialog.getByRole('textbox', { name: 'Raccourci pour Nouveau fichier', exact: true })
	).toHaveValue(expectedShortcut);

	await testInfo.attach('custom-shortcut', {
		body: JSON.stringify({ command: 'new', shortcut: expectedShortcut, draftCount: 1 }),
		contentType: 'application/json'
	});
});

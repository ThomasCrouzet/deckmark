import { expect, test } from '@playwright/test';
import { createFirstFile, resetAppState, writeSourceContent } from './helpers';
import { enableTypewriter } from './typewriter-helpers';

test('typewriter keeps source keyboard selection, composition, undo and accessible input', async ({
	page
}, info) => {
	await resetAppState(page);
	await createFirstFile(page);
	const initial = '# Keyboard\n\nOriginal paragraph.\n';
	await writeSourceContent(page, initial);
	await enableTypewriter(page);
	const source = page.locator('.cm-content');
	await expect(source).toHaveAttribute('role', 'textbox');
	await expect(source).toHaveAttribute('aria-multiline', 'true');
	await expect(source).toHaveAttribute('aria-label', /\S+/);
	await source.focus();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.insertText('selection');
	await page.keyboard.press('Shift+ArrowLeft');
	await page.keyboard.press('Shift+ArrowLeft');
	expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('on');
	await page.keyboard.press('ArrowRight');
	await source.evaluate((element) =>
		element.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }))
	);
	await page.keyboard.insertText('é漢');
	await source.evaluate((element) =>
		element.dispatchEvent(new CompositionEvent('compositionend', { data: 'é漢', bubbles: true }))
	);
	await expect(source).toContainText('selectioné漢');
	await page.keyboard.press('ControlOrMeta+z');
	await expect(source).not.toContainText('é漢');
	const redo = await source.evaluate((element) => {
		// A generic Event discards inputType and does not exercise the native history path.
		const event = new InputEvent('beforeinput', {
			inputType: 'historyRedo',
			bubbles: true,
			cancelable: true,
			composed: true
		});
		element.dispatchEvent(event);
		return {
			constructor: event.constructor.name,
			inputType: event.inputType,
			targetIsSource: event.target === element,
			canceled: event.defaultPrevented
		};
	});
	expect(redo).toEqual({
		constructor: 'InputEvent',
		inputType: 'historyRedo',
		targetIsSource: true,
		canceled: true
	});
	await expect(source).toContainText('selectioné漢');
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					new Promise<string>((resolve, reject) => {
						const request = indexedDB.open('mdsh');
						request.onerror = () => reject(request.error);
						request.onsuccess = () => {
							const database = request.result;
							const get = database.transaction('drafts').objectStore('drafts').getAll();
							get.onsuccess = () => {
								database.close();
								resolve(get.result[0].content);
							};
							get.onerror = () => reject(get.error);
						};
					})
			)
		)
		.toBe(`${initial}selectioné漢`);
	await info.attach('typewriter-keyboard.json', {
		body: JSON.stringify({
			expected: `${initial}selectioné漢`,
			aria: await source.getAttribute('aria-label'),
			redo,
			limitation: 'Synthetic composition events do not prove a physical IME or screen reader.'
		}),
		contentType: 'application/json'
	});
	await page.reload();
	await expect(page.locator('.cm-content')).toContainText('selectioné漢');
});

test('uses the reported keyboard platform before a Safari-compatible user agent', async ({
	page
}, testInfo) => {
	await page.addInitScript(() => {
		Object.defineProperty(navigator, 'platform', { get: () => 'Linux x86_64' });
		Object.defineProperty(navigator, 'userAgent', {
			get: () =>
				'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15'
		});
	});
	await resetAppState(page);
	await createFirstFile(page);
	await page.locator('button[data-mode="source"]').click();
	await expect(page.locator('.cm-content')).toBeVisible();
	await page.locator('.cm-content').click();
	await page.keyboard.insertText('Keyboard platform document');
	await page.keyboard.press('Control+,');
	await expect(page.getByRole('dialog', { name: 'Réglages', exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Fermer', exact: true }).click();
	await expect(
		page.locator('aside').getByRole('button', { name: /Nouveau fichier, raccourci Ctrl\+N/ })
	).toBeVisible();
	await testInfo.attach('keyboard-platform', {
		body: JSON.stringify(
			await page.evaluate(() => ({ platform: navigator.platform, userAgent: navigator.userAgent }))
		),
		contentType: 'application/json'
	});
});

test('rejects Control-only app shortcuts on a Mac-reported web platform', async ({
	page
}, testInfo) => {
	await page.addInitScript(() => {
		Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
	});
	await resetAppState(page);
	await createFirstFile(page);
	const title = page.locator('input[aria-label^="Nom du fichier"]');
	const name = await title.inputValue();
	await page.locator('button[data-mode="source"]').click();
	await expect(page.locator('.cm-content')).toBeVisible();

	const expectNoAppCommand = async (mode: string) => {
		await expect(page.getByTestId('create-presentation')).toHaveCount(0);
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await expect(title).toHaveValue(name);
		await expect(page.locator(`button[data-mode="${mode}"]`)).toHaveAttribute(
			'aria-checked',
			'true'
		);
	};

	// Source mode keeps native Control navigation and must not run app commands.
	await page.locator('.cm-content').click();
	for (const key of ['Control+n', 'Control+o', 'Control+e', 'Control+f'])
		await page.keyboard.press(key);
	await expectNoAppCommand('source');

	// Edit mode keeps the same boundary.
	await page.locator('button[data-mode="wysiwyg"]').click();
	await expect(page.locator('.milkdown')).toBeVisible({ timeout: 15_000 });
	await page.locator('.milkdown').click();
	for (const key of ['Control+n', 'Control+o', 'Control+e', 'Control+f'])
		await page.keyboard.press(key);
	await expectNoAppCommand('wysiwyg');

	// The Command versions remain application commands.
	await page.keyboard.press('Meta+n');
	await expect(page.getByTestId('create-presentation')).toBeVisible();
	await testInfo.attach('mac-control-shortcuts.json', {
		body: JSON.stringify(
			{
				platform: await page.evaluate(() => navigator.platform),
				rejected: ['Control+n', 'Control+o', 'Control+e', 'Control+f'],
				accepted: ['Meta+n'],
				modes: ['source', 'wysiwyg']
			},
			null,
			2
		),
		contentType: 'application/json'
	});
});

test('rejects Command-only app shortcuts on Linux and keeps Control', async ({ page }) => {
	await page.addInitScript(() => {
		Object.defineProperty(navigator, 'platform', { get: () => 'Linux x86_64' });
	});
	await resetAppState(page);
	await createFirstFile(page);
	await page.locator('button[data-mode="source"]').click();
	await expect(page.locator('.cm-content')).toBeVisible();
	await page.locator('.cm-content').click();
	await page.keyboard.press('Meta+n');
	await expect(page.getByTestId('create-presentation')).toHaveCount(0);
	await page.keyboard.press('Control+n');
	await expect(page.getByTestId('create-presentation')).toBeVisible();
});

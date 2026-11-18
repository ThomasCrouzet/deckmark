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
	// Record the event state after the application handler runs on `window`.
	await page.evaluate(() => {
		const seen: Array<{ key: string; prevented: boolean }> = [];
		(window as Window & { __macControlKeys?: typeof seen }).__macControlKeys = seen;
		window.addEventListener('keydown', (event) => {
			if (event.ctrlKey && !event.metaKey && event.key !== 'Control')
				seen.push({ key: event.key, prevented: event.defaultPrevented });
		});
	});
	const controlKeys = () =>
		page.evaluate(
			() =>
				(window as Window & { __macControlKeys?: Array<{ key: string; prevented: boolean }> })
					.__macControlKeys ?? []
		);
	const clearControlKeys = () =>
		page.evaluate(() => {
			(
				window as Window & { __macControlKeys?: Array<{ key: string; prevented: boolean }> }
			).__macControlKeys!.length = 0;
		});
	await createFirstFile(page);
	const title = page.locator('input[aria-label^="Nom du fichier"]');
	const name = await title.inputValue();
	await page.locator('button[data-mode="source"]').click();
	await expect(page.locator('.cm-content')).toBeVisible();

	const expectNoAppCommand = async (mode: string) => {
		await expect(page.getByTestId('create-presentation')).toHaveCount(0);
		await expect(page.getByRole('dialog')).toHaveCount(0);
		// Find stays closed in Source (CodeMirror panel) and in Edit (tool).
		await expect(page.locator('.cm-panels')).toHaveCount(0);
		await expect(page.locator('[data-document-navigation]')).toHaveCount(0);
		await expect(title).toHaveValue(name);
		await expect(page.locator(`button[data-mode="${mode}"]`)).toHaveAttribute(
			'aria-checked',
			'true'
		);
	};

	// Source mode keeps editor Control navigation and must not run app commands.
	await writeSourceContent(page, '# Mac note\n\nFirst paragraph.\n\nSecond paragraph.\n');
	await page.keyboard.press('Meta+Home');
	await clearControlKeys();
	const activeLineBefore = await page.locator('.cm-activeLine').innerText();
	for (const key of ['Control+n', 'Control+o', 'Control+e', 'Control+f'])
		await page.keyboard.press(key);
	await expectNoAppCommand('source');
	// The editor keeps its own Control bindings: the caret moved.
	expect(await page.locator('.cm-activeLine').innerText()).not.toBe(activeLineBefore);
	expect((await controlKeys()).map((entry) => entry.key)).toEqual(['n', 'o', 'e', 'f']);

	// Edit mode keeps the same boundary for the caret and for the focused region.
	await clearControlKeys();
	await page.locator('button[data-mode="wysiwyg"]').click();
	await expect(page.locator('.milkdown')).toBeVisible({ timeout: 15_000 });
	await page.locator('.milkdown').click();
	for (const key of ['Control+n', 'Control+o', 'Control+e', 'Control+f'])
		await page.keyboard.press(key);
	await expectNoAppCommand('wysiwyg');
	expect((await controlKeys()).map((entry) => entry.key)).toEqual(['n', 'o', 'e', 'f']);

	// A focused editor region without a keymap conflict shows the modifier
	// boundary itself: the application leaves every Control-only key alone.
	await clearControlKeys();
	await page.locator('.mdsh-editor').focus();
	for (const key of ['Control+n', 'Control+o', 'Control+e', 'Control+f'])
		await page.keyboard.press(key);
	expect(await controlKeys()).toEqual([
		{ key: 'n', prevented: false },
		{ key: 'o', prevented: false },
		{ key: 'e', prevented: false },
		{ key: 'f', prevented: false }
	]);

	// The Command versions remain application commands: mode, find and new.
	await page.keyboard.press('Meta+r');
	await expect(page.locator('button[data-mode="read"]')).toHaveAttribute('aria-checked', 'true');
	await page.keyboard.press('Meta+e');
	await expect(page.locator('.milkdown')).toBeVisible({ timeout: 15_000 });
	await expect(page.locator('button[data-mode="wysiwyg"]')).toHaveAttribute('aria-checked', 'true');
	await page.locator('.milkdown .ProseMirror').click();
	await page.keyboard.press('Meta+f');
	await expect(page.locator('[data-document-navigation]')).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page.locator('[data-document-navigation]')).toHaveCount(0);
	await page.keyboard.press('Meta+n');
	await expect(page.getByTestId('create-presentation')).toBeVisible();
	await testInfo.attach('mac-control-shortcuts.json', {
		body: JSON.stringify(
			{
				platform: await page.evaluate(() => navigator.platform),
				rejected: ['Control+n', 'Control+o', 'Control+e', 'Control+f'],
				accepted: ['Meta+r', 'Meta+e', 'Meta+f', 'Meta+n'],
				modes: ['source', 'wysiwyg'],
				limitation:
					'A Playwright key event does not prove a macOS engine text command or a browser-reserved key.'
			},
			null,
			2
		),
		contentType: 'application/json'
	});
});

test('keeps Mac file navigation, dialog focus and custom bindings without Control-only commands', async ({
	page
}, testInfo) => {
	await page.addInitScript(() => {
		Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
	});
	await resetAppState(page);
	// A custom binding for New file, away from the reserved editing keys.
	await page.evaluate(() =>
		localStorage.setItem('mdsh:shortcuts:web', JSON.stringify({ new: { key: '1', shift: false } }))
	);
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor({ timeout: 15_000 });
	await createFirstFile(page);
	const title = page.locator('input[aria-label^="Nom du fichier"]');
	const firstName = await title.inputValue();
	// A second file is necessary for the Control+Tab navigation exception.
	await page.locator('aside button[aria-label^="Nouveau fichier"]').first().click();
	await page.getByTestId('create-note').click();
	await expect(title).not.toHaveValue(firstName);
	const secondName = await title.inputValue();
	await page.locator('button[data-mode="source"]').click();
	await expect(page.locator('.cm-content')).toBeVisible();
	await page.locator('.cm-content').click();

	// The documented Control+Tab file navigation stays active on a Mac platform.
	await page.keyboard.press('Control+Tab');
	await expect(title).toHaveValue(firstName);
	await expect(page.locator('.cm-content')).toBeVisible();
	await page.keyboard.press('Control+Shift+Tab');
	await expect(title).toHaveValue(secondName);

	// A custom binding uses Command and ignores a Control-only press.
	await page.keyboard.press('Control+1');
	await expect(page.getByTestId('create-presentation')).toHaveCount(0);
	await page.keyboard.press('Meta+1');
	await expect(page.getByTestId('create-presentation')).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('create-presentation')).toHaveCount(0);

	// An open dialog keeps the keyboard.
	await page.keyboard.press('Meta+,');
	const settings = page.getByRole('dialog', { name: 'Réglages', exact: true });
	await expect(settings).toBeVisible();
	await page.keyboard.press('Meta+n');
	await expect(settings).toBeVisible();
	await expect(page.getByTestId('create-presentation')).toHaveCount(0);
	await settings.getByRole('button', { name: 'Fermer', exact: true }).click();
	await expect(settings).toBeHidden();

	// A composing event does not run an application command.
	await page.locator('.cm-content').click();
	await page.locator('.cm-content').evaluate((element) => {
		element.dispatchEvent(
			new KeyboardEvent('keydown', {
				key: 'n',
				metaKey: true,
				isComposing: true,
				bubbles: true,
				cancelable: true
			})
		);
	});
	await page.waitForTimeout(50);
	await expect(page.getByTestId('create-presentation')).toHaveCount(0);

	await testInfo.attach('mac-regressions.json', {
		body: JSON.stringify(
			{
				platform: await page.evaluate(() => navigator.platform),
				files: [firstName, secondName],
				checks: ['Control+Tab', 'Control+Shift+Tab', 'custom binding', 'dialog focus', 'IME'],
				limitation: 'A synthetic composition event does not prove an operating-system input method.'
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

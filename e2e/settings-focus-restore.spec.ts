import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { resetAppState } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

async function attach(info: TestInfo, name: string, value: unknown) {
	await info.attach(name, {
		body: JSON.stringify(value, null, 2),
		contentType: 'application/json'
	});
}

async function activeIn(page: Page, selector: string): Promise<boolean> {
	return page.evaluate(({ selector: target }) => document.activeElement?.closest(target) !== null, {
		selector
	});
}

/**
 * Issue #736 (part): the Settings dialog becomes inert while a prompt opens.
 * The browser moves focus to the body, so the prompt close left the keyboard
 * outside the dialog. The panel now returns focus to its first control.
 */
test('returns focus to Settings after a prompt closes', async ({ page }, info) => {
	await resetAppState(page);
	await page.keyboard.press('Control+,');

	const settings = page.getByRole('dialog', { name: 'Réglages', exact: true });
	await expect(settings).toBeVisible();
	const close = settings.getByRole('button', { name: 'Fermer', exact: true });
	await expect(close).toBeFocused();

	// Keyboard activation of the encrypted export opens a passphrase prompt.
	const encrypted = settings.getByRole('button', { name: /Exporter \(chiffré\)/ });
	await encrypted.focus();
	await expect(encrypted).toBeFocused();
	await page.keyboard.press('Enter');

	const prompt = page.getByRole('dialog', { name: 'Chiffrer la sauvegarde', exact: true });
	await expect(prompt).toBeVisible();
	const passphrase = prompt.getByRole('textbox');
	await expect(passphrase).toBeFocused();
	expect(await activeIn(page, '[role="dialog"][aria-labelledby="settings-title"]')).toBe(false);

	// Escape cancels the prompt. Focus must come back inside the dialog.
	await page.keyboard.press('Escape');
	await expect(prompt).toBeHidden();
	await expect(settings).toBeVisible();
	await expect(close).toBeFocused();
	expect(await activeIn(page, '[role="dialog"][aria-labelledby="settings-title"]')).toBe(true);

	// A second prompt keeps the same contract.
	await encrypted.focus();
	await page.keyboard.press('Enter');
	await expect(prompt).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(prompt).toBeHidden();
	await expect(close).toBeFocused();

	await attach(info, 'settings-focus-restore.json', {
		command:
			'npx playwright test e2e/settings-focus-restore.spec.ts --project=chromium --workers=1',
		trigger: 'Export (encrypted) opens the passphrase prompt',
		restoredControl: 'Settings close button',
		repeatedPrompt: true
	});
	await info.attach('settings-focus-restore.png', { body: await page.screenshot() });
});

import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createFirstFile, resetAppState } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

interface ChordResult {
	defaultPrevented: boolean;
	key: string;
	code: string;
	shiftKey: boolean;
}

/**
 * Send the event shape that an AZERTY keyboard produces for the Source chord:
 * the physical Slash key with Shift held, and ':' as the produced character.
 * Playwright's keyboard cannot set `code` and `key` independently.
 */
async function pressAzertySourceChord(page: Page): Promise<ChordResult> {
	return page.evaluate(
		() =>
			new Promise<ChordResult>((resolve) => {
				const isMac = /mac/i.test(navigator.platform);
				const event = new KeyboardEvent('keydown', {
					key: ':',
					code: 'Slash',
					shiftKey: true,
					ctrlKey: !isMac,
					metaKey: isMac,
					bubbles: true,
					cancelable: true
				});
				window.dispatchEvent(event);
				resolve({
					defaultPrevented: event.defaultPrevented,
					key: event.key,
					code: event.code,
					shiftKey: event.shiftKey
				});
			})
	);
}

async function attach(info: TestInfo, name: string, value: unknown) {
	await info.attach(name, {
		body: JSON.stringify(value, null, 2),
		contentType: 'application/json'
	});
}

/**
 * Issue #719: an AZERTY keyboard needs Shift for '/'. The binding matched only
 * `event.key === '/'`, so the Source chord never fired on that layout.
 */
test('matches the Source chord on an AZERTY event shape', async ({ page }, info) => {
	await resetAppState(page, { mode: 'wysiwyg' });
	await createFirstFile(page);
	await expect(page.locator('.ProseMirror').first()).toBeVisible({ timeout: 20_000 });
	await expect
		.poll(() => page.locator('[data-mode][aria-checked="true"]').getAttribute('data-mode'))
		.toBe('wysiwyg');

	const chord = await pressAzertySourceChord(page);
	expect(chord.defaultPrevented).toBe(true);
	await expect
		.poll(() => page.locator('[data-mode][aria-checked="true"]').getAttribute('data-mode'))
		.toBe('source');
	await expect(page.locator('.cm-content').first()).toBeVisible({ timeout: 20_000 });

	await attach(info, 'keyboard-azerty.json', {
		command: 'npx playwright test e2e/keyboard-azerty.spec.ts --project=chromium --workers=1',
		method: 'synthetic KeyboardEvent with the AZERTY Slash shape',
		event: chord,
		mode: 'source'
	});
});

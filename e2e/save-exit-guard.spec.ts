import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createFirstFile, resetAppState, writeSourceContent } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

interface UnloadResult {
	defaultPrevented: boolean;
	returnValue: unknown;
}

/**
 * Dispatch a real beforeunload event and read the cancel state. Playwright
 * cannot read the browser confirmation dialog, so the event result is the
 * observable contract of the guard.
 */
async function dispatchUnload(page: Page): Promise<UnloadResult> {
	return page.evaluate(() => {
		const event = new Event('beforeunload', { cancelable: true });
		window.dispatchEvent(event);
		return { defaultPrevented: event.defaultPrevented, returnValue: event.returnValue };
	});
}

async function attach(info: TestInfo, name: string, value: unknown) {
	await info.attach(name, {
		body: JSON.stringify(value, null, 2),
		contentType: 'application/json'
	});
}

test('leaves quietly with durable drafts and asks when a write is pending', async ({
	page
}, info) => {
	await resetAppState(page);
	await createFirstFile(page);
	await writeSourceContent(page, '# Exit guard\n\nDurable baseline.\n');

	const quiet = await dispatchUnload(page);
	expect(quiet.defaultPrevented).toBe(false);

	// One key arms the 400 ms debounce. The unload handler flushes, the put is
	// still in flight, and the flush cannot prove durability in that turn.
	await page.locator('.cm-content').first().focus();
	await page.keyboard.press('Control+End');
	await page.keyboard.insertText(' pending');
	const pending = await dispatchUnload(page);
	expect(pending.defaultPrevented).toBe(true);

	// The queued write completes, so a later unload returns to the quiet path.
	await expect
		.poll(async () => (await dispatchUnload(page)).defaultPrevented, { timeout: 10_000 })
		.toBe(false);

	await attach(info, 'exit-guard.json', {
		command: 'npx playwright test e2e/save-exit-guard.spec.ts --project=chromium --workers=1',
		durable: quiet,
		pending,
		path: 'beforeunload handler in src/lib/ui/file-intents.svelte.ts'
	});
});

test('asks before leaving when a draft write failed', async ({ page }, info) => {
	await resetAppState(page);
	await createFirstFile(page);
	const name = await page.locator('#app-toolbar input').inputValue();
	await writeSourceContent(page, '# Failed exit\n\nDurable baseline.\n');

	// Same failure injection as e2e/editor-state.spec.ts: the drafts store
	// rejects every put like an exhausted quota.
	await page.evaluate(() => {
		const originalPut = IDBObjectStore.prototype.put;
		IDBObjectStore.prototype.put = function (...args: Parameters<typeof originalPut>) {
			if (this.name === 'drafts')
				throw new DOMException('Exit guard write failure', 'QuotaExceededError');
			return originalPut.apply(this, args);
		};
	});
	await page.locator('.cm-content').first().focus();
	await page.keyboard.press('Control+End');
	await page.keyboard.insertText(' lost without a guard');

	const warning = page.getByRole('alert').filter({ hasText: name });
	await expect(warning).toBeVisible({ timeout: 10_000 });
	const failed = await dispatchUnload(page);
	expect(failed.defaultPrevented).toBe(true);

	await attach(info, 'exit-guard-failed-save.json', {
		command: 'npx playwright test e2e/save-exit-guard.spec.ts --project=chromium --workers=1',
		injection: 'IDBObjectStore.prototype.put throws QuotaExceededError for drafts',
		alert: await warning.textContent(),
		beforeunload: failed
	});
});

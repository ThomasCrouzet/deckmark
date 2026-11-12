import { test, expect, type Download, type Page, type TestInfo } from '@playwright/test';
import { createFirstFile, renameActiveFile, resetAppState, writeSourceContent } from './helpers';

// Issue #620 - the StatusBar keeps its own backup-reminder state. These cases
// check the reminder before and after a manual external backup, a failed
// export, a dismissal and the two reminder windows. They use the real Settings
// export path and the real localStorage timestamps.

const DAY = 24 * 60 * 60 * 1000;
const BACKUP_KEY = 'mdsh:storage:last-external-backup';
const REMINDER_KEY = 'mdsh:storage:last-backup-reminder';
const ERROR_KEY = 'mdsh:storage:last-backup-error';
const NOTE = '# Backup note\n\nLocal content that needs a backup.\n';

interface Timestamps {
	backup: string | null;
	reminder: string | null;
	error: string | null;
}

async function ready(page: Page): Promise<void> {
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor({
		state: 'visible',
		timeout: 15_000
	});
}

async function seedTimestamps(
	page: Page,
	backup: number | null,
	reminder: number | null
): Promise<void> {
	await page.evaluate(
		({ backupKey, reminderKey, backupAt, reminderAt }) => {
			for (const [key, value] of [
				[backupKey, backupAt],
				[reminderKey, reminderAt]
			] as const) {
				if (value === null) localStorage.removeItem(key);
				else localStorage.setItem(key, String(value));
			}
		},
		{ backupKey: BACKUP_KEY, reminderKey: REMINDER_KEY, backupAt: backup, reminderAt: reminder }
	);
}

async function timestamps(page: Page): Promise<Timestamps> {
	return page.evaluate(
		({ backupKey, reminderKey, errorKey }) => ({
			backup: localStorage.getItem(backupKey),
			reminder: localStorage.getItem(reminderKey),
			error: localStorage.getItem(errorKey)
		}),
		{ backupKey: BACKUP_KEY, reminderKey: REMINDER_KEY, errorKey: ERROR_KEY }
	);
}

function reminder(page: Page) {
	return page.locator('#app-statusbar').getByRole('button', { name: 'Sauvegarder vos documents' });
}

async function openSettings(page: Page): Promise<void> {
	await ready(page);
	await page.keyboard.press('ControlOrMeta+,');
	await expect(page.getByRole('dialog', { name: 'Réglages' })).toBeVisible();
}

async function overdueLibrary(page: Page, now = Date.now()): Promise<void> {
	await resetAppState(page);
	await createFirstFile(page);
	await writeSourceContent(page, NOTE);
	await seedTimestamps(page, now - 60 * DAY, null);
	await page.reload();
	await ready(page);
}

async function downloadBytes(download: Download): Promise<Buffer> {
	const stream = await download.createReadStream();
	const chunks: Buffer[] = [];
	for await (const chunk of stream!) chunks.push(chunk);
	return Buffer.concat(chunks);
}

async function attach(info: TestInfo, name: string, value: unknown): Promise<void> {
	await info.attach(name, {
		body: JSON.stringify(value, null, 2),
		contentType: 'application/json'
	});
}

test('a successful Settings export clears the overdue reminder in the same tab', async ({
	page
}, info) => {
	await overdueLibrary(page);
	await expect(reminder(page)).toBeVisible();
	const before = await timestamps(page);
	expect(before.backup).not.toBeNull();
	expect(before.reminder).toBeNull();

	await openSettings(page);
	const pending = page.waitForEvent('download', { timeout: 15_000 });
	await page.getByRole('button', { name: 'Exporter une sauvegarde', exact: true }).click();
	const download = await pending;
	const bytes = await downloadBytes(download);
	const backup = JSON.parse(bytes.toString()) as { format?: string; drafts?: unknown[] };
	expect(backup.format).toBe('mdsh-backup');
	expect(backup.drafts).toHaveLength(1);
	await expect(
		page.getByRole('status').filter({ hasText: 'Sauvegarde exportée.' }).last()
	).toBeVisible();

	// The mounted StatusBar is behind the dialog. A same-tab success removes its
	// reminder before Settings closes.
	await expect(reminder(page)).toHaveCount(0);
	await page.keyboard.press('Escape');
	await expect(page.getByRole('dialog', { name: 'Réglages' })).toBeHidden();
	await expect(reminder(page)).toHaveCount(0);

	const after = await timestamps(page);
	expect(Number(after.backup)).toBeGreaterThan(Number(before.backup));
	expect(after.reminder).toBe(after.backup);

	await page.reload();
	await ready(page);
	await expect(reminder(page)).toHaveCount(0);
	await attach(info, 'backup-reminder-success.json', {
		before,
		after,
		downloadName: download.suggestedFilename(),
		backupBytes: bytes.length,
		backupDrafts: backup.drafts?.length,
		reminderAfterReload: await reminder(page).count()
	});
});

test('a failed export preserves the overdue reminder across close and reload', async ({
	page
}, info) => {
	await overdueLibrary(page);
	await expect(reminder(page)).toBeVisible();
	const before = await timestamps(page);
	expect(before.reminder).toBeNull();

	// Opening Settings through the toolbar is a read. It must not acknowledge
	// the reminder or move the controlled overdue state.
	await openSettings(page);
	const afterOpen = await timestamps(page);
	expect(afterOpen).toEqual(before);

	await page.evaluate(() => {
		const original = URL.createObjectURL;
		(window as unknown as { __restoreObjectUrl: () => void }).__restoreObjectUrl = () => {
			URL.createObjectURL = original;
		};
		URL.createObjectURL = () => {
			throw new DOMException('Export blocked', 'NotAllowedError');
		};
	});
	let downloaded = false;
	try {
		const unexpected = page
			.waitForEvent('download', { timeout: 3000 })
			.then(() => {
				downloaded = true;
			})
			.catch(() => {});
		await page.getByRole('button', { name: 'Exporter une sauvegarde', exact: true }).click();
		await expect(
			page
				.getByRole('alert')
				.filter({ hasText: /export de la sauvegarde a échoué/i })
				.last()
		).toBeVisible();
		await unexpected;
	} finally {
		await page.evaluate(() => {
			(window as unknown as { __restoreObjectUrl?: () => void }).__restoreObjectUrl?.();
		});
	}
	// The actual failure must leave the controlled overdue state untouched.
	const afterFailure = await timestamps(page);
	expect(afterFailure.backup).toBe(before.backup);
	expect(afterFailure.reminder).toBe(before.reminder);
	expect(afterFailure.error).not.toBeNull();
	expect(downloaded).toBe(false);

	await page.keyboard.press('Escape');
	await expect(page.getByRole('dialog', { name: 'Réglages' })).toBeHidden();
	await expect(reminder(page)).toBeVisible();
	const afterClose = await timestamps(page);
	expect(afterClose.backup).toBe(before.backup);
	expect(afterClose.reminder).toBeNull();

	await page.reload();
	await ready(page);
	await expect(reminder(page)).toBeVisible();
	const reloaded = await timestamps(page);
	expect(reloaded.backup).toBe(before.backup);
	expect(reloaded.reminder).toBeNull();
	expect(Date.now() - Number(reloaded.backup)).toBeGreaterThan(30 * DAY);
	await attach(info, 'backup-reminder-failure.json', {
		before,
		afterOpen,
		afterFailure,
		afterClose,
		reloaded,
		downloaded,
		reminderVisibleAfterReload: await reminder(page).isVisible()
	});
});

test('opening, closing Settings and changing documents keep the reminder due', async ({
	page
}, info) => {
	await overdueLibrary(page);
	await renameActiveFile(page, 'Reminder note');
	await expect(reminder(page)).toBeVisible();
	const before = await timestamps(page);
	expect(before.reminder).toBeNull();

	await openSettings(page);
	expect(await timestamps(page)).toEqual(before);
	await page.keyboard.press('Escape');
	await expect(page.getByRole('dialog', { name: 'Réglages' })).toBeHidden();
	expect(await timestamps(page)).toEqual(before);
	await expect(reminder(page)).toBeVisible();

	// Create a second note, then return to the first. A document change is not
	// a reminder action.
	await page
		.getByRole('button', { name: /^Nouveau fichier/ })
		.first()
		.click();
	await page.getByTestId('create-note').click();
	await expect(page.locator('input[aria-label^="Nom du fichier"]')).toBeVisible();
	expect(await timestamps(page)).toEqual(before);
	await page
		.locator('aside')
		.getByRole('button', { name: /^Reminder note/ })
		.first()
		.click();
	expect(await timestamps(page)).toEqual(before);
	await expect(reminder(page)).toBeVisible();

	await page.reload();
	await ready(page);
	await expect(reminder(page)).toBeVisible();
	const reloaded = await timestamps(page);
	expect(reloaded).toEqual(before);
	await attach(info, 'backup-reminder-open-close.json', {
		before,
		reloaded,
		reminderVisibleAfterReload: await reminder(page).isVisible()
	});
});

test('unavailable reminder timestamps do not crash export or clear the reminder', async ({
	page
}, info) => {
	await overdueLibrary(page);
	await expect(reminder(page)).toBeVisible();
	const before = await timestamps(page);
	const pageErrors: string[] = [];
	page.on('pageerror', (error) => pageErrors.push(error.message));

	// Block only the reminder timestamp keys after app setup. The app already
	// loaded its other preferences, so this stays inside the status bar path.
	await page.evaluate(() => {
		const proto = Storage.prototype;
		const get = proto.getItem;
		const set = proto.setItem;
		const remove = proto.removeItem;
		const blocked = (key: unknown) => typeof key === 'string' && key.startsWith('mdsh:storage:');
		proto.getItem = function (key) {
			if (blocked(key)) throw new DOMException('blocked', 'SecurityError');
			return get.call(this, key);
		};
		proto.setItem = function (key, value) {
			if (blocked(key)) throw new DOMException('blocked', 'SecurityError');
			return set.call(this, key, value);
		};
		proto.removeItem = function (key) {
			if (blocked(key)) throw new DOMException('blocked', 'SecurityError');
			return remove.call(this, key);
		};
		(window as unknown as { __restoreTimestampStorage: () => void }).__restoreTimestampStorage =
			() => {
				proto.getItem = get;
				proto.setItem = set;
				proto.removeItem = remove;
			};
	});
	try {
		await openSettings(page);
		const pending = page.waitForEvent('download', { timeout: 15_000 });
		await page.getByRole('button', { name: 'Exporter une sauvegarde', exact: true }).click();
		const download = await pending;
		const bytes = await downloadBytes(download);
		expect((JSON.parse(bytes.toString()) as { format?: string }).format).toBe('mdsh-backup');
		await expect(
			page.getByRole('status').filter({ hasText: 'Sauvegarde exportée.' }).last()
		).toBeVisible();
		// The success signal recomputes from unreadable timestamps. It must keep
		// the reminder due instead of publishing a false cleared state.
		await expect(reminder(page)).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(page.getByRole('dialog', { name: 'Réglages' })).toBeHidden();
		await expect(reminder(page)).toBeVisible();
	} finally {
		await page.evaluate(() => {
			(
				window as unknown as { __restoreTimestampStorage?: () => void }
			).__restoreTimestampStorage?.();
		});
	}
	expect(pageErrors).toEqual([]);
	const after = await timestamps(page);
	expect(after.backup).toBe(before.backup);
	expect(after.reminder).toBe(before.reminder);
	expect(after.error).toBeNull();
	await page.reload();
	await ready(page);
	await expect(reminder(page)).toBeVisible();
	await attach(info, 'backup-reminder-unavailable.json', {
		before,
		after,
		pageErrors,
		reminderVisibleAfterReload: await reminder(page).isVisible()
	});
});

test('dismissing the reminder stays dismissed after reload', async ({ page }, info) => {
	await overdueLibrary(page);
	await expect(reminder(page)).toBeVisible();
	const before = await timestamps(page);
	await page
		.locator('#app-statusbar')
		.getByRole('button', { name: 'Me rappeler la sauvegarde la semaine prochaine' })
		.click();
	await expect(reminder(page)).toHaveCount(0);
	const after = await timestamps(page);
	expect(Number(after.reminder)).toBeGreaterThan(Number(before.backup));
	await page.reload();
	await ready(page);
	await expect(reminder(page)).toHaveCount(0);
	await attach(info, 'backup-reminder-dismiss.json', {
		before,
		after,
		reminderAfterReload: await reminder(page).count()
	});
});

test('the backup age and reminder windows still decide the reminder', async ({ page }, info) => {
	await resetAppState(page);
	await createFirstFile(page);
	await writeSourceContent(page, NOTE);
	const now = Date.now();
	const cases = [
		{
			name: 'old backup, recent reminder',
			backup: now - 60 * DAY,
			reminder: now - DAY,
			due: false
		},
		{
			name: 'old backup, reminder window open',
			backup: now - 60 * DAY,
			reminder: now - 8 * DAY,
			due: true
		},
		{ name: 'recent backup', backup: now - DAY, reminder: now - 8 * DAY, due: false }
	];
	const results: Array<{ name: string; due: boolean; visible: number }> = [];
	for (const item of cases) {
		await seedTimestamps(page, item.backup, item.reminder);
		await page.reload();
		await ready(page);
		const visible = await reminder(page).count();
		results.push({ name: item.name, due: item.due, visible });
		expect(visible, item.name).toBe(item.due ? 1 : 0);
	}
	await attach(info, 'backup-reminder-windows.json', { now, results });
});

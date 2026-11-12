import { test, expect, type Download, type Page, type TestInfo } from '@playwright/test';
import { createFirstFile, resetAppState, writeSourceContent } from './helpers';

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

test('a failed export keeps an overdue reminder and records no success', async ({ page }, info) => {
	await overdueLibrary(page);
	await expect(reminder(page)).toBeVisible();
	const before = await timestamps(page);

	await openSettings(page);
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
	await page.keyboard.press('Escape');
	await expect(page.getByRole('dialog', { name: 'Réglages' })).toBeHidden();
	await expect(reminder(page)).toBeVisible();

	const after = await timestamps(page);
	expect(after.backup).toBe(before.backup);
	expect(after.error).not.toBeNull();
	expect(downloaded).toBe(false);
	await attach(info, 'backup-reminder-failure.json', {
		before,
		after,
		downloaded,
		reminderVisible: await reminder(page).isVisible()
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

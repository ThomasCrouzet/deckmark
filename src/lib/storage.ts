// §J1 - Local storage resilience (IndexedDB).
//
// The app persists EVERYTHING in IndexedDB (drafts, trash, workspaces) - no
// backend, no network fallback. So it is a single point of failure that we
// harden here:
//   - `isQuotaError`        : detects a quota overflow (cross-browser).
//   - `reportPersistenceError` : routes a write error to a user toast
//                             instead of swallowing it in the console.
//   - `requestPersistentStorage` : requests a persistent bucket so the
//                             browser does not evict the data under disk
//                             pressure (without it, IDB is "best-effort").
//   - `checkStoragePressure` : preemptive alert before the quota is reached.
//
// Acute motivation: since image drag & drop (inline data-URI in the markdown
// content), a draft can weigh several MB - the quota becomes reachable, and a
// silent failure = invisible data loss.

import { browser } from '$app/env';
import { t } from '#lib/i18n/index.js';
import { db } from './db';
import { notify } from './notify.svelte';

/** Context of a storage operation, for a tailored error message. */
export type PersistenceContext = 'save' | 'trash' | 'reorder' | 'delete' | 'load';

const BACKUP_SUCCESS_KEY = 'mdsh:storage:last-external-backup';
const BACKUP_ERROR_KEY = 'mdsh:storage:last-backup-error';
const BACKUP_REMINDER_KEY = 'mdsh:storage:last-backup-reminder';
const BACKUP_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const BACKUP_REMINDER_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export interface StorageHealth {
	persistence: 'persistent' | 'best-effort' | 'unavailable';
	usage: number | null;
	quota: number | null;
	projectAssetCount: number | null;
	projectAssetBytes: number | null;
	lastExternalBackupAt: number | null;
	lastBackupErrorAt: number | null;
	backupReminderDue: boolean;
}

function readTimestamp(key: string): number | null {
	if (!browser) return null;
	try {
		const value = Number(localStorage.getItem(key));
		return Number.isFinite(value) && value > 0 ? value : null;
	} catch {
		return null;
	}
}

function writeTimestamp(key: string, value: number | null): void {
	if (!browser) return;
	try {
		if (value === null) localStorage.removeItem(key);
		else localStorage.setItem(key, String(value));
	} catch {
		// Local health metadata is best-effort and never blocks the actual backup.
	}
}

export function recordExternalBackupSuccess(now = Date.now()): void {
	writeTimestamp(BACKUP_SUCCESS_KEY, now);
	writeTimestamp(BACKUP_ERROR_KEY, null);
	writeTimestamp(BACKUP_REMINDER_KEY, now);
}

export function recordExternalBackupFailure(now = Date.now()): void {
	writeTimestamp(BACKUP_ERROR_KEY, now);
}

export function recordBackupReminderShown(now = Date.now()): void {
	writeTimestamp(BACKUP_REMINDER_KEY, now);
}

export function isBackupReminderDue(
	now: number,
	lastBackupAt: number | null,
	lastReminderAt: number | null
): boolean {
	const backupTooOld = lastBackupAt === null || now - lastBackupAt >= BACKUP_MAX_AGE_MS;
	const reminderWindowOpen =
		lastReminderAt === null || now - lastReminderAt >= BACKUP_REMINDER_INTERVAL_MS;
	return backupTooOld && reminderWindowOpen;
}

export async function getStorageHealth(now = Date.now()): Promise<StorageHealth> {
	const lastExternalBackupAt = readTimestamp(BACKUP_SUCCESS_KEY);
	const lastBackupErrorAt = readTimestamp(BACKUP_ERROR_KEY);
	const lastReminderAt = readTimestamp(BACKUP_REMINDER_KEY);
	let projectAssetCount: number | null = null;
	let projectAssetBytes: number | null = null;
	if (browser) {
		try {
			projectAssetCount = await db.projectAssets.count();
			projectAssetBytes = 0;
			await db.projectAssets.each((asset) => {
				projectAssetBytes! += asset.data.byteLength;
			});
		} catch {
			projectAssetCount = null;
			projectAssetBytes = null;
		}
	}
	if (!browser || !navigator.storage) {
		return {
			persistence: 'unavailable',
			usage: null,
			quota: null,
			projectAssetCount,
			projectAssetBytes,
			lastExternalBackupAt,
			lastBackupErrorAt,
			backupReminderDue: isBackupReminderDue(now, lastExternalBackupAt, lastReminderAt)
		};
	}

	let persistence: StorageHealth['persistence'] = 'best-effort';
	let usage: number | null = null;
	let quota: number | null = null;
	try {
		if (navigator.storage.persisted && (await navigator.storage.persisted())) {
			persistence = 'persistent';
		}
	} catch {
		persistence = 'best-effort';
	}
	try {
		const estimate = await navigator.storage.estimate?.();
		usage = typeof estimate?.usage === 'number' ? estimate.usage : null;
		quota = typeof estimate?.quota === 'number' ? estimate.quota : null;
	} catch {
		// Estimates are optional. Keep the unknown values initialized above.
	}
	return {
		persistence,
		usage,
		quota,
		projectAssetCount,
		projectAssetBytes,
		lastExternalBackupAt,
		lastBackupErrorAt,
		backupReminderDue: isBackupReminderDue(now, lastExternalBackupAt, lastReminderAt)
	};
}

export function formatStorageBytes(value: number): string {
	if (value < 1024) return `${value} B`;
	const units = ['KiB', 'MiB', 'GiB', 'TiB'];
	let amount = value / 1024;
	let unit = units[0]!;
	for (let index = 1; index < units.length && amount >= 1024; index++) {
		amount /= 1024;
		unit = units[index]!;
	}
	return `${amount.toFixed(amount >= 10 ? 0 : 1)} ${unit}`;
}

/** Detects the quota error variants exposed by supported browsers. */
export function isQuotaError(err: unknown): boolean {
	if (err instanceof DOMException) {
		return (
			err.name === 'QuotaExceededError' || // Historical Firefox.
			err.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
			err.code === 22
		);
	}
	return false;
}

/**
 * Routes a persistence error to a visible user notification.
 * Distinguishes a full quota (actionable: export / close files) from a generic
 * failure. The toast is deduplicated on the `notify` side - no avalanche if
 * every write fails (the typical case when the quota is reached).
 */
export function reportPersistenceError(err: unknown, context: PersistenceContext): void {
	if (isQuotaError(err)) {
		notify.error(t('storage.quotaFull'));
	} else {
		notify.error(
			context === 'save'
				? t('storage.saveFailed')
				: context === 'load'
					? t('storage.loadFailed')
					: t('storage.genericFailed')
		);
	}
	console.error(`[mdsh] persistance (${context}) :`, err);
}

/**
 * Asks the browser for persistent storage (best-effort, idempotent).
 * Without a persistent bucket, IndexedDB can be purged under disk pressure - for
 * an app whose sole storage this is, we want the persistent mode.
 * Returns `true` if granted (or already granted), `false` otherwise.
 */
export async function requestPersistentStorage(): Promise<boolean> {
	if (!browser) return false;
	const storage = navigator.storage;
	if (!storage?.persist) return false;
	try {
		if (storage.persisted && (await storage.persisted())) return true;
		return await storage.persist();
	} catch {
		return false;
	}
}

/**
 * Checks storage pressure and alerts (info toast) if usage exceeds `threshold`
 * (fraction 0..1) of the quota. No-op if the `estimate` API is unavailable or
 * fails (private mode). To be called at startup, after the load.
 */
export async function checkStoragePressure(threshold = 0.85): Promise<void> {
	if (!browser) return;
	const storage = navigator.storage;
	if (!storage?.estimate) return;
	try {
		const { usage, quota } = await storage.estimate();
		if (!usage || !quota) return;
		if (usage / quota >= threshold) {
			const pct = Math.round((usage / quota) * 100);
			notify.info(t('storage.pressureWarning', { pct }));
		}
	} catch {
		// estimate() can throw in private browsing - best-effort, silent.
	}
}

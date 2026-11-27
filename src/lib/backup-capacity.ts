// Early warning before the library grows past a backup limit.
//
// A backup fails above 3,000 documents, 64 MiB of text in total, or 16 MiB for
// one document. The check reads the draft manifest index keys, so it never
// loads a document body. A save schedules it with a trailing throttle: it runs
// at most once per interval and never per keystroke. The interval is 10 s near
// a limit and 2 min when every limit is below half.

import { browser } from '$app/env';
import { t } from '#lib/i18n/index.js';
import { BACKUP_LIMITS, IMPORT_LIMITS } from './config';
import { db } from './db';
import { readDraftManifests } from './draft-manifest';
import { notify } from './notify.svelte';

/** A warning appears at this share of a limit. */
export const BACKUP_CAPACITY_WARNING_RATIO = 0.8;
/** Minimum time between two checks when a limit is near. */
export const BACKUP_CAPACITY_INTERVAL_MS = 10_000;
/** Minimum time between two checks while every limit is far (below half). */
export const BACKUP_CAPACITY_IDLE_INTERVAL_MS = 120_000;
const FAR_RATIO = 0.5;

const METRICS = import.meta.env.VITE_SOURCE_FIDELITY_METRICS === '1';
const MIB = 1024 * 1024;

export interface BackupCapacity {
	documents: number;
	/** UTF-16 units of text. UTF-8 needs at least as many bytes. */
	textBytes: number;
	largest: { id: string; title: string; bytes: number } | null;
}

export interface BackupCapacityWarning {
	/** Stable identity, so one warning shows once per session. */
	key: string;
	message: string;
}

/** Pure threshold check. The text size is a lower bound, so a warning is early, not late. */
export function backupCapacityWarnings(capacity: BackupCapacity): BackupCapacityWarning[] {
	const warnings: BackupCapacityWarning[] = [];
	if (capacity.documents >= BACKUP_LIMITS.maxDocuments * BACKUP_CAPACITY_WARNING_RATIO)
		warnings.push({
			key: 'documents',
			message: t('backup.capacityDocuments', { count: capacity.documents })
		});
	if (capacity.textBytes >= IMPORT_LIMITS.maxBatchBytes * BACKUP_CAPACITY_WARNING_RATIO)
		warnings.push({
			key: 'text',
			message: t('backup.capacityText', { size: (capacity.textBytes / MIB).toFixed(0) })
		});
	if (
		capacity.largest &&
		capacity.largest.bytes >= IMPORT_LIMITS.maxFileBytes * BACKUP_CAPACITY_WARNING_RATIO
	)
		warnings.push({
			key: `document:${capacity.largest.id}`,
			message: t('backup.capacityDocument', {
				title: capacity.largest.title,
				size: (capacity.largest.bytes / MIB).toFixed(1)
			})
		});
	return warnings;
}

/** Reads the library size from index keys only. Returns `null` when the index is incomplete. */
export async function readBackupCapacity(): Promise<BackupCapacity | null> {
	const manifests = await readDraftManifests();
	if (!manifests) return null;
	let textBytes = 0;
	let largest: BackupCapacity['largest'] = null;
	for (const manifest of manifests) {
		textBytes += manifest.contentLength;
		if (!largest || manifest.contentLength > largest.bytes)
			largest = { id: manifest.id, title: manifest.name, bytes: manifest.contentLength };
	}
	const templates = await db.templates.count();
	return { documents: manifests.length + templates, textBytes, largest };
}

/** True when the library uses at least half of one backup limit. */
export function nearBackupLimit(capacity: BackupCapacity): boolean {
	return (
		capacity.documents >= BACKUP_LIMITS.maxDocuments * FAR_RATIO ||
		capacity.textBytes >= IMPORT_LIMITS.maxBatchBytes * FAR_RATIO ||
		(capacity.largest?.bytes ?? 0) >= IMPORT_LIMITS.maxFileBytes * FAR_RATIO
	);
}

const warned = new Set<string>();
let interval = BACKUP_CAPACITY_INTERVAL_MS;
let lastRunAt = 0;
let running = false;
let timer: ReturnType<typeof setTimeout> | undefined;

async function runCheck(): Promise<void> {
	if (running) return;
	running = true;
	lastRunAt = Date.now();
	const startedAt = METRICS ? performance.now() : 0;
	try {
		const capacity = await readBackupCapacity();
		if (METRICS)
			performance.measure('mdsh:backup-capacity', {
				start: startedAt,
				end: performance.now(),
				detail: { documents: capacity?.documents ?? null }
			});
		if (!capacity) return;
		interval = nearBackupLimit(capacity)
			? BACKUP_CAPACITY_INTERVAL_MS
			: BACKUP_CAPACITY_IDLE_INTERVAL_MS;
		for (const warning of backupCapacityWarnings(capacity)) {
			if (warned.has(warning.key)) continue;
			warned.add(warning.key);
			notify.info(warning.message);
		}
	} catch {
		// The warning is advice. A failed read must not disturb a save.
	} finally {
		running = false;
	}
}

/**
 * Requests a capacity check. The call is cheap: it compares two numbers and
 * arms at most one timer, so a save may call it on every write.
 */
export function scheduleBackupCapacityCheck(): void {
	if (!browser || timer !== undefined) return;
	const wait = Math.max(0, lastRunAt + interval - Date.now());
	timer = setTimeout(() => {
		timer = undefined;
		void runCheck();
	}, wait);
}

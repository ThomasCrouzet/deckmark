// Desktop Complete automatic backups.
//
// This module is loaded only by the desktop edition. Native calls use dynamic
// imports, so the Web Light build has no Tauri bridge and no scheduler. Each
// snapshot uses the portable backup format and a folder that the user selects.

import { browser } from '$app/env';
import { IS_DESKTOP_EDITION } from './edition';
import { readPreference, writePreference } from './preferences';
import { collectBackup, parseBackupWithReport, serializeBackup } from './services/backup';

const STORAGE_KEY = 'mdsh:desktop-backup';
const DEFAULT_INTERVAL_HOURS = 24;
const MIN_INTERVAL_HOURS = 1;
const MAX_INTERVAL_HOURS = 168;
const DEFAULT_RETENTION = 10;
const MIN_RETENTION = 1;
const MAX_RETENTION = 50;
const HOUR_MS = 3_600_000;

export interface DesktopBackupPreferences {
	enabled: boolean;
	root: string | null;
	rootId: string | null;
	intervalHours: number;
	retention: number;
	lastSuccessAt: number | null;
}

export interface DesktopBackupState extends DesktopBackupPreferences {
	nextRunAt: number | null;
	lastError: string | null;
}

export interface BackupEntry {
	path: string;
	fileName: string;
	size: number;
	modifiedMs: number;
}

export interface BackupWrite {
	path: string;
	fileName: string;
	size: number;
	createdAtMs: number;
	removed: number;
}

type Listener = () => void;

interface BackupRoot {
	rootId: string;
	path: string;
}

let timer: ReturnType<typeof setTimeout> | null = null;
let nextRunAt: number | null = null;
let lastError: string | null = null;
let running = false;
let schedulerActive = false;
const listeners = new Set<Listener>();

function defaults(): DesktopBackupPreferences {
	return {
		enabled: false,
		root: null,
		rootId: null,
		intervalHours: DEFAULT_INTERVAL_HOURS,
		retention: DEFAULT_RETENTION,
		lastSuccessAt: null
	};
}

export function clampIntervalHours(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_INTERVAL_HOURS;
	return Math.min(MAX_INTERVAL_HOURS, Math.max(MIN_INTERVAL_HOURS, Math.round(value)));
}

export function clampRetention(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_RETENTION;
	return Math.min(MAX_RETENTION, Math.max(MIN_RETENTION, Math.round(value)));
}

function loadPreferences(): DesktopBackupPreferences {
	const raw = readPreference(STORAGE_KEY);
	if (!raw) return defaults();
	try {
		const value: unknown = JSON.parse(raw);
		if (typeof value !== 'object' || value === null || Array.isArray(value)) return defaults();
		const rootId =
			'rootId' in value && typeof value.rootId === 'string' && value.rootId.length > 0
				? value.rootId
				: null;
		return {
			enabled: rootId !== null && 'enabled' in value && value.enabled === true,
			root:
				rootId && 'root' in value && typeof value.root === 'string' && value.root.length > 0
					? value.root
					: null,
			rootId,
			intervalHours: clampIntervalHours(
				'intervalHours' in value && typeof value.intervalHours === 'number'
					? value.intervalHours
					: DEFAULT_INTERVAL_HOURS
			),
			retention: clampRetention(
				'retention' in value && typeof value.retention === 'number'
					? value.retention
					: DEFAULT_RETENTION
			),
			lastSuccessAt:
				'lastSuccessAt' in value &&
				typeof value.lastSuccessAt === 'number' &&
				Number.isFinite(value.lastSuccessAt) &&
				value.lastSuccessAt >= 0
					? value.lastSuccessAt
					: null
		};
	} catch {
		return defaults();
	}
}

function savePreferences(preferences: DesktopBackupPreferences): void {
	writePreference(STORAGE_KEY, JSON.stringify(preferences));
	notify();
}

function notify(): void {
	for (const listener of listeners) listener();
}

export function subscribeDesktopBackup(listener: Listener): () => void {
	listeners.add(listener);
	listener();
	return () => {
		listeners.delete(listener);
	};
}

export function getDesktopBackupState(): DesktopBackupState {
	return {
		...loadPreferences(),
		nextRunAt,
		lastError
	};
}

function requireDesktop(): void {
	if (!IS_DESKTOP_EDITION) {
		throw new Error('Desktop backups are not available in the Web edition.');
	}
}

async function invokeDesktop<T>(command: string, args: Record<string, unknown>): Promise<T> {
	requireDesktop();
	const { invoke } = await import('@tauri-apps/api/core');
	return invoke<T>(command, args);
}

async function buildSnapshot(): Promise<string> {
	const { filesStore } = await import('./files.svelte');
	await filesStore.flushPendingAwait();
	const json = serializeBackup(await collectBackup());
	parseBackupWithReport(json);
	return json;
}

export async function chooseBackupFolder(title: string): Promise<string | null> {
	requireDesktop();
	if (!browser) return null;
	const selected = await invokeDesktop<BackupRoot | null>('desktop_backup_pick_root', { title });
	if (!selected) return null;
	const preferences = loadPreferences();
	preferences.root = selected.path;
	preferences.rootId = selected.rootId;
	preferences.lastSuccessAt = null;
	savePreferences(preferences);
	restartScheduler(preferences);
	return selected.path;
}

export function setBackupIntervalHours(hours: number): void {
	const preferences = loadPreferences();
	preferences.intervalHours = clampIntervalHours(hours);
	savePreferences(preferences);
	restartScheduler(preferences);
}

export function setBackupRetention(count: number): void {
	const preferences = loadPreferences();
	preferences.retention = clampRetention(count);
	savePreferences(preferences);
}

export function enableDesktopBackup(): void {
	const preferences = loadPreferences();
	if (!preferences.rootId) throw new Error('Choose a backup folder first.');
	preferences.enabled = true;
	savePreferences(preferences);
	restartScheduler(preferences);
}

export function disableDesktopBackup(): void {
	const preferences = loadPreferences();
	preferences.enabled = false;
	savePreferences(preferences);
	schedulerActive = false;
	stopTimer();
	notify();
}

let pendingWrite: Promise<BackupWrite> | null = null;

export function writeBackupNow(): Promise<BackupWrite> {
	// Manual and scheduled calls share one snapshot build and one native write.
	pendingWrite ??= performBackupWrite().finally(() => {
		pendingWrite = null;
	});
	return pendingWrite;
}

async function performBackupWrite(): Promise<BackupWrite> {
	requireDesktop();
	const preferences = loadPreferences();
	if (!preferences.rootId) throw new Error('Choose a backup folder first.');
	const payload = await buildSnapshot();
	const result = await invokeDesktop<BackupWrite>('desktop_backup_write', {
		rootId: preferences.rootId,
		payload,
		keep: clampRetention(preferences.retention)
	});
	const current = loadPreferences();
	if (current.rootId === preferences.rootId) {
		current.lastSuccessAt = Date.now();
		lastError = null;
		savePreferences(current);
		if (schedulerActive) restartScheduler(current);
	}
	notify();
	return result;
}

export async function listBackupSnapshots(): Promise<BackupEntry[]> {
	const preferences = loadPreferences();
	if (!preferences.rootId) return [];
	const entries = await invokeDesktop<BackupEntry[]>('desktop_backup_list', {
		rootId: preferences.rootId
	});
	return entries;
}

export async function readBackupSnapshot(fileName: string): Promise<string> {
	const preferences = loadPreferences();
	if (!preferences.rootId) throw new Error('Choose a backup folder first.');
	return invokeDesktop<string>('desktop_backup_read', { rootId: preferences.rootId, fileName });
}

function stopTimer(): void {
	if (timer !== null) {
		clearTimeout(timer);
		timer = null;
	}
	nextRunAt = null;
}

function restartScheduler(preferences: DesktopBackupPreferences): void {
	schedulerActive = preferences.enabled && preferences.rootId !== null;
	if (schedulerActive) startScheduler(preferences);
	else {
		stopTimer();
		notify();
	}
}

function startScheduler(preferences: DesktopBackupPreferences, retry = false): void {
	stopTimer();
	const intervalMs = clampIntervalHours(preferences.intervalHours) * HOUR_MS;
	const now = Date.now();
	const lastRun = retry ? now : Math.min(preferences.lastSuccessAt ?? 0, now);
	nextRunAt = Math.max(now, lastRun + intervalMs);
	timer = setTimeout(() => {
		timer = null;
		void runScheduledBackup();
	}, nextRunAt - now);
	notify();
}

async function runScheduledBackup(): Promise<void> {
	if (running) return;
	const preferences = loadPreferences();
	if (!schedulerActive || !preferences.enabled || !preferences.rootId) {
		stopTimer();
		notify();
		return;
	}
	running = true;
	let failed = false;
	try {
		await writeBackupNow();
	} catch (error) {
		failed = true;
		lastError = error instanceof Error ? error.message : String(error);
	} finally {
		running = false;
		const current = loadPreferences();
		if (schedulerActive && current.enabled && current.rootId) {
			startScheduler(current, failed);
		} else {
			stopTimer();
		}
		notify();
	}
}

/**
 * Starts the desktop schedule. This is a no-op when the schedule is disabled
 * and when the build is not the desktop edition.
 */
export function startDesktopBackupScheduler(): void {
	if (!IS_DESKTOP_EDITION || !browser) return;
	restartScheduler(loadPreferences());
}

export function stopDesktopBackupScheduler(): void {
	schedulerActive = false;
	stopTimer();
	notify();
}

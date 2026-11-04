// Opt-in preference for the global quick-capture shortcut. The preference
// persists before the native registration runs, so a restart can retry it.
// The native calls stay in `capture.ts` and its dynamic Tauri imports.

import { browser } from '$app/env';
import { IS_DESKTOP_EDITION } from './edition';
import { readPreference, writePreference } from './preferences';
import {
	captureErrorMessage,
	captureStatus,
	registerCaptureShortcut,
	showCaptureWindow,
	unregisterCaptureShortcut,
	type CaptureStatus
} from './capture';

export const CAPTURE_SHORTCUT_KEY = 'mdsh:capture-shortcut';
export const CAPTURE_ENABLED_KEY = 'mdsh:capture-enabled';
export const DEFAULT_CAPTURE_SHORTCUT = 'CommandOrControl+Shift+Space';

class CaptureSettingsStore {
	shortcut = $state(DEFAULT_CAPTURE_SHORTCUT);
	enabled = $state(false);
	status = $state<CaptureStatus>({ registered: false, shortcut: null });
	busy = $state(false);
	error = $state('');
	loaded = $state(false);

	load(): void {
		if (!browser) return;
		this.shortcut = readPreference(CAPTURE_SHORTCUT_KEY) ?? DEFAULT_CAPTURE_SHORTCUT;
		this.enabled = readPreference(CAPTURE_ENABLED_KEY) === '1';
		this.loaded = true;
	}

	async refreshStatus(): Promise<void> {
		if (!IS_DESKTOP_EDITION) return;
		try {
			this.status = await captureStatus();
		} catch (error) {
			this.error = captureErrorMessage(error);
		}
	}

	/** Applies the persisted preference once at startup. */
	async applyStartup(): Promise<void> {
		this.load();
		if (!IS_DESKTOP_EDITION) return;
		if (!this.enabled) {
			await this.refreshStatus();
			return;
		}
		await this.register();
	}

	private persist(): void {
		writePreference(CAPTURE_SHORTCUT_KEY, this.shortcut);
		writePreference(CAPTURE_ENABLED_KEY, this.enabled ? '1' : '0');
	}

	private async register(): Promise<void> {
		this.busy = true;
		this.error = '';
		try {
			await registerCaptureShortcut(this.shortcut);
			await this.refreshStatus();
		} catch (error) {
			this.error = captureErrorMessage(error);
			await this.refreshStatus();
		} finally {
			this.busy = false;
		}
	}

	private async unregister(): Promise<void> {
		this.busy = true;
		this.error = '';
		try {
			await unregisterCaptureShortcut();
			await this.refreshStatus();
		} catch (error) {
			this.error = captureErrorMessage(error);
		} finally {
			this.busy = false;
		}
	}

	async setEnabled(enabled: boolean): Promise<void> {
		this.enabled = enabled;
		this.persist();
		if (!IS_DESKTOP_EDITION) return;
		if (enabled) await this.register();
		else await this.unregister();
	}

	async setShortcut(shortcut: string): Promise<void> {
		this.shortcut = shortcut.trim();
		this.persist();
		if (!IS_DESKTOP_EDITION) return;
		if (this.enabled) await this.register();
		else await this.refreshStatus();
	}

	async openWindow(): Promise<void> {
		if (!IS_DESKTOP_EDITION) return;
		this.error = '';
		try {
			await showCaptureWindow();
		} catch (error) {
			this.error = captureErrorMessage(error);
		}
	}
}

export const captureSettings = new CaptureSettingsStore();

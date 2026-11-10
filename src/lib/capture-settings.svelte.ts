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
			this.reconcile();
		} catch (error) {
			this.error = captureErrorMessage(error);
		}
	}

	/**
	 * The native status is the source of truth after every operation. Persist
	 * the actual state so a restart cannot claim that a missing binding is on.
	 */
	private reconcile(): void {
		if (this.enabled === this.status.registered) return;
		this.enabled = this.status.registered;
		this.persist();
	}

	/** Applies the persisted preference once at startup. */
	async applyStartup(): Promise<void> {
		this.load();
		if (!IS_DESKTOP_EDITION) return;
		if (!this.enabled) {
			await this.refreshStatus();
			if (this.status.registered) await this.unregister();
			return;
		}
		await this.register();
	}

	private persist(): void {
		writePreference(CAPTURE_SHORTCUT_KEY, this.shortcut);
		writePreference(CAPTURE_ENABLED_KEY, this.enabled ? '1' : '0');
	}

	private async register(): Promise<boolean> {
		this.busy = true;
		this.error = '';
		try {
			await registerCaptureShortcut(this.shortcut);
			await this.refreshStatus();
			return this.status.registered;
		} catch (error) {
			this.error = captureErrorMessage(error);
			await this.refreshStatus();
			this.reconcile();
			return false;
		} finally {
			this.busy = false;
		}
	}

	private async unregister(): Promise<boolean> {
		this.busy = true;
		this.error = '';
		try {
			await unregisterCaptureShortcut();
			await this.refreshStatus();
			return !this.status.registered;
		} catch (error) {
			this.error = captureErrorMessage(error);
			await this.refreshStatus();
			this.reconcile();
			return false;
		} finally {
			this.busy = false;
		}
	}

	async setEnabled(enabled: boolean): Promise<void> {
		if (!IS_DESKTOP_EDITION) {
			this.enabled = enabled;
			this.persist();
			return;
		}
		if (enabled) {
			const registered = await this.register();
			this.enabled = registered;
			this.persist();
			return;
		}
		const unregistered = await this.unregister();
		this.enabled = !unregistered;
		this.persist();
	}

	async setShortcut(shortcut: string): Promise<void> {
		const next = shortcut.trim();
		if (!IS_DESKTOP_EDITION) {
			this.shortcut = next;
			this.persist();
			return;
		}
		if (!this.enabled) {
			this.shortcut = next;
			this.persist();
			await this.refreshStatus();
			return;
		}
		const previous = this.shortcut;
		this.busy = true;
		this.error = '';
		try {
			await registerCaptureShortcut(next);
			this.shortcut = next;
			await this.refreshStatus();
			if (!this.status.registered) {
				this.shortcut = previous;
				this.enabled = false;
			}
		} catch (error) {
			this.shortcut = previous;
			this.error = captureErrorMessage(error);
			await this.refreshStatus();
			this.reconcile();
		} finally {
			this.busy = false;
			this.persist();
		}
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

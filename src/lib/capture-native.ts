// Native command bridge for the Desktop Complete quick capture window.
// The Web Light build aliases this module to `capture-native.web.ts`, so no
// command name or Tauri import enters the Web bundle.

import { IS_DESKTOP_EDITION } from './edition';

export interface CaptureStatus {
	registered: boolean;
	shortcut: string | null;
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
	if (!IS_DESKTOP_EDITION) throw new Error('Quick capture is not available in this edition.');
	const { invoke: nativeInvoke } = await import('@tauri-apps/api/core');
	return nativeInvoke<T>(command, args);
}

export async function showCaptureWindow(): Promise<void> {
	await invoke('desktop_capture_show');
}

export async function hideCaptureWindow(): Promise<void> {
	await invoke('desktop_capture_hide');
}

export async function registerCaptureShortcut(shortcut: string): Promise<void> {
	await invoke('desktop_capture_register', { shortcut });
}

export async function unregisterCaptureShortcut(): Promise<void> {
	await invoke('desktop_capture_unregister');
}

export async function captureStatus(): Promise<CaptureStatus> {
	return invoke<CaptureStatus>('desktop_capture_status');
}

/** Subscribes to the native reset event. Returns a no-op outside desktop. */
export async function onCaptureReset(handler: () => void): Promise<() => void> {
	if (!IS_DESKTOP_EDITION) return () => {};
	const { listen } = await import('@tauri-apps/api/event');
	return listen('mdsh://capture-reset', handler);
}

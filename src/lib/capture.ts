// Shared helpers for the Desktop Complete quick-capture window.
// The native command bridge lives in `capture-native.ts`. The Web Light build
// aliases that module to a stub, so no command name or Tauri import enters the
// Web bundle.

import { IS_DESKTOP_EDITION } from './edition';

export type { CaptureStatus } from '#lib/capture-native.js';
export {
	showCaptureWindow,
	hideCaptureWindow,
	registerCaptureShortcut,
	unregisterCaptureShortcut,
	captureStatus,
	onCaptureReset
} from '#lib/capture-native.js';

export const CAPTURE_WINDOW_QUERY = 'capture';
export const CAPTURE_WINDOW_QUERY_VALUE = '1';

/** True only in the Desktop Complete edition with the capture query. */
export function isCaptureWindow(search: string): boolean {
	if (!IS_DESKTOP_EDITION) return false;
	const params = new URLSearchParams(search);
	return params.get(CAPTURE_WINDOW_QUERY) === CAPTURE_WINDOW_QUERY_VALUE;
}

export function captureErrorMessage(error: unknown): string {
	if (typeof error === 'string') return error;
	if (error instanceof Error) return error.message;
	return String(error);
}

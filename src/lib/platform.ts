import { browser } from '$app/env';

/**
 * Detects whether we are running on macOS. Conservative detection based on
 * navigator.platform (deprecated but widely supported) and a userAgent fallback.
 * Returns false on SSR.
 */
export function isMac(): boolean {
	if (!browser) return false;
	const nav = navigator;
	// navigator.platform: "MacIntel" on Intel/M-series, "iPhone"/"iPad" for iOS.
	// On recent iPads, some browsers return "MacIntel" - we treat iPad as Mac (cmd shortcuts).
	const platform = nav.platform || '';
	if (platform) return /Mac|iPhone|iPad|iPod/i.test(platform);
	// userAgent fallback (older versions).
	return /Mac|iPhone|iPad|iPod/.test(nav.userAgent);
}

/** Modifier key symbol (`⌘` on Mac, `Ctrl` elsewhere). */
export const modKey = (): string => (isMac() ? '⌘' : 'Ctrl');

/** Platform-adapted shift key symbol (`⇧` on Mac, `Shift` elsewhere). */
export const shiftKey = (): string => (isMac() ? '⇧' : 'Shift');

/**
 * Formats a shortcut. We accept the Mac notation as the canonical source.
 * Example: formatKbd('⌘⇧P') → '⌘⇧P' on Mac, 'Ctrl+Shift+P' on Windows/Linux.
 * Example: formatKbd('⌘N') → '⌘N' on Mac, 'Ctrl+N' elsewhere.
 */
export function formatKbd(macShortcut: string): string {
	if (isMac()) return macShortcut;
	return macShortcut
		.replace('⌘', 'Ctrl+')
		.replace('⇧', 'Shift+')
		.replace('⌥', 'Alt+')
		.replace(/\+\+/g, '+'); // avoids double `+`
}

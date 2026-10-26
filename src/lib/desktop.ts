import { browser } from '$app/env';

/**
 * Desktop shell detection (Tauri 2).
 *
 * Prefer `import.meta.env.TAURI_ENV_PLATFORM`, injected by `tauri dev` and `tauri build`.
 * Otherwise, use the runtime globals from the webview. This also detects a
 * desktop shell that opens a production web build.
 *
 * Do not import `@tauri-apps/*` here. Keep Tauri out of the GitHub Pages boot graph and size-limit budget.
 * Desktop-only call sites must load native APIs with dynamic `import()`.
 */
export function isDesktop(): boolean {
	if (!browser) return false;
	// Vite / Tauri inject this for both dev and production desktop builds.
	const platform = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env
		?.TAURI_ENV_PLATFORM;
	if (typeof platform === 'string' && platform.length > 0) return true;
	const w = window as Window & {
		__TAURI_INTERNALS__?: unknown;
		isTauri?: boolean;
	};
	return w.isTauri === true || typeof w.__TAURI_INTERNALS__ !== 'undefined';
}

// §2.1 - Pure theme logic (no rune, testable in isolation).
//
// Three user preferences: `system` (follows the OS), `light`, `dark`.
// The preference is persisted as-is; the EFFECTIVE theme applied to the DOM
// (`data-theme`) is resolved on the store side via `resolveTheme` - which lets
// the CSS carry only a single set of overrides (`[data-theme='light']`), dark
// remaining the `@theme` default.

export type ThemePref = 'system' | 'light' | 'dark';
export type EffectiveTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'mdsh:theme';

/** System bar color (PWA / mobile) per effective theme. */
export const THEME_COLORS: Record<EffectiveTheme, string> = {
	light: '#f4f0e8',
	dark: '#0b0c0d'
};

/** Type guard: validates a value read from localStorage. */
export function isThemePref(v: unknown): v is ThemePref {
	return v === 'system' || v === 'light' || v === 'dark';
}

/** Resolves the preference into an effective theme, per the current system state. */
export function resolveTheme(pref: ThemePref, systemPrefersLight: boolean): EffectiveTheme {
	if (pref === 'light') return 'light';
	if (pref === 'dark') return 'dark';
	return systemPrefersLight ? 'light' : 'dark';
}

/** Cycle system → light → dark → system (for a single toggle). */
export function nextThemePref(pref: ThemePref): ThemePref {
	return pref === 'system' ? 'light' : pref === 'light' ? 'dark' : 'system';
}

/**
 * Mermaid palette name for the markdown renderer.
 * `default` is Mermaid's light theme; `dark` is its dark theme.
 * Driven from the app's effective `data-theme` on `<html>` (not the stored
 * preference, which may still be `system`).
 */
export type MermaidThemeName = 'default' | 'dark';

/**
 * Maps the live UI theme (`data-theme` attribute) to a Mermaid theme.
 * Light UI → light diagrams; anything else (dark or unset) → dark diagrams.
 */
export function mermaidThemeFromDataTheme(dataTheme: string | null | undefined): MermaidThemeName {
	return dataTheme === 'light' ? 'default' : 'dark';
}

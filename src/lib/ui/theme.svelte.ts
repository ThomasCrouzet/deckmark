// §2.1 - Theme store (runes singleton). Applies the user preference
// (system / light / dark), persists it in localStorage, follows the OS
// switches when the preference is `system`.
//
// Singleton (no factory): importable anywhere (page, palette, settings)
// like `filesStore`/`notify`. The matchMedia listener is managed
// imperatively (no `$effect`) to stay outside of any component scope.

import { browser } from '$app/env';
import { readPreference, writePreference } from '#lib/preferences.js';
import {
	THEME_COLORS,
	THEME_STORAGE_KEY,
	isThemePref,
	nextThemePref,
	resolveTheme,
	type EffectiveTheme,
	type ThemePref
} from '#lib/theme.js';

function systemPrefersLight(): boolean {
	return browser && typeof window.matchMedia === 'function'
		? window.matchMedia('(prefers-color-scheme: light)').matches
		: false;
}

/**
 * Applies the preference to the DOM: effective `data-theme` on <html> + meta
 * `theme-color` and `color-scheme` (PWA system bar, native controls).
 */
function applyTheme(pref: ThemePref): void {
	if (!browser) return;
	const effective = resolveTheme(pref, systemPrefersLight());
	document.documentElement.setAttribute('data-theme', effective);
	document
		.querySelector('meta[name="theme-color"]')
		?.setAttribute('content', THEME_COLORS[effective]);
	document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', effective);
}

class ThemeStore {
	pref = $state<ThemePref>('system');
	effective = $state<EffectiveTheme>('dark');
	private apply(): void {
		this.effective = resolveTheme(this.pref, systemPrefersLight());
		applyTheme(this.pref);
	}
	private mq: MediaQueryList | null = null;
	private onSystemChange = () => {
		// Re-applies only if we follow the system (otherwise the pref is absolute).
		if (this.pref === 'system') this.apply();
	};

	/** Loads the persisted preference, subscribes to system tracking, applies. */
	load(): void {
		if (!browser) return;
		const saved = readPreference(THEME_STORAGE_KEY);
		if (isThemePref(saved)) this.pref = saved;
		if (!this.mq && typeof window.matchMedia === 'function') {
			this.mq = window.matchMedia('(prefers-color-scheme: light)');
			this.mq.addEventListener('change', this.onSystemChange);
		}
		this.apply();
	}

	set(pref: ThemePref): void {
		this.pref = pref;
		writePreference(THEME_STORAGE_KEY, pref);
		this.apply();
	}

	/** Single toggle: system → light → dark → system. */
	cycle(): void {
		this.set(nextThemePref(this.pref));
	}
}

export const themeStore = new ThemeStore();

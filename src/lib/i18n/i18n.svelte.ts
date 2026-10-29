// i18n store (singleton runes), modeled on `themeStore`: importable everywhere
// (`import { t } from '#lib/i18n'`). The default is `DEFAULT_LOCALE` (English)
// at module load, which guarantees the first client render matches the server /
// prerender render (no hydration mismatch). The actual locale (persisted /
// detected) is applied on mount via `load()`, like `themeStore.load()`.

import { browser } from '$app/env';
import { en, type MessageKey } from './messages/en';
import { fr } from './messages/fr';
import {
	DEFAULT_LOCALE,
	LOCALE_STORAGE_KEY,
	detectLocale,
	interpolate,
	type Locale
} from './locale';

const DICTS: Record<Locale, Record<MessageKey, string>> = { en, fr };

class I18nStore {
	locale = $state<Locale>(DEFAULT_LOCALE);

	/**
	 * Applies the persisted / detected locale on mount (browser only). Called in
	 * `onMount` like `themeStore.load()`: calling after hydration avoids any
	 * discrepancy between the prerendered HTML (English) and the first render.
	 */
	load(): void {
		if (!browser) return;
		let saved: string | null = null;
		try {
			saved = localStorage.getItem(LOCALE_STORAGE_KEY);
		} catch {
			// Storage access denied (private mode): fall back to detection.
		}
		this.locale = detectLocale(navigator.language, saved);
		document.documentElement.lang = this.locale;
	}

	/** Changes the current locale and persists the explicit choice. */
	set(locale: Locale): void {
		this.locale = locale;
		if (browser) {
			try {
				localStorage.setItem(LOCALE_STORAGE_KEY, locale);
			} catch {
				// Best-effort persistence: ignore a storage failure.
			}
			document.documentElement.lang = locale;
			window.dispatchEvent(new CustomEvent('mdsh:locale-change', { detail: { locale } }));
		}
	}

	/**
	 * Translates a key in the current locale. Reads the `locale` `$state` on every
	 * call: used in a template, it becomes reactive to language changes. Falls
	 * back to English then to the raw key if an entry is missing.
	 */
	t = (key: MessageKey, params?: Record<string, string | number>): string => {
		const dict = DICTS[this.locale] ?? en;
		return interpolate(dict[key] ?? en[key] ?? key, params);
	};
}

export const i18n = new I18nStore();

/** Reactive translation helper, bound to the singleton. */
export const t = i18n.t;

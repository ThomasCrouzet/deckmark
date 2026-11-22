// i18n store (singleton runes), modeled on `themeStore`: importable everywhere
// (`import { t } from '#lib/i18n'`). The default is `DEFAULT_LOCALE` (English)
// at module load, which guarantees the first client render matches the server /
// prerender render (no hydration mismatch). The actual locale (persisted /
// detected) is applied on mount via `load()`, like `themeStore.load()`.
//
// English is the only static dictionary. French lives in a separate app chunk
// that the service worker precaches, so a French locale still works offline
// with no third-party request. `t()` stays synchronous and falls back to
// English until that chunk arrives.

import { browser } from '$app/env';
import { en, type MessageKey } from './messages/en';
import {
	DEFAULT_LOCALE,
	LOCALE_STORAGE_KEY,
	detectLocale,
	interpolate,
	type Locale
} from './locale';

type Dictionary = Record<MessageKey, string>;

const DICTS: Partial<Record<Locale, Dictionary>> = { en };
let frenchLoading: Promise<void> | null = null;

function loadFrench(): Promise<void> {
	if (DICTS.fr) return Promise.resolve();
	frenchLoading ??= import('./messages/fr')
		.then(({ fr }) => {
			registerDictionary('fr', fr);
		})
		.finally(() => {
			frenchLoading = null;
		});
	return frenchLoading;
}

class I18nStore {
	locale = $state<Locale>(DEFAULT_LOCALE);
	/**
	 * Bumps when a lazily loaded dictionary arrives, so a component that called
	 * `t()` re-renders with the new values.
	 */
	revision = $state(0);

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
		this.apply(detectLocale(navigator.language, saved));
	}

	/** Changes the current locale and persists the explicit choice. */
	set(locale: Locale): void {
		this.apply(locale);
		if (browser) {
			try {
				localStorage.setItem(LOCALE_STORAGE_KEY, locale);
			} catch {
				// Best-effort persistence: ignore a storage failure.
			}
			window.dispatchEvent(new CustomEvent('mdsh:locale-change', { detail: { locale } }));
		}
	}

	/**
	 * Applies a locale and starts its dictionary load. The document language
	 * follows the requested locale at once; translations follow when the chunk
	 * arrives. A failed load keeps English rather than blocking the page.
	 */
	private apply(locale: Locale): void {
		this.locale = locale;
		if (browser) document.documentElement.lang = locale;
		if (locale !== 'fr' || DICTS.fr) return;
		void loadFrench().catch(() => {
			// Leave the English fallback in place.
		});
	}

	/**
	 * Translates a key in the current locale. Reads the `locale` and `revision`
	 * `$state` on every call: used in a template, it becomes reactive to
	 * language changes and to the arrival of a lazy dictionary. Falls back to
	 * English then to the raw key if an entry is missing.
	 */
	t = (key: MessageKey, params?: Record<string, string | number>): string => {
		void this.revision;
		const dict = DICTS[this.locale] ?? en;
		return interpolate(dict[key] ?? en[key] ?? key, params);
	};
}

export const i18n = new I18nStore();

/**
 * Installs a dictionary for a locale. The lazy loader uses it for French; the
 * test setup uses it to keep synchronous French assertions without a fetch.
 */
export function registerDictionary(locale: Locale, dict: Dictionary): void {
	DICTS[locale] = dict;
	i18n.revision += 1;
}

/** Reactive translation helper, bound to the singleton. */
export const t = i18n.t;

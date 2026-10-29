// Entry point of the i18n layer. Components import from here:
//   import { t } from '#lib/i18n/index.js';
//   import { i18n, LOCALES, LOCALE_LABELS, type Locale } from '#lib/i18n/index.js';

export { i18n, t } from './i18n.svelte';
export {
	LOCALES,
	LOCALE_LABELS,
	DEFAULT_LOCALE,
	LOCALE_STORAGE_KEY,
	isLocale,
	detectLocale,
	type Locale
} from './locale';
export type { MessageKey } from './messages/en';

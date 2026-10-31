import { describe, it, expect } from 'vitest';
import { detectLocale, interpolate } from './locale';
import { en } from './messages/en';
import { fr } from './messages/fr';
import { slidesEn } from './messages/slides-en';
import { slidesFr } from './messages/slides-fr';
import { i18n } from './i18n.svelte';

describe('locale - pure logic', () => {
	it('uses a valid stored locale before the browser language', () => {
		expect(detectLocale('fr-FR', 'en')).toBe('en');
		expect(detectLocale('en-US', 'fr')).toBe('fr');
	});

	it('uses English for an unsupported or missing browser language', () => {
		expect(detectLocale('de-DE', null)).toBe('en');
		expect(detectLocale(undefined, null)).toBe('en');
	});

	it('ignores an invalid stored locale', () => {
		expect(detectLocale('fr-FR', 'klingon')).toBe('fr');
		expect(detectLocale('en-US', 123)).toBe('en');
	});

	it('fills known placeholders and keeps unknown placeholders', () => {
		expect(interpolate('{missing} kept', {})).toBe('{missing} kept');
		expect(interpolate('{a} {b} {a}', { a: 'x', b: 'y' })).toBe('x y x');
	});
});

describe('message dictionaries', () => {
	it('has no empty value in either locale', () => {
		for (const dict of [en, fr]) {
			for (const [key, value] of Object.entries(dict)) {
				expect(value, `Empty message: ${key}`).toBeTruthy();
			}
		}
	});

	it('defines the same slide key set in both locales', () => {
		expect(Object.keys(slidesFr).sort()).toEqual(Object.keys(slidesEn).sort());
	});
});

it('reports a language change to the native menu', () => {
	let detail: unknown;
	const listener = (event: Event) => {
		detail = (event as CustomEvent).detail;
	};
	window.addEventListener('mdsh:locale-change', listener);
	try {
		i18n.set('fr');
		expect(detail).toEqual({ locale: 'fr' });
	} finally {
		window.removeEventListener('mdsh:locale-change', listener);
	}
});

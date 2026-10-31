import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { themeStore } from './theme.svelte';
import { THEME_STORAGE_KEY, THEME_COLORS } from '#lib/theme.js';

// jsdom does not implement matchMedia. Provide a controllable MediaQueryList to
// set the light or dark system preference and dispatch its `change` event.
let mqlMatches = false;
const listeners = new Set<(e: MediaQueryListEvent) => void>();
const mql = {
	get matches() {
		return mqlMatches;
	},
	media: '(prefers-color-scheme: light)',
	addEventListener: (_type: string, cb: (e: MediaQueryListEvent) => void) => listeners.add(cb),
	removeEventListener: (_type: string, cb: (e: MediaQueryListEvent) => void) => listeners.delete(cb)
} as unknown as MediaQueryList;

function setSystemLight(light: boolean): void {
	mqlMatches = light;
	for (const cb of listeners) cb({ matches: light } as MediaQueryListEvent);
}

function metaContent(name: string): string | null | undefined {
	return document.querySelector(`meta[name="${name}"]`)?.getAttribute('content');
}

beforeAll(() => {
	(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = () => mql;
	for (const name of ['theme-color', 'color-scheme']) {
		if (!document.querySelector(`meta[name="${name}"]`)) {
			const m = document.createElement('meta');
			m.setAttribute('name', name);
			document.head.appendChild(m);
		}
	}
});

beforeEach(() => {
	localStorage.clear();
	mqlMatches = false; // système = sombre par défaut
	themeStore.pref = 'dark';
	document.documentElement.removeAttribute('data-theme');
});

describe('themeStore', () => {
	it('starts dark on a light system', () => {
		mqlMatches = true;
		themeStore.load();
		expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
		expect(metaContent('theme-color')).toBe(THEME_COLORS.dark);
	});

	it('ignores an invalid localStorage value', () => {
		localStorage.setItem(THEME_STORAGE_KEY, 'rainbow');
		themeStore.load();
		expect(themeStore.pref).toBe('dark');
	});

	it('applies and persists a theme and updates metadata', () => {
		themeStore.set('light');
		expect(themeStore.pref).toBe('light');
		expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
		expect(document.documentElement.getAttribute('data-theme')).toBe('light');
		expect(metaContent('theme-color')).toBe(THEME_COLORS.light);

		themeStore.set('dark');
		expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
		expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
	});

	it('follows operating system changes for the system preference', () => {
		localStorage.setItem(THEME_STORAGE_KEY, 'system');
		themeStore.load();
		expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
		setSystemLight(true);
		expect(document.documentElement.getAttribute('data-theme')).toBe('light');
		setSystemLight(false);
		expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
	});

	it('ignores operating system changes for an explicit preference', () => {
		themeStore.load();
		themeStore.set('dark');
		setSystemLight(true); // l'OS passe en clair
		expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
	});
});

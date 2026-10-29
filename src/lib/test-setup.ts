import 'fake-indexeddb/auto';
import '@testing-library/jest-dom/vitest';
import { i18n } from '#lib/i18n/index.js';

// Default test locale = French. The app default is English (i18n layer), but
// the content assertions of the tests target the historical French strings. The
// en/fr parity and the English default are verified separately in i18n.test.ts;
// tests that want another locale set it explicitly (e.g. i18n.test.ts switches
// back to 'en').
i18n.locale = 'fr';

// In-memory `localStorage` polyfill. Node 22 ships an experimental native
// `localStorage`, disabled without `--localstorage-file`, which shadows the
// jsdom one (which is not exposed here anyway). Without this polyfill, the
// stores that persist to localStorage (theme, locale, editor width, UI
// preferences) are not testable. We set it on globalThis AND window (the code
// reads `localStorage` as a global).
class MemoryStorage implements Storage {
	private store = new Map<string, string>();
	get length(): number {
		return this.store.size;
	}
	clear(): void {
		this.store.clear();
	}
	getItem(key: string): string | null {
		return this.store.has(key) ? (this.store.get(key) as string) : null;
	}
	key(index: number): string | null {
		return Array.from(this.store.keys())[index] ?? null;
	}
	removeItem(key: string): void {
		this.store.delete(key);
	}
	setItem(key: string, value: string): void {
		this.store.set(key, String(value));
	}
}

const memoryStorage = new MemoryStorage();
Object.defineProperty(globalThis, 'localStorage', {
	value: memoryStorage,
	configurable: true,
	writable: true
});
if (typeof window !== 'undefined') {
	Object.defineProperty(window, 'localStorage', {
		value: memoryStorage,
		configurable: true,
		writable: true
	});
}

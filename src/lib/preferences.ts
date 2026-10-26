import { browser } from '$app/env';

/** Preferences must not prevent access to durable documents. */
export function readPreference(key: string): string | null {
	if (!browser) return null;
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

export function writePreference(key: string, value: string | null): boolean {
	if (!browser) return false;
	try {
		if (value === null) localStorage.removeItem(key);
		else localStorage.setItem(key, value);
		return true;
	} catch {
		return false;
	}
}

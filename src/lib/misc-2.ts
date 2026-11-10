/**
 * Best-effort client preferences. A blocked or full `localStorage` must not
 * interrupt a durable comment or index operation. A failed write keeps the
 * value in memory for the rest of the session only.
 */

const session = new Map<string, string | null>();

function preferenceStorage(): Storage | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		return null;
	}
}

/** Reads a preference. A blocked read returns null instead of throwing. */
export function readPreference(key: string): string | null {
	if (session.has(key)) return session.get(key) ?? null;
	try {
		return preferenceStorage()?.getItem(key) ?? null;
	} catch {
		return null;
	}
}

/**
 * Writes or removes a preference. Returns true when the browser store accepted
 * the value. A false result means the value stays active only for this session.
 */
export function writePreference(key: string, value: string | null): boolean {
	try {
		const storage = preferenceStorage();
		if (!storage) throw new Error('Storage unavailable');
		if (value === null) storage.removeItem(key);
		else storage.setItem(key, value);
		session.delete(key);
		return true;
	} catch {
		session.set(key, value);
		return false;
	}
}

// Public host identity. The two production hosts serve independent static
// builds. They share no browser storage.

export type PublicHostRole = 'main' | 'fallback' | 'local' | 'other';

export interface PublicHostInfo {
	role: PublicHostRole;
	hostname: string;
	label: string;
	otherUrl: string | null;
}

const MAIN_HOST = 'www.deckmark.dev';
const FALLBACK_HOST = 'thomascrouzet.github.io';
const FALLBACK_BASE = '/deckmark/';

export function publicHostInfo(hostname: string): PublicHostInfo {
	const normal = hostname.toLowerCase();
	if (normal === MAIN_HOST) {
		return {
			role: 'main',
			hostname,
			label: 'Main site',
			otherUrl: `https://${FALLBACK_HOST}${FALLBACK_BASE}`
		};
	}
	if (normal === FALLBACK_HOST) {
		return {
			role: 'fallback',
			hostname,
			label: 'Fallback site',
			otherUrl: `https://${MAIN_HOST}/`
		};
	}
	if (normal === 'localhost' || normal === '127.0.0.1' || normal === '[::1]') {
		return { role: 'local', hostname, label: 'Local development', otherUrl: null };
	}
	return { role: 'other', hostname, label: 'Self-hosted copy', otherUrl: null };
}

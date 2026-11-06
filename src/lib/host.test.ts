import { describe, expect, it } from 'vitest';
import { publicHostInfo } from './host';

describe('public host identity', () => {
	it('identifies the main Cloudflare host and links to the fallback', () => {
		const info = publicHostInfo('www.deckmark.dev');
		expect(info.role).toBe('main');
		expect(info.otherUrl).toBe('https://thomascrouzet.github.io/deckmark/');
	});

	it('identifies the GitHub Pages fallback and links to the main host', () => {
		const info = publicHostInfo('ThomasCrouzet.github.io');
		expect(info.role).toBe('fallback');
		expect(info.otherUrl).toBe('https://www.deckmark.dev/');
	});

	it('does not invent another host for local or unknown origins', () => {
		expect(publicHostInfo('127.0.0.1').role).toBe('local');
		expect(publicHostInfo('localhost').otherUrl).toBeNull();
		expect(publicHostInfo('docs.example.test').role).toBe('other');
		expect(publicHostInfo('docs.example.test').otherUrl).toBeNull();
	});
});

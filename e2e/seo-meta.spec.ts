import { expect, test, type TestInfo } from '@playwright/test';

// The same suite runs for the root build and the GitHub Pages project build
// (BASE_PATH=/deckmark). Both builds must advertise the canonical origin.
const ORIGIN = 'https://www.deckmark.dev';

function appPath(testInfo: TestInfo): string {
	const configured = testInfo.config.metadata.basePath;
	return `${typeof configured === 'string' ? configured : (process.env.BASE_PATH ?? '')}/`;
}

/** Read one head tag from the served HTML, before any script runs. */
function metaContent(html: string, attribute: 'name' | 'property', key: string): string | null {
	const tag = new RegExp(`<meta\\s[^>]*${attribute}="${key}"[^>]*>`, 'i').exec(html)?.[0];
	if (!tag) return null;
	return /content="([^"]*)"/i.exec(tag)?.[1] ?? null;
}

test.describe('Served HTML metadata', () => {
	test('uses absolute canonical URLs for the share card image and page', async ({
		request
	}, testInfo) => {
		const response = await request.get(appPath(testInfo));
		expect(response.ok()).toBe(true);
		const html = await response.text();

		// Open Graph and X card readers need absolute image URLs.
		expect(metaContent(html, 'property', 'og:image')).toBe(`${ORIGIN}/og-image.png`);
		expect(metaContent(html, 'name', 'twitter:image')).toBe(`${ORIGIN}/og-image.png`);
		expect(metaContent(html, 'property', 'og:url')).toBe(`${ORIGIN}/`);
		expect(metaContent(html, 'name', 'twitter:card')).toBe('summary_large_image');
		expect(/<link\s[^>]*rel="canonical"[^>]*href="([^"]*)"/i.exec(html)?.[1]).toBe(`${ORIGIN}/`);
	});

	test('names slides in the title, the descriptions and the static home content', async ({
		request
	}, testInfo) => {
		const html = await (await request.get(appPath(testInfo))).text();
		const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? '';
		expect(title).toMatch(/notes and slides/i);
		for (const [attribute, key] of [
			['name', 'description'],
			['property', 'og:description'],
			['name', 'twitter:description'],
			['property', 'og:title'],
			['name', 'twitter:title']
		] as const) {
			expect(metaContent(html, attribute, key), key).toMatch(/slide/i);
		}
		// A crawler and a reader without JavaScript get this static home content.
		const shell = /<div id="seo-shell"[\s\S]*?<\/nav>/i.exec(html)?.[0] ?? '';
		expect(shell).toMatch(/<h1[^>]*>[^<]*slides[^<]*<\/h1>/i);
		expect(shell).toMatch(/releases\?q=desktop/);
	});
});

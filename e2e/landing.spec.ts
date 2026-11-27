import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { waitForPresentation } from './presentation-helpers';

// Review finding PROD-04: the first visit opened an empty editor with no pitch,
// no screenshot and no desktop link. The first-visit view must say what DeckMark
// is, offer the start actions and the downloads, make no network request, and
// stay out of the way of a returning user.

type Locale = 'en' | 'fr';

async function start(page: Page, locale: Locale, theme: 'dark' | 'light' = 'dark') {
	await page.addInitScript(
		({ value, selected }) => {
			localStorage.setItem('mdsh:locale', value);
			localStorage.setItem('mdsh:mode', 'source');
			localStorage.setItem('mdsh:theme', selected);
		},
		{ value: locale, selected: theme }
	);
	await page.goto('/');
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
}

const copy = {
	en: {
		title: /notes and slides/,
		h1: 'Markdown notes and slides, on your device',
		facts: ['No account', 'Works offline', 'Open source'],
		desktop: 'Desktop app (Beta)',
		lead: /^Plain Markdown files in one local library\./,
		demo: 'Open a demo document',
		slides: 'Slides, not just notes'
	},
	fr: {
		title: /présentations Markdown/,
		h1: 'Notes et présentations Markdown, sur votre appareil',
		facts: ['Sans compte', 'Fonctionne hors ligne', 'Open source'],
		desktop: 'Application Desktop (Beta)',
		lead: /^Des fichiers Markdown simples dans une bibliothèque locale\./,
		demo: 'Ouvrir un document de démo',
		slides: 'Des présentations, pas seulement des notes'
	}
};

for (const locale of ['en', 'fr'] as const) {
	test.describe(`first visit in ${locale}`, () => {
		test.use({ locale: locale === 'en' ? 'en-US' : 'fr-FR' });

		test('explains the product, offers every start action and links the downloads', async ({
			page
		}) => {
			const foreign: string[] = [];
			let appOrigin = '';
			page.on('request', (request) => {
				const url = new URL(request.url());
				if (url.protocol === 'data:' || url.protocol === 'blob:') return;
				if (appOrigin && url.origin !== appOrigin) foreign.push(request.url());
			});
			await start(page, locale);
			appOrigin = new URL(page.url()).origin;
			await page.reload();
			await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();

			const text = copy[locale];
			await expect(page).toHaveTitle(text.title);
			const headings = page.getByRole('heading', { level: 1 });
			await expect(headings).toHaveCount(1);
			await expect(headings).toContainText(text.h1);
			for (const fact of text.facts) {
				await expect(page.getByRole('list', { name: /./ }).getByText(fact)).toBeVisible();
			}
			await expect(page.getByRole('heading', { level: 2, name: text.slides })).toBeVisible();

			// One short supporting sentence follows the title, then the fact chips.
			const intro = page.locator('.welcome-intro');
			await expect(intro.locator('p')).toHaveCount(1);
			await expect(intro.locator('p')).toHaveText(text.lead);

			// The demo button carries its label only. A side badge reads as a shortcut.
			await expect(page.getByTestId('welcome-demo')).toHaveText(text.demo);

			for (const id of [
				'welcome-new',
				'welcome-new-presentation',
				'welcome-demo',
				'welcome-import'
			]) {
				await expect(page.getByTestId(id)).toBeVisible();
			}

			const desktop = page.getByTestId('welcome-desktop-link');
			await expect(desktop).toContainText(text.desktop);
			// The label stays on one line at desktop width.
			const lines = await desktop.locator('span').evaluate((node) => node.getClientRects().length);
			expect(lines).toBe(1);
			await expect(desktop).toHaveAttribute(
				'href',
				/github\.com\/ThomasCrouzet\/deckmark\/releases\?q=desktop/
			);
			await expect(desktop).toHaveAttribute('target', '_blank');
			await expect(desktop).toHaveAttribute('rel', /noopener/);
			await expect(page.getByTestId('welcome-github-link')).toHaveAttribute(
				'href',
				'https://github.com/ThomasCrouzet/deckmark'
			);
			await expect(page.getByRole('link', { name: 'GitHub', exact: true })).toHaveAttribute(
				'href',
				'https://github.com/ThomasCrouzet/deckmark'
			);

			// No request leaves the origin, and the page holds no remote image.
			const remoteImages = await page.evaluate(() =>
				[...document.images]
					.map((image) => image.currentSrc)
					.filter((src) => !src.startsWith(location.origin))
			);
			expect(remoteImages).toEqual([]);
			expect(foreign).toEqual([]);
		});
	});
}

test.describe('first visit actions', () => {
	test.use({ locale: 'en-US' });

	test('New presentation opens the slide editor without a dialog', async ({ page }) => {
		await start(page, 'en');
		await page.getByTestId('welcome-new-presentation').click();
		await waitForPresentation(page);
		await expect(page.getByRole('dialog')).toHaveCount(0);
	});

	test('the demo button opens the demo document', async ({ page }) => {
		await start(page, 'en');
		await page.getByTestId('welcome-demo').click();
		await expect(page.locator('input[aria-label^="File name"]')).toHaveValue(
			'Welcome to the DeckMark demo',
			{ timeout: 10_000 }
		);
	});

	test('a returning user sees no introduction', async ({ page }) => {
		await start(page, 'en');
		await page.getByTestId('welcome-new').click();
		await page.getByTestId('create-note').click();
		await expect(page.locator('input[aria-label^="File name"]')).toBeVisible();
		await page.getByTestId('home-logo').click();
		await expect(page.getByTestId('welcome-new')).toBeVisible();
		await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
		await expect(page.locator('.welcome-pitch')).toHaveCount(0);
		await expect(page.getByTestId('welcome-desktop-link')).toHaveCount(0);
		await expect(page.getByRole('button', { name: /Open your library/ })).toBeVisible();

		// A reload keeps the pitch away, even before the library finishes loading.
		await page.reload();
		await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
		await expect(page.locator('.welcome-pitch')).toHaveCount(0);
	});
});

// Contrast of a text color on its own background, from the computed styles.
// Both colors go through a canvas so any CSS color syntax reduces to RGBA.
async function kbdContrast(page: Page, button: string) {
	return page.evaluate((selector) => {
		const rgba = (value: string) => {
			const canvas = document.createElement('canvas');
			canvas.width = canvas.height = 1;
			const context = canvas.getContext('2d', { willReadFrequently: true })!;
			context.clearRect(0, 0, 1, 1);
			context.fillStyle = value;
			context.fillRect(0, 0, 1, 1);
			const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
			return { r, g, b, a: a / 255 };
		};
		const luminance = ({ r, g, b }: { r: number; g: number; b: number }) => {
			const [lr, lg, lb] = [r, g, b].map((c) => {
				const v = c / 255;
				return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
			});
			return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
		};
		const host = document.querySelector(selector)!;
		const kbd = host.querySelector('kbd')!;
		const bg = rgba(getComputedStyle(host).backgroundColor);
		const fg = rgba(getComputedStyle(kbd).color);
		const blended = {
			r: fg.r * fg.a + bg.r * (1 - fg.a),
			g: fg.g * fg.a + bg.g * (1 - fg.a),
			b: fg.b * fg.a + bg.b * (1 - fg.a)
		};
		const [hi, lo] = [luminance(blended), luminance(bg)].sort((x, y) => y - x);
		return { ratio: (hi + 0.05) / (lo + 0.05), label: kbd.textContent?.trim() ?? '' };
	}, button);
}

for (const theme of ['light', 'dark'] as const) {
	test(`the primary action shortcut hint is readable in ${theme}`, async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await start(page, 'en', theme);
		const { ratio, label } = await kbdContrast(page, '[data-testid="welcome-new"]');
		expect(label).not.toBe('');
		expect(ratio).toBeGreaterThanOrEqual(4.5);
	});
}

test('the first-visit content starts high on a desktop window', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await start(page, 'en');
	// Offsets count from the top of the home area, below the app header.
	const offsets = await page.evaluate(() => {
		const shell = document.querySelector('.welcome-shell')!.getBoundingClientRect().top;
		const top = (selector: string) =>
			document.querySelector(selector)!.getBoundingClientRect().top - shell;
		return { console: top('.welcome-console'), primary: top('[data-testid="welcome-new"]') };
	});
	expect(offsets.console).toBeLessThanOrEqual(64);
	expect(offsets.primary).toBeLessThanOrEqual(120);
});

for (const [name, viewport] of [
	['desktop', { width: 1440, height: 900 }],
	['iPad portrait', { width: 820, height: 1180 }],
	['iPad landscape', { width: 1180, height: 820 }],
	['iPhone', { width: 390, height: 844 }],
	['narrow phone', { width: 320, height: 640 }]
] as const) {
	for (const theme of ['light', 'dark'] as const) {
		test(`first visit fits ${name} in ${theme} without overflow and passes axe`, async ({
			page
		}) => {
			await page.setViewportSize(viewport);
			await start(page, 'en', theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await expect(page.locator('.welcome-pitch')).toBeVisible();
			const fits = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
			expect(fits).toBe(true);
			// The primary action stays reachable without scrolling.
			await expect(page.getByTestId('welcome-new')).toBeInViewport();
			const small = await page.locator('.welcome-actions :is(button, a)').evaluateAll((items) =>
				items
					.map((item) => item.getBoundingClientRect())
					.filter((box) => box.height < 44)
					.map((box) => Math.round(box.height))
			);
			expect(small).toEqual([]);
			await page.evaluate(async () => {
				await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {})));
			});
			const results = await new AxeBuilder({ page }).analyze();
			const blocking = results.violations.filter(
				(violation) => violation.impact === 'critical' || violation.impact === 'serious'
			);
			expect(blocking.map((violation) => violation.id)).toEqual([]);
			await test.info().attach(`landing-${name}-${theme}.png`, {
				body: await page.screenshot(),
				contentType: 'image/png'
			});
		});
	}
}

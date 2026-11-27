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
		desktop: 'Download DeckMark Desktop (Beta)',
		slides: 'Slides, not just notes'
	},
	fr: {
		title: /présentations Markdown/,
		h1: 'Notes et présentations Markdown, sur votre appareil',
		facts: ['Sans compte', 'Fonctionne hors ligne', 'Open source'],
		desktop: 'Télécharger DeckMark Desktop (Beta)',
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

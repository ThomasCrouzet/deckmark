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
		facts: ['No account', 'Works offline', 'Free and open source'],
		desktop: 'Desktop app (Beta)',
		lead: /^Write notes and build slide decks in one library\./,
		demo: 'Open a demo document',
		slides: 'Slides, not just notes',
		sidebar: 'Your documents appear here.',
		noFile: 'No file open.'
	},
	fr: {
		title: /présentations Markdown/,
		h1: 'Notes et présentations Markdown, sur votre appareil',
		facts: ['Sans compte', 'Hors ligne', 'Gratuit et open source'],
		desktop: 'Application Desktop (Beta)',
		lead: /^Rédigez vos notes et créez vos présentations dans une même bibliothèque\./,
		demo: 'Ouvrir un document de démo',
		slides: 'Des présentations aussi',
		sidebar: 'Vos documents apparaissent ici.',
		noFile: 'Aucun fichier ouvert.'
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
				await expect(
					page.getByRole('list', { name: /./ }).getByText(fact, { exact: true })
				).toBeVisible();
			}
			await expect(page.getByRole('heading', { level: 2, name: text.slides })).toBeVisible();

			// One short supporting sentence follows the title, then the facts.
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

			// The side panel says what it is for. It does not repeat the start actions.
			const panel = page.locator('#files-panel');
			await expect(panel).toContainText(text.sidebar);
			await expect(panel).not.toContainText(text.noFile);
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
		await expect(page.locator('.welcome-visual')).toHaveCount(0);
		await expect(page.getByTestId('welcome-desktop-link')).toHaveCount(0);
		await expect(page.getByRole('button', { name: /Open your library/ })).toBeVisible();
		await expect(page.locator('#files-panel')).not.toContainText(copy.en.sidebar);

		// The new note is written to the drafts store after a short delay. Wait for
		// the write, so the reload does not race with it.
		await expect
			.poll(
				() =>
					page.evaluate(
						() =>
							new Promise<number>((resolve) => {
								const request = indexedDB.open('mdsh');
								request.onerror = () => resolve(0);
								request.onsuccess = () => {
									const database = request.result;
									const count = database.objectStoreNames.contains('drafts')
										? database.transaction('drafts').objectStore('drafts').count()
										: null;
									if (!count) {
										database.close();
										resolve(0);
										return;
									}
									count.onerror = () => resolve(0);
									count.onsuccess = () => {
										database.close();
										resolve(count.result);
									};
								};
							})
					),
				{ timeout: 10_000 }
			)
			.toBeGreaterThan(0);

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
		const shell = document.querySelector('.welcome-shell')!.getBoundingClientRect();
		const top = (selector: string) =>
			document.querySelector(selector)!.getBoundingClientRect().top - shell.top;
		return {
			height: shell.height,
			console: top('.welcome-console'),
			title: top('.welcome-title-text'),
			primary: top('[data-testid="welcome-new"]')
		};
	});
	// The title and the pitch come first. The primary action stays in the upper
	// half of the home area, and a tall window does not push the content down.
	expect(offsets.console).toBeLessThanOrEqual(96);
	expect(offsets.title).toBeLessThan(offsets.primary);
	expect(offsets.primary).toBeLessThanOrEqual(offsets.height / 2);
});

for (const locale of ['en', 'fr'] as const) {
	test(`each start action keeps its label on one line on a desktop window in ${locale}`, async ({
		page
	}) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await start(page, locale);
		const wrapped = await page.locator('.welcome-action > .flex-1').evaluateAll((labels) =>
			labels
				.filter((label) => {
					const range = document.createRange();
					range.selectNodeContents(label);
					return new Set([...range.getClientRects()].map((box) => Math.round(box.top))).size > 1;
				})
				.map((label) => label.textContent)
		);
		expect(wrapped).toEqual([]);
		// The page fits the window. No scroll bar shows at this size.
		const extra = await page
			.locator('.welcome-shell')
			.evaluate((shell) => shell.scrollHeight - shell.clientHeight);
		expect(extra).toBeLessThanOrEqual(0);
	});
}

for (const [name, viewport] of [
	['desktop', { width: 1440, height: 900 }],
	['iPad landscape', { width: 1180, height: 820 }],
	['iPhone', { width: 390, height: 844 }]
] as const) {
	test(`the keyboard order follows the visual order on ${name}`, async ({ page }) => {
		await page.setViewportSize(viewport);
		await start(page, 'en');
		const ids = [
			'welcome-new',
			'welcome-new-presentation',
			'welcome-demo',
			'welcome-import',
			'welcome-desktop-link',
			'welcome-github-link'
		];
		await page.getByTestId(ids[0]).focus();
		const focused = [ids[0]];
		for (let step = 1; step < ids.length; step += 1) {
			await page.keyboard.press('Tab');
			focused.push(
				await page.evaluate(() => (document.activeElement as HTMLElement).dataset.testid ?? '')
			);
		}
		expect(focused).toEqual(ids);

		// The four actions read row by row. The two links come after the action
		// group: below it, or in one column at its end.
		const boxes = await page.evaluate(
			(list) =>
				list.map((id) => {
					const box = document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect();
					return { top: box.top, left: box.left, bottom: box.bottom, right: box.right };
				}),
			ids
		);
		const follows = (a: (typeof boxes)[number], b: (typeof boxes)[number]) =>
			b.top >= a.bottom - 1 || (Math.abs(b.top - a.top) < 2 && b.left >= a.right - 1);
		for (let index = 1; index < 4; index += 1) {
			expect(follows(boxes[index - 1], boxes[index]), ids[index]).toBe(true);
		}
		const grid = await page.locator('.welcome-action-grid').boundingBox();
		for (const link of boxes.slice(4)) {
			const below = link.top >= grid!.y + grid!.height - 1;
			const atEnd = link.left >= grid!.x + grid!.width - 1;
			expect(below || atEnd).toBe(true);
		}
		expect(follows(boxes[4], boxes[5])).toBe(true);
	});
}

test('the figure is decoration and tells the same thing with no motion', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await start(page, 'en');
	const figure = page.locator('.welcome-visual');
	await expect(figure).toBeVisible();
	await expect(figure).toHaveAttribute('aria-hidden', 'true');
	await expect(figure.locator('a, button, input, [tabindex]')).toHaveCount(0);
	const state = () =>
		figure.evaluate(async (node) => {
			const animations = node.getAnimations({ subtree: true });
			const finite = animations.every((animation) =>
				Number.isFinite(Number(animation.effect?.getComputedTiming().endTime))
			);
			await Promise.all(animations.map((animation) => animation.finished.catch(() => {})));
			const slide = node.querySelector('.welcome-visual-slide')!;
			const wire = node.querySelector('.welcome-visual-wire')!;
			return {
				finite,
				animated: getComputedStyle(slide).animationName !== 'none',
				slideOpacity: getComputedStyle(slide).opacity,
				wireClip: getComputedStyle(wire).clipPath,
				slideBox: slide.getBoundingClientRect().toJSON() as DOMRect
			};
		});

	// Reduced motion: no animation is set, and the figure is complete.
	const still = await state();
	expect(still.animated).toBe(false);
	expect(still.slideOpacity).toBe('1');
	expect(still.wireClip).toBe('none');

	// Default motion: each animation ends, and the figure ends in the same state.
	await page.emulateMedia({ reducedMotion: 'no-preference' });
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	const moved = await state();
	expect(moved.animated).toBe(true);
	expect(moved.finite).toBe(true);
	expect(moved.slideOpacity).toBe('1');
	expect(moved.wireClip).toBe('none');
	expect(Math.round(moved.slideBox.x)).toBe(Math.round(still.slideBox.x));
	expect(Math.round(moved.slideBox.y)).toBe(Math.round(still.slideBox.y));
});

// The side panel shows the wordmark. The heading shows it only when the side
// panel is not on screen, so the page never shows two wordmarks.
for (const [name, viewport, sidebar, shown] of [
	['a desktop window with the side panel', { width: 1440, height: 900 }, 'open', false],
	['iPad landscape with the side panel', { width: 1180, height: 820 }, 'open', false],
	['iPad portrait with the side panel', { width: 820, height: 1180 }, 'open', false],
	['a desktop window with the side panel closed', { width: 1440, height: 900 }, 'closed', true],
	['iPad portrait with the side panel closed', { width: 820, height: 1180 }, 'closed', true],
	['iPhone', { width: 390, height: 844 }, 'open', true]
] as const) {
	test(`the page shows one wordmark on ${name}`, async ({ page }) => {
		await page.setViewportSize(viewport);
		await page.addInitScript((value) => localStorage.setItem('mdsh:sidebar', value), sidebar);
		await start(page, 'en');
		await expect(page.getByTestId('welcome-new')).toBeVisible();
		const heading = page.getByRole('heading', { level: 1 });
		await expect(heading).toHaveCount(1);
		await expect(heading).toContainText(copy.en.h1);
		const marks = await page.evaluate(() => {
			const seen = (element: Element | null) => {
				if (!element) return false;
				const box = element.getBoundingClientRect();
				return box.width > 4 && box.height > 4 && box.right > 0 && box.left < innerWidth;
			};
			return {
				hero: seen(document.querySelector('.welcome-first-visit .welcome-brand')),
				panel: seen(document.querySelector('#files-panel [data-testid="home-logo"]'))
			};
		});
		expect(marks.hero).toBe(shown);
		expect(marks.panel).toBe(!shown);
	});
}

// The hero stays in the middle of the frame. The rule stays near the top of the
// home area, and the three points and the footer stay near the bottom.
for (const [name, viewport] of [
	['large desktop', { width: 1920, height: 1080 }],
	['desktop', { width: 1440, height: 900 }]
] as const) {
	for (const locale of ['en', 'fr'] as const) {
		test(`the vertical space is balanced on ${name} in ${locale}`, async ({ page }) => {
			await page.setViewportSize(viewport);
			await start(page, locale);
			const space = await page.evaluate(() => {
				const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
				const shell = box('.welcome-shell');
				const frame = box('.welcome-first-visit');
				const hero = box('.welcome-hero');
				const points = box('.welcome-features');
				const footer = box('.welcome-footer');
				return {
					aboveRule: frame.top - shell.top,
					aboveHero: hero.top - frame.top,
					belowHero: points.top - hero.bottom,
					pointsToFooter: footer.top - points.bottom,
					belowFooter: shell.bottom - footer.bottom
				};
			});
			await test.info().attach('space.json', {
				body: JSON.stringify(space),
				contentType: 'application/json'
			});
			expect(Math.abs(space.aboveHero - space.belowHero)).toBeLessThanOrEqual(2);
			expect(space.aboveHero).toBeLessThanOrEqual(161);
			expect(space.pointsToFooter).toBeLessThanOrEqual(1);
			expect(space.aboveRule).toBeLessThanOrEqual(56);
			expect(space.belowFooter).toBeLessThanOrEqual(56);
			expect(Math.abs(space.aboveRule - space.belowFooter)).toBeLessThanOrEqual(24);
		});
	}
}

// The three points use the columns of the hero: the two columns of actions,
// then the figure on a desktop window or the links on a tablet in landscape.
for (const [name, viewport, third] of [
	['large desktop', { width: 1920, height: 1080 }, '.welcome-visual'],
	['desktop', { width: 1440, height: 900 }, '.welcome-visual'],
	['iPad landscape', { width: 1180, height: 820 }, '.welcome-links']
] as const) {
	test(`the three points use the hero columns on ${name}`, async ({ page }) => {
		await page.setViewportSize(viewport);
		await start(page, 'fr');
		const lefts = await page.evaluate((selector) => {
			const left = (element: Element) => Math.round(element.getBoundingClientRect().left);
			const actions = [...document.querySelectorAll('.welcome-action')];
			return {
				// The third point has a left padding on a desktop window, so read the titles.
				points: [...document.querySelectorAll('.welcome-features article h2')].map(left),
				hero: [left(actions[0]!), left(actions[1]!), left(document.querySelector(selector)!)]
			};
		}, third);
		expect(lefts.points).toHaveLength(3);
		for (let index = 0; index < 3; index += 1) {
			expect(
				Math.abs(lefts.points[index]! - lefts.hero[index]!),
				`column ${index}`
			).toBeLessThanOrEqual(1);
		}
	});
}

// Line boxes of a text, read from the layout. A wrapped text gives one entry per line.
async function textLines(page: Page, selector: string) {
	return page.locator(selector).evaluate((element) => {
		const lines: string[] = [];
		let last: number | null = null;
		const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
		for (
			let node = walker.nextNode() as Text | null;
			node;
			node = walker.nextNode() as Text | null
		) {
			for (let index = 0; index < node.length; index += 1) {
				const range = document.createRange();
				range.setStart(node, index);
				range.setEnd(node, index + 1);
				const box = range.getClientRects()[0];
				if (!box) continue;
				const top = Math.round(box.top);
				if (last === null || Math.abs(top - last) > 4) {
					lines.push('');
					last = top;
				}
				lines[lines.length - 1] += node.data[index];
			}
		}
		return lines.map((line) => line.replace(/\s+/g, ' ').trim());
	});
}

for (const [name, viewport] of [
	['desktop', { width: 1440, height: 900 }],
	['iPad landscape', { width: 1180, height: 820 }],
	['iPhone', { width: 390, height: 844 }],
	['narrow phone', { width: 320, height: 640 }]
] as const) {
	for (const locale of ['en', 'fr'] as const) {
		test(`the title and the wiki link token break well on ${name} in ${locale}`, async ({
			page
		}) => {
			await page.setViewportSize(viewport);
			await start(page, locale);
			// No line of the title holds one word only before the last line.
			const title = await textLines(page, '.welcome-first-visit .welcome-title-text');
			expect(title.join(' ')).toBe(copy[locale].h1);
			expect(title).not.toContain('Markdown,');
			// The wiki link token stays on one line.
			const token = locale === 'en' ? '[[wiki links]]' : '[[liens wiki]]';
			const point = await textLines(page, '.welcome-features article:first-child p');
			expect(point.join(' ')).toContain(token);
			expect(point.filter((line) => line.includes(token))).toHaveLength(1);
		});
	}
}

// Contrast of two CSS colors. Each color goes through a canvas, so any CSS
// color syntax reduces to RGB.
async function borderContrast(page: Page, selector: string) {
	return page.locator(selector).evaluate((element) => {
		const rgb = (value: string) => {
			const canvas = document.createElement('canvas');
			canvas.width = canvas.height = 1;
			const context = canvas.getContext('2d', { willReadFrequently: true })!;
			context.fillStyle = value;
			context.fillRect(0, 0, 1, 1);
			const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
			return { r: r!, g: g!, b: b!, a: a! / 255 };
		};
		const luminance = ({ r, g, b }: { r: number; g: number; b: number }) => {
			const [lr, lg, lb] = [r, g, b].map((channel) => {
				const value = channel / 255;
				return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
			});
			return 0.2126 * lr! + 0.7152 * lg! + 0.0722 * lb!;
		};
		const ratio = (
			a: { r: number; g: number; b: number },
			b: { r: number; g: number; b: number }
		) => {
			const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
			return (hi! + 0.05) / (lo! + 0.05);
		};
		const style = getComputedStyle(element);
		const border = rgb(style.borderTopColor);
		const surface = rgb(style.backgroundColor);
		const pageColor = rgb(getComputedStyle(document.body).backgroundColor);
		return {
			opaque: border.a === 1 && surface.a === 1 && pageColor.a === 1,
			width: parseFloat(style.borderTopWidth),
			toPage: ratio(border, pageColor),
			toSurface: ratio(border, surface)
		};
	});
}

for (const theme of ['light', 'dark'] as const) {
	test(`the border of each secondary action reaches 3:1 in ${theme}`, async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await start(page, 'en', theme);
		for (const id of ['welcome-new-presentation', 'welcome-demo', 'welcome-import']) {
			const contrast = await borderContrast(page, `[data-testid="${id}"]`);
			expect(contrast.opaque, id).toBe(true);
			expect(contrast.width, id).toBeGreaterThanOrEqual(1);
			expect(contrast.toPage, id).toBeGreaterThanOrEqual(3);
			expect(contrast.toSurface, id).toBeGreaterThanOrEqual(3);
		}
	});
}

// The figure. The slide lies over the source sheet and hides no source text.
// The wire ends at the title of the slide. Its small text stays readable.
for (const [name, viewport] of [
	['large desktop', { width: 1920, height: 1080 }],
	['desktop', { width: 1440, height: 900 }],
	['iPad landscape', { width: 1180, height: 820 }],
	['iPad portrait', { width: 820, height: 1180 }],
	['iPhone', { width: 390, height: 844 }],
	['narrow phone', { width: 320, height: 640 }]
] as const) {
	for (const locale of ['en', 'fr'] as const) {
		test(`the figure keeps its source lines clear on ${name} in ${locale}`, async ({ page }) => {
			await page.setViewportSize(viewport);
			await page.emulateMedia({ reducedMotion: 'reduce' });
			await start(page, locale);
			const figure = await page.locator('.welcome-visual').evaluate((node) => {
				const box = (element: Element) => element.getBoundingClientRect();
				const slide = box(node.querySelector('.welcome-visual-slide')!);
				const source = box(node.querySelector('.welcome-visual-source')!);
				const title = box(node.querySelector('.welcome-visual-slide-title')!);
				const end = box(node.querySelector('.welcome-visual-wire-end')!);
				const wire = box(node.querySelector('.welcome-visual-wire')!);
				const texts = [...node.querySelectorAll('.welcome-visual-code li')].map((line) => {
					const range = document.createRange();
					range.selectNodeContents(line);
					const rect = range.getBoundingClientRect();
					return { text: line.textContent!.trim(), rect };
				});
				const hidden = texts
					.filter(({ text }) => text !== '')
					.filter(
						({ rect }) =>
							rect.right > slide.left - 4 && rect.bottom > slide.top && rect.top < slide.bottom
					)
					.map(({ text }) => text);
				const clipped = texts
					.filter(({ text, rect }) => text !== '' && rect.right > source.right - 4)
					.map(({ text }) => text);
				const size = (selector: string, pseudo?: string) =>
					parseFloat(getComputedStyle(node.querySelector(selector)!, pseudo).fontSize);
				const slideStyle = getComputedStyle(node.querySelector('.welcome-visual-slide')!);
				const sourceStyle = getComputedStyle(node.querySelector('.welcome-visual-source')!);
				return {
					hidden,
					clipped,
					lines: texts.length,
					// The arrow is at the height of the title, on its right.
					endOnTitle:
						end.top + end.height / 2 > title.top &&
						end.top + end.height / 2 < title.bottom &&
						end.left >= title.right,
					endWidth: end.width,
					// The two parts of the wire meet.
					joined:
						Math.abs(wire.bottom - end.bottom) <= 1.5 && Math.abs(wire.right - end.right) <= 1.5,
					sizes: [
						size('.welcome-visual-tab span'),
						size('.welcome-visual-code li', '::before'),
						size('.welcome-visual-code li'),
						size('.welcome-visual-count'),
						size('.welcome-visual-bullet')
					],
					shadow: slideStyle.boxShadow,
					surfaces: [slideStyle.backgroundColor, sourceStyle.backgroundColor],
					borders: [slideStyle.borderTopColor, sourceStyle.borderTopColor]
				};
			});
			await test.info().attach('figure.json', {
				body: JSON.stringify(figure),
				contentType: 'application/json'
			});
			expect(figure.lines).toBe(8);
			expect(figure.hidden).toEqual([]);
			expect(figure.clipped).toEqual([]);
			expect(figure.endOnTitle).toBe(true);
			expect(figure.endWidth).toBeGreaterThanOrEqual(16);
			expect(figure.joined).toBe(true);
			for (const size of figure.sizes) expect(size).toBeGreaterThanOrEqual(11);
			// The slide is one step above the source sheet: its own surface, its own
			// border and a shadow.
			expect(figure.shadow).not.toBe('none');
			expect(figure.surfaces[0]).not.toBe(figure.surfaces[1]);
			expect(figure.borders[0]).not.toBe(figure.borders[1]);
		});
	}
}

// The Desktop edition has no use for a link to its own installers. The default
// server is DeckMark Web. Serve a Desktop build to check the other branch:
// `npx playwright test --config=playwright.capture.config.ts e2e/landing.spec.ts -g "follows the edition"`.
test('the desktop download link follows the edition', async ({ page }) => {
	await start(page, 'en');
	const edition = await page.evaluate(async () => {
		const manifest = (await (await fetch('edition.json')).json()) as { edition: string };
		return manifest.edition;
	});
	await test.info().attach('edition.txt', { body: edition, contentType: 'text/plain' });
	const link = page.getByTestId('welcome-desktop-link');
	if (edition === 'desktop') {
		await expect(link).toHaveCount(0);
		await expect(page.locator('#welcome-desktop-hint')).toHaveCount(0);
	} else {
		expect(edition).toBe('web');
		await expect(link).toBeVisible();
	}
	// The other start paths do not depend on the edition.
	await expect(page.getByTestId('welcome-github-link')).toBeVisible();
	await expect(page.getByTestId('welcome-new')).toBeVisible();
});

for (const [name, viewport] of [
	['large desktop', { width: 1920, height: 1080 }],
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
			await expect(page.locator('.welcome-visual')).toBeVisible();
			const fits = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
			expect(fits).toBe(true);
			// The primary action stays reachable without scrolling.
			await expect(page.getByTestId('welcome-new')).toBeInViewport();
			// The start actions, the two text links and the footer links are touch targets.
			const small = await page
				.locator('.welcome-actions :is(button, a), .welcome-footer a')
				.evaluateAll((items) =>
					items
						.map((item) => item.getBoundingClientRect())
						.filter((box) => box.height < 44)
						.map((box) => Math.round(box.height))
				);
			expect(small).toEqual([]);
			expect(await page.locator('.welcome-footer a').count()).toBe(4);
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

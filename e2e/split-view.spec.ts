import { test, expect } from '@playwright/test';
import { createFirstFile, resetAppState, writeSourceContent } from './helpers';
import { createHash } from 'node:crypto';
import { loadHeadingFixture } from './heading-fixture';

const fixture = [
	'# Split preview',
	'',
	'Opening paragraph.',
	'',
	'## Middle section',
	'',
	'Middle paragraph.',
	'',
	'## Final section',
	'',
	'Final paragraph.',
	'',
	'<script>window.__splitUnsafe = true</script>'
].join('\n');

test.beforeEach(async ({ page }) => {
	await resetAppState(page);
	await createFirstFile(page);
	await writeSourceContent(page, fixture);
});

test('keeps one editable source and renders a sanitized delayed preview', async ({
	page
}, testInfo) => {
	const toggle = page.getByRole('button', { name: 'Afficher l’aperçu' });
	await expect(toggle).toHaveAttribute('aria-pressed', 'false');
	await toggle.click();
	await expect(page.getByRole('button', { name: 'Masquer l’aperçu' })).toHaveAttribute(
		'aria-pressed',
		'true'
	);

	const split = page.getByTestId('split-view');
	await expect(split).toBeVisible();
	await expect(split.locator('.cm-content')).toHaveCount(1);
	await expect(split.getByRole('region', { name: 'Aperçu du rendu' })).toContainText(
		'Final paragraph.'
	);
	await expect(split.locator('script')).toHaveCount(0);
	await expect
		.poll(() => page.evaluate(() => (window as Window & { __splitUnsafe?: boolean }).__splitUnsafe))
		.toBeUndefined();

	const editor = split.locator('.cm-content');
	await editor.click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.insertText('\nDelayed update marker');
	expect(await split.getByRole('region', { name: 'Aperçu du rendu' }).textContent()).not.toContain(
		'Delayed update marker'
	);
	await expect(split.getByRole('region', { name: 'Aperçu du rendu' })).toContainText(
		'Delayed update marker'
	);

	await page.getByRole('button', { name: 'Masquer l’aperçu' }).click();
	await expect(page.getByTestId('split-view')).toHaveCount(0);
	await page.locator('.cm-content').focus();
	await page.keyboard.press('ControlOrMeta+z');
	await expect(page.locator('.cm-content')).not.toContainText('Delayed update marker');

	await testInfo.attach('split-view-fixture', { body: fixture, contentType: 'text/markdown' });
	await testInfo.attach('split-view', {
		body: await page.screenshot(),
		contentType: 'image/png'
	});
});

test('resizes with the keyboard and restores the saved split', async ({ page }) => {
	await page.getByRole('button', { name: 'Afficher l’aperçu' }).click();
	const separator = page.getByRole('separator', {
		name: 'Redimensionner la source et l’aperçu'
	});
	await expect(separator).toHaveAttribute('aria-valuenow', '50');
	await separator.focus();
	await page.keyboard.press('ArrowRight');
	await expect(separator).toHaveAttribute('aria-valuenow', '55');

	await page.reload();
	await expect(page.getByRole('button', { name: 'Masquer l’aperçu' })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
	await expect(
		page.getByRole('separator', { name: 'Redimensionner la source et l’aperçu' })
	).toHaveAttribute('aria-valuenow', '55');
});

test('synchronizes sections and stacks both panes on a narrow screen', async ({ page }) => {
	await page.getByRole('button', { name: 'Afficher l’aperçu' }).click();
	const split = page.getByTestId('split-view');
	const editor = split.locator('.cm-content');
	await editor.click();
	await page.keyboard.press('ControlOrMeta+End');
	await expect(split.getByRole('heading', { name: 'Final section' })).toBeInViewport();

	await page.setViewportSize({ width: 390, height: 720 });
	await expect(page.getByRole('separator')).toHaveAttribute('aria-orientation', 'horizontal');
	await expect
		.poll(async () => {
			const sourceBox = await split.getByRole('region', { name: 'Source Markdown' }).boundingBox();
			const previewBox = await split.getByRole('region', { name: 'Aperçu du rendu' }).boundingBox();
			return sourceBox !== null && previewBox !== null && previewBox.y > sourceBox.y;
		})
		.toBe(true);
});

for (const bytes of [240_000, 1_000_000]) {
	test(`indexes 1000 split headings without per-event scans at ${bytes} bytes`, async ({
		page,
		browserName
	}, info) => {
		test.setTimeout(90_000);
		const sections = Array.from(
			{ length: 1000 },
			(_, index) => `## Indexed section ${index + 1}\n\nLocal cœur 🎉. `
		);
		const remaining = bytes - Buffer.byteLength(sections.join('\n\n'));
		const source = sections
			.map(
				(section, index) =>
					section + 'x'.repeat(Math.floor(remaining / 1000) + (index < remaining % 1000 ? 1 : 0))
			)
			.join('\n\n');
		await loadHeadingFixture(page, source);
		await page.getByRole('button', { name: 'Afficher l’aperçu' }).click();
		const split = page.getByTestId('split-view');
		await expect(split.locator('.mdsh-preview h2')).toHaveCount(1000);
		await split.locator('.cm-content').focus();
		await page.keyboard.press('ControlOrMeta+Home');
		await page.waitForTimeout(600);
		const cdp = browserName === 'chromium' ? await page.context().newCDPSession(page) : null;
		await cdp?.send('Performance.enable');
		const before = await cdp?.send('Performance.getMetrics');
		await page.evaluate((source) => {
			const probe = { scans: 0, queries: 0, rectangles: 0 };
			Object.assign(window, { splitProbe: probe });
			const split = String.prototype.split;
			String.prototype.split = function (...args: Parameters<typeof split>) {
				if (String(this) === source && args[0] === '\n') probe.scans++;
				return Reflect.apply(split, this, args);
			};
			const query = Element.prototype.querySelectorAll;
			Element.prototype.querySelectorAll = function (selector: string) {
				if (/h1.*h2.*h3/.test(selector) && this.closest('.mdsh-split-preview')) probe.queries++;
				return Reflect.apply(query, this, [selector]);
			};
			const rect = Element.prototype.getBoundingClientRect;
			Element.prototype.getBoundingClientRect = function () {
				if (/^H[1-6]$/.test(this.tagName) && this.closest('.mdsh-split-preview'))
					probe.rectangles++;
				return Reflect.apply(rect, this, []);
			};
		}, source);
		for (let index = 0; index < 12; index++) await page.keyboard.press('ArrowRight');
		const caret = await page.evaluate(() => ({
			...(window as unknown as { splitProbe: object }).splitProbe
		}));
		await page.waitForTimeout(450);
		const samples = await split.locator('.mdsh-read').evaluate(async (scroller) => {
			const probe = (
				window as unknown as { splitProbe: { scans: number; queries: number; rectangles: number } }
			).splitProbe;
			probe.scans = probe.queries = probe.rectangles = 0;
			const raw: number[] = [];
			for (let index = 0; index < 24; index++) {
				const started = performance.now();
				scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) * ((index % 12) / 12);
				await new Promise<void>((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
				);
				raw.push(performance.now() - started);
			}
			return { raw, ...probe };
		});
		const after = await cdp?.send('Performance.getMetrics');
		const sorted = [...samples.raw].sort((a, b) => a - b);
		const percentile = (fraction: number) =>
			sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
		await info.attach('split-index-measurements.json', {
			body: JSON.stringify(
				{
					browserName,
					fixture: {
						bytes: Buffer.byteLength(source),
						sha256: createHash('sha256').update(source).digest('hex'),
						headings: 1000
					},
					caret,
					scroll: {
						...samples,
						p50: percentile(0.5),
						p95: percentile(0.95),
						warmup: 'Mount, Home, then 600 ms settlement',
						sampling: '24 scroll positions, each followed by two rAF callbacks'
					},
					chromiumMetrics: { before, after },
					limits: [
						'Two rAF callbacks measure a scheduling proxy, not physical paint.',
						'Rectangle calls are not forced-layout events.',
						...(cdp ? [] : ['WebKit does not expose CDP CPU or forced-layout counters.'])
					]
				},
				null,
				2
			),
			contentType: 'application/json'
		});
		await info.attach('split-index-fixture.md', { body: source, contentType: 'text/markdown' });
		expect(caret).toEqual({ scans: 0, queries: 0, rectangles: 0 });
		expect(samples.scans).toBe(0);
		expect(samples.queries).toBe(0);
		expect(samples.rectangles).toBe(0);
		await split.locator('.cm-content').focus();
		await page.waitForTimeout(450);
		await page.keyboard.press('ControlOrMeta+End');
		await expect(
			split.getByRole('heading', { name: 'Indexed section 1000', exact: true })
		).toBeInViewport();
		await expect(split.locator('.cm-content')).toBeFocused();
	});
}

test('refreshes split geometry after structural edits, theme and pane changes', async ({
	page
}, info) => {
	const source = Array.from(
		{ length: 360 },
		(_, index) => `## Geometry ${index + 1}\n\n${'Wrapping paragraph. '.repeat(12)}`
	).join('\n\n');
	await loadHeadingFixture(page, source);
	await page.getByRole('button', { name: 'Afficher l’aperçu' }).click();
	const split = page.getByTestId('split-view');
	const editor = split.locator('.cm-content');
	await expect(split.locator('.mdsh-preview h2')).toHaveCount(360);
	await editor.focus();
	await page.keyboard.press('ControlOrMeta+Home');
	await page.keyboard.insertText('## Inserted first\n\n');
	await expect(split.locator('.mdsh-preview h2')).toHaveCount(361);
	await page.keyboard.press('ControlOrMeta+End');
	await expect(split.getByRole('heading', { name: 'Geometry 360', exact: true })).toBeInViewport();
	await page.getByRole('separator').focus();
	await page.keyboard.press('ArrowRight');
	await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
	await page.setViewportSize({ width: 1100, height: 800 });
	await editor.focus();
	await page.waitForTimeout(450);
	await page.keyboard.press('ControlOrMeta+Home');
	await expect(
		split.getByRole('heading', { name: 'Inserted first', exact: true })
	).toBeInViewport();
	await page.keyboard.press('ControlOrMeta+z');
	await expect(split.locator('.mdsh-preview h2')).toHaveCount(360);
	await page.waitForTimeout(450);
	await page.keyboard.press('ControlOrMeta+End');
	await expect(split.getByRole('heading', { name: 'Geometry 360', exact: true })).toBeInViewport();
	const scroller = split.locator('.mdsh-read');
	await page.waitForTimeout(450);
	await scroller.evaluate((element) => {
		element.scrollTop = 0;
	});
	await expect
		.poll(() => split.locator('.cm-scroller').evaluate((element) => element.scrollTop))
		.toBeLessThan(150);
	await expect(editor).toBeFocused();
	const position = await scroller.evaluate((element) => element.scrollTop);
	await page.waitForTimeout(500);
	expect(await scroller.evaluate((element) => element.scrollTop)).toBe(position);
	await info.attach('split-geometry.png', {
		body: await page.screenshot(),
		contentType: 'image/png'
	});
	await info.attach('split-geometry-fixture.md', { body: source, contentType: 'text/markdown' });
});

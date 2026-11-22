import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createFirstFile, resetAppState, writeSourceContent } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

const NOTE = `# Shared column

A paragraph of body text. It is long enough to wrap at a desk width and to show the measure of the column.

- first item
- second item

### Detail

The quick brown fox jumps over the lazy dog.
`;

const LONG = `# Long note\n\n${Array.from(
	{ length: 160 },
	(_, index) => `Paragraph ${index + 1} has enough text to scroll the note.`
).join('\n\n')}\n`;

function relativeLuminance(rgb: [number, number, number]): number {
	const [r, g, b] = rgb.map((value) => {
		const channel = value / 255;
		return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
	}) as [number, number, number];
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
	const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
	return (lighter! + 0.05) / (darker! + 0.05);
}

function parseRgb(value: string): [number, number, number] {
	const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(value);
	if (!match) throw new Error(`Unreadable color: ${value}`);
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

async function setTheme(page: Page, theme: 'dark' | 'light'): Promise<void> {
	await page.evaluate((value) => localStorage.setItem('mdsh:theme', value), theme);
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]').waitFor({ timeout: 20_000 });
}

async function openNote(page: Page): Promise<void> {
	await resetAppState(page, { mode: 'source' });
	await createFirstFile(page);
	await writeSourceContent(page, NOTE);
}

async function column(page: Page) {
	return page.evaluate(() => {
		const root =
			document.querySelector('.mdsh-preview') ?? document.querySelector('.milkdown .ProseMirror');
		const paragraph = root?.querySelector('p');
		const heading = root?.querySelector('h1');
		const box = root?.getBoundingClientRect();
		const paragraphBox = paragraph?.getBoundingClientRect();
		const style = heading ? getComputedStyle(heading) : null;
		return {
			rootX: box ? Math.round(box.x) : null,
			rootWidth: box ? Math.round(box.width) : null,
			paragraphX: paragraphBox ? Math.round(paragraphBox.x) : null,
			headingSize: style?.fontSize ?? null,
			headingWeight: style?.fontWeight ?? null
		};
	});
}

test('Read and Edit share one content column and one heading scale', async ({
	page
}, info: TestInfo) => {
	await page.setViewportSize({ width: 1920, height: 1080 });
	await openNote(page);
	await page.locator('button[data-mode="wysiwyg"]').click();
	await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 20_000 });
	const edit = await column(page);

	await page.locator('button[data-mode="read"]').click();
	await expect(page.locator('.mdsh-preview')).toBeVisible({ timeout: 20_000 });
	const read = await column(page);

	expect(read.rootX).toBe(edit.rootX);
	expect(read.rootWidth).toBe(edit.rootWidth);
	expect(read.paragraphX).toBe(edit.paragraphX);
	expect(read.headingSize).toBe(edit.headingSize);
	expect(read.headingWeight).toBe(edit.headingWeight);
	expect(Number.parseFloat(read.headingSize!)).toBeGreaterThanOrEqual(32);
	expect(Number.parseFloat(read.headingSize!)).toBeLessThanOrEqual(36);
	expect(Number(read.headingWeight)).toBeGreaterThanOrEqual(600);

	await info.attach('reading-column.json', {
		body: JSON.stringify(
			{ command: 'npx playwright test e2e/ui-polish.spec.ts', edit, read },
			null,
			2
		),
		contentType: 'application/json'
	});
});

test('the empty state promotes New file and hides shortcut chips on a phone', async ({
	page
}, info: TestInfo) => {
	await resetAppState(page);
	await setTheme(page, 'dark');
	const colors = await page.evaluate(() => {
		const read = (id: string) => {
			const element = document.querySelector(`[data-testid="${id}"]`)!;
			const style = getComputedStyle(element);
			return {
				background: style.backgroundColor,
				color: style.color,
				borderColor: style.borderTopColor,
				borderWidth: style.borderTopWidth
			};
		};
		return { newFile: read('welcome-new'), importMd: read('welcome-import') };
	});
	const primaryContrast = contrast(
		parseRgb(colors.newFile.color),
		parseRgb(colors.newFile.background)
	);
	expect(colors.newFile.background).toBe('rgb(199, 154, 85)');
	expect(colors.newFile.background).not.toBe(colors.importMd.background);
	expect(colors.importMd.borderWidth).toBe('1px');
	expect(primaryContrast).toBeGreaterThanOrEqual(4.5);
	await page.screenshot({ path: 'test-results/ui-polish-empty-1920.png' });

	await page.setViewportSize({ width: 390, height: 844 });
	await page.waitForTimeout(200);
	await expect(page.locator('kbd:visible')).toHaveCount(0);
	await expect(page.locator('.welcome-shortcuts')).toBeHidden();

	await info.attach('empty-primary.json', {
		body: JSON.stringify({ colors, primaryContrast: Number(primaryContrast.toFixed(2)) }, null, 2),
		contentType: 'application/json'
	});
});

test('every dialog family uses the same surface tokens and fits 768 px', async ({
	page
}, info: TestInfo) => {
	await page.setViewportSize({ width: 1366, height: 768 });
	await openNote(page);
	const panel = () =>
		page.evaluate(() => {
			const element = document.querySelector('.mdsh-dialog-panel')!;
			const style = getComputedStyle(element);
			const scroller = document.querySelector('.dialog-body');
			return {
				radius: style.borderRadius,
				shadow: style.boxShadow,
				border: style.borderTopWidth + ' ' + style.borderTopColor,
				scrolls: scroller ? scroller.scrollHeight > scroller.clientHeight + 1 : null
			};
		});

	await page.keyboard.press('Control+n');
	await expect(page.getByTestId('create-note')).toBeVisible();
	const newfile = await panel();
	expect(newfile.scrolls).toBe(false);
	await page.keyboard.press('Escape');

	await page.keyboard.press('Control+Shift+P');
	await expect(page.getByRole('dialog')).toBeVisible();
	const palette = await panel();
	await page.keyboard.press('Escape');

	await page.keyboard.press('Control+,');
	await expect(page.getByRole('dialog')).toBeVisible();
	const settings = await panel();
	await page.keyboard.press('Escape');

	expect(newfile.radius).toBe(palette.radius);
	expect(palette.radius).toBe(settings.radius);
	expect(newfile.shadow).toBe(palette.shadow);
	expect(palette.shadow).toBe(settings.shadow);
	expect(newfile.border).toBe(palette.border);
	expect(palette.border).toBe(settings.border);

	await info.attach('dialog-surfaces.json', {
		body: JSON.stringify({ newfile, palette, settings }, null, 2),
		contentType: 'application/json'
	});
});

test('the light accent stays amber and above AA', async ({ page }, info: TestInfo) => {
	await resetAppState(page);
	await setTheme(page, 'light');
	const tokens = await page.evaluate(() => {
		const style = getComputedStyle(document.documentElement);
		const probe = document.createElement('span');
		probe.style.color = 'var(--color-accent)';
		probe.style.background = 'var(--color-bg)';
		document.body.append(probe);
		const computed = getComputedStyle(probe);
		const value = { accent: computed.color, background: computed.backgroundColor };
		probe.remove();
		return { token: style.getPropertyValue('--color-accent').trim(), ...value };
	});
	const ratio = contrast(parseRgb(tokens.accent), parseRgb(tokens.background));
	expect(tokens.token).toBe('#8a5f22');
	expect(ratio).toBeGreaterThanOrEqual(4.5);
	await page.screenshot({ path: 'test-results/ui-polish-light-accent.png' });
	await info.attach('light-accent.json', {
		body: JSON.stringify({ ...tokens, contrast: Number(ratio.toFixed(2)) }, null, 2),
		contentType: 'application/json'
	});
});

test('a phone shows one contextual scroll control', async ({ page }, info: TestInfo) => {
	await resetAppState(page, { mode: 'source' });
	await createFirstFile(page);
	await writeSourceContent(page, LONG);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.locator('button[data-mode="read"]').click();
	await expect(page.locator('.mdsh-preview')).toBeVisible({ timeout: 20_000 });

	await expect(page.getByTestId('scroll-nav-toggle')).toBeVisible();
	await expect(page.getByTestId('scroll-top')).toHaveCount(0);
	await expect(page.getByTestId('scroll-bottom')).toHaveCount(0);

	const toggle = page.getByTestId('scroll-nav-toggle');
	await expect(toggle).toHaveAttribute('aria-label', /bas|bottom/i);
	await toggle.click();
	await expect
		.poll(() =>
			page.locator('.mdsh-read').evaluate((element) => {
				return element.scrollTop + element.clientHeight >= element.scrollHeight - 2;
			})
		)
		.toBe(true);
	await expect(toggle).toHaveAttribute('aria-label', /haut|top/i);
	await toggle.click();
	await expect
		.poll(() => page.locator('.mdsh-read').evaluate((element) => element.scrollTop))
		.toBeLessThan(2);

	await page.screenshot({ path: 'test-results/ui-polish-mobile-scroll.png' });
	await info.attach('mobile-scroll.json', {
		body: JSON.stringify({ controls: 1, viewport: { width: 390, height: 844 } }, null, 2),
		contentType: 'application/json'
	});
});

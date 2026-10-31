import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { testSource } from './test-source.mjs';
import { ensureMode, seedDocuments, saveScreenshot } from './capture-helpers.mjs';
const baseURL = process.env.RELAY_URL ?? 'http://127.0.0.1:4893';
const out = process.env.RELAY_OUTPUT ?? 'test-results/relay';
await mkdir(join(out, 'previews'), { recursive: true });
await mkdir(join(out, 'validation'), { recursive: true });
const browser = await chromium.launch();
const report = {
	...testSource(),
	status: 'running',
	startedAt: new Date().toISOString(),
	baseURL,
	repeatCommand: `RELAY_URL=${baseURL} node scripts/relay-review.mjs`,
	browser: browser.version(),
	dimensions: [],
	checks: [],
	scans: []
};
const sample = {
	name: 'Night survey',
	content:
		'# Night survey\n\nField log 07. A short observing session from the north terrace.\n\n## Before dusk\n\nSet the notebook beside the finder scope. Record the time and the sky conditions before moving the mount.\n\n- [x] Align the finder scope\n- [ ] Sketch the western horizon\n- [ ] Compare both observation logs\n\n## Instrument notes\n\nThe tripod stays on the same three marks for each reading.\n\n> Leave space in the margin for the next observation.\n'
};
report.fixture = sample;
async function theme(page, value) {
	await page.keyboard.press('ControlOrMeta+,');
	const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
	await expect(dialog).toBeVisible();
	await dialog.getByRole('button', { name: value, exact: true }).click();
	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();
}
async function scan(page, id) {
	const result = await new AxeBuilder({ page })
		.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
		.analyze();
	report.scans.push({
		id,
		violations: result.violations.map((v) => ({
			id: v.id,
			impact: v.impact,
			nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary }))
		})),
		manualRules: result.incomplete.map((v) => v.id)
	});
	expect(result.violations, id + ': accessibility violations').toEqual([]);
}
try {
	for (const [name, width, height, touch] of [
		['desktop', 1440, 900, false],
		['tablet', 820, 1180, true],
		['mobile', 390, 844, true]
	]) {
		const context = await browser.newContext({
			viewport: { width: 1440, height: 900 },
			locale: 'en-US',
			colorScheme: 'light',
			reducedMotion: 'reduce',
			hasTouch: touch
		});
		const page = await context.newPage();
		await page.goto(baseURL);
		await expect(page.getByTestId('welcome-new')).toBeVisible();
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
		await seedDocuments(page, [
			{
				name: 'Observation log',
				content: '# Observation log\n\nThe previous session began before dusk.\n'
			},
			sample
		]);
		await ensureMode(page, 'wysiwyg');
		await page.setViewportSize({ width, height });
		await expect(page.locator('.ProseMirror h1')).toHaveText('Night survey');
		for (const mode of ['dark', 'light']) {
			if (mode === 'light') {
				await theme(page, 'Light');
				await page.reload();
				await expect(page.locator('.ProseMirror h1')).toHaveText('Night survey');
			}
			await expect(page.locator('html')).toHaveAttribute('data-theme', mode);
			const toolbar = page.locator('#app-toolbar');
			await expect(toolbar).toBeVisible();
			await expect(
				page.getByRole('button', { name: 'Close notification', exact: true })
			).toHaveCount(0, { timeout: 45000 });
			const sizes = await toolbar.locator('button:visible').evaluateAll((items) =>
				items.map((el) => {
					const r = el.getBoundingClientRect();
					return {
						label: el.getAttribute('aria-label'),
						width: r.width,
						height: r.height,
						left: r.left,
						right: r.right
					};
				})
			);
			const overflow = await page.evaluate(
				() => document.documentElement.scrollWidth > innerWidth + 1
			);
			report.dimensions.push({ name, width, height, theme: mode, overflow, toolbar: sizes });
			expect(overflow, name + ': document overflow').toBe(false);
			for (const target of sizes) {
				expect(target.left, target.label).toBeGreaterThanOrEqual(0);
				expect(target.right, target.label).toBeLessThanOrEqual(width);
				if (touch) {
					expect(target.width, target.label).toBeGreaterThanOrEqual(44);
					expect(target.height, target.label).toBeGreaterThanOrEqual(44);
				}
			}
			await saveScreenshot(page, join(out, 'previews', name + '-' + mode + '.png'));
			await scan(page, name + '-' + mode);
			if (name === 'mobile') {
				const menu = page.getByRole('button', { name: 'Menu', exact: true });
				await menu.focus();
				await page.keyboard.press('Enter');
				await expect(page.locator('#files-panel')).not.toHaveAttribute('inert', '');
				await expect(
					page.locator('#files-panel button').filter({ hasNotText: /./ }).first()
				).toBeAttached();
				await page.keyboard.press('Tab');
				if (
					!(await page.locator('#files-panel').evaluate((e) => e.contains(document.activeElement)))
				)
					throw Error('Focus escaped library');
				await page.keyboard.press('Escape');
				await expect(menu).toBeFocused();
				report.checks.push('Mobile keyboard drawer and focus return: ' + mode);
			}
		}
		if (name === 'mobile') {
			for (const w of [320, 600, 768, 1024]) {
				await page.setViewportSize({ width: w, height: 850 });
				await expect(page.locator('.ProseMirror h1')).toBeVisible();
				const layout = await page.evaluate(() => ({
					documentWidth: document.documentElement.scrollWidth,
					toolbarWidth: document.querySelector('#app-toolbar').scrollWidth,
					toolbarClient: document.querySelector('#app-toolbar').clientWidth
				}));
				report.dimensions.push({ name: 'reflow', width: w, ...layout });
				expect(layout.documentWidth).toBeLessThanOrEqual(w);
				expect(layout.toolbarWidth).toBeLessThanOrEqual(layout.toolbarClient);
			}
			await theme(page, 'System');
			await page.emulateMedia({ colorScheme: 'dark' });
			await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
			await page.emulateMedia({ colorScheme: 'light' });
			await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
			report.checks.push('Saved system choice follows OS changes.');
		}
		await context.close();
	}
	report.checks.push(
		'Dark on first visit with light OS. Light choice persists after reload on all three layouts.'
	);
	report.status = 'passed';
} catch (error) {
	report.status = 'failed';
	report.error = String(error);
	throw error;
} finally {
	report.finishedAt = new Date().toISOString();
	await writeFile(join(out, 'validation', 'browser.json'), JSON.stringify(report, null, 2) + '\n');
	await browser.close();
}

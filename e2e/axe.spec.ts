/**
 * Axe-core accessibility scan for release-blocking serious/critical issues.
 * Complements e2e/a11y.spec.ts (skip-link + focus trap).
 */
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { resetAppState, createFirstFile, openPalette } from './helpers';

test.use({ reducedMotion: 'reduce' });

function violationSummary(
	violations: Array<{ impact: string | null; id: string; nodes: Array<{ target: unknown }> }>
): string {
	return violations
		.map(
			(violation) =>
				`${violation.impact}: ${violation.id} ${violation.nodes
					.map((node) => JSON.stringify(node.target))
					.join(', ')}`
		)
		.join('\n');
}

async function expectNoBlockingViolations(page: Page, builder: AxeBuilder): Promise<void> {
	await page.evaluate(async () => {
		await Promise.all(
			document.getAnimations().map((animation) => animation.finished.catch(() => {}))
		);
	});
	const results = await builder.analyze();
	const blocking = results.violations.filter(
		(violation) => violation.impact === 'critical' || violation.impact === 'serious'
	);
	expect(blocking, violationSummary(blocking)).toEqual([]);
}

test.describe('Axe accessibility scan', () => {
	test.beforeEach(async ({ page }) => {
		await resetAppState(page);
	});

	test('Welcome screen passes in light and dark themes', async ({ page }) => {
		for (const theme of ['light', 'dark'] as const) {
			await page.evaluate(
				(selectedTheme) => localStorage.setItem('mdsh:theme', selectedTheme),
				theme
			);
			await page.reload();
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await expectNoBlockingViolations(page, new AxeBuilder({ page }));
		}
	});

	test('Source editor and palette pass in light and dark themes', async ({ page }) => {
		await createFirstFile(page);
		for (const theme of ['light', 'dark'] as const) {
			await page.evaluate(
				(selectedTheme) => localStorage.setItem('mdsh:theme', selectedTheme),
				theme
			);
			await page.reload();
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			// New notes open in Edit mode; select Source for the CodeMirror scan.
			await page.locator('button[data-mode="source"]').click();
			await expect(page.locator('.cm-content')).toHaveAttribute('aria-label');
			await expectNoBlockingViolations(page, new AxeBuilder({ page }).include('#main'));
			await openPalette(page);
			await expect(page.locator('.mdsh-dialog-panel')).toHaveCSS('opacity', '1');
			await expectNoBlockingViolations(
				page,
				new AxeBuilder({ page }).include('.mdsh-dialog-panel')
			);
			await page.keyboard.press('Escape');
		}
	});

	test('WYSIWYG, reading view, and Settings pass in light and dark themes', async ({ page }) => {
		await createFirstFile(page);
		for (const theme of ['light', 'dark'] as const) {
			await page.evaluate(
				(selectedTheme) => localStorage.setItem('mdsh:theme', selectedTheme),
				theme
			);
			await page.reload();
			await page.locator('button[data-mode="wysiwyg"]').click();
			await expect(page.locator('.ProseMirror')).toHaveAttribute('aria-label');
			await expectNoBlockingViolations(page, new AxeBuilder({ page }).include('#main'));

			await page.locator('button[data-mode="read"]').click();
			await expect(page.locator('.mdsh-preview')).toBeVisible();
			await expectNoBlockingViolations(page, new AxeBuilder({ page }).include('#main'));

			await page.keyboard.press('ControlOrMeta+,');
			await expect(page.getByRole('dialog')).toBeVisible();
			await expect(page.locator('.mdsh-dialog-panel')).toHaveCSS('opacity', '1');
			await expectNoBlockingViolations(page, new AxeBuilder({ page }).include('[role="dialog"]'));
			await page.keyboard.press('Escape');
		}
	});

	test('mobile welcome and source workspace have no blocking violations', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		for (const theme of ['light', 'dark'] as const) {
			await resetAppState(page);
			await page.evaluate(
				(selectedTheme) => localStorage.setItem('mdsh:theme', selectedTheme),
				theme
			);
			await page.reload();
			await expectNoBlockingViolations(page, new AxeBuilder({ page }));
			await page.locator('main [data-testid="welcome-new"]').click();
			await page.getByTestId('create-note').click();
			await page.locator('button[data-mode="source"]').click();
			await expect(page.locator('.cm-content')).toBeVisible();
			await expect(page.locator('.cm-content')).toHaveAttribute('aria-label');
			await expectNoBlockingViolations(page, new AxeBuilder({ page }).include('#main'));
		}
	});
});

test('secondary panels pass accessibility checks in both themes', async ({ page }) => {
	await resetAppState(page);
	await createFirstFile(page);
	for (const theme of ['light', 'dark']) {
		await page.evaluate((value) => localStorage.setItem('mdsh:theme', value), theme);
		await page.reload();
		for (const command of [
			'Bibliothèque de documents',
			'Recherche cross-fichiers',
			'Charger un workspace',
			'Gérer les liens disque',
			'Historique des versions',
			'Graphe des liens'
		]) {
			await openPalette(page);
			await page.getByRole('combobox').fill(command);
			await page.keyboard.press('Enter');
			await expect(
				page.getByRole('dialog', { name: 'Palette de commandes', exact: true })
			).toHaveCount(0);
			await expect(page.getByRole('dialog')).toBeVisible();
			await expectNoBlockingViolations(page, new AxeBuilder({ page }).include('[role="dialog"]'));
			await page.keyboard.press('Escape');
			await expect(page.getByRole('dialog')).toHaveCount(0);
		}
		await page.locator('aside button[aria-label^="Nouveau fichier"]').click();
		await expectNoBlockingViolations(page, new AxeBuilder({ page }).include('[role="dialog"]'));
		await page.getByTestId('create-presentation').click();
		await expect(page.getByTestId('presentation-editor')).toBeVisible();
		await expectNoBlockingViolations(
			page,
			new AxeBuilder({ page }).include('[data-testid="presentation-editor"]')
		);
		await page.keyboard.press('ControlOrMeta+w');
		await page.locator('button[data-mode="source"]').click();
		await expect(page.locator('.cm-content')).toBeVisible();
	}
});

test('workspace controls remain reachable at 200 percent CSS zoom', async ({ page }) => {
	await resetAppState(page);
	await createFirstFile(page);
	await page.evaluate(() => {
		document.documentElement.style.zoom = '2';
	});
	await openPalette(page);
	await expect(page.getByRole('combobox')).toBeInViewport();
	await expectNoBlockingViolations(page, new AxeBuilder({ page }).include('[role="dialog"]'));
	await page.keyboard.press('Escape');
	await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('search errors and nested workspace prompts pass accessibility checks', async ({ page }) => {
	await resetAppState(page);
	await createFirstFile(page);
	for (const theme of ['light', 'dark']) {
		await page.evaluate((value) => localStorage.setItem('mdsh:theme', value), theme);
		await page.reload();
		await openPalette(page);
		await page.getByRole('combobox').fill('Recherche cross-fichiers');
		await page.keyboard.press('Enter');
		await page.getByRole('button', { name: 'Utiliser une expression régulière' }).click();
		await page.getByRole('combobox').fill('[[');
		await expect(page.getByRole('alert')).toContainText('Regex invalide');
		await expectNoBlockingViolations(page, new AxeBuilder({ page }).include('[role="dialog"]'));
		await page.keyboard.press('Escape');
		await openPalette(page);
		await page.getByRole('combobox').fill('Charger un workspace');
		await page.keyboard.press('Enter');
		await page.getByRole('button', { name: 'Sauvegarder le workspace courant' }).click();
		const prompt = page.getByRole('dialog', { name: 'Nom du workspace ?' });
		await expect(prompt).toBeVisible();
		await expectNoBlockingViolations(page, new AxeBuilder({ page }).include('[role="dialog"]'));
		await page.keyboard.press('Escape');
		await expect(prompt).toHaveCount(0);
		await expect(
			page.getByRole('button', { name: 'Sauvegarder le workspace courant' })
		).toBeFocused();
		await page.keyboard.press('Escape');
	}
});

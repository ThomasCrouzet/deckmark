import { expect, test } from '@playwright/test';
import { resetAppState } from './helpers';
import { fr } from '../src/lib/i18n/messages/fr';
import { backupProjectFr } from '../src/lib/i18n/messages/backup-project-fr';
import { desktopBackupFr } from '../src/lib/i18n/messages/desktop-backup-fr';

// Review finding UX-04: the French interface kept a lowercase product name,
// two spellings of "hors ligne", English words and raw capability ids.
// The page cases check the visible result. The catalog case covers strings
// that appear only after rare events, such as the offline-ready toast.

test('French Settings names the product and the capabilities in French', async ({ page }) => {
	await resetAppState(page);
	await page.keyboard.press('Control+,');
	const settings = page.getByRole('dialog', { name: 'Réglages', exact: true });
	await expect(settings).toBeVisible();
	await expect(settings.getByRole('heading', { name: 'À propos de DeckMark' })).toBeVisible();
	const capabilities = settings.getByTestId('edition-capabilities');
	await expect(capabilities).toHaveText(
		'Capacités incluses : Notes, Présentations, Fichiers de code, Images, Projets, Utilisation hors ligne'
	);
	await expect(capabilities).not.toContainText('pwa-offline');
});

test('French palette entries use "espace de travail" and no English term', async ({ page }) => {
	await resetAppState(page);
	await page.getByRole('button', { name: 'Palette de commandes' }).click();
	const palette = page.getByRole('dialog', { name: 'Palette de commandes' });
	await expect(palette).toBeVisible();
	await page.getByRole('combobox').fill('espace de travail');
	await expect(palette.getByRole('option', { name: /Charger un espace de travail/ })).toBeVisible();
	await expect(
		palette.getByRole('option', { name: /Recherche dans tous les fichiers/ })
	).toHaveCount(0);
	await page.getByRole('combobox').fill('');
	await expect(
		palette.getByRole('option', { name: /Recherche dans tous les fichiers/ })
	).toBeVisible();
	await expect(palette).not.toContainText(/workspace|cross-fichiers|search\/replace|panel /i);
});

test('French home title is French after hydration', async ({ page }) => {
	await resetAppState(page);
	await expect(page).toHaveTitle(/espace de travail Markdown/);
	await expect(page).not.toHaveTitle(/local-first|editor/);
});

test('French catalog keeps one spelling and the product name', () => {
	const catalog: Record<string, string> = { ...fr, ...backupProjectFr, ...desktopBackupFr };
	const failures: string[] = [];
	for (const [key, value] of Object.entries(catalog)) {
		// A file name such as deckmark-backup-*.json is a literal, not prose.
		const prose = value.replace(/deckmark-backup-/g, '').replace(/\{\w+\}/g, '');
		if (/deckmark/.test(prose)) failures.push(`${key}: lowercase product name`);
		if (/hors-ligne/i.test(value)) failures.push(`${key}: write "hors ligne"`);
		if (/workspace/i.test(prose)) failures.push(`${key}: write "espace de travail"`);
		if (/cross-fichiers|best-effort|search\/replace/i.test(value)) {
			failures.push(`${key}: English term`);
		}
		if (/\b(Relie|Retire)-(les|le|la)\b/.test(value)) failures.push(`${key}: informal imperative`);
	}
	expect(failures).toEqual([]);
});

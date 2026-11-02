import { test, expect } from '@playwright/test';
import { resetAppState, createFirstFile, openPalette, writeSourceContent } from './helpers';

const FIXTURE = `# Titre H1

## Sous-titre H2

Paragraphe avec **gras**, *italique*, \`code inline\` et un [lien](https://example.com).

- Liste item 1
- Liste item 2
  - Imbriqué
- Liste item 3

1. Ordonné un
2. Ordonné deux

> Citation blockquote

\`\`\`js
const x = 42;
function hello() { return x; }
\`\`\`

| Col A | Col B |
| --- | --- |
| 1 | 2 |
| 3 | 4 |

---

- [ ] Tâche à faire
- [x] Tâche faite
`;

/**
 * Visual snapshots for the source mode, read mode, and command palette.
 * These checks are for local comparison. CI excludes this suite.
 * The versioned Linux and macOS baselines are platform-specific.
 * Playwright creates a PNG diff when a local comparison fails.
 *
 * Compare: `npm run test:e2e -- visual.spec.ts`
 * Update: `npm run test:e2e -- visual.spec.ts --update-snapshots`
 * See CONTRIBUTING.md for the Linux baseline update command.
 */
test.describe('Snapshots visuels - 3 modes', () => {
	test.beforeEach(async ({ page }) => {
		await resetAppState(page, { mode: 'source' });
		await createFirstFile(page);

		// Insert exact fixture bytes without automatic indentation from typed newlines.
		await writeSourceContent(page, FIXTURE);
		const cm = page.locator('.cm-content').first();
		await page.keyboard.press('ControlOrMeta+Home');
		await expect(cm.locator('.cm-line').first()).toHaveText('# Titre H1');
		await page.evaluate(() => navigator.serviceWorker.ready);
		// Let the initial offline-ready notice finish before image comparison.
		await expect(
			page.getByRole('status').filter({ hasText: 'prêt à fonctionner hors-ligne' })
		).toHaveCount(0, { timeout: 15_000 });
	});

	test('mode source', async ({ page }) => {
		// resetAppState already selected source mode.
		await expect(page.locator('main')).toHaveScreenshot('source-mode.png', {
			maxDiffPixelRatio: 0.02
		});
	});

	test('mode lecture', async ({ page }) => {
		// The button has `role="radio"`. Select it with `data-mode`.
		await page.locator('button[data-mode="read"]').click();
		await expect(page.locator('.mdsh-preview')).toBeVisible();
		// Wait for the lazy KaTeX, highlight.js, and Mermaid modules.
		await page.waitForTimeout(800);
		await expect(page.locator('main')).toHaveScreenshot('read-mode.png', {
			maxDiffPixelRatio: 0.02
		});
	});

	test('palette de commandes', async ({ page }) => {
		await openPalette(page);
		const dialog = page.getByRole('dialog', { name: 'Palette de commandes' });
		await expect(dialog).toBeVisible();
		// Capture only the dialog for a stable snapshot.
		await expect(dialog.locator('.mdsh-dialog-panel')).toHaveScreenshot('palette.png', {
			maxDiffPixelRatio: 0.02
		});
	});
});

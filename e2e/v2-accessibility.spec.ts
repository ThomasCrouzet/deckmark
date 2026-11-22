import { expect, test, type Page, type TestInfo } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {
	createFirstFile,
	openPalette,
	resetAppState,
	runAction,
	writeSourceContent
} from './helpers';

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

async function expectNoBlockingViolations(page: Page, selector: string): Promise<void> {
	await page.evaluate(async () => {
		await Promise.all(
			document.getAnimations().map((animation) => animation.finished.catch(() => {}))
		);
	});
	const results = await new AxeBuilder({ page }).include(selector).analyze();
	const evidenceName = `axe-${selector.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'document'}.json`;
	await test.info().attach(evidenceName, {
		body: JSON.stringify(results, null, 2),
		contentType: 'application/json'
	});
	const blocking = results.violations.filter(
		(violation) => violation.impact === 'critical' || violation.impact === 'serious'
	);
	expect(blocking, violationSummary(blocking)).toEqual([]);
}

async function attachEvidence(testInfo: TestInfo, page: Page, name: string): Promise<void> {
	await testInfo.attach(`${name}.png`, {
		body: await page.screenshot({ fullPage: true }),
		contentType: 'image/png'
	});
	await testInfo.attach(`${name}.json`, {
		body: JSON.stringify({
			command: 'npx playwright test e2e/v2-accessibility.spec.ts --project=chromium --workers=1',
			project: testInfo.project.name
		}),
		contentType: 'application/json'
	});
}

async function seedVersion(page: Page, content: string): Promise<void> {
	await page.evaluate(
		(versionContent) =>
			new Promise<void>((resolve, reject) => {
				const open = indexedDB.open('mdsh');
				open.onerror = () => reject(open.error);
				open.onsuccess = () => {
					const database = open.result;
					const draftRequest = database.transaction('drafts').objectStore('drafts').getAll();
					draftRequest.onerror = () => {
						database.close();
						reject(draftRequest.error);
					};
					draftRequest.onsuccess = () => {
						const draft = draftRequest.result.find((row) => row.open !== false);
						if (!draft) {
							database.close();
							reject(new Error('No open draft'));
							return;
						}
						const transaction = database.transaction('versions', 'readwrite');
						transaction.objectStore('versions').put({
							id: 'v2-accessibility-version',
							draftId: draft.id,
							name: draft.name,
							content: versionContent,
							createdAt: Date.now() - 60_000
						});
						transaction.oncomplete = () => {
							database.close();
							resolve();
						};
						transaction.onerror = () => {
							database.close();
							reject(transaction.error);
						};
					};
				};
			}),
		content
	);
}

test.beforeEach(async ({ page }) => {
	await resetAppState(page);
});

test('project tree supports keyboard navigation and has no blocking axe violations', async ({
	page
}, testInfo) => {
	const zip = new (await import('jszip')).default();
	zip.file('README.md', '# Home\n\n[Guide](notes/guide.md)\n');
	zip.file('notes/guide.md', '# Guide\n');
	const archive = await zip.generateAsync({ type: 'nodebuffer' });

	const trigger = page.getByTestId('projects-open');
	await trigger.click();
	const dialog = page.getByRole('dialog', { name: 'Projets Markdown' });
	await dialog.locator('input[type=file][accept=".zip"]').setInputFiles({
		name: 'Accessible-project.zip',
		mimeType: 'application/zip',
		buffer: archive
	});
	await expect(dialog.getByRole('button', { name: 'Fermer les projets' })).toBeFocused();
	await expectNoBlockingViolations(page, '[role="dialog"]');

	const folder = dialog.locator('summary').filter({ hasText: /^notes$/ });
	const guide = dialog.getByRole('button', { name: 'Ouvrir notes/guide.md', exact: true });
	await folder.focus();
	await page.keyboard.press('Enter');
	await expect(guide).not.toBeVisible();
	await page.keyboard.press('Enter');
	await expect(guide).toBeVisible();
	await guide.focus();
	await page.keyboard.press('Enter');
	await expect(dialog).toHaveCount(0);
	await expect(page.locator('.cm-content')).toBeFocused();

	await attachEvidence(testInfo, page, 'project-tree-accessibility');
});

test('split view and history diff support keyboard access and axe checks', async ({
	page
}, testInfo) => {
	await createFirstFile(page);
	const current = Array.from({ length: 120 }, (_, index) => `Current line ${index + 1}`).join('\n');
	const stored = Array.from({ length: 120 }, (_, index) => `Stored line ${index + 1}`).join('\n');
	await writeSourceContent(page, current);
	await seedVersion(page, stored);

	await page.getByRole('button', { name: 'Afficher l’aperçu' }).click();
	const separator = page.getByRole('separator', {
		name: 'Redimensionner la source et l’aperçu'
	});
	await separator.focus();
	await page.keyboard.press('ArrowLeft');
	await expect(separator).toHaveAttribute('aria-valuenow', '45');
	await expectNoBlockingViolations(page, '#main');

	await openPalette(page);
	await page.getByRole('combobox').fill('Historique des versions');
	await page.keyboard.press('Enter');
	const history = page.getByRole('dialog', { name: /Historique des versions/ });
	await history
		.getByRole('list', { name: 'Versions disponibles' })
		.getByRole('button')
		.last()
		.click();
	const diff = history.locator('.diff-view ol');
	await expect(diff).toBeVisible();
	await expectNoBlockingViolations(page, '[role="dialog"]');
	await diff.focus();
	await expect(diff).toBeFocused();
	await page.keyboard.press('PageDown');
	await expect.poll(() => diff.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

	await attachEvidence(testInfo, page, 'split-diff-accessibility');
});

test('disk conflict traps focus, passes axe, and restores the Actions trigger', async ({
	page
}, testInfo) => {
	await page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		const handle = await root.getFileHandle('accessible-conflict.md', { create: true });
		const writer = await handle.createWritable();
		await writer.write('Original disk content');
		await writer.close();
		Object.defineProperty(window, 'showOpenFilePicker', {
			configurable: true,
			value: async () => [handle]
		});
	});
	await page
		.locator('aside')
		.getByRole('button', { name: /^Importer un fichier markdown/ })
		.click();
	await writeSourceContent(page, 'Local content');
	await page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		const handle = await root.getFileHandle('accessible-conflict.md');
		const writer = await handle.createWritable();
		await writer.write('External disk content');
		await writer.close();
	});

	await runAction(page, 'save-disk');
	const dialog = page.getByRole('dialog', {
		name: 'Résoudre le conflit disque pour accessible-conflict.md'
	});
	const cancel = dialog.getByRole('button', { name: 'Annuler', exact: true }).first();
	await expect(cancel).toBeFocused();
	await expectNoBlockingViolations(page, '[role="dialog"]');
	await page.keyboard.press('Shift+Tab');
	await expect(dialog.getByRole('button', { name: 'Écraser le disque' })).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(dialog).toHaveCount(0);
	await expect(page.locator('[data-actions-trigger]')).toBeFocused();

	await attachEvidence(testInfo, page, 'disk-conflict-accessibility');
});

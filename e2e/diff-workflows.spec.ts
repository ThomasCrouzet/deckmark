import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
	createFirstFile,
	openPalette,
	resetAppState,
	seedFiles,
	writeSourceContent
} from './helpers';

async function openCommand(page: Page, label: string): Promise<void> {
	await openPalette(page);
	await page.getByRole('combobox').fill(label);
	await page.keyboard.press('Enter');
}

async function activeDraft(page: Page): Promise<{ id: string; name: string; content: string }> {
	return page.evaluate(
		() =>
			new Promise((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const rows = database.transaction('drafts').objectStore('drafts').getAll();
					rows.onerror = () => reject(rows.error);
					rows.onsuccess = () => {
						database.close();
						const row = rows.result.find((entry) => entry.open !== false) ?? rows.result[0];
						if (!row) reject(new Error('No active draft'));
						else resolve({ id: row.id, name: row.name, content: row.content });
					};
				};
			})
	);
}

async function seedVersion(
	page: Page,
	draft: { id: string; name: string },
	content: string
): Promise<void> {
	await page.evaluate(
		({ current, versionContent }) =>
			new Promise<void>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const tx = database.transaction('versions', 'readwrite');
					tx.objectStore('versions').put({
						id: `e2e-version-${Date.now()}`,
						draftId: current.id,
						name: current.name,
						content: versionContent,
						createdAt: Date.now() - 60_000
					});
					tx.oncomplete = () => {
						database.close();
						resolve();
					};
					tx.onerror = () => reject(tx.error);
				};
			}),
		{ current: draft, versionContent: content }
	);
}

async function storedVersionContents(page: Page): Promise<string[]> {
	return page.evaluate(
		() =>
			new Promise((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const rows = database.transaction('versions').objectStore('versions').getAll();
					rows.onerror = () => reject(rows.error);
					rows.onsuccess = () => {
						database.close();
						resolve(rows.result.map((row) => row.content));
					};
				};
			})
	);
}

async function attachEvidence(testInfo: TestInfo, page: Page, name: string): Promise<void> {
	await testInfo.attach(`${name}.png`, {
		body: await page.screenshot({ fullPage: true }),
		contentType: 'image/png'
	});
	await testInfo.attach(`${name}.json`, {
		body: JSON.stringify({
			command: 'npm run test:e2e -- e2e/diff-workflows.spec.ts --project=chromium --workers=1',
			project: testInfo.project.name,
			status: 'observed'
		}),
		contentType: 'application/json'
	});
}

test.describe('bounded diff workflows', () => {
	test.beforeEach(async ({ page }) => {
		await resetAppState(page);
	});

	test('keeps the replacement toggle under the pointer when results arrive', async ({
		page
	}, testInfo) => {
		await seedFiles(page, [{ name: 'Stable.md', content: 'alpha one' }]);
		await openCommand(page, 'Recherche cross-fichiers');
		const search = page.getByRole('dialog', { name: 'Recherche cross-fichiers' });
		await page.clock.pauseAt(new Date());
		await search.getByRole('combobox').fill('alpha');
		const toggle = search.getByRole('button', {
			name: 'Afficher le remplacement cross-fichiers'
		});
		const before = await toggle.boundingBox();
		expect(before).not.toBeNull();
		const point = { x: before!.x + before!.width / 2, y: before!.y + before!.height / 2 };
		await page.mouse.move(point.x, point.y);
		await page.clock.fastForward(150);
		await expect(search.getByRole('option')).toHaveCount(1);
		const after = await toggle.boundingBox();
		await testInfo.attach('replacement-toggle-geometry.json', {
			body: JSON.stringify({ before, after, point }),
			contentType: 'application/json'
		});
		expect(after).not.toBeNull();
		expect(Math.abs(after!.x - before!.x)).toBeLessThan(0.5);
		expect(Math.abs(after!.y - before!.y)).toBeLessThan(0.5);
		await page.mouse.click(point.x, point.y);
		await expect(toggle).toHaveAttribute('aria-pressed', 'true');
		await expect(search.getByRole('textbox', { name: 'Texte de remplacement' })).toBeVisible();
		await page.clock.resume();
		await attachEvidence(testInfo, page, 'replacement-toggle-stable');
	});

	test('shows an escaped history diff and keeps the current revision after restore', async ({
		page
	}, testInfo) => {
		await createFirstFile(page);
		const currentContent = '# Note\n\nCurrent line\n\nStable';
		const storedContent = '# Note\n\n<script>alert("old")</script>\n\nStable';
		await writeSourceContent(page, currentContent);
		const draft = await activeDraft(page);
		await seedVersion(page, draft, storedContent);

		await openCommand(page, 'Historique des versions');
		const history = page.getByRole('dialog', { name: /Historique des versions/ });
		await history
			.getByRole('list', { name: 'Versions disponibles' })
			.getByRole('button')
			.last()
			.click();
		await expect(history.locator('[data-diff-kind="remove"]')).toContainText('Current line');
		await expect(history.locator('[data-diff-kind="add"]')).toContainText(
			'<script>alert("old")</script>'
		);
		await expect(history.locator('script')).toHaveCount(0);
		await attachEvidence(testInfo, page, 'history-diff');

		await history.getByRole('button', { name: 'Restaurer cette version' }).click();
		await page
			.getByRole('dialog', { name: 'Restaurer cette version ?' })
			.getByRole('button', {
				name: 'Restaurer'
			})
			.click();
		await expect(page.locator('.cm-content')).toContainText('<script>alert("old")</script>');
		await expect
			.poll(() =>
				page.evaluate(
					(content) =>
						new Promise<boolean>((resolve) => {
							const request = indexedDB.open('mdsh');
							request.onsuccess = () => {
								const database = request.result;
								const rows = database.transaction('versions').objectStore('versions').getAll();
								rows.onsuccess = () => {
									database.close();
									resolve(rows.result.some((row) => row.content === content));
								};
							};
						}),
					currentContent
				)
			)
			.toBe(true);
	});

	test('treats an empty document as zero lines', async ({ page }, testInfo) => {
		await createFirstFile(page);
		const draft = await activeDraft(page);
		await seedVersion(page, draft, 'First stored line');

		await openCommand(page, 'Historique des versions');
		const history = page.getByRole('dialog', { name: /Historique des versions/ });
		await history
			.getByRole('list', { name: 'Versions disponibles' })
			.getByRole('button')
			.last()
			.click();
		await expect(history.locator('[data-diff-kind="add"]')).toContainText('First stored line');
		await expect(history.locator('[data-diff-kind="remove"]')).toHaveCount(0);
		await expect(history.getByRole('status')).toContainText(
			'1 ligne(s) ajoutée(s) et 0 supprimée(s).'
		);
		await attachEvidence(testInfo, page, 'empty-document-diff');
	});

	test('previews global replacement before it changes files', async ({ page }, testInfo) => {
		const firstContent = '# One\n\nalpha one';
		const secondContent = '# Two\n\nalpha two';
		await seedFiles(page, [
			{ name: 'One.md', content: firstContent },
			{ name: 'Two.md', content: secondContent }
		]);
		await openCommand(page, 'Recherche cross-fichiers');
		const search = page.getByRole('dialog', { name: 'Recherche cross-fichiers' });
		await search.getByRole('combobox').fill('alpha');
		await search.getByRole('button', { name: 'Afficher le remplacement cross-fichiers' }).click();
		await search.getByRole('textbox', { name: 'Texte de remplacement' }).fill('omega');
		await search.getByRole('button', { name: 'Remplacer tout' }).click();

		await expect(search.getByRole('heading', { name: 'Aperçu du remplacement' })).toBeVisible();
		await expect(search.locator('[data-diff-kind="remove"]')).toContainText('alpha');
		await expect(search.locator('[data-diff-kind="add"]')).toContainText('omega');
		await expect.poll(() => activeDraft(page).then((row) => row.content)).toContain('alpha');
		await attachEvidence(testInfo, page, 'replacement-preview');

		await search.getByRole('button', { name: 'Confirmer le remplacement' }).click();
		await expect(search).toHaveCount(0);
		await expect.poll(() => activeDraft(page).then((row) => row.content)).toContain('omega');
		await expect
			.poll(() => storedVersionContents(page))
			.toEqual(expect.arrayContaining([firstContent, secondContent]));
	});

	test('rejects a replacement preview after another tab changes a file', async ({
		page,
		context
	}, testInfo) => {
		await seedFiles(page, [
			{ name: 'One.md', content: '# One\n\nalpha one' },
			{ name: 'Two.md', content: '# Two\n\nalpha two' }
		]);
		await openCommand(page, 'Recherche cross-fichiers');
		const search = page.getByRole('dialog', { name: 'Recherche cross-fichiers' });
		await search.getByRole('combobox').fill('alpha');
		await search.getByRole('button', { name: 'Afficher le remplacement cross-fichiers' }).click();
		await search.getByRole('textbox', { name: 'Texte de remplacement' }).fill('omega');
		await search.getByRole('button', { name: 'Remplacer tout' }).click();
		await expect(search.getByRole('heading', { name: 'Aperçu du remplacement' })).toBeVisible();

		const otherTab = await context.newPage();
		await otherTab.goto('/');
		await otherTab.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
		await writeSourceContent(otherTab, '# Two\n\nalpha changed elsewhere');
		await page.waitForTimeout(500);

		await search.getByRole('button', { name: 'Confirmer le remplacement' }).click();
		await expect(search.getByRole('alert')).toContainText(
			'Un fichier de l’aperçu a changé. Créez un nouvel aperçu avant le remplacement.'
		);
		await expect(search.getByRole('heading', { name: 'Aperçu du remplacement' })).toHaveCount(0);
		await expect.poll(() => activeDraft(page).then((row) => row.content)).toContain('alpha');
		await attachEvidence(testInfo, page, 'replacement-preview-stale');
		await otherTab.close();
	});

	test('rejects a durable remote edit before its cross-tab message arrives', async ({
		page,
		context
	}, testInfo) => {
		await page.addInitScript(() => {
			const NativeBroadcastChannel = window.BroadcastChannel;
			if (!NativeBroadcastChannel) return;
			class DelayedBroadcastChannel {
				private channel: BroadcastChannel;
				onmessage: ((event: MessageEvent) => void) | null = null;

				constructor(name: string) {
					this.channel = new NativeBroadcastChannel(name);
					this.channel.onmessage = (event) => {
						window.setTimeout(() => this.onmessage?.(event), 10_000);
					};
				}

				postMessage(message: unknown): void {
					this.channel.postMessage(message);
				}

				close(): void {
					this.channel.close();
				}
			}
			Object.defineProperty(window, 'BroadcastChannel', {
				configurable: true,
				value: DelayedBroadcastChannel
			});
		});
		await resetAppState(page);
		await seedFiles(page, [{ name: 'Race.md', content: '# Race\n\nalpha original' }]);
		await openCommand(page, 'Recherche cross-fichiers');
		const search = page.getByRole('dialog', { name: 'Recherche cross-fichiers' });
		await search.getByRole('combobox').fill('alpha');
		await search.getByRole('button', { name: 'Afficher le remplacement cross-fichiers' }).click();
		await search.getByRole('textbox', { name: 'Texte de remplacement' }).fill('omega');
		await search.getByRole('button', { name: 'Remplacer tout' }).click();
		await expect(search.getByRole('heading', { name: 'Aperçu du remplacement' })).toBeVisible();

		const otherTab = await context.newPage();
		await otherTab.goto('/');
		await otherTab.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
		await writeSourceContent(otherTab, '# Race\n\nalpha durable remote');
		await expect(search.getByRole('heading', { name: 'Aperçu du remplacement' })).toBeVisible();

		await search.getByRole('button', { name: 'Confirmer le remplacement' }).click();
		await expect(search.getByRole('alert')).toContainText(
			'Un fichier de l’aperçu a changé. Créez un nouvel aperçu avant le remplacement.'
		);
		await expect
			.poll(() => activeDraft(otherTab).then((row) => row.content))
			.toContain('alpha durable remote');
		await attachEvidence(testInfo, page, 'replacement-preview-delayed-message');
		await otherTab.close();
	});

	test('bounds large diffs and remains keyboard responsive', async ({ page }, testInfo) => {
		await createFirstFile(page);
		const longCurrentLine = `current-${'c'.repeat(6_000)}`;
		const longStoredLine = `stored-${'s'.repeat(6_000)}`;
		const currentContent = [
			longCurrentLine,
			...Array.from({ length: 800 }, (_value, index) => `current line ${index}`)
		].join('\n');
		const storedContent = [
			longStoredLine,
			...Array.from({ length: 800 }, (_value, index) => `stored line ${index}`)
		].join('\n');
		await writeSourceContent(page, currentContent);
		const draft = await activeDraft(page);
		await seedVersion(page, draft, storedContent);

		await openCommand(page, 'Historique des versions');
		const history = page.getByRole('dialog', { name: /Historique des versions/ });
		await history
			.getByRole('list', { name: 'Versions disponibles' })
			.getByRole('button')
			.last()
			.click();
		await expect(
			history.getByText('Comparaison volumineuse. Les nombres sont approximatifs.')
		).toBeVisible({
			timeout: 2_000
		});
		await expect(history.locator('[data-diff-kind="skip"]')).toHaveText([/masquée/, /masquée/]);
		expect(await history.locator('.diff-line').count()).toBeLessThanOrEqual(500);
		const renderedLongLine = await history.locator('[data-diff-kind="add"]').first().textContent();
		expect(renderedLongLine?.length).toBeLessThan(2_100);
		await attachEvidence(testInfo, page, 'bounded-large-diff');

		await page.keyboard.press('Escape');
		await expect(history).toHaveCount(0, { timeout: 1_000 });
	});

	test('uses Escape to leave replacement preview before it closes search', async ({
		page
	}, testInfo) => {
		await seedFiles(page, [{ name: 'Escape.md', content: '# Escape\n\nalpha' }]);
		await openCommand(page, 'Recherche cross-fichiers');
		const search = page.getByRole('dialog', { name: 'Recherche cross-fichiers' });
		await search.getByRole('combobox').fill('alpha');
		await search.getByRole('button', { name: 'Afficher le remplacement cross-fichiers' }).click();
		await search.getByRole('textbox', { name: 'Texte de remplacement' }).fill('omega');
		await search.getByRole('button', { name: 'Remplacer tout' }).click();
		await expect(search.getByRole('heading', { name: 'Aperçu du remplacement' })).toBeVisible();

		await page.keyboard.press('Escape');
		await expect(search).toBeVisible();
		await expect(search.getByRole('heading', { name: 'Aperçu du remplacement' })).toHaveCount(0);
		await expect(search.getByRole('combobox')).toBeFocused();
		await attachEvidence(testInfo, page, 'replacement-preview-escape');

		await page.keyboard.press('Escape');
		await expect(search).toHaveCount(0);
	});
});

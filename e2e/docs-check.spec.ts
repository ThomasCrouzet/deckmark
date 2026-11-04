import { execSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { test, expect, type Download, type Page, type TestInfo } from '@playwright/test';
import { resetAppState } from './helpers';

const png = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
	'base64'
);

const fixtureDocuments: Record<string, string> = {
	'README.md': [
		'---',
		'title: Home',
		'---',
		'# Home',
		'',
		'[Broken link](notes/missing.md)',
		'',
		'![Missing image](assets/missing.png)',
		'',
		'## Duplicate',
		'',
		'## Duplicate',
		'',
		'[Missing anchor](#absent)',
		'',
		'[[alpha]]',
		''
	].join('\n'),
	'notes/guide.md': [
		'# Guide',
		'',
		'## Install',
		'',
		'[Broken anchor](../README.md#missing-anchor)',
		'',
		'![](../assets/present.png)',
		''
	].join('\n'),
	'notes/alpha.md': '# Alpha\n',
	'archive/alpha.md': '# Alpha archive\n',
	'notes/invalid.md': ['---', 'title: [broken', '---', '# Invalid', ''].join('\n')
};

async function projectFixture(): Promise<Buffer> {
	const zip = new (await import('jszip')).default();
	for (const [path, content] of Object.entries(fixtureDocuments)) zip.file(path, content);
	zip.file('assets/present.png', png);
	return zip.generateAsync({ type: 'nodebuffer' });
}

async function importProject(page: Page, buffer: Buffer): Promise<void> {
	await page.getByTestId('projects-open').click();
	const panel = page.getByRole('dialog', { name: 'Projets Markdown' });
	await panel
		.locator('input[type=file][accept=".zip"]')
		.setInputFiles({ name: 'docs-check-project.zip', mimeType: 'application/zip', buffer });
	await expect(panel.getByRole('button', { name: 'Vérifier la documentation' })).toBeVisible();
}

interface StoredDocument {
	id: string;
	content: string;
	updatedAt: number;
	relativePath?: string;
}

async function projectDocuments(page: Page): Promise<StoredDocument[]> {
	return page.evaluate(
		() =>
			new Promise<StoredDocument[]>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const transaction = database.transaction('drafts');
					const all = transaction.objectStore('drafts').getAll();
					transaction.oncomplete = () => {
						database.close();
						resolve(
							(all.result as StoredDocument[])
								.map(({ id, content, updatedAt, relativePath }) => ({
									id,
									content,
									updatedAt,
									...(relativePath === undefined ? {} : { relativePath })
								}))
								.sort((a, b) => (a.relativePath ?? '').localeCompare(b.relativePath ?? ''))
						);
					};
					transaction.onerror = () => reject(transaction.error);
				};
			})
	);
}

async function downloadReport(page: Page, testInfo: TestInfo, name: string): Promise<string> {
	const downloadPromise = page.waitForEvent('download');
	await page.getByTestId('docs-check-export').click();
	const download: Download = await downloadPromise;
	const path = testInfo.outputPath(name);
	await download.saveAs(path);
	return path;
}

test('documentation check reports issues, opens locations, and exports stable JSON', async ({
	page
}, testInfo) => {
	await resetAppState(page);
	const externalRequests: string[] = [];
	page.on('request', (request) => {
		const url = new URL(request.url());
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
		if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost')
			externalRequests.push(request.url());
	});

	const fixture = await projectFixture();
	await testInfo.attach('docs-check-project.zip', {
		body: fixture,
		contentType: 'application/zip'
	});
	await importProject(page, fixture);
	const before = await projectDocuments(page);

	await page.getByRole('button', { name: 'Vérifier la documentation', exact: true }).click();
	const panel = page.getByRole('dialog', { name: 'Vérifier la documentation' });
	await expect(panel).toBeVisible();
	await panel.getByRole('button', { name: 'Lancer la vérification' }).click();

	const issues = panel.locator('[data-docs-check-issue]');
	await expect(issues).toHaveCount(8, { timeout: 20_000 });
	await expect(panel.locator('[data-docs-check-summary]')).toContainText('5 document(s)');
	await expect(panel.locator('[data-docs-check-summary]')).toContainText('4 erreur(s)');
	await expect(panel.locator('[data-docs-check-summary]')).toContainText('4 avertissement(s)');

	const listed = await issues.evaluateAll((elements) =>
		elements.map((element) => ({
			code: element.getAttribute('data-code'),
			path: element.getAttribute('data-path'),
			line: element.getAttribute('data-line')
		}))
	);
	expect(listed).toEqual([
		{ code: 'link-missing', path: 'README.md', line: '6' },
		{ code: 'image-missing', path: 'README.md', line: '8' },
		{ code: 'heading-duplicate', path: 'README.md', line: '12' },
		{ code: 'anchor-missing', path: 'README.md', line: '14' },
		{ code: 'link-ambiguous', path: 'README.md', line: '16' },
		{ code: 'anchor-missing', path: 'notes/guide.md', line: '5' },
		{ code: 'image-alt-missing', path: 'notes/guide.md', line: '7' },
		{ code: 'frontmatter-invalid', path: 'notes/invalid.md', line: '1' }
	]);

	const firstReportPath = await downloadReport(page, testInfo, 'docs-check-report-first.json');
	const firstReport = await readFile(firstReportPath, 'utf8');

	await panel.getByRole('button', { name: 'Lancer la vérification' }).click();
	await expect(issues).toHaveCount(8);
	const secondReportPath = await downloadReport(page, testInfo, 'docs-check-report-second.json');
	const secondReport = await readFile(secondReportPath, 'utf8');
	expect(secondReport).toBe(firstReport);

	const parsed = JSON.parse(firstReport);
	expect(parsed).toMatchObject({
		schema: 'mdsh-docs-check/1',
		documents: 5,
		summary: { errors: 4, warnings: 4 }
	});
	expect(firstReport).not.toContain('generatedAt');
	expect(parsed.issues.map((issue: { code: string }) => issue.code)).toEqual(
		listed.map((issue) => issue.code)
	);

	const after = await projectDocuments(page);
	expect(after).toEqual(before);
	expect(externalRequests).toEqual([]);

	await panel
		.locator('[data-docs-check-issue][data-path="notes/guide.md"][data-code="anchor-missing"]')
		.click();
	await expect(panel).toBeHidden();
	await expect(page.locator('input[aria-label^="Nom du fichier"]')).toHaveValue('guide');
	await expect(page.locator('.cm-content').first()).toBeVisible();
	await expect(page.locator('.cm-activeLine')).toContainText('Broken anchor');

	const artifactPath = testInfo.outputPath('docs-check-artifact.json');
	await writeFile(
		artifactPath,
		`${JSON.stringify(
			{
				command:
					'npx playwright test e2e/docs-check.spec.ts --project=chromium --workers=1 --reporter=line',
				revision: execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim(),
				environment: { node: process.version, browser: 'chromium', locale: 'fr-FR' },
				fixtures: {
					archive: 'docs-check-project.zip',
					documents: Object.keys(fixtureDocuments),
					assets: ['assets/present.png']
				},
				result: {
					issues: listed.length,
					errors: parsed.summary.errors,
					warnings: parsed.summary.warnings,
					deterministic: secondReport === firstReport,
					opened: 'notes/guide.md:5',
					externalRequests,
					filesUnchanged: JSON.stringify(after) === JSON.stringify(before)
				}
			},
			null,
			2
		)}\n`,
		'utf8'
	);
	await testInfo.attach('docs-check-report.json', {
		path: firstReportPath,
		contentType: 'application/json'
	});
	await testInfo.attach('docs-check-artifact.json', {
		path: artifactPath,
		contentType: 'application/json'
	});
});

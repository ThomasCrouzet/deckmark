import { expect, test, type TestInfo } from '@playwright/test';
import { resetAppState } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

async function vaultZip(): Promise<Buffer> {
	const { default: JSZip } = await import('jszip');
	const zip = new JSZip();
	zip.file('.obsidian/app.json', '{"legacyEditor":false}');
	zip.file('MyVault/README.md', '# Vault\n\nSee [[Guide]].\n');
	zip.file('MyVault/Guide.md', '# Guide\n\n![logo](assets/logo.png)\n');
	zip.file('MyVault/assets/logo.png', Buffer.from('not-a-real-image'));
	zip.file('MyVault/Canvas.canvas', '{}');
	return zip.generateAsync({ type: 'nodebuffer' });
}

test('imports an Obsidian vault with a migration report', async ({ page }, info: TestInfo) => {
	await resetAppState(page);
	await page.getByTestId('projects-open').click();
	const dialog = page.getByRole('dialog');
	await expect(dialog).toBeVisible();
	const zip = await vaultZip();
	await dialog.locator('input[type="file"][accept=".zip"]').setInputFiles({
		name: 'vault.zip',
		mimeType: 'application/zip',
		buffer: zip
	});
	const report = page.getByTestId('migration-report');
	await expect(report).toBeVisible({ timeout: 20_000 });
	await expect(report).toContainText('obsidian');
	await expect(report).toContainText('2 document(s)');
	await expect(report).toContainText(/2 asset\(s\)|2 ressource\(s\)/);

	await page.keyboard.press('Escape');
	const imported = await page.evaluate(
		() =>
			new Promise<Array<{ relativePath?: string; content: string }>>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const rows = request.result.transaction('drafts').objectStore('drafts').getAll();
					rows.onerror = () => reject(rows.error);
					rows.onsuccess = () => {
						request.result.close();
						resolve(
							rows.result
								.filter((row) => row.projectId)
								.map((row) => ({ relativePath: row.relativePath, content: row.content }))
						);
					};
				};
			})
	);
	expect(imported.map((row) => row.relativePath)).toEqual(
		expect.arrayContaining(['README.md', 'Guide.md'])
	);
	expect(imported.find((row) => row.relativePath === 'Guide.md')?.content).toContain(
		'assets/logo.png'
	);
	expect(zip.length).toBeGreaterThan(0);

	await info.attach('vault-import.json', {
		body: JSON.stringify({ kind: 'obsidian', documents: 2, assets: 2, report: true }),
		contentType: 'application/json'
	});
	await info.attach('vault-import.png', { body: await page.screenshot() });
});

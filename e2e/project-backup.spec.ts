import { test, expect, type Download, type Page, type TestInfo } from '@playwright/test';
import { resetAppState } from './helpers';

const image = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
	'base64'
);

const legacyContent = '# Version 1.9\n\nComplete legacy content.\n';

interface StoredDraft {
	id: string;
	name: string;
	content: string;
	projectId?: string;
	relativePath?: string;
}

async function downloadBytes(download: Download): Promise<Buffer> {
	const stream = await download.createReadStream();
	const chunks: Buffer[] = [];
	for await (const chunk of stream!) chunks.push(chunk);
	return Buffer.concat(chunks);
}

async function projectFixture(): Promise<Buffer> {
	const zip = new (await import('jszip')).default();
	zip.file('README.md', '# Backup project\n\n![Exact image](assets/pixel.png)\n');
	zip.file('notes/guide.md', '# Guide\n\nPortable project document.\n');
	zip.file('assets/pixel.png', image);
	return zip.generateAsync({ type: 'nodebuffer' });
}

async function importProject(page: Page, bytes: Buffer): Promise<void> {
	await page.getByTestId('projects-open').click();
	const panel = page.getByRole('dialog', { name: 'Projets Markdown' });
	await panel.locator('input[type=file][accept=".zip"]').setInputFiles({
		name: 'backup-project.zip',
		mimeType: 'application/zip',
		buffer: bytes
	});
	await expect(panel.getByRole('button', { name: 'Ouvrir notes/guide.md' })).toBeVisible();
	await panel.getByRole('button', { name: 'Fermer les projets' }).click();
}

async function openSettings(page: Page): Promise<void> {
	await page.keyboard.press('ControlOrMeta+,');
	await expect(page.getByRole('dialog', { name: 'Réglages' })).toBeVisible();
}

async function exportBackup(page: Page, passphrase?: string): Promise<Buffer> {
	await openSettings(page);
	const downloadPromise = page.waitForEvent('download');
	if (passphrase === undefined) {
		await page.getByRole('button', { name: 'Exporter une sauvegarde', exact: true }).click();
	} else {
		await page.getByRole('button', { name: 'Exporter (chiffré)…', exact: true }).click();
		let prompt = page.getByRole('dialog', { name: 'Chiffrer la sauvegarde' });
		await prompt.locator('input[type=password]').fill(passphrase);
		await prompt.getByRole('button', { name: 'OK', exact: true }).click();
		prompt = page.getByRole('dialog', { name: 'Confirmer la phrase secrète' });
		await prompt.locator('input[type=password]').fill(passphrase);
		await prompt.getByRole('button', { name: 'OK', exact: true }).click();
	}
	return downloadBytes(await downloadPromise);
}

async function restoreBackup(
	page: Page,
	bytes: Buffer,
	name: string,
	passphrase?: string
): Promise<void> {
	await openSettings(page);
	await page.locator('input[type=file][accept*="json"]').setInputFiles({
		name,
		mimeType: 'application/json',
		buffer: bytes
	});
	if (passphrase !== undefined) {
		const prompt = page.getByRole('dialog', { name: 'Sauvegarde chiffrée' });
		await prompt.locator('input[type=password]').fill(passphrase);
		await prompt.getByRole('button', { name: 'OK', exact: true }).click();
	}
	const choice = page.getByRole('dialog', { name: 'Restaurer la sauvegarde' });
	await expect(choice).toContainText('1 projet');
	await expect(choice).toContainText('1 ressource');
	await choice.getByRole('button', { name: 'Remplacer', exact: true }).click();
	await expect(choice).toBeHidden();
	await expect(page.getByRole('status').filter({ hasText: 'Sauvegarde restaurée' })).toBeVisible();
	await page.keyboard.press('Escape');
}

async function exportProject(page: Page): Promise<Buffer> {
	await page.getByTestId('projects-open').click();
	const panel = page.getByRole('dialog', { name: 'Projets Markdown' });
	const downloadPromise = page.waitForEvent('download');
	await panel.getByRole('button', { name: 'Exporter le projet', exact: true }).click();
	return downloadBytes(await downloadPromise);
}

async function expectExactProjectImage(bytes: Buffer, testInfo: TestInfo, name: string) {
	await testInfo.attach(name, { body: bytes, contentType: 'application/zip' });
	const zip = await (await import('jszip')).default.loadAsync(bytes);
	expect(await zip.file('assets/pixel.png')!.async('nodebuffer')).toEqual(image);
	expect(await zip.file('notes/guide.md')!.async('string')).toContain('Portable project document.');
}

async function seedVersion5Database(page: Page) {
	return page.evaluate(
		() =>
			new Promise<Record<string, unknown>>((resolve, reject) => {
				const deletion = indexedDB.deleteDatabase('mdsh');
				deletion.onerror = () => reject(deletion.error);
				deletion.onblocked = () => reject(new Error('Version 5 database deletion was blocked'));
				deletion.onsuccess = () => {
					const request = indexedDB.open('mdsh', 50);
					request.onerror = () => reject(request.error);
					request.onupgradeneeded = () => {
						const database = request.result;
						const drafts = database.createObjectStore('drafts', { keyPath: 'id' });
						drafts.createIndex('updatedAt', 'updatedAt');
						drafts.createIndex('order', 'order');
						const trash = database.createObjectStore('trashed', { keyPath: 'id' });
						trash.createIndex('trashedAt', 'trashedAt');
						const workspaces = database.createObjectStore('workspaces', { keyPath: 'id' });
						workspaces.createIndex('updatedAt', 'updatedAt');
						const versions = database.createObjectStore('versions', { keyPath: 'id' });
						versions.createIndex('draftId', 'draftId');
						versions.createIndex('createdAt', 'createdAt');
						versions.createIndex('[draftId+createdAt]', ['draftId', 'createdAt']);
						const templates = database.createObjectStore('templates', { keyPath: 'id' });
						templates.createIndex('updatedAt', 'updatedAt');
						database.createObjectStore('metadata', { keyPath: 'key' });
					};
					request.onsuccess = () => {
						const database = request.result;
						const now = Date.now();
						const openDraft = {
							id: 'v5-open',
							name: 'open.md',
							content: '# Open version 5\n',
							createdAt: now - 5000,
							updatedAt: now - 4000,
							order: 0,
							open: true
						};
						const closedDraft = {
							id: 'v5-closed',
							name: 'closed.md',
							content: '# Closed version 5\n',
							createdAt: now - 5000,
							updatedAt: now - 3000,
							order: 1,
							open: false
						};
						const trashedDraft = {
							id: 'v5-trash',
							name: 'trash.md',
							content: '# Trash version 5\n',
							createdAt: now - 5000,
							updatedAt: now - 2000,
							order: 2,
							open: false
						};
						const workspace = {
							id: 'v5-workspace',
							name: 'Version 5 workspace',
							fileIds: [openDraft.id, closedDraft.id],
							activeId: openDraft.id,
							createdAt: now - 5000,
							updatedAt: now - 1000
						};
						const template = {
							id: 'v5-template',
							name: 'Version 5 template',
							content: '# Template version 5\n',
							builtin: false,
							createdAt: now - 5000,
							updatedAt: now - 1000
						};
						const version = {
							id: 'v5-version',
							draftId: openDraft.id,
							name: openDraft.name,
							content: '# Earlier version 5\n',
							createdAt: now - 4500
						};
						const metadata = { key: 'disk-link-epoch', value: 'version-5-epoch' };
						const tx = database.transaction(
							['drafts', 'trashed', 'workspaces', 'versions', 'templates', 'metadata'],
							'readwrite'
						);
						tx.objectStore('drafts').put(openDraft);
						tx.objectStore('drafts').put(closedDraft);
						tx.objectStore('trashed').put({
							id: trashedDraft.id,
							file: trashedDraft,
							order: trashedDraft.order,
							trashedAt: now
						});
						tx.objectStore('workspaces').put(workspace);
						tx.objectStore('versions').put(version);
						tx.objectStore('templates').put(template);
						tx.objectStore('metadata').put(metadata);
						tx.oncomplete = () => {
							database.close();
							resolve({
								openDraft,
								closedDraft,
								trashedDraft,
								workspace,
								template,
								version,
								metadata
							});
						};
						tx.onerror = () => reject(tx.error);
					};
				};
			})
	);
}

test.beforeEach(async ({ page }) => resetAppState(page));

test('migrates an exact IndexedDB version 5 database before importing a project', async ({
	page
}, testInfo) => {
	await page.route('**/api/__mdsh_e2e_v5_seed__', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'text/html',
			body: '<!doctype html><title>Seed</title>'
		})
	);
	await page.goto('/api/__mdsh_e2e_v5_seed__');
	const fixture = await seedVersion5Database(page);
	await page.unroute('**/api/__mdsh_e2e_v5_seed__');
	await page.goto('/');
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	const beforeProject = await page.evaluate(
		() =>
			new Promise<Record<string, unknown>>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const stores = ['drafts', 'trashed', 'workspaces', 'versions', 'templates', 'metadata'];
					const tx = database.transaction(stores);
					const reads = stores.map((store) => tx.objectStore(store).getAll());
					tx.oncomplete = () => {
						const result = Object.fromEntries(
							stores.map((store, index) => [store, reads[index]!.result])
						);
						database.close();
						resolve({ version: database.version, ...result });
					};
					tx.onerror = () => reject(tx.error);
				};
			})
	);
	expect(beforeProject.version).toBe(60);
	expect(beforeProject.drafts).toEqual(
		expect.arrayContaining([fixture.openDraft, fixture.closedDraft])
	);
	expect(beforeProject.drafts).toHaveLength(2);
	expect(beforeProject.trashed).toEqual([
		expect.objectContaining({ id: 'v5-trash', file: fixture.trashedDraft })
	]);
	expect(beforeProject.workspaces).toEqual([fixture.workspace]);
	expect(beforeProject.versions).toEqual([fixture.version]);
	expect(beforeProject.templates).toEqual(
		expect.arrayContaining([expect.objectContaining(fixture.template as Record<string, unknown>)])
	);
	expect(beforeProject.metadata).toEqual(expect.arrayContaining([fixture.metadata]));
	await importProject(page, await projectFixture());
	const migrated = await page.evaluate(
		() =>
			new Promise<Record<string, unknown>>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const tx = database.transaction(['drafts', 'projects', 'projectAssets']);
					const drafts = tx.objectStore('drafts').getAll();
					const projects = tx.objectStore('projects').getAll();
					const assets = tx.objectStore('projectAssets').getAll();
					tx.oncomplete = () => {
						const result = {
							drafts: drafts.result,
							projects: projects.result,
							assets: assets.result.map((asset) => ({
								...asset,
								data: Array.from(asset.data as Uint8Array)
							}))
						};
						database.close();
						resolve(result);
					};
					tx.onerror = () => reject(tx.error);
				};
			})
	);
	expect((migrated.drafts as StoredDraft[]).filter((draft) => draft.id.startsWith('v5-'))).toEqual(
		expect.arrayContaining([fixture.openDraft, fixture.closedDraft])
	);
	expect(migrated.projects).toEqual([expect.objectContaining({ name: 'backup-project' })]);
	expect(migrated.assets).toEqual([
		expect.objectContaining({ path: 'assets/pixel.png', data: Array.from(image) })
	]);
	await testInfo.attach('indexeddb-v5-to-v6.json', {
		body: JSON.stringify({ fixture, beforeProject, migrated }, null, 2),
		contentType: 'application/json'
	});
});

test('restores a complete version 1.9 schema 1 backup', async ({ page }, testInfo) => {
	const backup = Buffer.from(
		JSON.stringify({
			format: 'mdsh-backup',
			schemaVersion: 1,
			exportedAt: 1_725_000_000_000,
			drafts: [
				{
					id: 'legacy-1-9',
					name: 'legacy.md',
					content: legacyContent,
					createdAt: 1_725_000_000_000,
					updatedAt: 1_725_000_000_100,
					order: 0
				}
			],
			workspaces: [],
			templates: []
		})
	);
	await testInfo.attach('mdsh-1.9-schema-1.json', {
		body: backup,
		contentType: 'application/json'
	});
	await openSettings(page);
	await page.locator('input[type=file][accept*="json"]').setInputFiles({
		name: 'mdsh-1.9.json',
		mimeType: 'application/json',
		buffer: backup
	});
	await page
		.getByRole('dialog', { name: 'Restaurer la sauvegarde' })
		.getByRole('button', { name: 'Remplacer', exact: true })
		.click();
	await page.keyboard.press('Escape');
	await expect(page.locator('input[aria-label^="Nom du fichier"]')).toHaveValue('legacy');
	await expect
		.poll(() => page.locator('.cm-line').allTextContents())
		.toEqual(['# Version 1.9', '', 'Complete legacy content.', '']);
});

test('round-trips a plaintext project backup with exact image bytes', async ({
	page
}, testInfo) => {
	const fixture = await projectFixture();
	await testInfo.attach('project-input.zip', { body: fixture, contentType: 'application/zip' });
	await importProject(page, fixture);
	await page.evaluate(async () => {
		const database = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open('mdsh');
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		const tx = database.transaction('projects', 'readwrite');
		const store = tx.objectStore('projects');
		const projects = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
			const request = store.getAll();
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		store.put({ ...projects[0], nativeRootId: 'must-not-export' });
		await new Promise<void>((resolve, reject) => {
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
		database.close();
	});
	const exported = await exportBackup(page);
	await testInfo.attach('project-backup.json', {
		body: exported,
		contentType: 'application/json'
	});
	const parsed = JSON.parse(exported.toString('utf8'));
	expect(parsed.schemaVersion).toBe(2);
	expect(parsed.projects).toHaveLength(1);
	expect(parsed.projectAssets).toHaveLength(1);
	expect(parsed.projects[0]).not.toHaveProperty('nativeRootId');
	expect(Buffer.from(parsed.projectAssets[0].data, 'base64')).toEqual(image);
	expect(
		parsed.drafts.map((draft: { relativePath?: string }) => draft.relativePath).sort()
	).toEqual(['README.md', 'notes/guide.md']);
	await resetAppState(page);
	await page.evaluate(
		(projectId: string) =>
			new Promise<void>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const tx = database.transaction('metadata', 'readwrite');
					const metadata = tx.objectStore('metadata');
					metadata.put({ key: 'disk-link-epoch', value: 'stale-authority' });
					metadata.put({
						key: `project-native-revisions:${projectId}`,
						value: '{"stale":true}'
					});
					tx.oncomplete = () => {
						database.close();
						resolve();
					};
					tx.onerror = () => reject(tx.error);
				};
			}),
		parsed.projects[0].id
	);
	await restoreBackup(page, exported, 'project-backup.json');
	const metadata = await page.evaluate(
		() =>
			new Promise<Array<{ key: string; value: string }>>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const tx = database.transaction('metadata');
					const rows = tx.objectStore('metadata').getAll();
					tx.oncomplete = () => {
						database.close();
						resolve(rows.result);
					};
					tx.onerror = () => reject(tx.error);
				};
			})
	);
	expect(metadata.some((row) => row.key.startsWith('project-native-revisions:'))).toBe(false);
	expect(metadata.find((row) => row.key === 'disk-link-epoch')?.value).not.toBe('stale-authority');
	await expectExactProjectImage(await exportProject(page), testInfo, 'restored-project.zip');
});

test('round-trips an encrypted project backup with exact image bytes', async ({
	page
}, testInfo) => {
	const fixture = await projectFixture();
	await importProject(page, fixture);
	const encrypted = await exportBackup(page, 'project-backup-passphrase');
	await testInfo.attach('project-backup.enc.json', {
		body: encrypted,
		contentType: 'application/json'
	});
	expect(encrypted.toString('utf8')).not.toContain('Backup project');
	await resetAppState(page);
	await restoreBackup(page, encrypted, 'project-backup.enc.json', 'project-backup-passphrase');
	await expectExactProjectImage(
		await exportProject(page),
		testInfo,
		'restored-encrypted-project.zip'
	);
});

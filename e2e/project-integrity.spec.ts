import { test, expect, type Download, type Page, type TestInfo } from '@playwright/test';
import { resetAppState, writeSourceContent } from './helpers';

const image = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
	'base64'
);
const externalBranch = '# External durable branch\n\n![Exact image](../assets/pixel.png)\n';

interface StoredDraft {
	id: string;
	name: string;
	content: string;
	projectId?: string;
	relativePath?: string;
	createdAt: number;
	updatedAt: number;
	order: number;
	open?: boolean;
}

interface ProjectState {
	drafts: StoredDraft[];
	trash: Array<{ id: string; file: StoredDraft }>;
}

async function projectFixture(): Promise<Buffer> {
	const zip = new (await import('jszip')).default();
	zip.file('README.md', '# Integrity project\n\n![Exact image](assets/pixel.png)\n');
	zip.file(
		'notes/guide.md',
		'# Guide\n\nOriginal project content.\n\n![Exact image](../assets/pixel.png)\n'
	);
	zip.file('assets/pixel.png', image);
	return zip.generateAsync({ type: 'nodebuffer' });
}

async function importAndOpenGuide(page: Page): Promise<void> {
	await page.getByTestId('projects-open').click();
	const panel = page.getByRole('dialog', { name: 'Projets Markdown' });
	await panel.locator('input[type=file][accept=".zip"]').setInputFiles({
		name: 'integrity-project.zip',
		mimeType: 'application/zip',
		buffer: await projectFixture()
	});
	await panel.getByRole('button', { name: 'Ouvrir notes/guide.md' }).click();
	await expect(page.locator('.cm-content')).toContainText('Original project content.');
}

async function projectState(page: Page): Promise<ProjectState> {
	return page.evaluate(
		() =>
			new Promise<ProjectState>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const tx = database.transaction(['drafts', 'trashed']);
					const drafts = tx.objectStore('drafts').getAll();
					const trash = tx.objectStore('trashed').getAll();
					tx.oncomplete = () => {
						database.close();
						resolve({ drafts: drafts.result, trash: trash.result });
					};
					tx.onerror = () => reject(tx.error);
				};
			})
	);
}

async function trashActiveDocument(page: Page): Promise<void> {
	await page.locator('aside summary').filter({ hasText: 'Actions du document' }).click();
	await page
		.locator('aside')
		.getByRole('button', { name: 'Déplacer le document dans la corbeille', exact: true })
		.click();
	await page
		.getByRole('dialog', { name: 'Déplacer ce document dans la corbeille ?', exact: true })
		.getByRole('button', { name: 'Confirmer', exact: true })
		.click();
	await expect.poll(async () => (await projectState(page)).trash.length).toBe(1);
}

async function restoreGuide(page: Page): Promise<void> {
	const trash = page
		.locator('aside details')
		.filter({ has: page.locator('summary', { hasText: /^Corbeille/ }) });
	await trash.locator('summary').click();
	await trash.getByRole('button', { name: 'Restaurer guide.md', exact: true }).click();
	await expect.poll(async () => (await projectState(page)).trash.length).toBe(0);
}

async function downloadBytes(download: Download): Promise<Buffer> {
	const stream = await download.createReadStream();
	const chunks: Buffer[] = [];
	for await (const chunk of stream!) chunks.push(chunk);
	return Buffer.concat(chunks);
}

async function exportProject(page: Page, testInfo: TestInfo, name: string) {
	await page.getByTestId('projects-open').click();
	const panel = page.getByRole('dialog', { name: 'Projets Markdown' });
	const exportButton = panel.getByRole('button', { name: 'Exporter le projet', exact: true });
	await expect(exportButton).toBeEnabled({ timeout: 20_000 });
	const pending = page.waitForEvent('download');
	await exportButton.click();
	const bytes = await downloadBytes(await pending);
	await testInfo.attach(name, { body: bytes, contentType: 'application/zip' });
	return (await import('jszip')).default.loadAsync(bytes);
}

test.beforeEach(async ({ page }) => resetAppState(page));

test('restores a project document with its path and exact asset after reload', async ({
	page
}, testInfo) => {
	await importAndOpenGuide(page);
	await trashActiveDocument(page);
	await page.reload();
	await restoreGuide(page);
	const state = await projectState(page);
	const restored = state.drafts.find((draft) =>
		draft.content.includes('Original project content.')
	);
	expect(restored).toMatchObject({ relativePath: 'notes/guide.md' });
	expect(restored?.projectId).toBeTruthy();
	const zip = await exportProject(page, testInfo, 'trash-restored-project.zip');
	expect(await zip.file('notes/guide.md')!.async('string')).toContain('Original project content.');
	expect(await zip.file('assets/pixel.png')!.async('nodebuffer')).toEqual(image);
});

test('keeps a durable rename when a queued save preserves a conflict branch', async ({
	page
}, testInfo) => {
	await importAndOpenGuide(page);
	await page.evaluate(
		(externalContent) =>
			new Promise<void>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const tx = database.transaction('drafts', 'readwrite');
					const store = tx.objectStore('drafts');
					const index = store.index('projectId');
					const rows = index.getAll();
					rows.onsuccess = () => {
						const guide = rows.result.find(
							(row: StoredDraft) => row.relativePath === 'notes/guide.md'
						) as StoredDraft;
						store.put({
							...guide,
							name: 'renamed.md',
							relativePath: 'notes/renamed.md',
							content: externalContent,
							updatedAt: guide.updatedAt + 1
						});
					};
					tx.oncomplete = () => {
						database.close();
						resolve();
					};
					tx.onabort = () => reject(tx.error);
					rows.onerror = () => reject(rows.error);
				};
			}),
		externalBranch
	);
	await writeSourceContent(page, '# Local editor branch\n');
	const state = await projectState(page);
	await testInfo.attach('renamed-conflict-state.json', {
		body: JSON.stringify(state, null, 2),
		contentType: 'application/json'
	});
	const projectRows = state.drafts.filter((draft) => draft.projectId);
	expect(projectRows).toHaveLength(3);
	const renamed = projectRows.find((draft) => draft.relativePath === 'notes/renamed.md');
	expect(renamed?.content).toBe('# Local editor branch\n');
	expect(projectRows.filter((draft) => draft.relativePath === 'notes/renamed.md')).toHaveLength(1);
	const preserved = state.drafts.find((draft) => draft.content === externalBranch);
	expect(preserved?.projectId).toBe(renamed?.projectId);
	expect(preserved?.relativePath).toBe('notes/renamed (2).md');
	const zip = await exportProject(page, testInfo, 'renamed-conflict-project.zip');
	expect(zip.file('notes/guide.md')).toBeNull();
	expect(await zip.file('notes/renamed.md')!.async('string')).toBe('# Local editor branch\n');
	expect(await zip.file('notes/renamed (2).md')!.async('string')).toBe(externalBranch);
	expect(await zip.file('assets/pixel.png')!.async('nodebuffer')).toEqual(image);
});

test('assigns a sibling path when the restored project path is occupied', async ({
	page
}, testInfo) => {
	await importAndOpenGuide(page);
	await trashActiveDocument(page);
	await page.evaluate(
		() =>
			new Promise<void>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const tx = database.transaction(['drafts', 'trashed'], 'readwrite');
					const draftStore = tx.objectStore('drafts');
					const trashed = tx.objectStore('trashed').getAll();
					trashed.onsuccess = () => {
						const source = trashed.result[0].file as StoredDraft;
						draftStore.put({
							...source,
							id: 'replacement-guide',
							content: '# Replacement at the project path\n',
							open: false
						});
					};
					tx.oncomplete = () => {
						database.close();
						resolve();
					};
					tx.onerror = () => reject(tx.error);
				};
			})
	);
	await page.reload();
	await restoreGuide(page);
	await page.reload();
	const state = await projectState(page);
	await testInfo.attach('restore-collision-state.json', {
		body: JSON.stringify(state, null, 2),
		contentType: 'application/json'
	});
	const projectPaths = state.drafts
		.filter((draft) => draft.projectId)
		.map((draft) => draft.relativePath);
	expect(projectPaths.filter((path) => path === 'notes/guide.md')).toHaveLength(1);
	const restored = state.drafts.find((draft) =>
		draft.content.includes('Original project content.')
	);
	expect(restored?.projectId).toBeTruthy();
	expect(restored?.relativePath).toBe('notes/guide (2).md');
	const zip = await exportProject(page, testInfo, 'restore-collision-project.zip');
	expect(await zip.file('notes/guide.md')!.async('string')).toBe(
		'# Replacement at the project path\n'
	);
	expect(await zip.file('notes/guide (2).md')!.async('string')).toContain(
		'Original project content.'
	);
	expect(await zip.file('assets/pixel.png')!.async('nodebuffer')).toEqual(image);
});

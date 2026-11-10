import { test, expect, type Page } from '@playwright/test';
import { resetAppState, writeSourceContent, openPalette } from './helpers';
import { createPwaUpdateServer } from './pwa-update-server';

const offlineProjectTest = test.extend<{
	originServer: { origin: string; close: () => Promise<void> };
}>({
	// Playwright requires destructuring for a fixture without dependencies.
	// eslint-disable-next-line no-empty-pattern
	originServer: async ({}, use) => {
		const server = await createPwaUpdateServer('build');
		let closed = false;
		const close = async () => {
			if (closed) return;
			await server.close();
			closed = true;
		};
		try {
			await use({ origin: server.origin, close });
		} finally {
			await close();
		}
	},
	baseURL: async ({ originServer }, use) => use(originServer.origin)
});

const image = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
	'base64'
);
const pdf = Buffer.from('%PDF-1.4\n% Typed project PDF\n%%EOF\n');

interface StoredProject {
	id: string;
	name: string;
}

interface StoredProjectDraft {
	id: string;
	projectId?: string;
	relativePath?: string;
	kind?: string;
	mime?: string;
	data?: string;
	content: string;
}

interface StoredProjectAsset {
	id: string;
	projectId: string;
	path: string;
	mime: string;
}

interface StoredProjectState {
	projects: StoredProject[];
	drafts: StoredProjectDraft[];
	assets: StoredProjectAsset[];
}

async function readProjectState(page: Page): Promise<StoredProjectState> {
	return page.evaluate(
		() =>
			new Promise<StoredProjectState>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const tx = database.transaction(['projects', 'drafts', 'projectAssets']);
					const projects = tx.objectStore('projects').getAll();
					const drafts = tx.objectStore('drafts').getAll();
					const assets = tx.objectStore('projectAssets').getAll();
					tx.oncomplete = () => {
						database.close();
						resolve({
							projects: projects.result,
							drafts: drafts.result,
							assets: assets.result
						});
					};
					tx.onerror = () => reject(tx.error);
				};
			})
	);
}

async function downloadArchive(page: Page, name: string, projectName?: string) {
	const panel = await openProjects(page);
	if (projectName) await panel.locator('select').selectOption({ label: projectName });
	const pending = page.waitForEvent('download');
	await panel.getByRole('button', { name: 'Exporter le projet', exact: true }).click();
	const stream = await (await pending).createReadStream();
	const chunks: Buffer[] = [];
	for await (const chunk of stream!) chunks.push(chunk);
	const bytes = Buffer.concat(chunks);
	return { bytes, zip: await (await import('jszip')).default.loadAsync(bytes), name };
}

async function openProjects(page: Page) {
	const dialog = page.getByRole('dialog', { name: 'Projets Markdown' });
	if (await dialog.isVisible().catch(() => false)) return dialog;
	await page.getByTestId('projects-open').click();
	return dialog;
}

async function importArchive(page: Page, data: Buffer, name = 'Handbook.zip') {
	const panel = await openProjects(page);
	await panel.locator('input[type=file][accept=".zip"]').setInputFiles({
		name,
		mimeType: 'application/zip',
		buffer: data
	});
	return panel;
}

async function projectFixture() {
	const zip = new (await import('jszip')).default();
	zip.file(
		'README.md',
		'# Handbook\n\n[Guide](notes/README.md#details)\n\n[[notes/README|Wiki guide]]\n\n![Cover](assets/pixel.png)\n'
	);
	zip.file(
		'notes/README.md',
		'# Details\n\n[Home](../README.md)\n\n![Pixel](../assets/pixel.png)\n'
	);
	zip.file('assets/pixel.png', image);
	return zip.generateAsync({ type: 'nodebuffer' });
}

test.beforeEach(async ({ page }) => resetAppState(page));

offlineProjectTest(
	'project archives retain paths, local images, links, edits, and a rename',
	async ({ page, browserName, originServer }, info) => {
		const fixture = await projectFixture();
		await info.attach('project-input.zip', { body: fixture, contentType: 'application/zip' });
		let panel = await importArchive(page, fixture);
		await panel
			.locator('summary')
			.filter({ hasText: /^notes$/ })
			.click();
		await expect(
			panel.getByRole('button', { name: 'Ouvrir notes/README.md', exact: true })
		).not.toBeVisible();
		await panel
			.locator('summary')
			.filter({ hasText: /^notes$/ })
			.click();
		await panel.getByRole('button', { name: 'Ouvrir notes/README.md', exact: true }).click();
		await page.locator('[data-mode=read]').click();
		await expect(page.locator('.mdsh-preview img')).toBeVisible();
		await expect
			.poll(() =>
				page.locator('.mdsh-preview img').evaluate((img: HTMLImageElement) => img.naturalWidth)
			)
			.toBe(1);
		await page.locator('.mdsh-preview a').filter({ hasText: 'Home' }).click();
		await expect(page.locator('.mdsh-preview h1')).toHaveText('Handbook');
		await page.locator('.mdsh-preview a').filter({ hasText: 'Wiki guide' }).click();
		await expect(page.locator('.mdsh-preview h1')).toHaveText('Details');
		await page.locator('.mdsh-preview a').filter({ hasText: 'Home' }).click();
		await page.locator('.mdsh-preview').getByRole('link', { name: 'Guide', exact: true }).click();
		await expect(page.locator('.mdsh-preview h1')).toHaveText('Details');
		await writeSourceContent(
			page,
			'# Details\n\nEdited offline.\n\n[Home](../README.md)\n\n![Pixel](../assets/pixel.png)\n'
		);
		await page.locator('#app-toolbar input').fill('guide');
		await page.locator('#app-toolbar input').press('Enter');
		await expect(page.locator('#app-toolbar input')).toBeEnabled();
		await expect(
			page.locator('.mdsh-file-row').getByRole('button', { name: /^guide - / })
		).toBeVisible();
		await page.reload();
		panel = await openProjects(page);
		await expect(
			panel.getByRole('button', { name: 'Ouvrir notes/guide.md', exact: true })
		).toBeVisible();
		const download = page.waitForEvent('download');
		await panel.getByRole('button', { name: 'Exporter le projet', exact: true }).click();
		const stream = await (await download).createReadStream();
		const parts: Buffer[] = [];
		for await (const part of stream!) parts.push(part);
		const bytes = Buffer.concat(parts);
		await info.attach('project-output.zip', { body: bytes, contentType: 'application/zip' });
		const zip = await (await import('jszip')).default.loadAsync(bytes);
		expect(await zip.file('README.md')!.async('string')).toContain('(notes/guide.md#details)');
		expect(await zip.file('README.md')!.async('string')).toContain('[[notes/guide|Wiki guide]]');
		expect(await zip.file('notes/guide.md')!.async('string')).toContain('Edited offline.');
		expect(await zip.file('assets/pixel.png')!.async('nodebuffer')).toEqual(image);
		expect(JSON.parse(await zip.file('.mdsh/link-report.json')!.async('string')).issues).toEqual(
			[]
		);
		await panel.getByRole('button', { name: 'Fermer les projets' }).click();
		await openPalette(page);
		await page.getByRole('combobox').fill('Exporter tous les fichiers (ZIP)');
		const libraryDownload = page.waitForEvent('download');
		await page.keyboard.press('Enter');
		const libraryParts: Buffer[] = [];
		for await (const part of (await (await libraryDownload).createReadStream())!)
			libraryParts.push(part);
		const libraryBytes = Buffer.concat(libraryParts);
		await info.attach('library-with-project.zip', {
			body: libraryBytes,
			contentType: 'application/zip'
		});
		const libraryZip = await (await import('jszip')).default.loadAsync(libraryBytes);
		const nested = await (
			await import('jszip')
		).default.loadAsync(await libraryZip.file('Handbook.zip')!.async('nodebuffer'));
		expect(await nested.file('notes/guide.md')!.async('string')).toContain('Edited offline.');
		expect(await nested.file('assets/pixel.png')!.async('nodebuffer')).toEqual(image);
		await resetAppState(page);
		panel = await importArchive(page, bytes);
		await expect(
			panel.getByRole('button', { name: 'Ouvrir notes/guide.md', exact: true })
		).toBeVisible();
		await panel.getByRole('button', { name: 'Ouvrir notes/guide.md', exact: true }).click();
		await expect(page.locator('#app-toolbar input')).toHaveValue('guide');
		// Wait for the reopened tab state to reach storage before reloading.
		await expect(page.locator('#app-statusbar')).toContainText('Brouillons locaux :');
		await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
		await page.reload();
		await expect
			.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
			.toBe(true);
		await expect(page.locator('.mdsh-shell[aria-busy="false"]:not([inert])')).toBeVisible();
		await expect(page.locator('#app-toolbar input')).toHaveValue('guide');
		// WebKit offline emulation rejects service worker responses in Playwright 1.62.
		// Stop the real origin to check cached modules without that emulation defect.
		if (browserName === 'webkit') {
			await originServer.close();
			await expect(page.request.get(originServer.origin, { timeout: 1000 })).rejects.toThrow();
		} else await page.context().setOffline(true);
		await info.attach('project-offline-condition.json', {
			body: JSON.stringify({
				browserName,
				disruption: browserName === 'webkit' ? 'origin-stopped' : 'browser-offline',
				controlled: await page.evaluate(() => Boolean(navigator.serviceWorker.controller))
			}),
			contentType: 'application/json'
		});
		await page.locator('[data-mode=read]').click();
		await expect(page.locator('.mdsh-preview')).toContainText('Edited offline.');
		await expect
			.poll(() =>
				page.locator('.mdsh-preview img').evaluate((img: HTMLImageElement) => img.naturalWidth)
			)
			.toBe(1);
		await info.attach('project-offline.png', {
			body: await page.screenshot(),
			contentType: 'image/png'
		});
	}
);

test('unsafe archive paths fail before any project is stored', async ({ page }, info) => {
	const zip = new (await import('jszip')).default();
	zip.file('../outside.md', 'Must not import');
	zip.file('safe.md', 'Must not partially import');
	const bytes = await zip.generateAsync({ type: 'nodebuffer' });
	const panel = await importArchive(page, bytes, 'unsafe.zip');
	await expect(panel.getByRole('alert')).toBeVisible();
	await expect(panel.locator('[data-project-document]')).toHaveCount(0);
	await info.attach('unsafe-archive-result.png', {
		body: await page.screenshot(),
		contentType: 'image/png'
	});
});

test('link reports identify missing assets without contacting their host', async ({
	page
}, info) => {
	const zip = new (await import('jszip')).default();
	zip.file(
		'notes/start.md',
		'# Start\n\n![Missing](../assets/missing.png)\n\n[Lost](lost.md)\n\n![Remote](https://example.invalid/track.png)'
	);
	const requests: string[] = [];
	page.on('request', (request) => {
		if (request.url().includes('example.invalid')) requests.push(request.url());
	});
	const panel = await importArchive(page, await zip.generateAsync({ type: 'nodebuffer' }));
	await panel.getByRole('button', { name: 'Vérifier les liens', exact: true }).click();
	await expect(panel.locator('[data-project-link-report]')).toContainText('assets/missing.png');
	await expect(panel.locator('[data-project-link-report]')).toContainText('lost.md');
	await panel.getByRole('button', { name: 'Ouvrir notes/start.md', exact: true }).click();
	await page.locator('[data-mode=read]').click();
	await expect(page.locator('.mdsh-preview h1')).toHaveText('Start');
	expect(requests).toEqual([]);
	await info.attach('link-requests.json', {
		body: JSON.stringify(requests),
		contentType: 'application/json'
	});
});

test('same-document project links scroll to their heading', async ({ page }, info) => {
	const zip = new (await import('jszip')).default();
	zip.file(
		'index.md',
		`# Navigation\n\n[Go to end](index.md#destination)\n\n${'Paragraph with enough space.\n\n'.repeat(60)}## Destination\n`
	);
	const panel = await importArchive(page, await zip.generateAsync({ type: 'nodebuffer' }));
	await panel.getByRole('button', { name: 'Ouvrir index.md', exact: true }).click();
	await expect(page.locator('.mdsh-toc-col nav')).toBeVisible();
	// Capture the first painted link before the outline can change its position.
	const [firstPosition] = await Promise.all([
		page.evaluate(
			() =>
				new Promise<{ x: number; y: number }>((resolve, reject) => {
					const started = performance.now();
					function capture() {
						const link = document.querySelector<HTMLAnchorElement>(
							'.mdsh-preview a[href="index.md#destination"]'
						);
						const rectangle = link?.getBoundingClientRect();
						if (rectangle?.width && rectangle.height) {
							resolve({ x: rectangle.x, y: rectangle.y });
							return;
						}
						if (performance.now() - started > 5000) {
							reject(new Error('The rendered project link did not appear'));
							return;
						}
						requestAnimationFrame(capture);
					}
					requestAnimationFrame(capture);
				})
		),
		page.locator('[data-mode=read]').click()
	]);
	await expect(page.locator('.mdsh-toc-col nav button')).toHaveCount(2);
	const link = page.locator('.mdsh-preview').getByRole('link', { name: 'Go to end' });
	const settledPosition = await link.boundingBox();
	await info.attach('project-link-layout.json', {
		body: JSON.stringify({ firstPosition, settledPosition }),
		contentType: 'application/json'
	});
	expect(settledPosition).not.toBeNull();
	expect(settledPosition!.x).toBeCloseTo(firstPosition.x, 0);
	expect(settledPosition!.y).toBeCloseTo(firstPosition.y, 0);
	await link.click();
	await expect(page.locator('.mdsh-preview #destination')).toBeInViewport();
	await info.attach('project-heading.png', {
		body: await page.screenshot(),
		contentType: 'image/png'
	});
});

test('typed image and PDF documents keep their bytes and project name through ZIP', async ({
	page
}, info) => {
	const source = new (await import('jszip')).default();
	source.file('README.md', '# Typed project\n\n[![Pixel](assets/pixel.png)](assets/pixel.png)\n');
	source.file('assets/pixel.png', image);
	const imported = await importArchive(
		page,
		await source.generateAsync({ type: 'nodebuffer' }),
		'typed-source.zip'
	);
	await expect(imported.getByRole('button', { name: 'Ouvrir README.md' })).toBeVisible();
	let state = await readProjectState(page);
	const project = state.projects.find((entry) => entry.name === 'typed-source');
	expect(project).toBeTruthy();
	expect(state.assets.filter((asset) => asset.projectId === project!.id)).toMatchObject([
		{ path: 'assets/pixel.png', mime: 'image/png' }
	]);
	const pngUrl = `data:image/png;base64,${image.toString('base64')}`;
	const pdfUrl = `data:application/pdf;base64,${pdf.toString('base64')}`;
	await page.evaluate(
		async ({ projectId, pngUrl, pdfUrl }) => {
			await new Promise<void>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const tx = database.transaction('drafts', 'readwrite');
					const store = tx.objectStore('drafts');
					const now = Date.now();
					store.add({
						id: 'typed-image',
						name: 'photo.png',
						content: '',
						projectId,
						relativePath: 'photo.png',
						createdAt: now,
						updatedAt: now,
						order: 1,
						open: false,
						kind: 'image',
						mime: 'image/png',
						data: pngUrl
					});
					store.add({
						id: 'typed-pdf',
						name: 'manual.pdf',
						content: '',
						projectId,
						relativePath: 'manual.pdf',
						createdAt: now,
						updatedAt: now,
						order: 2,
						open: false,
						kind: 'pdf',
						mime: 'application/pdf',
						data: pdfUrl
					});
					tx.oncomplete = () => {
						database.close();
						resolve();
					};
					tx.onerror = () => reject(tx.error);
				};
			});
		},
		{ projectId: project!.id, pngUrl, pdfUrl }
	);
	await page.reload();
	const exported = await downloadArchive(page, 'typed-export.zip', 'typed-source');
	await info.attach('typed-project.zip', {
		body: exported.bytes,
		contentType: 'application/zip'
	});
	const manifest = JSON.parse(await exported.zip.file('.mdsh/project.json')!.async('string'));
	expect(manifest).toMatchObject({
		format: 'mdsh-project',
		schemaVersion: 2,
		name: 'typed-source'
	});
	expect(manifest.documents).toEqual(
		expect.arrayContaining([
			{ path: 'README.md', kind: 'note' },
			{ path: 'photo.png', kind: 'image', mime: 'image/png' },
			{ path: 'manual.pdf', kind: 'pdf', mime: 'application/pdf' }
		])
	);
	expect(await exported.zip.file('photo.png')!.async('nodebuffer')).toEqual(image);
	expect(await exported.zip.file('manual.pdf')!.async('nodebuffer')).toEqual(pdf);

	const importedAgain = await importArchive(page, exported.bytes, 'renamed-backup.zip');
	await expect(importedAgain.locator('[data-project-document="photo.png"]')).toBeVisible();
	state = await readProjectState(page);
	const restored = state.projects.find(
		(entry) => entry.name === 'typed-source' && entry.id !== project!.id
	);
	expect(restored).toBeTruthy();
	const restoredDrafts = state.drafts.filter((draft) => draft.projectId === restored!.id);
	expect(restoredDrafts.find((draft) => draft.relativePath === 'photo.png')).toMatchObject({
		kind: 'image',
		mime: 'image/png',
		data: pngUrl
	});
	expect(restoredDrafts.find((draft) => draft.relativePath === 'manual.pdf')).toMatchObject({
		kind: 'pdf',
		mime: 'application/pdf',
		data: pdfUrl
	});
	expect(
		state.assets.filter(
			(asset) =>
				asset.projectId === restored!.id &&
				(asset.path === 'photo.png' || asset.path === 'manual.pdf')
		)
	).toEqual([]);
	expect(state.assets.find((asset) => asset.projectId === restored!.id)).toMatchObject({
		path: 'assets/pixel.png',
		mime: 'image/png'
	});
	await expect(importedAgain.locator('[data-project-document="photo.png"]')).toBeVisible();
	await importedAgain.locator('[data-project-document="photo.png"] button').click();
	await expect(page.locator('[data-testid="document-kind"]')).toHaveText('Image');
	const reexported = await downloadArchive(page, 'typed-reexport.zip');
	expect(JSON.parse(await reexported.zip.file('.mdsh/project.json')!.async('string')).name).toBe(
		'typed-source'
	);
	expect(await reexported.zip.file('photo.png')!.async('nodebuffer')).toEqual(image);
	expect(await reexported.zip.file('manual.pdf')!.async('nodebuffer')).toEqual(pdf);
	await info.attach('typed-roundtrip-observations.json', {
		body: JSON.stringify(
			{
				projectName: restored!.name,
				drafts: restoredDrafts.map((draft) => ({
					relativePath: draft.relativePath,
					kind: draft.kind,
					mime: draft.mime
				})),
				assets: state.assets
					.filter((asset) => asset.projectId === restored!.id)
					.map((asset) => asset.path)
			},
			null,
			2
		),
		contentType: 'application/json'
	});
});

test('imports a binary-only typed project and a non-ASCII document path', async ({
	page
}, info) => {
	const archive = new (await import('jszip')).default();
	archive.file(
		'.mdsh/project.json',
		JSON.stringify({
			format: 'mdsh-project',
			schemaVersion: 2,
			name: 'Binary only',
			documents: [
				{ path: 'café.png', kind: 'image', mime: 'image/png' },
				{ path: 'manual.pdf', kind: 'pdf', mime: 'application/pdf' }
			]
		})
	);
	archive.file('café.png', image);
	archive.file('manual.pdf', pdf);
	const bytes = await archive.generateAsync({ type: 'nodebuffer' });
	await info.attach('binary-only-project.zip', {
		body: bytes,
		contentType: 'application/zip'
	});
	const panel = await importArchive(page, bytes, 'binary-only.zip');
	await expect(panel.locator('[data-project-document="café.png"]')).toBeVisible();
	const state = await readProjectState(page);
	const project = state.projects.find((entry) => entry.name === 'Binary only');
	expect(project).toBeTruthy();
	const drafts = state.drafts.filter((draft) => draft.projectId === project!.id);
	expect(drafts).toHaveLength(2);
	expect(drafts.find((draft) => draft.relativePath === 'café.png')).toMatchObject({
		kind: 'image',
		mime: 'image/png',
		data: `data:image/png;base64,${image.toString('base64')}`
	});
	expect(drafts.find((draft) => draft.relativePath === 'manual.pdf')).toMatchObject({
		kind: 'pdf',
		mime: 'application/pdf',
		data: `data:application/pdf;base64,${pdf.toString('base64')}`
	});
	expect(state.assets.filter((asset) => asset.projectId === project!.id)).toEqual([]);
	await expect(panel.locator('[data-project-document="café.png"]')).toBeVisible();
	await panel.locator('[data-project-document="manual.pdf"] button').click();
	await expect(page.locator('[data-testid="document-kind"]')).toHaveText('PDF');
});

test('rejects unsupported manifests and restores a legacy project name', async ({ page }) => {
	const archive = new (await import('jszip')).default();
	archive.file(
		'.mdsh/project.json',
		JSON.stringify({ format: 'mdsh-project', schemaVersion: 3, name: 'Future project' })
	);
	archive.file('README.md', '# Future\n');
	let panel = await importArchive(
		page,
		await archive.generateAsync({ type: 'nodebuffer' }),
		'future.zip'
	);
	await expect(panel.getByRole('alert')).toBeVisible();
	let state = await readProjectState(page);
	expect(state.projects.some((project) => project.name === 'Future project')).toBe(false);

	await panel.getByRole('button', { name: 'Fermer les projets' }).click();
	const malformed = new (await import('jszip')).default();
	malformed.file('.mdsh/project.json', '{');
	malformed.file('README.md', '# Malformed\n');
	panel = await importArchive(
		page,
		await malformed.generateAsync({ type: 'nodebuffer' }),
		'malformed.zip'
	);
	await expect(panel.getByRole('alert')).toBeVisible();

	await panel.getByRole('button', { name: 'Fermer les projets' }).click();
	const legacy = new (await import('jszip')).default();
	legacy.file(
		'.mdsh/project.json',
		JSON.stringify({ format: 'mdsh-project', schemaVersion: 1, name: 'Legacy name' })
	);
	legacy.file('README.md', '# Legacy\n');
	panel = await importArchive(
		page,
		await legacy.generateAsync({ type: 'nodebuffer' }),
		'renamed-legacy.zip'
	);
	await expect(panel.locator('[data-project-document="README.md"]')).toBeVisible();
	state = await readProjectState(page);
	expect(state.projects.some((project) => project.name === 'Legacy name')).toBe(true);
	expect(state.projects.some((project) => project.name === 'renamed-legacy')).toBe(false);
});

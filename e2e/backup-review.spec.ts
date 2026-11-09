import { test, expect, type Download, type Page, type TestInfo } from '@playwright/test';
import { createFirstFile, renameActiveFile, resetAppState, writeSourceContent } from './helpers';
import { presentationFixture } from './presentation-helpers';

const image = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
	'base64'
);
const stamp = 1_725_000_000_000;
const passphrase = 'backup-review-passphrase';
const protectedExamples = '---\nexample: "[[target-identifier#destination]]"\n---\n';
const codeExamples =
	'\n`[[target-identifier#destination]]`\n\n```md\n[[target-identifier#destination|Sample]]\n```\n';

interface Draft {
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
interface Backup {
	format: string;
	schemaVersion: number;
	exportedAt: number;
	drafts: Draft[];
	workspaces: unknown[];
	templates: unknown[];
	projects: Array<{ id: string; name: string; createdAt: number; updatedAt: number }>;
	projectAssets: Array<{ id: string; projectId: string; path: string; mime: string; data: string }>;
}

function emptyBackup(): Backup {
	return {
		format: 'mdsh-backup',
		schemaVersion: 2,
		exportedAt: stamp,
		drafts: [],
		workspaces: [],
		templates: [],
		projects: [],
		projectAssets: []
	};
}

async function attach(info: TestInfo, name: string, value: unknown) {
	await info.attach(name, {
		body: JSON.stringify(value, null, 2),
		contentType: 'application/json'
	});
}

async function bytes(download: Download) {
	const stream = await download.createReadStream();
	const chunks: Buffer[] = [];
	for await (const chunk of stream!) chunks.push(chunk);
	return Buffer.concat(chunks);
}

async function settings(page: Page) {
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	await page.keyboard.press('ControlOrMeta+,');
	await expect(page.getByRole('dialog', { name: 'Réglages' })).toBeVisible();
}

async function exportBackup(page: Page, encrypted = false) {
	await settings(page);
	const pending = page.waitForEvent('download', { timeout: 15000 });
	if (encrypted) {
		await page.getByRole('button', { name: 'Exporter (chiffré)…', exact: true }).click();
		for (const name of ['Chiffrer la sauvegarde', 'Confirmer la phrase secrète']) {
			const prompt = page.getByRole('dialog', { name, exact: true });
			await prompt.locator('input[type=password]').fill(passphrase);
			await prompt.getByRole('button', { name: 'OK', exact: true }).click();
		}
	} else {
		await page.getByRole('button', { name: 'Exporter une sauvegarde', exact: true }).click();
	}
	const result = await bytes(await pending);
	await page.keyboard.press('Escape');
	return result;
}

async function restore(page: Page, buffer: Buffer, mode = 'Remplacer', encrypted = false) {
	await settings(page);
	await page
		.locator('input[type=file][accept*="json"]')
		.setInputFiles({ name: 'review.json', mimeType: 'application/json', buffer });
	if (encrypted) {
		const prompt = page.getByRole('dialog', { name: 'Sauvegarde chiffrée' });
		await prompt.locator('input[type=password]').fill(passphrase);
		await prompt.getByRole('button', { name: 'OK', exact: true }).click();
	}
	const dialog = page.getByRole('dialog', { name: 'Restaurer la sauvegarde' });
	await dialog.getByRole('button', { name: mode, exact: true }).click();
	await expect(dialog).toBeHidden();
	await expect(
		page.getByRole('status').filter({ hasText: 'Sauvegarde restaurée' }).last()
	).toBeVisible();
	await page.keyboard.press('Escape');
}

async function importProject(page: Page, info: TestInfo, binary = false) {
	const zip = new (await import('jszip')).default();
	zip.file('README.md', '# Recovery project\n\n![Exact image](assets/pixel.png)\n');
	zip.file('notes/guide.md', '# Earlier trash\n\n![Exact image](../assets/pixel.png)\n');
	zip.file('assets/pixel.png', image);
	if (binary) {
		zip.file('config.json', '{"setting":true}\n');
		zip.file(
			'attachments/data.bin',
			Buffer.from(Array.from({ length: 2 * 1024 * 1024 + 17 }, (_, index) => index % 251))
		);
	}
	const input = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
	await info.attach('input-project.zip', { body: input, contentType: 'application/zip' });
	await page.getByTestId('projects-open').click();
	const panel = page.getByRole('dialog', { name: 'Projets Markdown' });
	await panel
		.locator('input[type=file][accept=".zip"]')
		.setInputFiles({ name: 'review-project.zip', mimeType: 'application/zip', buffer: input });
	await panel.getByRole('button', { name: 'Ouvrir notes/guide.md', exact: true }).click();
	return zip;
}

async function openDocument(page: Page, path: string, projectName = 'review-project') {
	await page.getByTestId('projects-open').click();
	await page
		.getByRole('dialog', { name: 'Projets Markdown' })
		.locator('select')
		.selectOption({ label: projectName });
	await page
		.getByRole('dialog', { name: 'Projets Markdown' })
		.getByRole('button', { name: `Ouvrir ${path}`, exact: true })
		.click();
}

async function exportProject(
	page: Page,
	info: TestInfo,
	name: string,
	projectName = 'review-project'
) {
	await page.getByTestId('projects-open').click();
	const panel = page.getByRole('dialog', { name: 'Projets Markdown' });
	const pending = page.waitForEvent('download');
	await panel.locator('select').selectOption({ label: projectName });
	await panel.getByRole('button', { name: 'Exporter le projet', exact: true }).click();
	const result = await bytes(await pending);
	await info.attach(name, { body: result, contentType: 'application/zip' });
	await panel.getByRole('button', { name: 'Fermer les projets' }).click();
	return (await import('jszip')).default.loadAsync(result);
}

async function inventory(page: Page) {
	return page.evaluate(
		() =>
			new Promise<{
				drafts: Draft[];
				trashed: Array<{ id: string; file: Draft }>;
				projects: Array<{ id: string; nativeRootId?: string }>;
				projectAssets: Array<{ id: string; projectId: string; path: string; data: number[] }>;
			}>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const stores = ['drafts', 'trashed', 'projects', 'projectAssets'];
					const transaction = database.transaction(stores);
					const reads = stores.map((store) => transaction.objectStore(store).getAll());
					transaction.oncomplete = () => {
						database.close();
						const cleanDraft = (row: Record<string, unknown>) => {
							const { metadata: _metadata, ...rest } = row;
							return rest;
						};
						const cleanTrash = (row: Record<string, unknown>) => {
							const { summary: _summary, file, ...rest } = row;
							return {
								...rest,
								file: file ? cleanDraft(file as Record<string, unknown>) : file
							};
						};
						resolve({
							drafts: reads[0]!.result.map(cleanDraft),
							trashed: reads[1]!.result.map(cleanTrash),
							projects: reads[2]!.result,
							projectAssets: reads[3]!.result.map((asset) => ({
								...asset,
								data: Array.from(asset.data as Uint8Array)
							}))
						});
					};
					transaction.onerror = () => reject(transaction.error);
				};
			})
	);
}

test.beforeEach(async ({ page }) => resetAppState(page));

test.afterEach(async ({ browser }, info) => {
	await attach(info, 'environment.json', {
		browser: browser.version(),
		project: info.project.name,
		baseURL: info.project.use.baseURL,
		node: process.version,
		status: info.status
	});
});

async function standaloneReplacement(page: Page, info: TestInfo) {
	await createFirstFile(page);
	await renameActiveFile(page, 'same');
	await writeSourceContent(page, '# Version A\n');
	const original = JSON.parse((await exportBackup(page)).toString()) as Backup;
	await attach(info, 'standalone-original.json', original);
	const incoming = structuredClone(original);
	incoming.drafts[0]!.content = '# Version B\n';
	incoming.drafts[0]!.updatedAt += 1;
	await attach(info, 'standalone-incoming.json', incoming);
	await restore(page, Buffer.from(JSON.stringify(incoming)));
	const state = await inventory(page);
	await attach(info, 'standalone-replaced.json', state);
	const id = original.drafts[0]!.id;
	expect(state.trashed).toEqual([
		expect.objectContaining({ id, file: expect.objectContaining({ id, content: '# Version A\n' }) })
	]);
	expect(state.drafts).toEqual([expect.objectContaining({ id, content: '# Version B\n' })]);
	return id;
}

async function historyRows(page: Page) {
	return page.evaluate(
		() =>
			new Promise<Array<{ id: string; draftId: string; content: string }>>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const transaction = database.transaction('versions');
					const rows = transaction.objectStore('versions').getAll();
					transaction.oncomplete = () => {
						database.close();
						resolve(rows.result);
					};
					transaction.onabort = () => reject(transaction.error);
				};
			})
	);
}

for (const closed of [false, true]) {
	test(`standalone replacement restores A and keeps ${closed ? 'closed' : 'open'} B and history`, async ({
		page
	}, info) => {
		const id = await standaloneReplacement(page, info);
		const history = await historyRows(page);
		await attach(info, 'history-before.json', history);
		expect(history.filter((row) => row.draftId === id).length).toBeGreaterThan(0);
		if (closed) {
			await page
				.locator('.mdsh-file-row')
				.filter({ hasText: 'same' })
				.locator('button')
				.last()
				.click();
			await expect
				.poll(async () => (await inventory(page)).drafts.find((row) => row.id === id)?.open)
				.toBe(false);
		}
		const trash = page
			.locator('aside details')
			.filter({ has: page.locator('summary', { hasText: /^Corbeille/ }) });
		await trash.locator('summary').click();
		await trash.getByRole('button', { name: 'Restaurer same.md', exact: true }).click();
		await expect(page.locator('.cm-content')).toContainText('# Version A');
		await expect.poll(async () => (await inventory(page)).trashed.length).toBe(0);
		const exported = await exportBackup(page);
		await info.attach('standalone-recovered-backup.json', {
			body: exported,
			contentType: 'application/json'
		});
		await page.reload();
		const state = await inventory(page);
		const afterHistory = await historyRows(page);
		await attach(info, 'standalone-recovered.json', { state, history: afterHistory });
		expect(state.drafts.find((row) => row.id === id)?.content).toBe('# Version B\n');
		const recovered = state.drafts.find((row) => row.content === '# Version A\n')!;
		expect(recovered.id).not.toBe(id);
		expect(state.drafts).toHaveLength(2);
		expect(
			afterHistory
				.filter((row) => row.draftId === recovered.id)
				.map((row) => row.content)
				.sort()
		).toEqual(
			history
				.filter((row) => row.draftId === id)
				.map((row) => row.content)
				.sort()
		);
		expect(
			(JSON.parse(exported.toString()) as Backup).drafts.map((row) => row.content).sort()
		).toEqual(['# Version A\n', '# Version B\n']);
	});
}

test('standalone replacement keeps B and the original trash reference after a failed copy', async ({
	page
}, info) => {
	const id = await standaloneReplacement(page, info);
	const before = await inventory(page);
	const history = await historyRows(page);
	await page.evaluate((originalId) => {
		const put = IDBObjectStore.prototype.put;
		IDBObjectStore.prototype.put = function (...args) {
			const row = args[0] as { id?: string; file?: { content?: string } };
			if (
				this.name === 'trashed' &&
				row.id !== originalId &&
				row.file?.content === '# Version A\n'
			) {
				IDBObjectStore.prototype.put = put;
				this.transaction.abort();
				throw new DOMException('Trash copy interrupted', 'QuotaExceededError');
			}
			return put.apply(this, args);
		};
	}, id);
	await page.locator('aside summary').filter({ hasText: 'Actions du document' }).click();
	await page
		.locator('aside')
		.getByRole('button', { name: 'Déplacer le document dans la corbeille', exact: true })
		.click();
	await page
		.getByRole('dialog', { name: 'Déplacer ce document dans la corbeille ?', exact: true })
		.getByRole('button', { name: 'Confirmer', exact: true })
		.click();
	await expect(page.getByRole('alert')).toBeVisible();
	await attach(info, 'standalone-copy-rollback.json', {
		state: await inventory(page),
		history: await historyRows(page)
	});
	await expect(page.locator('.cm-content')).toContainText('# Version B');
	await page.reload();
	const after = await inventory(page);
	await attach(info, 'standalone-copy-failure.json', {
		before,
		after,
		history: await historyRows(page)
	});
	expect(after).toEqual(before);
	expect(await historyRows(page)).toEqual(history);
	const exported = await exportBackup(page);
	await info.attach('standalone-after-failure.json', {
		body: exported,
		contentType: 'application/json'
	});
});

test('a failed recovery asset write rolls back the complete replacement', async ({
	page
}, info) => {
	await importProject(page, info);
	const before = await inventory(page);
	await attach(info, 'before-abort.json', before);
	await page.evaluate(() => {
		const put = IDBObjectStore.prototype.put;
		IDBObjectStore.prototype.put = function (...args) {
			if (this.name === 'projectAssets') {
				IDBObjectStore.prototype.put = put;
				this.transaction.abort();
				throw new DOMException('Recovery write interrupted', 'QuotaExceededError');
			}
			return put.apply(this, args);
		};
	});
	await settings(page);
	const incoming = emptyBackup();
	await attach(info, 'abort-input.json', incoming);
	await page.locator('input[type=file][accept*="json"]').setInputFiles({
		name: 'abort.json',
		mimeType: 'application/json',
		buffer: Buffer.from(JSON.stringify(incoming))
	});
	await page
		.getByRole('dialog', { name: 'Restaurer la sauvegarde' })
		.getByRole('button', { name: 'Remplacer', exact: true })
		.click();
	await expect(
		page.getByRole('alert').filter({ hasText: /Recovery write interrupted|abort|échoué/i })
	).toBeVisible();
	await page.reload();
	const after = await inventory(page);
	await attach(info, 'after-abort.json', after);
	expect(after).toEqual(before);
	const exported = await exportBackup(page);
	await info.attach('after-abort-backup.json', { body: exported, contentType: 'application/json' });
});

for (const schema of [1, 2]) {
	test(`replace schema ${schema} keeps outgoing and earlier trash assets through recovery`, async ({
		page
	}, info) => {
		await importProject(page, info);
		const original = JSON.parse((await exportBackup(page)).toString()) as Backup;
		await attach(info, 'outgoing-backup.json', original);
		await page.evaluate(
			(projectId) =>
				new Promise<void>((resolve, reject) => {
					const request = indexedDB.open('mdsh');
					request.onerror = () => reject(request.error);
					request.onsuccess = () => {
						const database = request.result;
						const transaction = database.transaction('projects', 'readwrite');
						const store = transaction.objectStore('projects');
						const project = store.get(projectId);
						project.onsuccess = () =>
							store.put({ ...project.result, nativeRootId: 'must-not-recover-authority' });
						transaction.oncomplete = () => {
							database.close();
							resolve();
						};
						transaction.onabort = () => reject(transaction.error);
					};
				}),
			original.projects[0]!.id
		);
		await page.locator('aside summary').filter({ hasText: 'Actions du document' }).click();
		await page
			.locator('aside')
			.getByRole('button', { name: 'Déplacer le document dans la corbeille', exact: true })
			.click();
		await page
			.getByRole('dialog', { name: 'Déplacer ce document dans la corbeille ?', exact: true })
			.getByRole('button', { name: 'Confirmer', exact: true })
			.click();
		await expect.poll(async () => (await inventory(page)).trashed.length).toBe(1);
		const incoming = emptyBackup();
		incoming.schemaVersion = schema;
		if (schema === 2) {
			incoming.projects = [{ ...original.projects[0]!, name: 'Incoming project' }];
			incoming.drafts = [{ ...original.drafts.find((row) => row.relativePath === 'README.md')! }];
			incoming.projectAssets = [
				{
					...original.projectAssets[0]!,
					data: Buffer.from('Different incoming bytes').toString('base64')
				}
			];
		}
		await attach(info, 'incoming-backup.json', incoming);
		await restore(page, Buffer.from(JSON.stringify(incoming)));
		const replaced = await inventory(page);
		await attach(info, 'after-replace.json', replaced);
		await page.reload();
		const trash = page
			.locator('aside details')
			.filter({ has: page.locator('summary', { hasText: /^Corbeille/ }) });
		await trash.locator('summary').click();
		for (const name of ['README.md', 'guide.md'])
			await trash.getByRole('button', { name: `Restaurer ${name}`, exact: true }).click();
		await expect.poll(async () => (await inventory(page)).trashed.length).toBe(0);
		await page.reload();
		const restored = await inventory(page);
		await attach(info, 'after-recovery.json', restored);
		expect(restored.projects.every((project) => project.nativeRootId === undefined)).toBe(true);
		const recovered = restored.drafts.filter(
			(row) => row.content.includes('![Exact image]') && row.projectId !== incoming.projects[0]?.id
		);
		expect(recovered).toHaveLength(2);
		for (const draft of recovered) {
			expect(restored.projects.some((project) => project.id === draft.projectId)).toBe(true);
			expect(
				restored.projectAssets.find((asset) => asset.projectId === draft.projectId)?.data
			).toEqual(Array.from(image));
		}
		if (schema === 2) {
			expect(recovered[0]!.projectId).not.toBe(incoming.projects[0]!.id);
			expect(restored.drafts.find((draft) => draft.id === incoming.drafts[0]!.id)).toMatchObject(
				incoming.drafts[0]!
			);
			expect(
				restored.projectAssets.find((asset) => asset.id === incoming.projectAssets[0]!.id)?.data
			).toEqual(Array.from(Buffer.from('Different incoming bytes')));
		}
		const exported = await exportBackup(page);
		await info.attach('recovered-backup.json', { body: exported, contentType: 'application/json' });
		await openDocument(page, 'notes/guide.md');
		await page.locator('[data-mode=read]').click();
		await expect(page.locator('.mdsh-preview img[alt="Exact image"]')).toBeVisible();
		await expect
			.poll(() =>
				page
					.locator('.mdsh-preview img[alt="Exact image"]')
					.evaluate((node) => (node as HTMLImageElement).naturalWidth)
			)
			.toBe(1);
		const zip = await exportProject(page, info, 'recovered-project.zip');
		expect(await zip.file('assets/pixel.png')!.async('nodebuffer')).toEqual(image);
		expect(await zip.file('notes/guide.md')!.async('string')).toContain('# Earlier trash');
	});
}

for (const encrypted of [false, true]) {
	test(`round-trips accepted binary assets in ${encrypted ? 'encrypted' : 'plaintext'} backups`, async ({
		page,
		browser
	}, info) => {
		const input = await importProject(page, info, true);
		const backup = await exportBackup(page, encrypted);
		await info.attach('binary-backup.json', { body: backup, contentType: 'application/json' });
		const context = await browser.newContext({
			locale: 'fr-FR',
			baseURL: info.project.use.baseURL
		});
		try {
			const fresh = await context.newPage();
			await resetAppState(fresh);
			await restore(fresh, backup, 'Remplacer', encrypted);
			await fresh.reload();
			const output = await exportProject(fresh, info, 'binary-restored.zip');
			for (const path of Object.keys(input.files).filter((path) => !input.files[path]!.dir)) {
				expect(await output.file(path)!.async('nodebuffer')).toEqual(
					await input.file(path)!.async('nodebuffer')
				);
			}
		} finally {
			await context.close();
		}
	});
}

function linkedBackup(fragments: boolean): Backup {
	const backup = emptyBackup();
	backup.projects = [
		{ id: 'linked-project', name: 'Linked project', createdAt: stamp, updatedAt: stamp }
	];
	const sources = [
		[
			'source-identifier',
			'index.md',
			fragments
				? `${protectedExamples}# Source\n\n[[target-identifier]]\n\n[[target-identifier#destination]]\n\n[[target-identifier#destination|Aliased destination]]\n${codeExamples}`
				: '# Source\n\n[[target-identifier|Forward]]\n'
		],
		[
			'target-identifier',
			'guide.md',
			`# Guide\n\n[[source-identifier|Back]]\n\n${'Spacing paragraph.\n\n'.repeat(40)}## Destination\n`
		]
	];
	backup.drafts = sources.map(([id, name, content], order) => ({
		id: id!,
		name: name!,
		content: content!,
		projectId: 'linked-project',
		relativePath: name!,
		createdAt: stamp,
		updatedAt: stamp,
		order,
		open: true
	}));
	backup.projectAssets = [
		{
			id: 'pixel',
			projectId: 'linked-project',
			path: 'assets/pixel.png',
			mime: 'image/png',
			data: image.toString('base64')
		}
	];
	return backup;
}

test('repeated merge keeps one project with cyclic ID links and exact asset and presentation bytes', async ({
	page
}, info) => {
	const fixture = linkedBackup(false);
	const deck = presentationFixture(['[[target-identifier#destination|Keep literal]]']);
	fixture.drafts.push({
		...fixture.drafts[0]!,
		id: 'deck-identifier',
		name: 'deck.md',
		relativePath: 'deck.md',
		content: deck,
		order: 2,
		open: false
	});
	await attach(info, 'linked-backup.json', fixture);
	const input = Buffer.from(JSON.stringify(fixture));
	await restore(page, input, 'Fusionner');
	const first = await inventory(page);
	await attach(info, 'first-merge.json', first);
	await restore(page, input, 'Fusionner');
	const second = await inventory(page);
	await attach(info, 'second-merge.json', second);
	expect(second.projects).toHaveLength(1);
	expect(second.drafts).toHaveLength(3);
	expect(second.projectAssets).toEqual(first.projectAssets);
	expect(second.drafts).toEqual(first.drafts);
	expect(second.drafts.find((draft) => draft.relativePath === 'deck.md')?.content).toBe(deck);
	await openDocument(page, 'index.md', 'Linked project');
	await page.locator('[data-mode=read]').click();
	await page.locator('.mdsh-preview').getByRole('link', { name: 'Forward', exact: true }).click();
	await expect(page.locator('.mdsh-preview h1')).toHaveText('Guide');
	await page.locator('.mdsh-preview').getByRole('link', { name: 'Back', exact: true }).click();
	await expect(page.locator('.mdsh-preview h1')).toHaveText('Source');
	const output = await exportProject(page, info, 'linked-project.zip', 'Linked project');
	expect(await output.file('assets/pixel.png')!.async('nodebuffer')).toEqual(image);
	expect(await output.file('index.md')!.async('string')).toBe('# Source\n\n[[guide.md|Forward]]\n');
	expect(await output.file('deck.md')!.async('nodebuffer')).toEqual(Buffer.from(deck));
});

test('merge rewrites ID fragments and aliases while preserving code and front matter', async ({
	page
}, info) => {
	const fixture = linkedBackup(true);
	await attach(info, 'fragment-backup.json', fixture);
	await restore(page, Buffer.from(JSON.stringify(fixture)), 'Fusionner');
	const merged = await inventory(page);
	await attach(info, 'fragment-merge.json', merged);
	const source = merged.drafts.find((draft) => draft.relativePath === 'index.md')!;
	const target = merged.drafts.find((draft) => draft.relativePath === 'guide.md')!;
	expect(target.id).not.toBe('target-identifier');
	expect(source.content).toContain(`[[${target.id}#destination]]`);
	expect(source.content).toContain(`[[${target.id}#destination|Aliased destination]]`);
	expect(source.content).toContain(protectedExamples);
	expect(source.content).toContain(codeExamples);
	await restore(page, Buffer.from(JSON.stringify(fixture)), 'Fusionner');
	const repeated = await inventory(page);
	await attach(info, 'fragment-repeat.json', repeated);
	expect(repeated.drafts).toEqual(merged.drafts);
	expect(repeated.projects).toEqual(merged.projects);
	expect(repeated.projectAssets).toEqual(merged.projectAssets);
	for (const name of [target.id, `${target.id}#destination`, 'Aliased destination']) {
		await openDocument(page, 'index.md', 'Linked project');
		await page.locator('[data-mode=read]').click();
		await page.locator('.mdsh-preview').getByRole('link', { name, exact: true }).click();
		await expect(page.locator('input[aria-label^="Nom du fichier"]')).toHaveValue('guide');
		if (name !== target.id)
			await expect(page.locator('.mdsh-preview #destination')).toBeInViewport();
	}
	await info.attach('fragment-target.png', {
		body: await page.screenshot(),
		contentType: 'image/png'
	});
});

test('backup inspection rejects oversized and unsafe assets before replacement', async ({
	page
}, info) => {
	await importProject(page, info);
	const before = await inventory(page);
	await attach(info, 'validation-before.json', before);
	await settings(page);
	const cases = [
		{
			name: 'oversized-image',
			mime: 'image/png',
			path: 'assets/pixel.png',
			data: Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64')
		},
		{
			name: 'image-with-binary-mime',
			mime: 'application/octet-stream',
			path: 'assets/pixel.png',
			data: Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64')
		},
		{
			name: 'oversized-binary',
			mime: 'application/octet-stream',
			path: 'data.bin',
			data: Buffer.alloc(16 * 1024 * 1024 + 1).toString('base64')
		},
		{ name: 'active-mime', mime: 'text/html', path: 'data.bin', data: 'AAAA' },
		{ name: 'unsafe-path', mime: 'application/octet-stream', path: '../data.bin', data: 'AAAA' },
		{ name: 'invalid-base64', mime: 'application/octet-stream', path: 'data.bin', data: 'AA=A' }
	];
	for (const { name, ...asset } of cases) {
		const input = linkedBackup(false);
		input.projectAssets = [{ id: 'invalid', projectId: 'linked-project', ...asset }];
		await attach(info, `${name}.json`, input);
		await page.locator('input[type=file][accept*="json"]').setInputFiles({
			name: `${name}.json`,
			mimeType: 'application/json',
			buffer: Buffer.from(JSON.stringify(input))
		});
		await expect(page.getByRole('alert').last()).toBeVisible();
		await expect(page.getByRole('dialog', { name: 'Restaurer la sauvegarde' })).toHaveCount(0);
		expect(await inventory(page)).toEqual(before);
		await page.getByRole('alert').last().getByRole('button').click();
		await expect(page.getByRole('alert')).toHaveCount(0);
	}
	await attach(info, 'validation-after.json', await inventory(page));
});

import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { resetAppState, seedFiles, writeSourceContent } from './helpers';

const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

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

interface StoredProject {
	id: string;
	name: string;
	createdAt: number;
	updatedAt: number;
}

const pixel = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
	'base64'
);

async function importProject(
	page: Page,
	name: string,
	files: Record<string, string | Buffer>
): Promise<void> {
	const zip = new (await import('jszip')).default();
	for (const [path, content] of Object.entries(files)) zip.file(path, content);
	await page.getByTestId('projects-open').click();
	const panel = page.getByRole('dialog', { name: 'Projets Markdown' });
	await panel.locator('input[type=file][accept=".zip"]').setInputFiles({
		name: `${name}.zip`,
		mimeType: 'application/zip',
		buffer: await zip.generateAsync({ type: 'nodebuffer' })
	});
	await panel.getByRole('button', { name: 'Fermer les projets' }).click();
}

async function storedState(page: Page): Promise<{
	drafts: StoredDraft[];
	projects: StoredProject[];
}> {
	return page.evaluate(
		() =>
			new Promise<{ drafts: StoredDraft[]; projects: StoredProject[] }>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const transaction = database.transaction(['drafts', 'projects']);
					const drafts = transaction.objectStore('drafts').getAll();
					const projects = transaction.objectStore('projects').getAll();
					transaction.oncomplete = () => {
						database.close();
						resolve({ drafts: drafts.result, projects: projects.result });
					};
					transaction.onerror = () => reject(transaction.error);
				};
			})
	);
}

async function projectRoot(page: Page, name: string) {
	return page.locator(`[data-project-root-name="${name}"]`);
}

async function expand(page: Page, name: string): Promise<void> {
	const root = await projectRoot(page, name);
	await ensureExpanded(root);
}

async function ensureExpanded(container: ReturnType<Page['locator']>): Promise<void> {
	const details = container.locator('details').first();
	try {
		await expect(details).toHaveAttribute('open', '', { timeout: 500 });
		return;
	} catch {
		// The folder starts closed, or the change handler is still opening it.
	}
	if ((await details.getAttribute('open')) === null)
		await container.locator('summary').first().click();
	await expect(details).toHaveAttribute('open', '');
}

async function dropFiles(
	page: Page,
	selector: string,
	files: Array<{ path: string; content: string; type?: string }>
) {
	await page.evaluate(
		({ selector, files }) => {
			const target = document.querySelector(selector);
			if (!target) throw new Error(`Missing drop target ${selector}`);
			const dataTransfer = new DataTransfer();
			for (const file of files) {
				const payload = new File([file.content], file.path.split('/').pop()!, {
					type: file.type ?? 'text/markdown'
				});
				Object.defineProperty(payload, 'webkitRelativePath', { value: file.path });
				dataTransfer.items.add(payload);
			}
			target.dispatchEvent(
				new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer })
			);
			target.dispatchEvent(
				new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer })
			);
		},
		{ selector, files }
	);
}

test.beforeEach(async ({ page }) => resetAppState(page));

test('sidebar explorer keeps expansion, opens one tab, and survives reload', async ({
	page
}, info) => {
	await importProject(page, 'Explorer', {
		'README.md': '# Home\n',
		'notes/guide.md': '# Guide\n',
		'notes/deep/reference.md': '# Reference\n'
	});
	const root = await projectRoot(page, 'Explorer');
	await expect(root).toBeVisible();
	await expand(page, 'Explorer');
	await expect(root.locator('[data-project-folder="notes"]')).toBeVisible();
	const notes = root.locator('[data-project-folder="notes"]');
	await expect(root.locator('[data-project-document="notes/guide.md"]')).not.toBeVisible();
	await notes.locator('summary').first().click();
	const guideButton = root.locator('[data-project-document="notes/guide.md"] button[data-file-id]');
	await expect(guideButton).toBeVisible();
	const guideId = await guideButton.getAttribute('data-file-id');
	await guideButton.click();
	await expect(page.locator('#app-toolbar input')).toHaveValue('guide');
	await guideButton.click();
	const state = await storedState(page);
	expect(state.drafts.filter((draft) => draft.id === guideId)).toHaveLength(1);
	expect(state.drafts.filter((draft) => draft.name === 'guide.md')).toHaveLength(1);

	// Collapse the folder, open a root file, then check that the folder stays closed.
	await notes.locator('summary').first().click();
	await expect(
		root.locator('[data-project-document="README.md"] button[data-file-id]')
	).toBeVisible();
	await root.locator('[data-project-document="README.md"] button[data-file-id]').click();
	await expect(root.locator('[data-project-folder="notes"] details').first()).not.toHaveAttribute(
		'open',
		''
	);
	await page.reload();
	await expect(root.locator('[data-project-folder="notes"]')).toBeVisible();
	await expect(root.locator('[data-project-folder="notes"] details').first()).not.toHaveAttribute(
		'open',
		''
	);
	// Keyboard disclosure keeps the same state.
	await notes.locator('summary').first().focus();
	await page.keyboard.press('ArrowRight');
	await expect(root.locator('[data-project-document="notes/guide.md"]')).toBeVisible();
	await page.keyboard.press('ArrowLeft');
	await expect(root.locator('[data-project-document="notes/guide.md"]')).not.toBeVisible();
	await page.keyboard.press('Enter');
	await expect(root.locator('[data-project-document="notes/guide.md"]')).toBeVisible();
	await page.keyboard.press('Enter');
	await expect(root.locator('[data-project-document="notes/guide.md"]')).not.toBeVisible();
	await info.attach('project-explorer-expansion.json', {
		body: JSON.stringify(
			{
				expanded: await page.evaluate(() => localStorage.getItem('mdsh:project-expanded')),
				draftIds: state.drafts.map((draft) => draft.id),
				guideId
			},
			null,
			2
		),
		contentType: 'application/json'
	});
	await info.attach('project-explorer-expansion.png', {
		body: await page.screenshot(),
		contentType: 'image/png'
	});
});

test('drops move a library document and keep both entries on a name conflict', async ({
	page
}, info) => {
	await seedFiles(page, [
		{ name: 'alpha', content: '# Alpha\n\n[[guide]]\n' },
		{ name: 'beta', content: '# Beta library\n' }
	]);
	const alpha = page
		.locator('aside .mdsh-file-row:not([data-project-document])')
		.filter({ hasText: 'alpha' })
		.locator('button[data-file-id]');
	const alphaId = await alpha.getAttribute('data-file-id');
	await importProject(page, 'Explorer', {
		'README.md': '# Home\n',
		'beta.md': '# Beta project\n',
		'notes/guide.md': '# Guide\n'
	});
	const root = await projectRoot(page, 'Explorer');
	await expand(page, 'Explorer');
	await alpha.dragTo(root.locator('summary').first());
	await expect(root.locator('[data-project-document="alpha.md"]')).toBeVisible();
	let state = await storedState(page);
	const moved = state.drafts.find((draft) => draft.id === alphaId)!;
	expect(moved.relativePath).toBe('alpha.md');
	expect(moved.projectId).toBeTruthy();
	await expect(page.locator(`[data-file-id="${alphaId}"]`)).toHaveCount(1);

	await page.reload();
	await expect(root.locator('[data-project-document="alpha.md"]')).toBeVisible();
	expect((await storedState(page)).drafts.find((draft) => draft.id === alphaId)?.relativePath).toBe(
		'alpha.md'
	);

	// The conflict prompt keeps the source and stores the dropped copy as a variant.
	const second = page
		.locator('aside .mdsh-file-row:not([data-project-document])')
		.filter({ hasText: 'beta' })
		.locator('button[data-file-id]');
	const secondId = await second.getAttribute('data-file-id');
	await second.dragTo(root.locator('summary').first());
	const conflict = page.getByRole('dialog', { name: 'Le nom existe déjà' });
	await expect(conflict).toBeVisible();
	await conflict.getByRole('button', { name: 'Conserver les deux' }).click();
	await expect(root.locator('[data-project-document="beta (2).md"]')).toBeVisible();
	state = await storedState(page);
	const firstRow = state.drafts.find((draft) => draft.relativePath === 'beta.md')!;
	const secondRow = state.drafts.find((draft) => draft.id === secondId)!;
	expect(firstRow.id).not.toBe(secondId);
	expect(firstRow.content).toContain('# Beta project');
	expect(secondRow.content).toContain('# Beta library');
	expect(secondRow.relativePath).toBe('beta (2).md');
	expect(firstRow.id).not.toBe(secondRow.id);
	await info.attach('project-drop-conflict.json', {
		body: JSON.stringify(
			state.drafts.filter((draft) => draft.relativePath?.startsWith('beta')),
			null,
			2
		),
		contentType: 'application/json'
	});
	await info.attach('project-drop-conflict.png', {
		body: await page.screenshot(),
		contentType: 'image/png'
	});
});

test('operating system drops keep relative paths and reject traversal', async ({ page }, info) => {
	await importProject(page, 'Explorer', {
		'README.md': '# Home\n',
		'notes/keep.md': '# Keep\n'
	});
	const root = await projectRoot(page, 'Explorer');
	await expand(page, 'Explorer');
	const notes = root.locator('[data-project-folder="notes"]');
	await ensureExpanded(notes);
	await dropFiles(page, '[data-project-folder="notes"]', [
		{ path: 'dropped.md', content: '# Dropped\n' }
	]);
	await expect(root.locator('[data-project-document="notes/dropped.md"]')).toBeVisible();
	await dropFiles(page, '[data-project-root-name="Explorer"]', [
		{ path: 'Folder/sub/nested.md', content: '# Nested\n' }
	]);
	await ensureExpanded(root.locator('[data-project-folder="Folder"]'));
	await ensureExpanded(root.locator('[data-project-folder="Folder/sub"]'));
	await expect(root.locator('[data-project-document="Folder/sub/nested.md"]')).toBeVisible();
	let state = await storedState(page);
	expect(state.drafts.find((draft) => draft.relativePath === 'notes/dropped.md')?.content).toBe(
		'# Dropped\n'
	);
	expect(state.drafts.find((draft) => draft.relativePath === 'Folder/sub/nested.md')).toBeTruthy();

	const before = state.drafts.length;
	await dropFiles(page, '[data-project-root-name="Explorer"]', [
		{ path: '../escape.md', content: '# Escape\n' }
	]);
	await dropFiles(page, '[data-project-root-name="Explorer"]', [
		{ path: 'unsupported.pdf', content: '%PDF', type: 'application/pdf' }
	]);
	await expect(page.getByRole('alert')).toContainText('Le déplacement a échoué');
	state = await storedState(page);
	expect(state.drafts).toHaveLength(before);
	expect(state.drafts.some((draft) => draft.relativePath?.includes('escape'))).toBe(false);
	expect(state.drafts.some((draft) => draft.relativePath?.includes('unsupported'))).toBe(false);
	// The global image drop must not create a library tab for this project drop.
	expect(state.drafts.filter((draft) => !draft.projectId)).toHaveLength(0);
	await info.attach('project-os-drop.json', {
		body: JSON.stringify(
			{
				imported: state.drafts
					.filter((draft) => draft.projectId)
					.map((draft) => draft.relativePath),
				rejectedTraversal: true
			},
			null,
			2
		),
		contentType: 'application/json'
	});
	await info.attach('project-os-drop.png', {
		body: await page.screenshot(),
		contentType: 'image/png'
	});
});

test('keyboard move rewrites links and a cancelled conflict rolls back', async ({ page }, info) => {
	await importProject(page, 'Explorer', {
		'README.md': '# Home\n\n[Guide](notes/guide.md)\n\n[[notes/guide|Wiki guide]]\n',
		'notes/guide.md': '# Guide\n\n[Home](../README.md)\n\n![Pixel](../assets/pixel.png)\n',
		'assets/pixel.png': pixel,
		'archive/notes/guide.md': '# Existing archive guide\n'
	});
	const root = await projectRoot(page, 'Explorer');
	await expand(page, 'Explorer');
	const notes = root.locator('[data-project-folder="notes"]');
	await ensureExpanded(notes);
	const moveFolder = notes.locator('[data-project-action="move-folder"]');
	await moveFolder.focus();
	await page.keyboard.press('Enter');
	const dialog = page.getByRole('dialog', { name: 'Déplacer ou copier' });
	await expect(dialog).toBeVisible();
	await dialog.getByTestId('project-move-folder').fill('archive');
	await dialog.getByTestId('project-move-submit').click();
	const conflict = page.getByRole('dialog', { name: 'Le nom existe déjà' });
	await expect(conflict).toBeVisible();
	await conflict.getByRole('button', { name: 'Annuler' }).click();
	await expect(root.locator('[data-project-document="notes/guide.md"]')).toBeVisible();
	expect(
		(await storedState(page)).drafts.find(
			(draft) => draft.relativePath === 'archive/notes/guide.md'
		)?.content
	).toContain('Existing archive guide');

	// Retry and keep both entries.
	await moveFolder.focus();
	await page.keyboard.press('Enter');
	await dialog.getByTestId('project-move-folder').fill('archive');
	await dialog.getByTestId('project-move-submit').click();
	await expect(conflict).toBeVisible();
	await conflict.getByRole('button', { name: 'Conserver les deux' }).click();
	await ensureExpanded(root.locator('[data-project-folder="archive"]'));
	await ensureExpanded(root.locator('[data-project-folder="archive/notes"]'));
	await expect(root.locator('[data-project-document="archive/notes/guide (2).md"]')).toBeVisible();
	const state = await storedState(page);
	expect(
		state.drafts.find((draft) => draft.relativePath === 'archive/notes/guide.md')?.content
	).toBe('# Existing archive guide\n');
	const moved = state.drafts.find((draft) => draft.relativePath === 'archive/notes/guide (2).md')!;
	expect(moved.content).toContain('[Home](../../README.md)');
	expect(moved.content).toContain('![Pixel](../../assets/pixel.png)');
	const readme = state.drafts.find((draft) => draft.relativePath === 'README.md')!;
	expect(readme.content).toContain('[Guide](archive/notes/guide%20%282%29.md)');
	expect(readme.content).toContain('[[archive/notes/guide%20%282%29|Wiki guide]]');
	expect(state.drafts.some((draft) => draft.relativePath === 'notes/guide.md')).toBe(false);
	await info.attach('project-keyboard-move.json', {
		body: JSON.stringify(
			state.drafts
				.filter((draft) => draft.relativePath?.endsWith('.md'))
				.map((draft) => ({ path: draft.relativePath, content: draft.content })),
			null,
			2
		),
		contentType: 'application/json'
	});
	await info.attach('project-keyboard-move.png', {
		body: await page.screenshot(),
		contentType: 'image/png'
	});
});

test('copy keeps the source document and creates a new identity', async ({ page }, info) => {
	await importProject(page, 'Explorer', {
		'README.md': '# Home\n\n[Guide](notes/guide.md)\n',
		'notes/guide.md': '# Guide\n'
	});
	const root = await projectRoot(page, 'Explorer');
	await expand(page, 'Explorer');
	const before = await storedState(page);
	const source = before.drafts.find((draft) => draft.relativePath === 'README.md')!;
	await root
		.locator('[data-project-document="README.md"] [data-project-action="move-document"]')
		.click();
	const dialog = page.getByRole('dialog', { name: 'Déplacer ou copier' });
	await dialog.getByTestId('project-move-folder').fill('copies');
	await dialog.getByTestId('project-move-copy').click();
	await ensureExpanded(root.locator('[data-project-folder="copies"]'));
	await expect(root.locator('[data-project-document="copies/README.md"]')).toBeVisible();
	const after = await storedState(page);
	const original = after.drafts.find((draft) => draft.id === source.id)!;
	const copy = after.drafts.find((draft) => draft.relativePath === 'copies/README.md')!;
	expect(original.relativePath).toBe('README.md');
	expect(copy.id).not.toBe(source.id);
	expect(copy.content).toContain('[Guide](../notes/guide.md)');
	expect(original.content).toContain('[Guide](notes/guide.md)');
	await info.attach('project-copy.json', {
		body: JSON.stringify({ original, copy }, null, 2),
		contentType: 'application/json'
	});
	await info.attach('project-copy.png', {
		body: await page.screenshot(),
		contentType: 'image/png'
	});
});

test('copy leaves existing siblings and their links unchanged', async ({ page }, info) => {
	await importProject(page, 'Explorer', {
		'README.md': '# Home\n\n[Guide](notes/guide.md)\n',
		'notes/guide.md': '# Guide\n\n[Home](../README.md)\n'
	});
	const root = await projectRoot(page, 'Explorer');
	await expand(page, 'Explorer');
	const notes = root.locator('[data-project-folder="notes"]');
	await ensureExpanded(notes);
	const before = await storedState(page);
	const source = before.drafts.find((draft) => draft.relativePath === 'notes/guide.md')!;
	const readme = before.drafts.find((draft) => draft.relativePath === 'README.md')!;
	await notes
		.locator('[data-project-document="notes/guide.md"] [data-project-action="move-document"]')
		.click();
	const dialog = page.getByRole('dialog', { name: 'Déplacer ou copier' });
	await dialog.getByTestId('project-move-folder').fill('copies');
	await dialog.getByTestId('project-move-copy').click();
	await ensureExpanded(root.locator('[data-project-folder="copies"]'));
	await expect(root.locator('[data-project-document="copies/guide.md"]')).toBeVisible();
	const after = await storedState(page);
	const original = after.drafts.find((draft) => draft.id === source.id)!;
	const copied = after.drafts.find((draft) => draft.relativePath === 'copies/guide.md')!;
	const readmeAfter = after.drafts.find((draft) => draft.id === readme.id)!;
	expect(original.content).toBe(source.content);
	expect(readmeAfter.content).toBe(readme.content);
	expect(readmeAfter.content).toContain('[Guide](notes/guide.md)');
	expect(readmeAfter.updatedAt).toBe(readme.updatedAt);
	expect(copied.id).not.toBe(source.id);
	expect(copied.content).toContain('[Home](../README.md)');
	expect(after.drafts).toHaveLength(before.drafts.length + 1);
	await info.attach('project-copy-existing.json', {
		body: JSON.stringify({ original, copied, readmeAfter }, null, 2),
		contentType: 'application/json'
	});
	await info.attach('project-copy-existing.png', {
		body: await page.screenshot(),
		contentType: 'image/png'
	});
});

test('opens a mixed-case project Markdown link in read mode', async ({ page }, info) => {
	await importProject(page, 'Links', {
		'docs/Guide.md': '# Guide\n\nCanonical target.\n',
		'notes/reader.md': '# Reader\n\n[Read guide](../docs/guide.md)\n'
	});
	const root = await projectRoot(page, 'Links');
	await expand(page, 'Links');
	await ensureExpanded(root.locator('[data-project-folder="notes"]'));
	const paths = (await storedState(page)).drafts.map((draft) => draft.relativePath);
	expect(paths).toContain('docs/Guide.md');
	expect(paths).toContain('notes/reader.md');
	await root.locator('[data-project-document="notes/reader.md"] button[data-file-id]').click();
	const fileName = page.locator('input[aria-label^="Nom du fichier"]');
	await expect(fileName).toHaveValue('reader');
	// Write the authored mixed-case destination after import, so no migration
	// pass can repair it before Read mode resolves the stored path.
	await writeSourceContent(page, '# Reader\n\n[Read guide](../docs/guide.md)\n');
	await page.locator('button[data-mode="read"]').click();
	const link = page.getByRole('link', { name: 'Read guide' });
	expect(await link.getAttribute('href')).toBe('../docs/guide.md');
	await link.click();
	await expect(fileName).toHaveValue('Guide');
	await expect(page.locator('.mdsh-preview')).toContainText('Canonical target');
	await info.attach('project-read-case-link.json', {
		body: JSON.stringify({ destination: '../docs/guide.md', target: 'docs/Guide.md' }, null, 2),
		contentType: 'application/json'
	});
	await info.attach('project-read-case-link.png', {
		body: await page.screenshot(),
		contentType: 'image/png'
	});
});

test('moves a document to another project with the same identity', async ({ page }, info) => {
	await importProject(page, 'First', { 'README.md': '# First\n' });
	await importProject(page, 'Second', { 'notes/guide.md': '# Guide\n' });
	const second = await projectRoot(page, 'Second');
	await expand(page, 'Second');
	const notes = second.locator('[data-project-folder="notes"]');
	await ensureExpanded(notes);
	const guide = notes.locator('[data-project-document="notes/guide.md"]');
	const original = (await storedState(page)).drafts.find(
		(draft) => draft.relativePath === 'notes/guide.md'
	)!;
	await guide.locator('[data-project-action="move-document"]').click();
	const dialog = page.getByRole('dialog', { name: 'Déplacer ou copier' });
	await dialog.getByTestId('project-move-project').selectOption({ label: 'First' });
	await dialog.getByTestId('project-move-folder').fill('archive');
	await dialog.getByTestId('project-move-submit').click();
	const first = await projectRoot(page, 'First');
	await ensureExpanded(first.locator('[data-project-folder="archive"]'));
	await expect(first.locator('[data-project-document="archive/guide.md"]')).toBeVisible();
	const state = await storedState(page);
	const moved = state.drafts.find((draft) => draft.id === original.id)!;
	expect(moved.relativePath).toBe('archive/guide.md');
	expect(moved.projectId).not.toBe(original.projectId);
	expect(state.drafts.some((draft) => draft.relativePath === 'notes/guide.md')).toBe(false);
	await info.attach('project-cross-project-move.json', {
		body: JSON.stringify({ original, moved }, null, 2),
		contentType: 'application/json'
	});
});

test('bounded rendering keeps a large project responsive', async ({ page }, info) => {
	await page.evaluate(async () => {
		await new Promise<void>((resolve, reject) => {
			const request = indexedDB.open('mdsh');
			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				const database = request.result;
				const transaction = database.transaction(['projects', 'drafts'], 'readwrite');
				transaction.objectStore('projects').put({
					id: 'large-project',
					name: 'Large project',
					createdAt: 1,
					updatedAt: 1
				});
				for (let index = 0; index < 320; index++) {
					transaction.objectStore('drafts').put({
						id: `large-${index}`,
						name: `Note ${String(index).padStart(3, '0')}.md`,
						content: '# Note\n',
						projectId: 'large-project',
						relativePath: `bulk/Note ${String(index).padStart(3, '0')}.md`,
						createdAt: 1,
						updatedAt: 1,
						order: index,
						open: true
					});
				}
				transaction.oncomplete = () => {
					database.close();
					resolve();
				};
				transaction.onerror = () => reject(transaction.error);
			};
		});
	});
	await page.reload();
	const root = await projectRoot(page, 'Large project');
	await expand(page, 'Large project');
	const folder = root.locator('[data-project-folder="bulk"]');
	await ensureExpanded(folder);
	const rows = folder.locator('[data-project-document]');
	await page.evaluate(() => {
		const samples: number[] = [];
		let previous = performance.now();
		const timer = setInterval(() => {
			const now = performance.now();
			samples.push(now - previous);
			previous = now;
		}, 16);
		Object.assign(window, {
			explorerHeartbeat: () => {
				clearInterval(timer);
				samples.push(performance.now() - previous);
				return { samples, maxGapMs: Math.max(...samples) };
			}
		});
	});
	await expect(rows).toHaveCount(150);
	await expect(root.getByRole('button', { name: 'Afficher les 320 fichiers' })).toBeVisible();
	const started = performance.now();
	await root.getByRole('button', { name: 'Afficher les 320 fichiers' }).click();
	await expect(rows).toHaveCount(320);
	const elapsedMs = performance.now() - started;
	const heartbeat = await page.evaluate(() =>
		(
			window as unknown as {
				explorerHeartbeat: () => { samples: number[]; maxGapMs: number };
			}
		).explorerHeartbeat()
	);
	expect(elapsedMs).toBeLessThan(3000);
	expect(heartbeat.maxGapMs).toBeLessThan(1000);
	await info.attach('project-explorer-performance.json', {
		body: JSON.stringify(
			{
				fixture: '320 documents in one folder',
				initialRenderedRows: 150,
				finalRenderedRows: 320,
				elapsedMs,
				heartbeat
			},
			null,
			2
		),
		contentType: 'application/json'
	});
	await info.attach('project-explorer-performance.png', {
		body: await page.screenshot(),
		contentType: 'image/png'
	});
});

test.afterEach(async ({ page, browser }, info) => {
	await info.attach('project-explorer-run.json', {
		body: JSON.stringify(
			{
				command:
					process.env.PROJECT_EXPLORER_TEST_COMMAND ??
					'npx playwright test e2e/project-explorer.spec.ts --project=chromium --workers=1 --retries=0',
				revision,
				environment: {
					node: process.version,
					platform: process.platform,
					browser: browser.version(),
					baseURL: info.project.use.baseURL
				},
				test: info.title,
				status: info.status,
				errors: info.errors.map((error) => error.message)
			},
			null,
			2
		),
		contentType: 'application/json'
	});
	if (info.status !== info.expectedStatus) {
		await info.attach('failure-state.png', {
			body: await page.screenshot(),
			contentType: 'image/png'
		});
	}
});

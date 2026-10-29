import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { resetAppState, writeSourceContent } from './helpers';

async function openProjects(page: Page) {
	await page.getByTestId('projects-open').click();
	return page.getByRole('dialog', { name: 'Projets Markdown' });
}

async function importArchive(page: Page, data: Buffer, name: string, info: TestInfo) {
	await info.attach(name, { body: data, contentType: 'application/zip' });
	const panel = await openProjects(page);
	await panel.locator('input[type=file][accept=".zip"]').setInputFiles({
		name,
		mimeType: 'application/zip',
		buffer: data
	});
	return panel;
}

async function downloadBuffer(page: Page, action: () => Promise<void>): Promise<Buffer> {
	const download = page.waitForEvent('download');
	await action();
	const stream = await (await download).createReadStream();
	const parts: Buffer[] = [];
	for await (const part of stream!) parts.push(part);
	return Buffer.concat(parts);
}

async function readProjectDocuments(page: Page) {
	return page.evaluate(
		() =>
			new Promise<Array<{ id: string; content: string; relativePath?: string }>>(
				(resolve, reject) => {
					const opening = indexedDB.open('mdsh');
					opening.onerror = () => reject(opening.error);
					opening.onsuccess = () => {
						const request = opening.result.transaction('drafts').objectStore('drafts').getAll();
						request.onerror = () => reject(request.error);
						request.onsuccess = () =>
							resolve(
								(
									request.result as Array<{ id: string; content: string; relativePath?: string }>
								).filter((row) => row.relativePath)
							);
					};
				}
			)
	);
}

test.beforeEach(async ({ page }) => resetAppState(page));

test('rejects case variants of the reserved metadata directory', async ({ page }, info) => {
	const zip = new (await import('jszip')).default();
	zip.file('README.md', '# Safe document');
	zip.file('.MDSH/project.json', '{"name":"replacement"}');
	const panel = await importArchive(
		page,
		await zip.generateAsync({ type: 'nodebuffer' }),
		'reserved-case.zip',
		info
	);
	await expect(panel.getByRole('alert')).toBeVisible();
	await expect(panel.locator('[data-project-document]')).toHaveCount(0);
	expect(await readProjectDocuments(page)).toEqual([]);
});

test('rename encodes parentheses and preserves protected Markdown examples', async ({
	page
}, info) => {
	const source = [
		'# Links',
		'',
		'[Live](target.md)',
		'',
		'> ```md',
		'> [Quoted](target.md)',
		'> ```',
		'',
		'- ```md',
		'  [Listed](target.md)',
		'  ```',
		'',
		'<pre>',
		'[Raw](target.md)',
		'</pre>'
	].join('\n');
	const zip = new (await import('jszip')).default();
	zip.file('README.md', source);
	zip.file('target.md', '# Target');
	let panel = await importArchive(
		page,
		await zip.generateAsync({ type: 'nodebuffer' }),
		'protected-links.zip',
		info
	);
	await panel.getByRole('button', { name: 'Ouvrir target.md', exact: true }).click();
	await expect(page.locator('.cm-content')).toBeFocused();
	panel = await openProjects(page);
	const target = panel.getByRole('button', { name: 'Ouvrir target.md', exact: true });
	await target.focus();
	await page.keyboard.press('Enter');
	const name = page.locator('#app-toolbar input');
	await name.fill('target)');
	await name.press('Enter');
	await expect(name).toHaveValue('target)');
	await expect
		.poll(async () => {
			const documents = await readProjectDocuments(page);
			return {
				renamed: documents.some((row) => row.relativePath === 'target).md'),
				readme: documents.find((row) => row.relativePath === 'README.md')
			};
		})
		.toMatchObject({
			renamed: true,
			readme: {
				content: source.replace('[Live](target.md)', '[Live](target%29.md)')
			}
		});
});

test('reports a reference-style remote image without a network request', async ({ page }, info) => {
	const zip = new (await import('jszip')).default();
	zip.file(
		'notes/start.md',
		'# Start\n\n![Remote][hero]\n\n[hero]: https://example.invalid/pixel.png'
	);
	const requests: string[] = [];
	page.on('request', (request) => {
		if (request.url().includes('example.invalid')) requests.push(request.url());
	});
	const panel = await importArchive(
		page,
		await zip.generateAsync({ type: 'nodebuffer' }),
		'reference-image.zip',
		info
	);
	await panel.getByRole('button', { name: 'Vérifier les liens', exact: true }).click();
	await expect(panel.locator('[data-project-link-report]')).toContainText(
		'https://example.invalid/pixel.png'
	);
	expect(requests).toEqual([]);
});

test('reports a basename-only wiki link with multiple project targets as ambiguous', async ({
	page
}, info) => {
	const zip = new (await import('jszip')).default();
	zip.file('index.md', '# Home\n\n[[topic]]');
	zip.file('a/topic.md', '# Topic A');
	zip.file('b/topic.md', '# Topic B');
	const panel = await importArchive(
		page,
		await zip.generateAsync({ type: 'nodebuffer' }),
		'ambiguous-wiki.zip',
		info
	);
	await panel.getByRole('button', { name: 'Vérifier les liens', exact: true }).click();
	const report = panel.locator('[data-project-link-report]');
	await expect(report).toContainText('index.md: topic');
	await expect(report).toContainText('Lien wiki ambigu');
	await expect(report).not.toContainText('Tous les liens locaux sont résolus.');
	await panel.getByRole('button', { name: 'Ouvrir index.md', exact: true }).click();
	await page.locator('[data-mode=read]').click();
	await page.locator('.mdsh-preview a.wiki-link').click();
	await expect(page.locator('.mdsh-preview h1')).toHaveText('Home');
});

test('export keeps a generated image asset after a case-folded path collision', async ({
	page
}, info) => {
	const data = Buffer.from('portable generated image');
	const hash = createHash('sha256').update(data).digest('hex');
	const dataUri = `data:image/png;base64,${data.toString('base64')}`;
	const zip = new (await import('jszip')).default();
	zip.file('README.md', `# Images\n\n![Generated](${dataUri})`);
	zip.file(`ASSETS/image-${hash}.png`, Buffer.from('existing asset'));
	const panel = await importArchive(
		page,
		await zip.generateAsync({ type: 'nodebuffer' }),
		'asset-collision.zip',
		info
	);
	const output = await downloadBuffer(page, () =>
		panel.getByRole('button', { name: 'Exporter le projet', exact: true }).click()
	);
	await info.attach('asset-collision-output.zip', {
		body: output,
		contentType: 'application/zip'
	});
	const exported = await (await import('jszip')).default.loadAsync(output);
	const paths = Object.values(exported.files)
		.filter((entry) => !entry.dir)
		.map((entry) => entry.name);
	expect(new Set(paths.map((path) => path.toLowerCase())).size).toBe(paths.length);
	expect(await exported.file(`ASSETS/image-${hash}.png`)!.async('string')).toBe('existing asset');
	const markdown = await exported.file('README.md')!.async('string');
	const generatedPath = /\]\(([^)]*\/image-[^)]+\.png)\)/i.exec(markdown)?.[1];
	expect(generatedPath).toBeTruthy();
	expect(await exported.file(generatedPath!)!.async('nodebuffer')).toEqual(data);
});

test('export rejects a ZIP whose generated directory entries exceed the import limit', async ({
	page
}, info) => {
	test.setTimeout(60_000);
	const zip = new (await import('jszip')).default();
	zip.file('README.md', '# Entry limit');
	for (let index = 0; index < 1299; index++) {
		zip.file(`assets-${index}/item.bin`, 'x', { createFolders: false });
	}
	const panel = await importArchive(
		page,
		await zip.generateAsync({ type: 'nodebuffer' }),
		'entry-limit.zip',
		info
	);
	await panel.getByRole('button', { name: 'Exporter le projet', exact: true }).click();
	await expect(panel.getByRole('alert')).toBeVisible();
});

test('exports internal wiki IDs as portable relative paths without changing source', async ({
	page
}, info) => {
	const zip = new (await import('jszip')).default();
	zip.file('README.md', '# Home');
	zip.file('notes/guide.md', '# Guide\n\n## Details');
	let panel = await importArchive(
		page,
		await zip.generateAsync({ type: 'nodebuffer' }),
		'wiki-id.zip',
		info
	);
	await expect(
		panel.getByRole('button', { name: 'Ouvrir notes/guide.md', exact: true })
	).toBeVisible();
	const guide = (await readProjectDocuments(page)).find(
		(document) => document.relativePath === 'notes/guide.md'
	)!;
	await panel.getByRole('button', { name: 'Ouvrir README.md', exact: true }).click();
	const source = `# Home\n\n[[${guide.id}#details|Guide by ID]]`;
	await writeSourceContent(page, source);
	panel = await openProjects(page);
	await panel.getByRole('button', { name: 'Vérifier les liens', exact: true }).click();
	await expect(panel.locator('[data-project-link-report]')).toHaveText(
		'Tous les liens locaux sont résolus.'
	);
	const output = await downloadBuffer(page, () =>
		panel.getByRole('button', { name: 'Exporter le projet', exact: true }).click()
	);
	const exported = await (await import('jszip')).default.loadAsync(output);
	expect(await exported.file('README.md')!.async('string')).toContain(
		'[[notes/guide.md#details|Guide by ID]]'
	);
	expect(
		(await readProjectDocuments(page)).find((document) => document.relativePath === 'README.md')
			?.content
	).toBe(source);
});

test('keeps reserved wiki characters encoded through rename and reimport', async ({
	page
}, info) => {
	const zip = new (await import('jszip')).default();
	zip.file('README.md', '# Home\n\n[[target|Special target]]');
	zip.file('target.md', '# Special target');
	let panel = await importArchive(
		page,
		await zip.generateAsync({ type: 'nodebuffer' }),
		'wiki-special.zip',
		info
	);
	await panel.getByRole('button', { name: 'Ouvrir target.md', exact: true }).click();
	const name = page.locator('#app-toolbar input');
	await name.fill('target[]#');
	await name.press('Enter');
	await expect
		.poll(async () =>
			(await readProjectDocuments(page)).find((document) => document.relativePath === 'README.md')
		)
		.toMatchObject({ content: '# Home\n\n[[target%5B%5D%23|Special target]]' });
	panel = await openProjects(page);
	await panel.getByRole('button', { name: 'Ouvrir README.md', exact: true }).click();
	await page.locator('[data-mode=read]').click();
	await page.locator('.mdsh-preview a').filter({ hasText: 'Special target' }).click();
	await expect(page.locator('.mdsh-preview h1')).toHaveText('Special target');
	panel = await openProjects(page);
	const output = await downloadBuffer(page, () =>
		panel.getByRole('button', { name: 'Exporter le projet', exact: true }).click()
	);
	const exported = await (await import('jszip')).default.loadAsync(output);
	expect(await exported.file('README.md')!.async('string')).toContain(
		'[[target%5B%5D%23|Special target]]'
	);
	expect(exported.file('target[]#.md')).not.toBeNull();
	await resetAppState(page);
	panel = await importArchive(page, output, 'wiki-special-reimport.zip', info);
	await panel.getByRole('button', { name: 'Ouvrir README.md', exact: true }).click();
	await page.locator('[data-mode=read]').click();
	await page.locator('.mdsh-preview a').filter({ hasText: 'Special target' }).click();
	await expect(page.locator('.mdsh-preview h1')).toHaveText('Special target');
});

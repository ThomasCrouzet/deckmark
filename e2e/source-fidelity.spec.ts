import { test, expect } from '@playwright/test';
import { resetAppState, seedFiles, openPalette, createFirstFile } from './helpers';
import { fidelityFixtures, sentence, replacement } from './fixtures/source-fidelity';
import {
	editSentence,
	editCodeLine,
	exportSource,
	importSource,
	recordFidelity,
	installFidelityCounters,
	readFidelityCounters
} from './source-fidelity-harness';

test.beforeEach(async ({ page }) => {
	await installFidelityCounters(page);
});

test.afterEach(async ({ page }, info) => {
	if (info.status === 'skipped') return;
	const pathCounts = await readFidelityCounters(page);
	const expectedFullSerializer = Number(
		info.annotations.find((item) => item.type === 'source-fidelity-full-serializer')?.description ??
			0
	);
	await info.attach('source-fidelity-path-counts.json', {
		body: JSON.stringify({ pathCounts, expectedFullSerializer }),
		contentType: 'application/json'
	});
	expect(pathCounts.fullSerializer, 'Unexpected full serializer fallback in this corpus case').toBe(
		expectedFullSerializer
	);
	if (info.title.startsWith('one sentence changes only required bytes:')) {
		expect(
			pathCounts.fastPath + pathCounts.blockFallback + pathCounts.fullSerializer,
			'The visual corpus must exercise the source fidelity counters'
		).toBeGreaterThan(0);
	}
});

test('a visual editor visit preserves the exact Markdown source without an edit', async ({
	page
}, info) => {
	await resetAppState(page);
	const source =
		'---\ntitle: Source fidelity\n---\n\nHeading\n=======\n\n* first\n* second\n\n[Example][target]\n\n[target]: https://example.invalid/ "Title"\n\n~~~text\nraw sample\n~~~\n\n<div>Raw HTML</div>\n';
	await seedFiles(page, [{ name: 'fidelity', content: source }]);
	await page.locator('[data-mode=wysiwyg]').click();
	await expect(page.locator('.ProseMirror')).toBeVisible();
	await page.locator('[data-mode=read]').click();
	await expect(page.locator('.mdsh-preview h1')).toHaveText('Heading');
	await page.locator('[data-mode=source]').click();
	await openPalette(page);
	await page.getByRole('combobox').fill('Exporter tous les fichiers (ZIP)');
	const download = page.waitForEvent('download');
	await page.keyboard.press('Enter');
	const chunks: Buffer[] = [];
	for await (const chunk of (await (await download).createReadStream())!) chunks.push(chunk);
	const bytes = Buffer.concat(chunks);
	const zip = await (await import('jszip')).default.loadAsync(bytes);
	expect(await zip.file('fidelity.md')!.async('string')).toBe(source);
	await info.attach('source.md', { body: source, contentType: 'text/markdown' });
	await info.attach('unchanged-source.zip', { body: bytes, contentType: 'application/zip' });
});

test('library export rejects more than 300 documents before a download', async ({ page }, info) => {
	await resetAppState(page);
	await page.evaluate(
		() =>
			new Promise<void>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const db = request.result;
					const tx = db.transaction('drafts', 'readwrite');
					for (let i = 0; i < 301; i++)
						tx.objectStore('drafts').put({
							id: `limit-${i}`,
							name: `limit-${i}.md`,
							content: '# Limit',
							updatedAt: Date.now(),
							order: i,
							open: false
						});
					tx.oncomplete = () => {
						db.close();
						resolve();
					};
					tx.onabort = () => {
						db.close();
						reject(tx.error);
					};
				};
			})
	);
	await page.reload();
	const downloads: string[] = [];
	page.on('download', (download) => downloads.push(download.suggestedFilename()));
	await openPalette(page);
	await page.getByRole('combobox').fill('Exporter tous les fichiers (ZIP)');
	await page.keyboard.press('Enter');
	await expect(page.getByRole('alert')).toContainText('La création du ZIP a échoué.');
	expect(downloads).toEqual([]);
	await info.attach('library-limit.png', {
		body: await page.screenshot(),
		contentType: 'image/png'
	});
});

for (const fixture of fidelityFixtures) {
	test(`one sentence changes only required bytes: ${fixture.id}`, async ({ page }, info) => {
		await resetAppState(page);
		await importSource(page, fixture.source, fixture.id);
		await page.locator('[data-mode=wysiwyg]').click();
		if (fixture.id === 'inline-code-boundary') {
			await editSentence(page, sentence, '');
			await page.keyboard.type(replacement);
		} else if (
			['code-block', 'code-block-crlf', 'code-info-collision', 'indented-code'].includes(fixture.id)
		) {
			await expect(page.locator('.ProseMirror')).toBeVisible();
			await page
				.locator('.milkdown-code-block')
				.filter({ hasText: sentence })
				.scrollIntoViewIfNeeded();
			await editCodeLine(page, sentence, replacement, '.milkdown-code-block .cm-content');
		} else await editSentence(page, sentence, replacement);
		const actual = await exportSource(page);
		await recordFidelity(info, page, fixture.id, fixture.source, fixture.expected, actual);
	});
}

test('a sentence across inline marks keeps the other source spans', async ({ page }, info) => {
	await resetAppState(page);
	const source = fidelityFixtures[0]!.source.replace(sentence, 'The __small__ bird sings.');
	await importSource(page, source);
	await page.locator('[data-mode=wysiwyg]').click();
	await editSentence(page, sentence, '');
	await page.keyboard.type(replacement);
	await recordFidelity(
		info,
		page,
		'across-marks',
		source,
		source.replace('The __small__ bird sings.', replacement),
		await exportSource(page)
	);
});

test('literal syntax in a visual sentence keeps its meaning and nearby bytes', async ({
	page
}, info) => {
	await resetAppState(page);
	const source = fidelityFixtures[0]!.source;
	await importSource(page, source);
	await page.locator('[data-mode=wysiwyg]').click();
	const text = 'A *literal* [sentence] & a bird.';
	await editSentence(page, sentence, text, true);
	await recordFidelity(
		info,
		page,
		'literal-syntax',
		source,
		source.replace(sentence, 'A \\*literal\\* \\[sentence] & a bird.'),
		await exportSource(page)
	);
	await page.locator('[data-mode=read]').click();
	await expect(page.locator('.mdsh-preview')).toContainText(text);
});

test('undo, redo, two edits, mode changes, and reload keep source bytes', async ({
	page
}, info) => {
	await resetAppState(page);
	const source = fidelityFixtures[0]!.source;
	await importSource(page, source);
	await page.locator('[data-mode=wysiwyg]').click();
	await editSentence(page, sentence, replacement);
	await page.keyboard.press('ControlOrMeta+z');
	await expect(page.locator('.ProseMirror')).toContainText(sentence);
	await recordFidelity(info, page, 'undo', source, source, await exportSource(page));
	await page.locator('.ProseMirror').click();
	await page.keyboard.press('ControlOrMeta+Shift+z');
	await expect(page.locator('.ProseMirror')).toContainText(replacement);
	await editSentence(page, 'Keep the final paragraph.', 'Keep the last paragraph.');
	const expected = source
		.replace(sentence, replacement)
		.replace('Keep the final paragraph.', 'Keep the last paragraph.');
	await page.locator('[data-mode=source]').click();
	await page.locator('[data-mode=read]').click();
	await recordFidelity(info, page, 'two-edits', source, expected, await exportSource(page));
	await page.reload();
	await page.locator('[data-mode=wysiwyg]').click();
	await expect(page.locator('.ProseMirror')).toContainText(replacement);
	await editSentence(page, replacement, 'The green bird sings.');
	await recordFidelity(
		info,
		page,
		'reload-edit',
		source,
		expected.replace(replacement, 'The green bird sings.'),
		await exportSource(page)
	);
});

for (const mode of ['source', 'split'] as const) {
	for (const newline of ['lf', 'crlf', 'mixed'] as const) {
		test(`a ${mode} edit retains ${newline} line endings`, async ({ page }, info) => {
			await resetAppState(page);
			let source = `Heading\n=======\n\n${sentence}\n\n* Keep this.\n`;
			if (newline === 'crlf') source = source.replaceAll('\n', '\r\n');
			if (newline === 'mixed')
				source = source
					.replace('Heading\n', 'Heading\r\n')
					.replace(`${sentence}\n`, `${sentence}\r\n`);
			await importSource(page, source);
			await page.locator('[data-mode=source]').click();
			if (mode === 'split') await page.getByTestId('split-view-toggle').click();
			await editCodeLine(page, sentence, replacement);
			await recordFidelity(
				info,
				page,
				`${mode}-${newline}`,
				source,
				source.replace(sentence, replacement),
				await exportSource(page)
			);
		});
	}
}

test('repeated text keeps its occurrence and flushes before a tab switch', async ({
	page
}, info) => {
	await resetAppState(page);
	const source = fidelityFixtures[0]!.source
		.replace('title: "Source fidelity"', 'title: "first"')
		.replace(sentence, `${sentence}\n\n${sentence}`);
	await importSource(page, source, 'first');
	await importSource(page, 'Keep the other document.\n', 'second');
	await page.locator('aside').getByRole('button', { name: /first/ }).first().click();
	await page.locator('[data-mode=wysiwyg]').click();
	await editSentence(page, sentence, replacement);
	await page
		.locator('aside')
		.getByRole('button', { name: /second/ })
		.first()
		.click();
	await expect(page.locator('.ProseMirror')).toContainText('Keep the other document.');
	await page.locator('aside').getByRole('button', { name: /first/ }).first().click();
	await expect(page.locator('.ProseMirror')).toContainText(replacement);
	await recordFidelity(
		info,
		page,
		'repeated-tab-flush',
		source,
		source.replace(sentence, replacement),
		await exportSource(page, 'first.md')
	);
});

test('an edit in a large document preserves all other source spans', async ({ page }, info) => {
	await resetAppState(page);
	const source =
		fidelityFixtures[0]!.source +
		Array.from(
			{ length: 400 },
			(_, index) =>
				`\nSection ${index}\n------------\n\n* Keep item ${index}.\n\nKeep &amp; paragraph ${index}.\n`
		).join('');
	await importSource(page, source);
	await page.locator('[data-mode=wysiwyg]').click();
	await editSentence(page, sentence, replacement);
	await recordFidelity(
		info,
		page,
		'large-document',
		source,
		source.replace(sentence, replacement),
		await exportSource(page)
	);
});

for (const mode of ['source', 'wysiwyg'] as const) {
	test(`a ${mode} edit keeps the UTF-8 byte order mark and front matter`, async ({
		page
	}, info) => {
		await resetAppState(page);
		const source =
			'\uFEFF' +
			(mode === 'source'
				? `---\ntitle: BOM\n---\n\nOriginal heading\n================\n\n${sentence}\n`
				: fidelityFixtures[0]!.source);
		await importSource(page, source);
		await page.locator(`[data-mode=${mode}]`).click();
		if (mode === 'wysiwyg') await editSentence(page, sentence, replacement);
		else await editCodeLine(page, sentence, replacement);
		await recordFidelity(
			info,
			page,
			`bom-${mode}`,
			source,
			source.replace(sentence, replacement),
			await exportSource(page)
		);
		await page.locator('[data-mode=read]').click();
		await expect(page.locator('.mdsh-preview h1')).toHaveText('Original heading');
	});
}

test('an edit keeps reference definitions inside a quote', async ({ page }, info) => {
	await resetAppState(page);
	const source =
		fidelityFixtures[0]!.source.replace(sentence, 'An unchanged sentence.') +
		`\n> [local]: https://example.invalid/\n>\n> ${sentence}\n>\n> * Keep [this][local].\n`;
	await importSource(page, source);
	await page.locator('[data-mode=wysiwyg]').click();
	await editSentence(page, sentence, replacement);
	await recordFidelity(
		info,
		page,
		'nested-definition',
		source,
		source.replace(sentence, replacement),
		await exportSource(page)
	);
});

test('an edit keeps an explicit default image scale', async ({ page }, info) => {
	await resetAppState(page);
	const source =
		`![Keep alt](data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7)\n<!-- mdsh:image ratio=1.00 -->\n\n` +
		fidelityFixtures[0]!.source.replace(
			'---\ntitle: "Source fidelity"\ntags: [one, two]\n---\n',
			''
		);
	await importSource(page, source);
	await page.locator('[data-mode=wysiwyg]').click();
	await editSentence(page, sentence, replacement);
	await recordFidelity(
		info,
		page,
		'default-image-scale',
		source,
		source.replace(sentence, replacement),
		await exportSource(page)
	);
});

test('a linked disk file keeps its BOM and rejects an external revision', async ({
	page,
	browserName
}, info) => {
	test.skip(browserName !== 'chromium', 'The browser file picker requires Chromium.');
	await resetAppState(page);
	const source = '\uFEFFHeading\r\n=======\r\n\r\n' + sentence + '\r\n';
	await page.evaluate(async (source) => {
		const root = await navigator.storage.getDirectory();
		const handle = await root.getFileHandle('bom-disk.md', { create: true });
		const writer = await handle.createWritable();
		await writer.write(source);
		await writer.close();
		Object.defineProperty(window, 'showOpenFilePicker', {
			configurable: true,
			value: async () => [handle]
		});
	}, source);
	await page
		.locator('aside')
		.getByRole('button', { name: /^Importer un fichier markdown/ })
		.click();
	await page.locator('[data-mode=wysiwyg]').click();
	await editSentence(page, sentence, replacement);
	await page.getByRole('button', { name: 'Enregistrer sur le disque', exact: true }).click();
	const diskBytes = () =>
		page.evaluate(async () => {
			const file = await (
				await (await navigator.storage.getDirectory()).getFileHandle('bom-disk.md')
			).getFile();
			return Array.from(new Uint8Array(await file.arrayBuffer()));
		});
	const expected = source.replace(sentence, replacement);
	const committedSnapshot = async (expected: string, phase: string) => {
		let bytes: Buffer = Buffer.alloc(0);
		await expect(async () => {
			bytes = Buffer.from(await diskBytes());
			expect(bytes).toEqual(Buffer.from(expected, 'utf8'));
		}).toPass({ timeout: 10_000 });
		await info.attach(`${phase}-disk-bytes.md`, {
			body: bytes,
			contentType: 'text/markdown'
		});
		return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
	};
	await recordFidelity(
		info,
		page,
		'bom-disk-save',
		source,
		expected,
		await committedSnapshot(expected, 'bom-disk-save')
	);
	const external = expected.replace(replacement, 'An external sentence.');
	await page.evaluate(async (text) => {
		const writer = await (
			await (await navigator.storage.getDirectory()).getFileHandle('bom-disk.md')
		).createWritable();
		await writer.write(text);
		await writer.close();
	}, external);
	await editSentence(page, replacement, 'A later local sentence.');
	await page.getByRole('button', { name: 'Enregistrer sur le disque', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Résoudre le conflit disque pour bom-disk.md' });
	await expect(dialog).toContainText('An external sentence.');
	await expect(dialog).toContainText('A later local sentence.');
	await page.keyboard.press('Escape');
	await recordFidelity(
		info,
		page,
		'bom-disk-conflict',
		source,
		external,
		await committedSnapshot(external, 'bom-disk-conflict')
	);
});

test('a BOM without front matter keeps the source outline and bytes', async ({ page }, info) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await resetAppState(page);
	const source = '\uFEFF# Visible heading\n\n' + sentence + '\n';
	await importSource(page, source);
	await expect(
		page.locator('.mdsh-toc-col nav').getByRole('button', { name: 'Visible heading', exact: true })
	).toBeVisible();
	await editCodeLine(page, sentence, replacement);
	await recordFidelity(
		info,
		page,
		'bom-source-outline',
		source,
		source.replace(sentence, replacement),
		await exportSource(page)
	);
});

test('typing in an empty visual document adds no surrounding blank lines', async ({
	page
}, info) => {
	await resetAppState(page);
	await createFirstFile(page);
	await page.locator('[data-mode=wysiwyg]').click();
	await page.locator('.ProseMirror').click();
	await page.keyboard.type(sentence);
	await recordFidelity(info, page, 'empty-document', '', sentence, await exportSource(page));
});

test('two sentence edits in one paragraph keep the source between them', async ({ page }, info) => {
	await resetAppState(page);
	const source = fidelityFixtures[0]!.source.replace(
		sentence,
		`${sentence} Keep &amp; this soft\nwrap. Another small bird sings.`
	);
	await importSource(page, source);
	await page.locator('[data-mode=wysiwyg]').click();
	await editSentence(page, sentence, replacement);
	await editSentence(page, 'Another small bird sings.', 'Another bright bird sings.');
	const expected = source
		.replace(sentence, replacement)
		.replace('Another small bird sings.', 'Another bright bird sings.');
	await recordFidelity(
		info,
		page,
		'two-sentences-one-paragraph',
		source,
		expected,
		await exportSource(page)
	);
});

test('a JSON backup with a BOM retains the Markdown BOM after restore', async ({ page }, info) => {
	await resetAppState(page);
	const source = '\uFEFF' + fidelityFixtures[0]!.source;
	const backup =
		'\uFEFF' +
		JSON.stringify({
			format: 'mdsh-backup',
			schemaVersion: 1,
			exportedAt: 1_725_000_000_000,
			drafts: [
				{
					id: 'bom-backup',
					name: 'bom-backup.md',
					content: source,
					createdAt: 1_725_000_000_000,
					updatedAt: 1_725_000_000_100,
					order: 0
				}
			],
			workspaces: [],
			templates: []
		});
	await info.attach('bom-backup.json', { body: backup, contentType: 'application/json' });
	await page.keyboard.press('ControlOrMeta+,');
	await page.locator('input[type=file][accept*="json"]').setInputFiles({
		name: 'bom-backup.json',
		mimeType: 'application/json',
		buffer: Buffer.from(backup)
	});
	const dialog = page.getByRole('dialog', { name: 'Restaurer la sauvegarde' });
	await dialog.getByRole('button', { name: 'Remplacer', exact: true }).click();
	await expect(dialog).toBeHidden();
	await expect(page.getByRole('status').filter({ hasText: 'Sauvegarde restaurée' })).toBeVisible();
	await page.keyboard.press('Escape');
	await page.locator('[data-mode=wysiwyg]').click();
	await editSentence(page, sentence, replacement);
	await recordFidelity(
		info,
		page,
		'bom-backup-restore',
		source,
		source.replace(sentence, replacement),
		await exportSource(page)
	);
});

for (const yaml of [false, true]) {
	test(`a presentation visit keeps a BOM with front matter ${yaml}`, async ({ page }, info) => {
		await resetAppState(page);
		const source =
			'\uFEFF' +
			(yaml ? '---\ntitle: BOM slide\n---\n\n' : '') +
			'# Single slide\n\n' +
			sentence +
			'\n';
		await importSource(page, source);
		await page.getByTestId('slides-open').click();
		const editor = page.getByTestId('presentation-editor');
		await expect(editor.getByTestId('slide-thumbnail')).toHaveCount(1);
		await editor.getByTestId('slide-close').click();
		await recordFidelity(
			info,
			page,
			`bom-presentation-${yaml}`,
			source,
			source,
			await exportSource(page)
		);
		await page.getByTestId('slides-open').click();
		await editor.locator('[data-testid=slide-object][data-object-type=text]').first().dblclick();
		await editor.getByTestId('slide-text-editor').fill('# Single slide\n\n' + replacement);
		await editor.getByTestId('slide-text-done').click();
		await editor.getByTestId('slide-source').click();
		const converted = await editor.getByTestId('slide-source-editor').inputValue();
		expect(converted.startsWith('\uFEFF')).toBe(true);
		expect(converted.startsWith('\uFEFF\n')).toBe(false);
		if (yaml) expect(converted.startsWith('\uFEFF---\ntitle: BOM slide\n---\n')).toBe(true);
		expect(converted).toContain(replacement);
		await info.attach(`bom-converted-${yaml}.md`, {
			body: converted,
			contentType: 'text/markdown'
		});
	});
}

test('a project rename keeps BOM front matter and code examples exact', async ({ page }, info) => {
	await resetAppState(page);
	const body = '[[target]] and [body](target.md).\n';
	const sources = {
		'README.md':
			'\uFEFF---\ntitle: Links\nnote: "[[target]] and [sample](target.md)"\n---\n\n' + body,
		'code.md': '\uFEFF~~~md\n[[target]] and [sample](target.md)\n~~~\n\n' + body
	};
	const zip = new (await import('jszip')).default();
	for (const [name, source] of Object.entries(sources)) zip.file(name, source);
	zip.file('target.md', '# Target\n');
	await page.getByTestId('projects-open').click();
	let panel = page.getByRole('dialog', { name: 'Projets Markdown' });
	await panel.locator('input[type=file][accept=".zip"]').setInputFiles({
		name: 'bom-links.zip',
		mimeType: 'application/zip',
		buffer: await zip.generateAsync({ type: 'nodebuffer' })
	});
	await panel.getByRole('button', { name: 'Ouvrir target.md', exact: true }).click();
	const name = page.locator('#app-toolbar input');
	await name.fill('renamed');
	await name.press('Enter');
	await expect(name).toHaveValue('renamed');
	await page.getByTestId('projects-open').click();
	panel = page.getByRole('dialog', { name: 'Projets Markdown' });
	await expect(panel.getByRole('button', { name: 'Ouvrir renamed.md', exact: true })).toBeVisible();
	const download = page.waitForEvent('download');
	await panel.getByRole('button', { name: 'Exporter le projet', exact: true }).click();
	const chunks: Buffer[] = [];
	for await (const chunk of (await (await download).createReadStream())!) chunks.push(chunk);
	const exported = await (await import('jszip')).default.loadAsync(Buffer.concat(chunks));
	for (const [name, source] of Object.entries(sources)) {
		const expected = source.replace('\n\n' + body, '\n\n[[renamed]] and [body](renamed.md).\n');
		await recordFidelity(
			info,
			page,
			`bom-project-${name}`,
			source,
			expected,
			await exported.file(name)!.async('string')
		);
	}
});

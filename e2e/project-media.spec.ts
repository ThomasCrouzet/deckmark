import { test, expect } from '@playwright/test';
import { resetAppState, openPalette } from './helpers';

const png =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('visual project images never request private relative paths', async ({
	page,
	context
}, info) => {
	await resetAppState(page);
	const privateRequests: string[] = [];
	page.on('request', (request) => {
		const url = new URL(request.url());
		if (url.pathname.startsWith('/assets/private-')) privateRequests.push(url.href);
	});
	const zip = new (await import('jszip')).default();
	zip.file(
		'notes/index.md',
		[
			'# Private media',
			'',
			'![Block](../assets/private-block.png)',
			'',
			'Inline ![Inline](../assets/private-inline.png) image.',
			'',
			'![Missing](../assets/private-customer-map.png?account=alpine)',
			''
		].join('\n')
	);
	zip.file('assets/private-block.png', Buffer.from(png, 'base64'));
	zip.file('assets/private-inline.png', Buffer.from(png, 'base64'));
	zip.file('assets/private-update.png', Buffer.from(png, 'base64'));
	const input = await zip.generateAsync({ type: 'nodebuffer' });
	await info.attach('private-media-project.zip', {
		body: input,
		contentType: 'application/zip'
	});
	await page.getByTestId('projects-open').click();
	const panel = page.getByRole('dialog', { name: 'Projets Markdown' });
	await panel
		.locator('input[type=file][accept=".zip"]')
		.setInputFiles({ name: 'Private-media.zip', mimeType: 'application/zip', buffer: input });
	await panel.getByRole('button', { name: 'Ouvrir notes/index.md', exact: true }).click();
	await page.locator('[data-mode=wysiwyg]').click();
	await expect(page.locator('.milkdown-image-block img')).toHaveCount(2);
	await expect(page.locator('img.image-inline')).toHaveCount(1);
	await expect
		.poll(() =>
			page
				.locator('.ProseMirror img')
				.evaluateAll((images) =>
					images.every((image) => image.getAttribute('src')?.startsWith('data:'))
				)
		)
		.toBe(true);

	const otherTab = await context.newPage();
	await otherTab.goto('/');
	await otherTab.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	await otherTab.locator('[data-mode=source]').click();
	const source = otherTab.locator('.cm-content').first();
	await source.click();
	await otherTab.keyboard.press('ControlOrMeta+a');
	await otherTab.keyboard.insertText(
		[
			'# Updated private media',
			'',
			'![Updated](../assets/private-update.png)',
			'',
			'Inline ![Missing inline](../assets/private-update-missing.png?account=bravo) image.',
			''
		].join('\n')
	);
	await expect(page.locator('.ProseMirror')).toContainText('Updated private media');
	await expect(page.locator('.milkdown-image-block img')).toHaveCount(1);
	await expect(page.locator('img.image-inline')).toHaveCount(1);
	await expect
		.poll(() =>
			page
				.locator('.ProseMirror img')
				.evaluateAll((images) =>
					images.every((image) => image.getAttribute('src')?.startsWith('data:'))
				)
		)
		.toBe(true);
	await otherTab.close();
	await page.waitForTimeout(100);
	await info.attach('private-image-requests.json', {
		body: Buffer.from(JSON.stringify(privateRequests, null, 2)),
		contentType: 'application/json'
	});
	expect(privateRequests).toEqual([]);
});

test('resolves a project image whose reference differs only by path case', async ({
	page
}, info) => {
	await resetAppState(page);
	await page.evaluate(async (base64) => {
		const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
		await new Promise<void>((resolve, reject) => {
			const request = indexedDB.open('mdsh');
			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				const database = request.result;
				const transaction = database.transaction(
					['projects', 'drafts', 'projectAssets'],
					'readwrite'
				);
				transaction.objectStore('projects').put({
					id: 'case-project',
					name: 'Case project',
					createdAt: 1,
					updatedAt: 1
				});
				transaction.objectStore('drafts').put({
					id: 'case-file',
					name: 'page.md',
					content: '# Case\n\n![Diagram](../assets/diagram.png)\n',
					projectId: 'case-project',
					relativePath: 'notes/page.md',
					createdAt: 1,
					updatedAt: 1,
					order: 0,
					open: true
				});
				transaction.objectStore('projectAssets').put({
					id: 'case-asset',
					projectId: 'case-project',
					path: 'Assets/Diagram.PNG',
					mime: 'image/png',
					data: bytes
				});
				transaction.oncomplete = () => {
					database.close();
					resolve();
				};
				transaction.onerror = () => reject(transaction.error);
			};
		});
		localStorage.setItem('mdsh:activeId', 'case-file');
		localStorage.setItem('mdsh:mode', 'source');
	}, png);
	await info.attach('case-media-fixture.json', {
		body: JSON.stringify(
			{
				document: 'notes/page.md',
				reference: '../assets/diagram.png',
				asset: 'Assets/Diagram.PNG'
			},
			null,
			2
		),
		contentType: 'application/json'
	});
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	const reference = '../assets/diagram.png';
	await expect(page.locator('.cm-content')).toContainText(reference);
	await page.locator('[data-mode=read]').click();
	const previewImage = page.locator('.mdsh-preview img');
	await expect(previewImage).toHaveCount(1);
	await expect
		.poll(() => previewImage.evaluate((image: HTMLImageElement) => image.naturalWidth))
		.toBe(1);
	await expect.poll(() => previewImage.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
	await page.locator('[data-mode=wysiwyg]').click();
	const visualImage = page.locator('.ProseMirror img').first();
	await expect
		.poll(() => visualImage.evaluate((image: HTMLImageElement) => image.naturalWidth))
		.toBe(1);
	await page.locator('[data-mode=source]').click();
	await expect(page.locator('.cm-content')).toContainText(reference!);
	await expect(page.locator('.cm-content')).not.toContainText('data:image');
	await info.attach('case-media-preview.png', { body: await page.screenshot() });
});

test('project images retain relative paths through visual editing, drop, and HTML export', async ({
	page
}, info) => {
	await resetAppState(page);
	const zip = new (await import('jszip')).default();
	zip.file('notes/index.md', '# Project media\n\n![Existing](../assets/pixel.png)\n');
	zip.file('assets/pixel.png', Buffer.from(png, 'base64'));
	const input = await zip.generateAsync({ type: 'nodebuffer' });
	await info.attach('media-project.zip', { body: input, contentType: 'application/zip' });
	await page.getByTestId('projects-open').click();
	const panel = page.getByRole('dialog', { name: 'Projets Markdown' });
	await panel
		.locator('input[type=file][accept=".zip"]')
		.setInputFiles({ name: 'Media.zip', mimeType: 'application/zip', buffer: input });
	await panel.getByRole('button', { name: 'Ouvrir notes/index.md', exact: true }).click();
	await page.locator('[data-mode=wysiwyg]').click();
	const visualImage = page.locator('.ProseMirror img').first();
	await expect
		.poll(() => visualImage.evaluate((image: HTMLImageElement) => image.naturalWidth))
		.toBe(1);
	await page.locator('.ProseMirror').click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('Enter');
	await page.keyboard.insertText('Visual addition');
	await page.locator('[data-mode=source]').click();
	await expect(page.locator('.cm-content')).toContainText('../assets/pixel.png');
	await expect(page.locator('.cm-content')).not.toContainText('data:image');
	await page.evaluate((base64) => {
		const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
		const dataTransfer = new DataTransfer();
		dataTransfer.items.add(new File([bytes], 'dropped.png', { type: 'image/png' }));
		window.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
	}, png);
	await expect(page.locator('.cm-content')).toContainText('dropped.png');
	await expect(page.locator('.cm-content')).not.toContainText('data:image');
	await expect(page.locator('#app-statusbar')).toContainText('Brouillons locaux : enregistré');
	await page.reload();
	await page.locator('[data-mode=read]').click();
	await expect(page.locator('.mdsh-preview img')).toHaveCount(2);
	await expect
		.poll(() =>
			page
				.locator('.mdsh-preview img')
				.evaluateAll((images) => images.map((image) => (image as HTMLImageElement).naturalWidth))
		)
		.toEqual([1, 1]);
	await openPalette(page);
	await page.getByRole('combobox').fill('Exporter en HTML');
	const downloaded = page.waitForEvent('download');
	await page.keyboard.press('Enter');
	const parts: Buffer[] = [];
	for await (const part of (await (await downloaded).createReadStream())!) parts.push(part);
	const html = Buffer.concat(parts);
	expect(html.toString()).toContain('data:image/png;base64,');
	await info.attach('project-media.html', { body: html, contentType: 'text/html' });
});

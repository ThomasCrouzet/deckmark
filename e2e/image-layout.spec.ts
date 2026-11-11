import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createFirstFile, resetAppState, writeSourceContent } from './helpers';

test.describe('Embedded image editing and layout', () => {
	test.beforeEach(async ({ page }) => {
		await resetAppState(page);
		await createFirstFile(page);
	});

	test('hides image payloads and keeps the original bytes through editing and export', async ({
		page
	}, testInfo) => {
		const payload = (await readFile('static/pwa-192x192.png')).toString('base64');
		const image = `![Local image](data:image/png;base64,${payload})`;
		await writeSourceContent(page, `# Image data\n\n${image}\n\nLast paragraph.`);
		const source = page.locator('.cm-content');
		await expect(source).not.toContainText(payload);
		await expect(
			source.getByRole('button', { name: 'Afficher les données de l’image' })
		).toBeVisible();
		await source.click();
		await page.keyboard.press('ControlOrMeta+End');
		await page.keyboard.insertText(' More text.');
		await expect(source).toContainText('More text.');
		await page.keyboard.press('ControlOrMeta+z');
		await expect(source).not.toContainText('More text.');
		await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y');
		await expect(source).toContainText('More text.');
		await page.locator('button[data-mode="read"]').click();
		await expect(page.locator('.mdsh-preview img')).toHaveAttribute(
			'src',
			`data:image/png;base64,${payload}`
		);
		await page.locator('button[data-mode="source"]').click();
		await expect
			.poll(() =>
				page.evaluate(
					() =>
						new Promise<boolean>((resolve, reject) => {
							const request = indexedDB.open('mdsh');
							request.onerror = () => reject(request.error);
							request.onsuccess = () => {
								const db = request.result;
								const query = db.transaction('drafts').objectStore('drafts').getAll();
								query.onsuccess = () => {
									db.close();
									resolve(
										query.result.some((draft: { content: string }) =>
											draft.content.includes('More text.')
										)
									);
								};
								query.onerror = () => {
									db.close();
									reject(query.error);
								};
							};
						})
				)
			)
			.toBe(true);
		await page.reload();
		await expect(
			source.getByRole('button', { name: 'Afficher les données de l’image' })
		).toBeVisible();
		await expect(source).toContainText('More text.');
		const download = page.waitForEvent('download');
		await page.keyboard.press('ControlOrMeta+s');
		const path = testInfo.outputPath('embedded-image.md');
		await (await download).saveAs(path);
		expect(await readFile(path, 'utf8')).toContain(image);
		await source.getByRole('button', { name: 'Afficher les données de l’image' }).focus();
		await page.keyboard.press('Enter');
		await expect(source).toContainText(payload);
		await testInfo.attach('portable-markdown', { path, contentType: 'text/markdown' });
	});

	test('keeps the short-document caret policy across embedded image byte boundaries', async ({
		page
	}, testInfo) => {
		const base = (await readFile('static/pwa-192x192.png')).toString('base64');
		const head = '# Boundary\n\nText before the image.\n\n![Figure](data:image/png;base64,';
		const tail = ')\n\nText after the image.\n';
		const stored = () =>
			page.evaluate(
				() =>
					new Promise<string>((resolve, reject) => {
						const id = localStorage.getItem('mdsh:activeId') ?? '';
						const request = indexedDB.open('mdsh');
						request.onerror = () => reject(request.error);
						request.onsuccess = () => {
							const database = request.result;
							const get = database.transaction('drafts').objectStore('drafts').get(id);
							get.onsuccess = () => {
								database.close();
								resolve((get.result as { content?: string } | undefined)?.content ?? '');
							};
							get.onerror = () => reject(get.error);
						};
					})
			);
		const samples: Array<Record<string, unknown>> = [];
		for (const targetBytes of [255, 256, 257].map((size) => size * 1024)) {
			const padding = Math.max(0, targetBytes - head.length - tail.length - base.length);
			const source = `${head}${base}${'A'.repeat(padding)}${tail}`;
			await writeSourceContent(page, source);
			await page.waitForTimeout(1_000);
			await page.locator('button[data-mode="wysiwyg"]').click();
			const dialog = page.getByRole('dialog', {
				name: /Afficher ce document volumineux|Render this large document/
			});
			await dialog.waitFor({ state: 'visible', timeout: 3_000 }).catch(() => {});
			const confirmed = await dialog.isVisible().catch(() => false);
			if (confirmed) {
				await dialog.getByRole('button', { name: /Afficher le document|Render document/ }).click();
			}
			const editor = page.locator('.ProseMirror');
			await expect(editor).toHaveAttribute('contenteditable', 'true', { timeout: 120_000 });
			const host = page.locator('.mdsh-editor');
			const storedBefore = (await stored()).length;
			const longDocument = await host.evaluate((element) =>
				element.classList.contains('mdsh-long-document')
			);
			const virtualCursor = await editor.evaluate((element) =>
				element.classList.contains('virtual-cursor-enabled')
			);
			const paragraph = editor.locator('p', { hasText: 'Text before the image.' });
			await paragraph.click();
			await page.keyboard.press('End');
			const before = await page.evaluate(() => {
				const target = [...document.querySelectorAll('.ProseMirror > p')].find((element) =>
					element.textContent?.includes('Text before the image.')
				);
				const hostElement = document.querySelector('.mdsh-editor');
				return {
					paragraphs: document.querySelectorAll('.ProseMirror > p').length,
					scrollTop: hostElement?.scrollTop ?? 0,
					top: target?.getBoundingClientRect().top ?? 0
				};
			});
			await page.keyboard.insertText('X');
			await expect
				.poll(async () => (await stored()).includes('Text before the image.X'), {
					timeout: 20_000,
					intervals: [250, 500, 1_000]
				})
				.toBe(true);
			const after = await page.evaluate(() => {
				const target = [...document.querySelectorAll('.ProseMirror > p')].find((element) =>
					element.textContent?.includes('Text before the image.X')
				);
				const hostElement = document.querySelector('.mdsh-editor');
				return {
					paragraphs: document.querySelectorAll('.ProseMirror > p').length,
					scrollTop: hostElement?.scrollTop ?? 0,
					top: target?.getBoundingClientRect().top ?? 0
				};
			});
			const saved = await stored();
			samples.push({
				targetBytes,
				sourceBytes: source.length,
				storedBytesBeforeTyping: storedBefore,
				longDocument,
				virtualCursor,
				confirmation: confirmed,
				before,
				after,
				savedBytes: saved.length
			});
			expect(longDocument, 'embedded bytes must not select the long-document class').toBe(false);
			expect(virtualCursor, 'embedded bytes must not disable the caret plugin').toBe(true);
			expect(after.paragraphs, 'typing must not create a blank paragraph').toBe(before.paragraphs);
			expect(after.scrollTop, 'the scroll anchor stays stable').toBe(before.scrollTop);
			expect(Math.abs(after.top - before.top), 'the edited block keeps its position').toBeLessThan(
				2
			);
			expect(saved).toBe(source.replace('Text before the image.', 'Text before the image.X'));
		}
		const referenced =
			'Text before the image.\n\n![Figure](assets/figure.png)\n\nText after the image.\n';
		await writeSourceContent(page, referenced);
		await page.locator('button[data-mode="wysiwyg"]').click();
		const referencedEditor = page.locator('.ProseMirror');
		await expect(referencedEditor).toHaveAttribute('contenteditable', 'true', { timeout: 120_000 });
		const referencedFlags = await page.evaluate(() => ({
			longDocument: document
				.querySelector('.mdsh-editor')
				?.classList.contains('mdsh-long-document'),
			virtualCursor: document
				.querySelector('.ProseMirror')
				?.classList.contains('virtual-cursor-enabled')
		}));
		samples.push({ kind: 'referenced-project-asset', ...referencedFlags });
		expect(referencedFlags.longDocument, 'a project asset keeps the short policy').toBe(false);
		expect(referencedFlags.virtualCursor, 'a project asset keeps the caret plugin').toBe(true);
		expect(await stored()).toBe(referenced);
		await testInfo.attach('image-policy-boundaries.json', {
			body: JSON.stringify(samples, null, 2),
			contentType: 'application/json'
		});
	});

	test('keeps all pixels visible when the PDF guide and viewport shrink', async ({
		page
	}, testInfo) => {
		await page.setViewportSize({ width: 1500, height: 1000 });
		const image = await page.evaluate(() => {
			const canvas = document.createElement('canvas');
			canvas.width = 1800;
			canvas.height = 600;
			const context = canvas.getContext('2d')!;
			context.fillStyle = '#00aa00';
			context.fillRect(0, 0, 1800, 600);
			context.fillStyle = '#ff0000';
			context.fillRect(0, 0, 1800, 30);
			context.fillStyle = '#0000ff';
			context.fillRect(0, 570, 1800, 30);
			return canvas.toDataURL();
		});
		await writeSourceContent(page, `# Image width\n\n![Wide image](${image})`);
		await page.locator('button[data-mode="wysiwyg"]').click();
		const picture = page.locator('.milkdown-image-block img');
		await expect(picture).toBeVisible({ timeout: 20_000 });
		await page.keyboard.press('ControlOrMeta+,');
		await page.getByRole('button', { name: 'PDF (A4)', exact: true }).click();
		await page.getByRole('button', { name: 'Fermer', exact: true }).click();
		for (const width of [1500, 850, 1200]) {
			await page.setViewportSize({ width, height: 1000 });
			await expect
				.poll(() =>
					picture.evaluate((element) => {
						const rect = element.getBoundingClientRect();
						return Math.abs(rect.width / rect.height - 3);
					})
				)
				.toBeLessThan(0.02);
			const metrics = await picture.evaluate((element) => {
				const rect = element.getBoundingClientRect();
				const parent = element.closest('.ProseMirror')!;
				const style = getComputedStyle(parent);
				return {
					right: rect.right,
					limit: parent.getBoundingClientRect().right - parseFloat(style.paddingRight)
				};
			});
			expect(metrics.right).toBeLessThanOrEqual(metrics.limit + 1);
		}
		await testInfo.attach('pdf-width-image', {
			body: await page.screenshot(),
			contentType: 'image/png'
		});
	});
});

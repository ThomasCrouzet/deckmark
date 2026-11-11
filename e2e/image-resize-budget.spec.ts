import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { resetAppState } from './helpers';

// Image block geometry and resize budget for issue 573.
test.use({ locale: 'en-US', reducedMotion: 'reduce', trace: 'off' });

type Mutation = { attribute: string | null };

async function seedNote(page: Page, id: string): Promise<{ content: string }> {
	return page.evaluate(async (rowId) => {
		const draw = (color: string): string => {
			const canvas = document.createElement('canvas');
			canvas.width = 1600;
			canvas.height = 1200;
			const context = canvas.getContext('2d')!;
			context.fillStyle = color;
			context.fillRect(0, 0, 1600, 1200);
			context.fillStyle = '#fff';
			context.fillRect(160, 160, 480, 320);
			return canvas.toDataURL('image/png');
		};
		const paragraph =
			'Geometry text keeps the same words in every run and fills a long document with plain paragraphs. ';
		let content = '# Resize budget\n\nBefore the first image.\n\n';
		for (let index = 0; index < 4; index += 1) {
			content += `Paragraph before image ${index}.\n\n![Measured image ${index}](${draw(index % 2 ? '#234' : '#834')})\n\nParagraph after image ${index}.\n\n`;
		}
		let section = 0;
		while (content.length < 340_000) {
			content += `## Section ${section}\n\n${paragraph.repeat(6)}\n\n`;
			section += 1;
		}
		await new Promise<void>((resolve, reject) => {
			const request = indexedDB.open('mdsh');
			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				const database = request.result;
				const transaction = database.transaction('drafts', 'readwrite');
				transaction.objectStore('drafts').put({
					id: rowId,
					name: `${rowId}.md`,
					content,
					createdAt: 1_700_000_000_000,
					updatedAt: 1_700_000_000_000,
					order: 0,
					open: true
				});
				transaction.oncomplete = () => {
					database.close();
					resolve();
				};
				transaction.onerror = () => reject(transaction.error);
			};
		});
		localStorage.setItem('mdsh:activeId', rowId);
		localStorage.setItem('mdsh:locale', 'en');
		return { content };
	}, id);
}

async function openVisualEditor(page: Page) {
	await page.locator('[data-mode=wysiwyg]').click();
	const dialog = page.getByRole('dialog', { name: /Render this large document/ });
	await dialog.waitFor({ state: 'visible', timeout: 3_000 }).catch(() => {});
	if (await dialog.isVisible().catch(() => false)) {
		await dialog.getByRole('button', { name: /Render document/ }).click();
	}
	await expect(page.locator('.ProseMirror')).toHaveAttribute('contenteditable', 'true', {
		timeout: 60_000
	});
}

async function installMutationProbe(page: Page) {
	await page.evaluate(() => {
		const records: Mutation[] = [];
		const observer = new MutationObserver((mutations) => {
			for (const mutation of mutations) records.push({ attribute: mutation.attributeName });
		});
		for (const image of document.querySelectorAll('.milkdown-image-block img')) {
			observer.observe(image, {
				attributes: true,
				attributeFilter: ['style', 'crossorigin', 'referrerpolicy', 'width', 'height']
			});
		}
		(window as unknown as { __resizeProbe: { records: Mutation[] } }).__resizeProbe = {
			records
		};
	});
}

async function readMutations(page: Page): Promise<Mutation[]> {
	return page.evaluate(
		() => (window as unknown as { __resizeProbe: { records: Mutation[] } }).__resizeProbe.records
	);
}

async function blockMetrics(page: Page) {
	return page.locator('.milkdown-image-block').evaluateAll((blocks) =>
		blocks.map((block) => {
			const image = block.querySelector('img')!;
			const rect = image.getBoundingClientRect();
			return {
				contentVisibility: getComputedStyle(block).contentVisibility,
				intrinsic: (block as HTMLElement).style.getPropertyValue('contain-intrinsic-size'),
				styleWidth: (image as HTMLElement).style.width,
				width: rect.width,
				height: rect.height,
				ratio: rect.height ? rect.width / rect.height : 0,
				alt: image.getAttribute('alt')
			};
		})
	);
}

test('image blocks keep measured geometry and avoid policy writes on resize', async ({
	page,
	browserName
}, info) => {
	test.setTimeout(180_000);
	await resetAppState(page, { mode: 'source' });
	const fixture = await seedNote(page, 'resize-budget');
	await page.reload();
	await openVisualEditor(page);
	await expect(page.locator('.milkdown-image-block img')).toHaveCount(4);
	await expect
		.poll(() =>
			page
				.locator('.milkdown-image-block img')
				.evaluateAll((images) => images.every((image) => (image as HTMLImageElement).complete))
		)
		.toBe(true);
	await expect
		.poll(async () => (await blockMetrics(page)).every((block) => block.styleWidth))
		.toBe(true);
	const before = await blockMetrics(page);
	if (browserName !== 'webkit') {
		expect(before.every((block) => block.contentVisibility === 'auto')).toBe(true);
		expect(
			before.every((block) => {
				const match = /auto (\d+)px (\d+)px/.exec(block.intrinsic);
				return Boolean(match) && Number(match![2]) > 100;
			})
		).toBe(true);
	}
	expect(before.every((block) => Math.abs(block.ratio - 4 / 3) < 0.03)).toBe(true);
	expect(before.map((block) => block.alt)).toEqual([
		'Measured image 0',
		'Measured image 1',
		'Measured image 2',
		'Measured image 3'
	]);

	await installMutationProbe(page);
	await page.setViewportSize({ width: 1100, height: 900 });
	await page.waitForTimeout(800);
	const afterResize = await blockMetrics(page);
	const resizeMutations = await readMutations(page);
	const policyWrites = resizeMutations.filter((mutation) =>
		['crossorigin', 'referrerpolicy'].includes(mutation.attribute ?? '')
	);
	const styleWrites = resizeMutations.filter((mutation) => mutation.attribute === 'style');
	expect(policyWrites, 'a sizing pass must not rewrite an unchanged fetch policy').toEqual([]);
	expect(styleWrites.length).toBeLessThanOrEqual(8);
	expect(afterResize.some((block, index) => block.width !== before[index]!.width)).toBe(true);
	expect(afterResize.every((block) => Math.abs(block.ratio - 4 / 3) < 0.03)).toBe(true);
	if (browserName !== 'webkit') {
		expect(
			afterResize.every((block) => {
				const match = /auto (\d+)px (\d+)px/.exec(block.intrinsic);
				return Boolean(match) && Number(match![2]) > 100;
			})
		).toBe(true);
	}

	// Plain typing next to an image must not resize or restyle any image.
	await page.evaluate(() => {
		(window as unknown as { __resizeProbe: { records: Mutation[] } }).__resizeProbe.records.length =
			0;
	});
	const paragraph = page.locator('.ProseMirror p').first();
	await paragraph.click();
	await page.keyboard.press('End');
	for (let index = 0; index < 20; index += 1) await page.keyboard.insertText('typing ');
	await page.waitForTimeout(300);
	const typingMutations = await readMutations(page);
	expect(
		typingMutations.filter((mutation) => mutation.attribute === 'style'),
		'typing must not restyle image geometry'
	).toEqual([]);
	expect(await page.locator('.ProseMirror')).toContainText('typing typing');
	await info.attach('image-resize-budget.json', {
		body: JSON.stringify(
			{
				fixture: {
					sha256: createHash('sha256').update(fixture.content).digest('hex'),
					bytes: Buffer.byteLength(fixture.content)
				},
				browser: browserName,
				before,
				afterResize,
				resizeMutations,
				typingMutations,
				viewport: { width: 1100, height: 900 }
			},
			null,
			2
		),
		contentType: 'application/json'
	});
	await info.attach('image-resize-budget.png', {
		body: await page.screenshot(),
		contentType: 'image/png'
	});
});

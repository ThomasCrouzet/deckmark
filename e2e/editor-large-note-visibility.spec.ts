import { createHash } from 'node:crypto';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { openPalette, resetAppState } from './helpers';

const noteId = 'webkit-large-visibility';
// The inline pixel image keeps image blocks in the large note layout.
const inlineImage =
	'![inline pixel](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3kAAAAAElFTkSuQmCC)';

// A 240 KB note keeps the visual editor on the scoped source path. The
// headings, image blocks and several hundred lines make the paragraph count
// large enough for the WebKit paint regression from issue #553.
function largeNote(): string {
	const paragraph =
		'Large note text keeps every inserted paragraph visible after the next paint. The local editor stores Markdown and redraws the paragraph immediately. ';
	let content = '# Large note visibility\n\n';
	let section = 0;
	while (content.length < 240_000) {
		content += `## Section ${section}\n\n${paragraph.repeat(4)}`;
		if (section % 12 === 0) content += `\n\n${inlineImage}`;
		content += '\n\n';
		section += 1;
	}
	return `${content}The final paragraph closes the fixture.\n`;
}

async function seedNote(page: Page, content: string) {
	await page.evaluate(
		async ({ id, source }) => {
			await new Promise<void>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const transaction = database.transaction('drafts', 'readwrite');
					transaction.objectStore('drafts').put({
						id,
						name: `${id}.md`,
						content: source,
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
			localStorage.setItem('mdsh:activeId', id);
			localStorage.setItem('mdsh:mode', 'wysiwyg');
		},
		{ id: noteId, source: content }
	);
}

async function storedContent(page: Page): Promise<string> {
	return page.evaluate(
		(id) =>
			new Promise<string>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const transaction = database.transaction('drafts');
					const get = transaction.objectStore('drafts').get(id);
					get.onsuccess = () => {
						database.close();
						resolve((get.result as { content?: string } | undefined)?.content ?? '');
					};
					get.onerror = () => reject(get.error);
				};
			}),
		noteId
	);
}

async function downloadMarkdown(page: Page): Promise<string> {
	await openPalette(page);
	const pending = page.waitForEvent('download');
	await page.locator('#cmd-palette-opt-export-md').click();
	const download = await pending;
	const chunks: Buffer[] = [];
	for await (const chunk of (await download.createReadStream())!) chunks.push(chunk);
	expect(download.suggestedFilename()).toMatch(/\.md$/);
	return Buffer.concat(chunks).toString('utf8');
}

async function openVisualEditor(page: Page) {
	await page.locator('[data-mode=wysiwyg]').click();
	const dialog = page.getByRole('dialog', {
		name: /Render this large document|Afficher ce document volumineux/
	});
	await dialog.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
	if (await dialog.isVisible().catch(() => false)) {
		await dialog.getByRole('button', { name: /Render document|Afficher le document/ }).click();
	}
	await expect(page.locator('.ProseMirror')).toHaveAttribute('contenteditable', 'true', {
		timeout: 180_000
	});
}

async function placeCaretAtDocumentEnd(page: Page) {
	await page.locator('.ProseMirror').evaluate((root) => {
		const paragraphs = root.querySelectorAll(':scope > p');
		const last = paragraphs[paragraphs.length - 1] ?? root;
		const range = document.createRange();
		range.selectNodeContents(last);
		range.collapse(false);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		(root as HTMLElement).focus();
	});
}

type PaintEvidence = {
	text: string;
	found: boolean;
	rect: { x: number; y: number; width: number; height: number } | null;
	style: {
		display: string;
		visibility: string;
		opacity: string;
		color: string;
		userSelect: string;
		pointerEvents: string;
	} | null;
	inViewport: boolean;
	hitInStack: boolean;
	hitTest: string | null;
	hitTag: string | null;
	hitClass: string | null;
	selection: string | null;
	selectionRects: number;
	inkPixels: number;
	pixels: number;
};

/**
 * Read back the rendered viewport and measure the ink inside every paragraph.
 * A paragraph with zero ink is present in the DOM but not painted: hidden,
 * transparent, clipped or covered by another element.
 */
async function paintEvidence(page: Page, texts: string[]): Promise<PaintEvidence[]> {
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			)
	);
	const screenshot = await page.screenshot();
	const rects = await page.evaluate((wanted) => {
		const root = document.querySelector<HTMLElement>('.ProseMirror');
		if (!root) return wanted.map(() => null);
		const paragraphs = [...root.querySelectorAll<HTMLElement>(':scope > p')];
		return wanted.map((text) => {
			const paragraph = paragraphs.find((entry) => entry.textContent === text);
			if (!paragraph) return null;
			const rect = paragraph.getBoundingClientRect();
			const style = getComputedStyle(paragraph);
			const pointX = Math.min(window.innerWidth - 1, Math.max(0, rect.x + rect.width / 2));
			const pointY = Math.min(window.innerHeight - 1, Math.max(0, rect.y + rect.height / 2));
			const hit = document.elementFromPoint(pointX, pointY);
			// An editor toolbar can cover the center point without hiding the
			// text. The paragraph must still be in the hit stack at that point.
			const hitInStack = document
				.elementsFromPoint(pointX, pointY)
				.some((entry) => entry === paragraph || paragraph.contains(entry));
			const range = document.createRange();
			range.selectNodeContents(paragraph);
			const selection = window.getSelection();
			selection?.removeAllRanges();
			selection?.addRange(range);
			return {
				rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
				style: {
					display: style.display,
					visibility: style.visibility,
					opacity: style.opacity,
					color: style.color,
					userSelect: style.userSelect,
					pointerEvents: style.pointerEvents
				},
				inViewport:
					rect.width > 0 &&
					rect.height > 0 &&
					rect.top >= 0 &&
					rect.left >= 0 &&
					rect.bottom <= window.innerHeight &&
					rect.right <= window.innerWidth,
				hitInStack,
				hitTest: hit
					? hit === paragraph || paragraph.contains(hit)
						? 'paragraph'
						: hit.className || hit.tagName
					: null,
				hitTag: hit?.tagName ?? null,
				hitClass: typeof hit?.className === 'string' ? hit.className : null,
				selection: selection?.toString() ?? null,
				selectionRects: range.getClientRects().length
			};
		});
	}, texts);
	const pixels = await page.evaluate(
		async ({ base64, rects: boxes }: { base64: string; rects: typeof rects }) => {
			const image = new Image();
			image.src = `data:image/png;base64,${base64}`;
			await image.decode();
			const canvas = document.createElement('canvas');
			canvas.width = image.width;
			canvas.height = image.height;
			const context = canvas.getContext('2d');
			if (!context) return boxes.map(() => ({ ink: 0, total: 0 }));
			context.drawImage(image, 0, 0);
			const scale = image.width / window.innerWidth;
			return boxes.map((box) => {
				if (!box) return { ink: 0, total: 0 };
				const x = Math.max(0, Math.round(box.rect.x * scale));
				const y = Math.max(0, Math.round(box.rect.y * scale));
				const width = Math.min(image.width - x, Math.max(0, Math.round(box.rect.width * scale)));
				const height = Math.min(image.height - y, Math.max(0, Math.round(box.rect.height * scale)));
				if (width <= 0 || height <= 0) return { ink: 0, total: 0 };
				const data = context.getImageData(x, y, width, height).data;
				const counts = new Map<number, number>();
				for (let index = 0; index < data.length; index += 4) {
					const key = (data[index]! << 16) | (data[index + 1]! << 8) | data[index + 2]!;
					counts.set(key, (counts.get(key) ?? 0) + 1);
				}
				let background = 0;
				let backgroundCount = -1;
				for (const [key, count] of counts) {
					if (count > backgroundCount) {
						background = key;
						backgroundCount = count;
					}
				}
				const red = (background >> 16) & 0xff;
				const green = (background >> 8) & 0xff;
				const blue = background & 0xff;
				let ink = 0;
				for (let index = 0; index < data.length; index += 4) {
					const distance =
						Math.abs(data[index]! - red) +
						Math.abs(data[index + 1]! - green) +
						Math.abs(data[index + 2]! - blue);
					if (distance > 90) ink += 1;
				}
				return { ink, total: width * height };
			});
		},
		{ base64: screenshot.toString('base64'), rects }
	);
	return texts.map((text, index) => {
		const box = rects[index];
		const ink = pixels[index] ?? { ink: 0, total: 0 };
		return {
			text,
			found: box !== null,
			rect: box?.rect ?? null,
			style: box?.style ?? null,
			inViewport: box?.inViewport ?? false,
			hitInStack: box?.hitInStack ?? false,
			hitTest: box?.hitTest ?? null,
			hitTag: box?.hitTag ?? null,
			hitClass: box?.hitClass ?? null,
			selection: box?.selection ?? null,
			selectionRects: box?.selectionRects ?? 0,
			inkPixels: ink.ink,
			pixels: ink.total
		};
	});
}

async function revealParagraph(page: Page, text: string) {
	await page.locator('.ProseMirror > p').filter({ hasText: text }).first().scrollIntoViewIfNeeded();
	await page.waitForTimeout(100);
}

function expectPainted(evidence: PaintEvidence[]) {
	for (const sample of evidence) {
		expect.soft(sample.found, `paragraph must exist: ${sample.text}`).toBe(true);
		expect
			.soft(sample.rect?.width ?? 0, `paragraph must have width: ${sample.text}`)
			.toBeGreaterThan(0);
		expect
			.soft(sample.rect?.height ?? 0, `paragraph must have height: ${sample.text}`)
			.toBeGreaterThan(0);
		expect.soft(sample.inViewport, `paragraph must be in the viewport: ${sample.text}`).toBe(true);
		expect.soft(sample.style?.display, `display: ${sample.text}`).not.toBe('none');
		expect.soft(sample.style?.visibility, `visibility: ${sample.text}`).toBe('visible');
		expect.soft(Number(sample.style?.opacity), `opacity: ${sample.text}`).toBeGreaterThan(0.9);
		expect
			.soft(sample.style?.color ?? '', `color: ${sample.text}`)
			.not.toMatch(/^rgba\([^)]*,\s*0(?:\.0+)?\)$/);
		expect.soft(sample.style?.userSelect, `selectable: ${sample.text}`).not.toBe('none');
		expect.soft(sample.style?.pointerEvents, `pointer events: ${sample.text}`).not.toBe('none');
		expect
			.soft(
				sample.hitInStack,
				`hit stack: ${sample.text} (top ${sample.hitTag}.${sample.hitClass}, hit ${sample.hitTest})`
			)
			.toBe(true);
		expect.soft(sample.selection, `selected text: ${sample.text}`).toBe(sample.text);
		expect.soft(sample.selectionRects, `selection layout: ${sample.text}`).toBeGreaterThan(0);
		// Anti-aliased glyph pixels are far from the modal background. A hidden,
		// transparent, clipped or covered paragraph keeps this count near zero.
		expect.soft(sample.inkPixels, `painted ink: ${sample.text}`).toBeGreaterThan(20);
	}
	expect(evidence.map((sample) => sample.text)).toHaveLength(3);
}

async function attachEvidence(
	info: TestInfo,
	page: Page,
	fixture: string,
	evidence: PaintEvidence[],
	source: string
) {
	await info.attach('visibility-evidence.json', {
		body: JSON.stringify(
			{
				...info.config.metadata,
				browser: info.project.name,
				browserVersion: page.context().browser()?.version(),
				command: info.config.metadata.command,
				fixture: {
					bytes: Buffer.byteLength(fixture),
					sha256: createHash('sha256').update(fixture).digest('hex')
				},
				exportedSourceBytes: Buffer.byteLength(source),
				paragraphs: evidence
			},
			null,
			2
		),
		contentType: 'application/json'
	});
	await info.attach('visible-paragraphs.png', {
		body: await page.screenshot(),
		contentType: 'image/png'
	});
}

test.describe('large note paragraph visibility', () => {
	test.use({ colorScheme: 'light' });

	test('inserted paragraphs paint and persist in a large note', async ({ page }, info) => {
		test.setTimeout(240_000);
		const fixture = largeNote();
		await resetAppState(page, { mode: 'source' });
		await seedNote(page, fixture);
		await page.reload();
		await openVisualEditor(page);
		// Let the first render and its scoped source reconciliation settle before
		// the baseline save. The baseline is the exact prior source.
		await page.waitForTimeout(700);
		const before = await storedContent(page);
		expect(before).toContain('## Section 0');
		expect(before).toContain('![inline pixel]');

		await placeCaretAtDocumentEnd(page);
		const inserted = [
			'First inserted paragraph alpha, painted without a pointer event.',
			'Second inserted paragraph bravo, still visible after the next frame.',
			'Third inserted paragraph charlie, persistent after reload.'
		];
		for (const text of inserted) {
			await page.keyboard.press('Enter');
			await page.keyboard.insertText(text);
			await expect(page.locator('.ProseMirror')).toContainText(text);
		}
		const expected = `${before.trimEnd()}\n\n${inserted.join('\n\n')}\n`;
		await expect.poll(() => storedContent(page), { timeout: 60_000 }).toBe(expected);

		const firstPaint = await paintEvidence(page, inserted);
		expectPainted(firstPaint);

		// Undo and redo keep the exact inserted text before any mode change.
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(() => page.locator('.ProseMirror').innerText()).not.toContain(inserted[2]!);
		await page.keyboard.press('ControlOrMeta+Shift+z');
		await expect(page.locator('.ProseMirror')).toContainText(inserted[2]!);

		// Leave the paragraphs, then return without a click. The paint must not
		// depend on a pointer event.
		await page.locator('.mdsh-editor').evaluate((element) => {
			element.scrollTop = 0;
		});
		await page.waitForTimeout(200);
		await revealParagraph(page, inserted[2]!);
		const afterScroll = await paintEvidence(page, inserted);
		expectPainted(afterScroll);

		// Source and back keeps the same visible paragraphs and exact bytes.
		await page.locator('[data-mode=source]').click();
		await expect(page.locator('.cm-content')).toBeVisible({ timeout: 30_000 });
		const afterModeSwitch = await downloadMarkdown(page);
		expect(afterModeSwitch).toBe(expected);
		await openVisualEditor(page);
		await revealParagraph(page, inserted[2]!);
		const afterModeReturn = await paintEvidence(page, inserted);
		expectPainted(afterModeReturn);

		await page.reload();
		await openVisualEditor(page);
		await page.waitForTimeout(700);
		await revealParagraph(page, inserted[2]!);
		const afterReload = await paintEvidence(page, inserted);
		expectPainted(afterReload);
		expect(await downloadMarkdown(page)).toBe(expected);

		await attachEvidence(info, page, fixture, afterReload, expected);
	});
});

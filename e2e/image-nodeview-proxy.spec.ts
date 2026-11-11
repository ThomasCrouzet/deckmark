import { expect, test, type Page } from '@playwright/test';
import { resetAppState } from './helpers';

// Image NodeView proxy reuse and stale-result fencing for issue 575.
test.use({ locale: 'en-US', reducedMotion: 'reduce', trace: 'off' });

const counterKey = 'deckmark:nodeview-counters';

async function installCounters(page: Page) {
	await page.addInitScript((key) => {
		window.addEventListener('deckmark:editor-perf', (event) => {
			const detail = (event as CustomEvent<{ kind: string; name: string }>).detail;
			if (detail.kind !== 'counter') return;
			const counts = JSON.parse(sessionStorage.getItem(key) ?? '{}') as Record<string, number>;
			counts[detail.name] = (counts[detail.name] ?? 0) + 1;
			sessionStorage.setItem(key, JSON.stringify(counts));
		});
	}, counterKey);
}

async function readCounters(page: Page): Promise<Record<string, number>> {
	return page.evaluate((key) => {
		const counts = JSON.parse(sessionStorage.getItem(key) ?? '{}') as Record<string, number>;
		const media = (
			window as unknown as {
				__MDSH_PROJECT_MEDIA__?: { stats: () => Record<string, number> };
			}
		).__MDSH_PROJECT_MEDIA__;
		if (media) {
			for (const name of [
				'contextReads',
				'assetReads',
				'decodeCalls',
				'resolvedHits',
				'fingerprintCalls'
			])
				counts[`media.${name}`] = media.stats()[name] ?? 0;
		}
		return counts;
	}, counterKey);
}

async function resetCounters(page: Page): Promise<void> {
	await page.evaluate((key) => {
		sessionStorage.removeItem(key);
		(
			window as unknown as { __MDSH_PROJECT_MEDIA__?: { reset: () => void } }
		).__MDSH_PROJECT_MEDIA__?.reset();
	}, counterKey);
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

async function seedInlineInProject(page: Page): Promise<{ inline: string }> {
	return page.evaluate(async () => {
		const draw = (width: number, height: number, color: string): string => {
			const canvas = document.createElement('canvas');
			canvas.width = width;
			canvas.height = height;
			const context = canvas.getContext('2d')!;
			context.fillStyle = color;
			context.fillRect(0, 0, width, height);
			return canvas.toDataURL('image/png');
		};
		const inline = draw(80, 80, '#c33');
		const project = draw(1500, 1000, '#3c3');
		const projectBytes = Uint8Array.from(atob(project.split(',')[1]!), (character) =>
			character.charCodeAt(0)
		);
		const inlineContent = `# Inline image\n\n![Inline](${inline})\n\nParagraph after the image.\n`;
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
					id: 'nodeview-project',
					name: 'NodeView project',
					createdAt: 1,
					updatedAt: 1
				});
				transaction.objectStore('projectAssets').put({
					id: 'nodeview-asset',
					projectId: 'nodeview-project',
					path: 'assets/large.png',
					mime: 'image/png',
					data: projectBytes
				});
				transaction.objectStore('drafts').put({
					id: 'nodeview-note',
					name: 'nodeview-note.md',
					content: inlineContent,
					projectId: 'nodeview-project',
					relativePath: 'notes/nodeview-note.md',
					createdAt: 1,
					updatedAt: 1,
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
		localStorage.setItem('mdsh:activeId', 'nodeview-note');
		localStorage.setItem('mdsh:locale', 'en');
		return { inline };
	});
}

async function currentImage(page: Page): Promise<{ src: string; width: number }> {
	return page
		.locator('.milkdown-image-block img')
		.first()
		.evaluate((element) => {
			const image = element as HTMLImageElement;
			return { src: image.currentSrc || image.src, width: image.naturalWidth };
		});
}

type ImageStep = { attribute: string; value: string };

async function setImageAttributes(page: Page, steps: ImageStep[]): Promise<void> {
	await page.evaluate((changes) => {
		const view = (
			window as unknown as {
				__MDSH_EDITOR_VIEW__: {
					state: {
						doc: {
							descendants: (
								callback: (
									node: { type: { name: string }; attrs: Record<string, unknown> },
									position: number
								) => void
							) => void;
						};
						tr: {
							setNodeAttribute: (pos: number, attr: string, value: string) => unknown;
						};
					};
					dispatch: (transaction: unknown) => void;
				};
			}
		).__MDSH_EDITOR_VIEW__;
		let position: number | null = null;
		view.state.doc.descendants((node, offset) => {
			if (position !== null) return;
			if (node.type.name.includes('image') && 'src' in node.attrs) position = offset;
		});
		if (position === null) throw new Error('No image node');
		for (const change of changes)
			view.dispatch(view.state.tr.setNodeAttribute(position, change.attribute, change.value));
	}, steps);
}

test('an inline data image skips project media and an unchanged update skips the proxy', async ({
	page
}, info) => {
	test.setTimeout(120_000);
	await installCounters(page);
	await resetAppState(page, { mode: 'source' });
	await seedInlineInProject(page);
	await page.reload();
	await openVisualEditor(page);
	await expect(page.locator('.milkdown-image-block img')).toHaveCount(1);
	await expect.poll(async () => (await currentImage(page)).width).toBe(80);
	const mounted = await readCounters(page);
	expect(mounted['media.contextReads'] ?? 0).toBe(0);
	expect(mounted['media.assetReads'] ?? 0).toBe(0);

	await resetCounters(page);
	// A NodeView update with the same source must not call the proxy.
	await setImageAttributes(page, [{ attribute: 'caption', value: 'New caption' }]);
	await page.waitForTimeout(300);
	const unchanged = await readCounters(page);
	expect(unchanged.imageProxyCall ?? 0).toBe(0);

	// Selection changes and ordinary text must not resolve the image again.
	const paragraph = page.locator('.ProseMirror p').last();
	await paragraph.click();
	await page.keyboard.press('End');
	for (let index = 0; index < 20; index += 1) await page.keyboard.insertText('text ');
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.press('ArrowLeft');
	await page.keyboard.press('ControlOrMeta+z');
	await page.waitForTimeout(300);
	const afterTyping = await readCounters(page);
	expect(afterTyping.imageProxyCall ?? 0).toBe(0);
	expect((await currentImage(page)).width).toBe(80);
	expect(await page.locator('.ProseMirror')).toContainText('Paragraph after the image.');
	await info.attach('nodeview-proxy.json', {
		body: JSON.stringify(
			{ mounted, unchanged, afterTyping, browser: page.context().browser()?.version() },
			null,
			2
		),
		contentType: 'application/json'
	});
});

test('a slow project resolution cannot replace a newer image source', async ({ page }, info) => {
	test.setTimeout(120_000);
	await installCounters(page);
	await resetAppState(page, { mode: 'source' });
	const fixture = await seedInlineInProject(page);
	await page.reload();
	await openVisualEditor(page);
	await expect.poll(async () => (await currentImage(page)).width).toBe(80);
	await resetCounters(page);

	// Start an asynchronous project lookup, then replace the source before it
	// settles. The stale result must not win.
	await setImageAttributes(page, [
		{ attribute: 'src', value: '../assets/large.png' },
		{ attribute: 'src', value: fixture.inline }
	]);
	await page.waitForTimeout(1_000);
	const settled = await currentImage(page);
	const counters = await readCounters(page);
	expect(settled.src.startsWith('data:image/png')).toBe(true);
	expect(settled.width).toBe(80);
	expect(counters.imageProxyCall ?? 0).toBeGreaterThanOrEqual(2);
	expect(counters['media.assetReads'] ?? 0).toBeGreaterThanOrEqual(1);
	expect(await page.locator('.milkdown-image-block img').first().getAttribute('alt')).toBe(
		'Inline'
	);
	await info.attach('nodeview-stale-result.json', {
		body: JSON.stringify(
			{
				inlineLength: fixture.inline.length,
				settled: { ...settled, src: `${settled.src.slice(0, 40)}...` },
				counters
			},
			null,
			2
		),
		contentType: 'application/json'
	});
});

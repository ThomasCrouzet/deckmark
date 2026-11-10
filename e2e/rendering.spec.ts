import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resetAppState, seedFiles, openPalette } from './helpers';

async function expectMermaidLabels(page: Page, selector: string) {
	const diagram = page.locator(selector).first();
	await expect(diagram).toBeVisible({ timeout: 20_000 });
	await expect
		.poll(() =>
			diagram.locator('.node').evaluateAll((nodes) =>
				nodes.map((node) => {
					const text = node.querySelector('text');
					const shape = node.querySelector('rect');
					const box = text?.getBBox();
					return {
						label: text?.textContent?.trim(),
						visible: Boolean(box && box.width > 0 && box.height > 0),
						fill: shape ? getComputedStyle(shape).fill : ''
					};
				})
			)
		)
		.toEqual([
			{ label: 'A', visible: true, fill: expect.not.stringMatching(/^(?:rgb\(0, 0, 0\)|none|)$/) },
			{ label: 'B', visible: true, fill: 'rgb(254, 226, 226)' }
		]);
	await expect(diagram.locator('style, foreignObject')).toHaveCount(0);
}

test.describe('KaTeX and Mermaid rendering in read mode', () => {
	test.beforeEach(async ({ page }) => {
		await resetAppState(page);
	});

	for (const mode of ['read', 'wysiwyg'] as const) {
		test(`keeps the complete flowchart visible in ${mode} with reduced motion`, async ({
			page
		}, testInfo) => {
			await page.emulateMedia({ reducedMotion: 'reduce' });
			await seedFiles(page, [
				{
					name: 'flowchart',
					content:
						'# Diagram\n\n```mermaid\nflowchart LR\nA[Write] --> B[Save locally]\nB --> C[Export]\n```'
				}
			]);
			await page.locator(`button[data-mode="${mode}"]`).click();
			const diagram = page.locator(mode === 'read' ? '.mdsh-preview svg' : '.milkdown svg').filter({
				has: page.locator('.node')
			});
			await expect(diagram).toBeVisible({ timeout: 20_000 });
			await expect(diagram.locator('.node')).toHaveCount(3);
			await expect
				.poll(() =>
					diagram.evaluate((element) => {
						const svg = element as SVGSVGElement;
						const box = svg.getBBox();
						const view = svg.viewBox.baseVal;
						return (
							box.width > 0 &&
							box.height > 0 &&
							box.x >= view.x - 1 &&
							box.y >= view.y - 1 &&
							box.x + box.width <= view.x + view.width + 1 &&
							box.y + box.height <= view.y + view.height + 1
						);
					})
				)
				.toBe(true);
			await testInfo.attach(`reduced-motion-${mode}`, {
				body: await diagram.screenshot(),
				contentType: 'image/png'
			});
		});
	}

	test('renders KaTeX in read mode', async ({ page }) => {
		await seedFiles(page, [
			{
				name: 'math',
				content: '# Math\n\nIdentité d’Euler : $e^{i\\pi} + 1 = 0$\n'
			}
		]);
		await page.locator('button[data-mode="read"]').click();
		// The KaTeX renderer adds `.katex` after the lazy module loads.
		await expect(page.locator('.mdsh-preview .katex').first()).toBeVisible({
			timeout: 15_000
		});
	});

	test('keeps Mermaid labels and colors in read mode, offline HTML, and PDF', async ({
		page,
		browser
	}, testInfo) => {
		await seedFiles(page, [
			{
				name: 'diagram',
				content:
					'# Diagramme\n\n```mermaid\ngraph LR\nA --> B\nstyle B fill:#fee2e2,stroke:#991b1b,color:#123456\n```\n'
			}
		]);
		await page.locator('button[data-mode="read"]').click();
		await expectMermaidLabels(page, '.mdsh-preview svg');
		await page
			.locator('.mdsh-preview svg')
			.screenshot({ path: testInfo.outputPath('mermaid-read.png') });

		let captured = '';
		await page.exposeFunction('captureMermaidPrint', (html: string) => {
			captured = html;
		});
		await page.evaluate(() => {
			const capture = (
				globalThis as typeof globalThis & { captureMermaidPrint: (html: string) => Promise<void> }
			).captureMermaidPrint;
			new MutationObserver((records) => {
				for (const record of records)
					for (const node of record.addedNodes) {
						if (node instanceof HTMLIFrameElement && node.contentWindow)
							node.contentWindow.print = () => {
								void capture(node.contentDocument?.documentElement.outerHTML ?? '');
							};
					}
			}).observe(document.body, { childList: true, subtree: true });
		});
		await page.getByRole('button', { name: 'Exporter en PDF' }).click();
		await expect.poll(() => captured.length).toBeGreaterThan(100);
		const printable = await browser.newPage();
		await printable.goto(page.url());
		await printable.setContent(captured, { waitUntil: 'networkidle' });
		await printable.emulateMedia({ media: 'print' });
		await expectMermaidLabels(printable, '.mermaid-block svg');
		const pdfPath = testInfo.outputPath('mermaid.pdf');
		await printable.pdf({ path: pdfPath, format: 'A4', printBackground: true });
		expect((await readFile(pdfPath)).subarray(0, 5).toString()).toBe('%PDF-');
		await testInfo.attach('mermaid-pdf', { path: pdfPath, contentType: 'application/pdf' });
		await printable.close();

		await openPalette(page);
		await page.keyboard.type('Exporter en HTML');
		const download = page.waitForEvent('download');
		await page.keyboard.press('Enter');
		const htmlPath = testInfo.outputPath('mermaid.html');
		await (await download).saveAs(htmlPath);
		const offline = await browser.newContext({ offline: true });
		const exported = await offline.newPage();
		await exported.goto(pathToFileURL(htmlPath).href);
		await expectMermaidLabels(exported, '.mermaid-block svg');
		await testInfo.attach('mermaid-html', { path: htmlPath, contentType: 'text/html' });
		await offline.close();
	});

	test('rejects Mermaid network images and styles before a request starts', async ({ page }) => {
		const requests: string[] = [];
		await page.route('**/mermaid-beacon*', async (route) => {
			requests.push(route.request().url());
			await route.abort();
		});
		for (const [index, code] of [
			'flowchart TD\nA@{ "i\\u006dg": "/mermaid-beacon.png", label: "Image" }',
			'---\nconfig:\n  themeCSS: ".node rect {fill:url(/mermaid-beacon.svg#paint)}"\n---\nflowchart TD\nA --> B'
		].entries()) {
			if (index > 0) await resetAppState(page);
			await seedFiles(page, [
				{ name: `unsafe-diagram-${index}`, content: '```mermaid\n' + code + '\n```' }
			]);
			await page.locator('button[data-mode="read"]').click();
			await expect(page.locator('.mermaid-error')).toContainText(
				'Les images intégrées et les styles réseau Mermaid ne sont pas pris en charge'
			);
		}
		expect(requests).toEqual([]);
	});

	test('shows clean checklist markers and limits permalinks to read mode', async ({ page }) => {
		await seedFiles(page, [
			{
				name: 'tasks',
				content: '## Tâches\n\n- [ ] À faire\n- [x] Fait\n'
			}
		]);
		await page.locator('button[data-mode="read"]').click();

		const taskItems = page.locator('.mdsh-preview li.task-list-item');
		await expect(taskItems).toHaveCount(2);
		await expect(taskItems.first()).toHaveCSS('list-style-type', 'none');
		await expect(page.locator('.mdsh-preview .mdsh-anchor')).toHaveCount(1);
	});

	test('keeps later preview paragraphs after an early paragraph edit', async ({ page }, info) => {
		const paragraphs = Array.from(
			{ length: 200 },
			(_, index) => `Paragraph ${index} keeps one stable sentence for the preview.`
		);
		const source = `${paragraphs.join('\n\n')}\n\n![Stable](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDfoAAAAASUVORK5CYII=)`;
		await seedFiles(page, [{ name: 'preview-first-edit', content: source }]);
		await page.getByTestId('split-view-toggle').click();
		const preview = page.locator('.mdsh-preview');
		await expect(preview.locator('p').first()).toBeVisible({ timeout: 20_000 });
		await expect.poll(() => preview.locator('p').count()).toBeGreaterThanOrEqual(200);
		const count = await preview.locator('p').count();
		const second = await preview.locator('p').nth(1).elementHandle();
		const last = await preview
			.locator('p')
			.nth(count - 1)
			.elementHandle();
		const editor = page.locator('.cm-content').first();
		await editor.click();
		await page.keyboard.press('ControlOrMeta+Home');
		await page.keyboard.insertText('Changed ');
		await expect(preview).toContainText('Changed Paragraph 0 keeps one stable sentence');
		const retained = {
			second: await second!.evaluate((node) => node.isConnected),
			last: await last!.evaluate((node) => node.isConnected),
			first: await preview.locator('p').first().innerText(),
			count: await preview.locator('p').count()
		};
		await info.attach('first-paragraph-edit.json', {
			body: JSON.stringify({ sourceLength: source.length, retained }, null, 2),
			contentType: 'application/json'
		});
		expect(retained.second).toBe(true);
		expect(retained.last).toBe(true);
		expect(retained.count).toBe(count);
	});

	test('keeps unchanged diagram and code DOM after a split section edit', async ({
		page
	}, info) => {
		const source = [
			'# Stable preview',
			'Edit this paragraph.',
			'```mermaid\nflowchart LR\nA[First] --> B[Second]\n```',
			'```js\nconst stable = 42;\n```',
			'```mermaid\nflowchart LR\nA[First] --> B[Second]\n```',
			'## Final heading',
			'Complete tail.'
		].join('\n\n');
		await seedFiles(page, [{ name: 'stable-preview', content: source }]);
		await page.getByTestId('split-view-toggle').click();
		await expect(page.locator('.mdsh-preview svg')).toHaveCount(2);
		const diagram = await page.locator('.mdsh-preview svg').first().elementHandle();
		const code = await page.locator('.mdsh-preview pre').first().elementHandle();
		const editor = page.locator('.cm-content').first();
		await editor.click();
		await page.keyboard.press('ControlOrMeta+End');
		await page.keyboard.insertText('\n\nA changed section.');
		await expect(page.locator('.mdsh-preview')).toContainText('A changed section.');
		const retained = {
			diagram: await diagram!.evaluate((node) => node.isConnected),
			code: await code!.evaluate((node) => node.isConnected),
			ids: await page.locator('.mdsh-preview [id]').evaluateAll((nodes) => nodes.map((n) => n.id)),
			stages: await page.evaluate(() =>
				performance
					.getEntriesByType('measure')
					.filter((entry) => entry.name.startsWith('mdsh:render:'))
					.map((entry) => ({
						name: entry.name,
						duration: entry.duration,
						detail: (entry as PerformanceMeasure).detail
					}))
			)
		};
		await info.attach('section-edit.json', {
			body: JSON.stringify({ source, retained }),
			contentType: 'application/json'
		});
		expect(retained.diagram).toBe(true);
		expect(retained.code).toBe(true);
		expect(new Set(retained.ids).size).toBe(retained.ids.length);
		const diagrams = retained.stages.filter((stage) => stage.name === 'mdsh:render:diagrams');
		expect(diagrams.at(-1)?.detail.cacheMisses).toBe(0);
		expect(diagrams.at(-1)?.detail.cacheHits).toBe(2);
	});

	test('renders and exports all 101 diagrams and 1000 headings with distinct SVG references', async ({
		page
	}, info) => {
		test.setTimeout(120_000);
		const source = Array.from({ length: 1000 }, (_, index) =>
			[
				`## Section ${index}`,
				index < 101 ? `\`\`\`mermaid\nflowchart LR\nA[Item ${index}] --> B[Diagram]\n\`\`\`` : '',
				index % 100 === 0 ? '```js\nconst answer = 42;\n```\n\n$x^2$' : '',
				index === 999 ? 'Complete offscreen sentinel.' : 'Section content.'
			].join('\n\n')
		).join('\n\n');
		await page.evaluate(async (content) => {
			await new Promise<void>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const transaction = database.transaction('drafts', 'readwrite');
					transaction.objectStore('drafts').put({
						id: 'complete-preview',
						name: 'complete-preview.md',
						content,
						createdAt: 1700000000000,
						updatedAt: 1700000000000,
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
			localStorage.setItem('mdsh:activeId', 'complete-preview');
			localStorage.setItem('mdsh:mode', 'source');
		}, source);
		await page.reload();
		await expect(page.locator('#app-toolbar input')).toHaveValue('complete-preview');
		await page.locator('[data-mode=read]').click();
		await expect(page.locator('.mdsh-preview svg')).toHaveCount(101, { timeout: 90_000 });
		await expect(page.locator('.mdsh-preview h2')).toHaveCount(1000);
		const references = await page.locator('.mdsh-preview').evaluate((article) => {
			const ids = Array.from(article.querySelectorAll('[id]'), (node) => node.id);
			const missing: string[] = [];
			for (const node of article.querySelectorAll('svg *')) {
				for (const attr of Array.from(node.attributes)) {
					for (const match of attr.value.matchAll(/url\(#([^)]+)\)/g)) {
						if (!ids.includes(match[1]!)) missing.push(match[1]!);
					}
				}
			}
			return { count: ids.length, unique: new Set(ids).size, missing };
		});
		expect(references.unique).toBe(references.count);
		expect(references.missing).toEqual([]);
		let printable = '';
		await page.exposeFunction('captureCompletePrint', (html: string) => {
			printable = html;
		});
		await page.evaluate(() => {
			const capture = (
				window as typeof window & { captureCompletePrint: (html: string) => Promise<void> }
			).captureCompletePrint;
			new MutationObserver((records) => {
				for (const record of records)
					for (const node of record.addedNodes) {
						if (node instanceof HTMLIFrameElement && node.contentWindow) {
							node.contentWindow.print = () => {
								void capture(node.contentDocument?.documentElement.outerHTML ?? '');
							};
						}
					}
			}).observe(document.body, { childList: true, subtree: true });
		});
		await page.getByRole('button', { name: 'Exporter en PDF' }).click();
		await expect
			.poll(() => printable.includes('Complete offscreen sentinel.'), { timeout: 30_000 })
			.toBe(true);
		expect(printable.match(/class="mermaid-block"/g)).toHaveLength(101);
		expect(printable.match(/<h2 /g)).toHaveLength(1000);
		await info.attach('complete-print.html', { body: printable, contentType: 'text/html' });
		await openPalette(page);
		await page.keyboard.type('Exporter en HTML');
		const download = page.waitForEvent('download');
		await page.keyboard.press('Enter');
		const path = info.outputPath('complete.html');
		await (await download).saveAs(path);
		const exported = await readFile(path, 'utf8');
		expect(exported).toContain('Complete offscreen sentinel.');
		expect(exported.match(/class="mermaid-block"/g)).toHaveLength(101);
		expect(exported.match(/<h2 /g)).toHaveLength(1000);
		await info.attach('complete.html', { path, contentType: 'text/html' });
		await info.attach('complete-fixture.json', {
			body: JSON.stringify({ source, references }),
			contentType: 'application/json'
		});
	});

	test('keeps complete Markdown semantics when Workers are unavailable', async ({ page }, info) => {
		await page.addInitScript(() => {
			Object.defineProperty(window, 'Worker', { value: undefined, configurable: true });
		});
		await resetAppState(page);
		const source =
			'\uFEFF---\r\ntitle: Local fallback\r\n---\r\n\r\n# Same\r\n\r\n[Reference][local]\r\n\r\n# Same\r\n\r\n$x^2$\r\n\r\n```js\r\nconst answer = 42;\r\n```\r\n\r\n[local]: #same-2\r\n\r\n<script>window.renderInjection = true</script>\r\n\r\nComplete tail.';
		await seedFiles(page, [{ name: 'fallback', content: source }]);
		await page.locator('[data-mode=read]').click();
		await expect(page.locator('.mdsh-preview #same')).toHaveText('Same');
		await expect(page.locator('.mdsh-preview #same-2')).toHaveText('Same');
		await expect(page.locator('.mdsh-preview a').filter({ hasText: 'Reference' })).toHaveAttribute(
			'href',
			'#same-2'
		);
		await expect(page.locator('.mdsh-preview .katex')).toHaveCount(1);
		await expect(page.locator('.mdsh-preview code .hljs-keyword')).toHaveText('const');
		await expect(page.locator('.mdsh-preview')).toContainText('Complete tail.');
		await expect(page.locator('.mdsh-preview script')).toHaveCount(0);
		expect(await page.evaluate(() => 'renderInjection' in window)).toBe(false);
		await info.attach('fallback-source.md', { body: source, contentType: 'text/markdown' });
	});
});

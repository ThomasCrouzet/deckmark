import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { resetAppState, runAction, seedFiles } from './helpers';

test('preserves typography and multipage Markdown content in an A4 PDF', async ({
	page,
	browser
}, testInfo) => {
	test.setTimeout(90_000);
	await resetAppState(page);
	const png = await readFile('static/pwa-192x192.png');
	const rows = Array.from(
		{ length: 65 },
		(_, index) => `| Ligne ${index + 1} | Valeur contrôlée ${index + 1} | Conforme |`
	).join('\n');
	const code = Array.from(
		{ length: 65 },
		(_, index) => `const line${index + 1} = "Texte de contrôle ${index + 1}";`
	).join('\n');
	const markdown = `# Fidélité du document Markdown

Ce paragraphe vérifie la police du texte, les accents français et la ponctuation. Le **texte en gras**, le *texte en italique* et le \`code inline\` doivent rester lisibles.

## Listes et citation

1. Première étape numérotée
2. Deuxième étape numérotée
   - Élément imbriqué
   - Second élément imbriqué

- [x] Vérification terminée
- [ ] Vérification restante

> Une citation conserve son retrait, sa bordure et son style italique.

### Illustration locale

![Illustration locale 192 pixels](data:image/png;base64,${png.toString('base64')})

## Mathématiques et diagramme

Identité d’Euler : $e^{i\\pi}+1=0$.

$$
\\int_0^1 x^2\\,dx = \\frac{1}{3}
$$

\`\`\`mermaid
graph LR
A[Lecture] --> B[Export PDF]
style B fill:#fee2e2,stroke:#991b1b,color:#123456
\`\`\`

## Tableau sur plusieurs pages

| Référence | Description | Résultat |
| --- | --- | --- |
${rows}

## Mots longs et liens

https://example.test/documents/${'reference'.repeat(18)}

| Identifiant long | Valeur |
| --- | --- |
| ${'0123456789abcdef'.repeat(8)} | Dernière cellule visible |

## Code sur plusieurs pages

\`\`\`javascript
${code}
const lastLine = "FIN DU CODE VISIBLE";
\`\`\`

## Conclusion

FIN DU DOCUMENT VISIBLE.
`;
	await writeFile(testInfo.outputPath('document.md'), markdown);
	await seedFiles(page, [{ name: 'fidelite-pdf', content: markdown }]);
	await page.locator('button[data-mode="read"]').click();
	await expect(page.locator('.mdsh-preview .mermaid-block svg')).toBeVisible();
	await expect(page.locator('.mdsh-preview .katex').first()).toBeVisible();
	const families = await page.locator('.mdsh-preview').evaluate((article) => ({
		prose: getComputedStyle(article).fontFamily,
		code: getComputedStyle(article.querySelector('code')!).fontFamily
	}));
	await page.locator('.mdsh-preview').screenshot({ path: testInfo.outputPath('lecture.png') });
	let captured = '';
	await page.exposeFunction('captureFidelityPrint', (html: string) => {
		captured = html;
	});
	await page.evaluate(() => {
		const capture = (
			globalThis as typeof globalThis & { captureFidelityPrint: (html: string) => Promise<void> }
		).captureFidelityPrint;
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
	await runAction(page, 'export-pdf');
	// The print frame runs no script and carries no content it did not build.
	await expect
		.poll(() =>
			page.evaluate(
				() => document.querySelector('iframe[data-mdsh-print]')?.getAttribute('sandbox') ?? null
			)
		)
		.toBe('allow-same-origin allow-modals');
	await expect.poll(() => captured.length).toBeGreaterThan(100);
	const printable = await browser.newPage({ viewport: { width: 673, height: 970 } });
	try {
		// Use a new navigation so app effects cannot change the printable document.
		await printable.route('**/api/__pdf_fidelity__', (route) =>
			route.fulfill({ contentType: 'text/html', body: `<!doctype html>${captured}` })
		);
		await printable.goto(new URL('/api/__pdf_fidelity__', page.url()).href, {
			waitUntil: 'networkidle'
		});
		await printable.emulateMedia({ media: 'print' });
		await printable.evaluate(async () => {
			await document.fonts.ready;
			await Promise.all(Array.from(document.images, (image) => image.decode()));
		});
		const pdfPath = testInfo.outputPath('fidelite-a4.pdf');
		await printable.pdf({
			path: pdfPath,
			format: 'A4',
			preferCSSPageSize: true,
			printBackground: true
		});
		await testInfo.attach('fidelite-a4', { path: pdfPath, contentType: 'application/pdf' });
		await writeFile(testInfo.outputPath('print.html'), captured);
		const metrics = await printable.evaluate(() => ({
			prose: getComputedStyle(document.body).fontFamily,
			proseHyphens: getComputedStyle(document.querySelector('p')!).hyphens,
			code: getComputedStyle(document.querySelector('pre code')!).fontFamily,
			technicalReferences: [
				'a[href^="https://example.test/"]',
				'table:last-of-type tbody td:first-child'
			].map((selector) => {
				const element = document.querySelector(selector)!;
				const range = document.createRange();
				range.selectNodeContents(element);
				const style = getComputedStyle(element);
				return {
					hyphens: style.hyphens,
					overflowWrap: style.overflowWrap,
					lines: range.getClientRects().length
				};
			}),
			imageCenter: (() => {
				const box = document.querySelector('img')!.getBoundingClientRect();
				return box.left + box.width / 2;
			})(),
			width: document.body.clientWidth,
			overflow: Array.from(
				document.querySelectorAll('p, pre, table, img, .mermaid-block, .math-block')
			)
				.filter(
					(element) =>
						element.getBoundingClientRect().right > document.body.clientWidth + 1 ||
						element.scrollWidth > element.clientWidth + 1
				)
				.map((element) => ({
					tag: element.tagName,
					text: element.textContent?.slice(0, 80),
					width: element.clientWidth,
					scroll: element.scrollWidth
				}))
		}));
		await writeFile(
			testInfo.outputPath('metrics.json'),
			JSON.stringify({ reading: families, print: metrics }, null, 2)
		);
		expect(metrics.prose).toBe(families.prose);
		expect(metrics.code).toBe(families.code);
		expect(metrics.proseHyphens).toBe('auto');
		for (const reference of metrics.technicalReferences) {
			expect(reference.hyphens).toBe('none');
			expect(reference.overflowWrap).toBe('anywhere');
			expect(reference.lines).toBeGreaterThan(1);
		}
		expect(Math.abs(metrics.imageCenter - metrics.width / 2)).toBeLessThan(1);
		expect(metrics.overflow).toEqual([]);
		await expect(printable.locator('h1')).toHaveText('Fidélité du document Markdown');
		await expect(printable.locator('input[type="checkbox"]')).toHaveCount(2);
		await expect(printable.locator('table').first().locator('tbody tr')).toHaveCount(65);
		await expect(printable.locator('pre code')).toContainText('FIN DU CODE VISIBLE');
		await expect(printable.locator('.mermaid-block svg text')).toContainText([
			'Lecture',
			'Export PDF'
		]);
		await expect(printable.locator('body')).toContainText('FIN DU DOCUMENT VISIBLE');
	} finally {
		await printable.close();
	}
});

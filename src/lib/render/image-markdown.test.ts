import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyImageMetadataToHtml, ImageMarkdownRoundTrip } from './image-markdown';

describe('ImageMarkdownRoundTrip', () => {
	it('keeps Unicode alternative text and captions after WYSIWYG editing', () => {
		const source = '![Évolution des résultats](image.png "Légende précise")';
		const roundTrip = new ImageMarkdownRoundTrip(source);
		expect(roundTrip.editorMarkdown).toBe('![1.00](image.png "Légende précise")');
		expect(roundTrip.restore(roundTrip.editorMarkdown)).toBe(source);
		expect(roundTrip.alternatives).toEqual(['Évolution des résultats']);
	});

	it('persists image size separately from alternative text', () => {
		const first = new ImageMarkdownRoundTrip('![Diagramme](image.png "Légende")');
		const resized = first.restore('![0.75](image.png "Légende")');
		expect(resized).toContain('![Diagramme](image.png "Légende")');
		expect(resized).toContain('<!-- mdsh:image ratio=0.75 -->');
		const reloaded = new ImageMarkdownRoundTrip(resized);
		expect(reloaded.editorMarkdown).toContain('![0.75](image.png "Légende")');
		expect(reloaded.restore(reloaded.editorMarkdown)).toBe(resized);
	});

	it('does not convert numeric or decorative alternative text to geometry', () => {
		const source = '![2026](year.png)\n\n![](decoration.png "Décoration")';
		const roundTrip = new ImageMarkdownRoundTrip(source);
		expect(roundTrip.restore(roundTrip.editorMarkdown)).toBe(source);
	});

	it('keeps different alternative text for two uses of one source', () => {
		const source = '![Avant](same.png)\n\n![Après](same.png)';
		const roundTrip = new ImageMarkdownRoundTrip(source);
		expect(roundTrip.restore(roundTrip.editorMarkdown)).toBe(source);
	});

	it('keeps alternative text with the moved image when captions disambiguate a reorder', () => {
		const roundTrip = new ImageMarkdownRoundTrip(
			'![Avant](same.png "A")\n\n![Après](same.png "B")'
		);
		expect(roundTrip.restore('![1.00](same.png "B")\n\n![1.00](same.png "A")')).toBe(
			'![Après](same.png "B")\n\n![Avant](same.png "A")'
		);
	});
});

describe('applyImageMetadataToHtml', () => {
	it('applies the declared ratio only to matching images', () => {
		const html = applyImageMetadataToHtml(
			'![Figure](figure.png)\n<!-- mdsh:image ratio=0.50 -->',
			'<p><img src="figure.png" alt="Figure"></p><img src="other.png">'
		);
		const template = document.createElement('template');
		template.innerHTML = html;
		expect(template.content.querySelector('img')?.getAttribute('data-mdsh-image-ratio')).toBe(
			'0.5'
		);
		expect(
			template.content.querySelector('img[src="other.png"]')?.hasAttribute('data-mdsh-image-ratio')
		).toBe(false);
	});
});

describe('example and metadata preservation', () => {
	it('does not change images and comments in code blocks', () => {
		const source =
			'~~~markdown\n![Exemple](example.png)\n<!-- mdsh:image ratio=0.50 -->\n```\n~~~\n\n![Vraie](real.png)';
		const roundTrip = new ImageMarkdownRoundTrip(source);
		expect(roundTrip.editorMarkdown).toContain('![Exemple](example.png)');
		expect(roundTrip.restore(roundTrip.editorMarkdown)).toBe(source);
		expect(applyImageMetadataToHtml(source, '<img src="example.png">')).toBe(
			'<img src="example.png">'
		);
	});

	it('keeps escaped characters and normalizes three title syntaxes', () => {
		for (const title of ['"Légende \\"précise\\""', "'Légende précise'", '(Légende précise)']) {
			const roundTrip = new ImageMarkdownRoundTrip(`![A\\[B\\]](<images/été 2026.png> ${title})`);
			expect(roundTrip.restore(roundTrip.editorMarkdown)).toContain(
				'![A\\[B\\]](<images/été 2026.png> "Légende'
			);
		}
	});

	it('ignores invalid ratios and keeps the last valid ratio', () => {
		const roundTrip = new ImageMarkdownRoundTrip('![Alt](a.png)\n<!-- mdsh:image ratio=0.50 -->');
		expect(roundTrip.restore('![invalid](a.png)')).toContain('ratio=0.50');
		for (const ratio of ['0', '0.01', '11']) {
			const source = `![Alt](a.png)\n<!-- mdsh:image ratio=${ratio} -->`;
			expect(new ImageMarkdownRoundTrip(source).editorMarkdown).toContain('![1.00]');
			expect(applyImageMetadataToHtml(source, '<img src="a.png">')).toBe('<img src="a.png">');
		}
	});

	it('uses new block captions and removes only orphan comments', () => {
		const roundTrip = new ImageMarkdownRoundTrip('');
		expect(
			roundTrip.restore(
				'![text](new.png "Nouvelle")\n<!-- mdsh:image ratio=0.50 -->\n\n<!-- mdsh:image ratio=0.25 -->'
			)
		).toBe('![Nouvelle](new.png "Nouvelle")\n');
	});

	it('applies ratios by occurrence and keeps images without a source', () => {
		const source = '![A](same.png)\n<!-- mdsh:image ratio=0.50 -->\n![B](same.png)';
		const html = applyImageMetadataToHtml(
			source,
			'<img><img src="same.png"><img src="same.png"><img src="unknown.png">'
		);
		expect(html.match(/data-mdsh-image-ratio/g)).toHaveLength(1);
	});
});

describe('image syntax and hostile input', () => {
	it.each([
		'data:image/png;base64,AAAA',
		'blob:https://example.test/1234',
		'https://example.test/image_(1).png',
		'<images/été 2026.png>'
	])('préserve la destination %s sans la réinterpréter', (source) => {
		const markdown = `![Figure]( ${source})`;
		expect(new ImageMarkdownRoundTrip(markdown).editorMarkdown).toBe(markdown);
		const accepted = `![Figure](${source} "Légende")`;
		const roundTrip = new ImageMarkdownRoundTrip(accepted);
		expect(roundTrip.editorMarkdown).toBe(`![1.00](${source} "Légende")`);
		expect(roundTrip.restore(roundTrip.editorMarkdown)).toBe(accepted);
	});

	it('keeps literal backslashes, escaped delimiters, and empty titles', () => {
		const markdown = String.raw`![A\\B\[C\]\\](image.png "C\\D\"E\\")`;
		const roundTrip = new ImageMarkdownRoundTrip(markdown);
		expect(roundTrip.alternatives).toEqual(['A\\B[C]\\']);
		expect(roundTrip.restore(roundTrip.editorMarkdown)).toBe(markdown);
		for (const title of ['""', "''", '()']) {
			const empty = new ImageMarkdownRoundTrip(`![Alt](image.png ${title})`);
			expect(empty.restore(empty.editorMarkdown)).toBe('![Alt](image.png)');
		}
	});

	it('accepts a large valid embedded image and a long escaped caption', () => {
		const source = 'data:image/png;base64,' + 'A'.repeat(300000);
		const title = String.raw`Une \"citation\" et un chemin C:\\images. `.repeat(1000);
		const markdown = `![Illustration](${source} "${title}")`;
		const image = new ImageMarkdownRoundTrip(markdown);
		expect(image.editorMarkdown).toBe(`![1.00](${source} "${title}")`);
		expect(image.restore(image.editorMarkdown)).toBe(markdown);
	});

	it.each(['alt', 'double', 'single', 'parentheses'])(
		'borne le traitement du motif hostile %s dans un processus isolé',
		(kind) => {
			const moduleUrl = pathToFileURL(resolve('src/lib/render/image-markdown.ts')).href;
			const script = `
				import assert from 'node:assert/strict';
				import { ImageMarkdownRoundTrip } from ${JSON.stringify(moduleUrl)};
				const backslash = String.fromCharCode(92);
				const kind = ${JSON.stringify(kind)};
				const source = kind === 'alt' ? '![' + backslash.repeat(200000) + 'x'
					: '![](! ' + ({double: '"', single: "'", parentheses: '('}[kind])
						+ (backslash + ({double: '!', single: '&', parentheses: '('}[kind])).repeat(200000);
				const image = new ImageMarkdownRoundTrip(source);
				assert.equal(image.editorMarkdown, source);
				assert.equal(image.restore(source), source);
				assert.deepEqual(image.alternatives, []);
			`;
			const result = spawnSync(
				process.execPath,
				['--experimental-strip-types', '--input-type=module', '-e', script],
				{ encoding: 'utf8', timeout: 2000 }
			);
			expect(result.error, result.stderr).toBeUndefined();
			expect(result.signal, result.stderr).toBeNull();
			expect(result.status, result.stderr).toBe(0);
		}
	);
});

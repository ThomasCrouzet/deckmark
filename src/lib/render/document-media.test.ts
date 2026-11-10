import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { incorporateDocumentImages, markdownImageDestinations } from './document-media';

const PNG_BASE64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDfoAAAAASUVORK5CYII=';
const PNG_BYTES = Uint8Array.from(atob(PNG_BASE64), (character) => character.charCodeAt(0));
const OTHER_PNG_BASE64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const OTHER_PNG_BYTES = Uint8Array.from(atob(OTHER_PNG_BASE64), (character) =>
	character.charCodeAt(0)
);

function selectedFile(
	name: string,
	relativePath: string | undefined,
	bytes: Uint8Array<ArrayBuffer>
): File {
	const file = new File([bytes], name, { type: 'image/png' });
	if (relativePath) Object.defineProperty(file, 'webkitRelativePath', { value: relativePath });
	return file;
}

beforeEach(() =>
	vi.stubGlobal(
		'createImageBitmap',
		vi.fn(async () => ({ width: 1, height: 1, close: vi.fn() }))
	)
);
afterEach(() => vi.unstubAllGlobals());

describe('selected Markdown resources', () => {
	it('finds Unicode paths, enclosed spaces, and parentheses outside code', () => {
		const markdown =
			'![Été](<images/été 2026.png>)\n\n![Parenthèse](images/a(b).png)\n\n`![Code](ignore.png)`\n\n```md\n![Code](ignore2.png)\n```';
		expect(markdownImageDestinations(markdown).map((item) => item.source)).toEqual([
			'images/été 2026.png',
			'images/a(b).png'
		]);
	});

	it('embeds only the selected file that matches the path', async () => {
		const file = new File([PNG_BYTES], 'été 2026.png', { type: 'image/png' });
		Object.defineProperty(file, 'webkitRelativePath', { value: 'rapport/images/été 2026.png' });
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		const result = await incorporateDocumentImages('![Été](<images/été 2026.png> "Légende")', {
			files: [file]
		});
		expect(result.markdown).toContain('![Été](<data:image/png;base64,');
		expect(result.markdown).toContain('> "Légende")');
		expect(result.embedded).toBe(1);
		expect(result.issues).toEqual([]);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('rejects traversal and an ambiguous choice without reading an adjacent file', async () => {
		const first = new File([PNG_BYTES], 'figure.png', { type: 'image/png' });
		const second = new File([PNG_BYTES], 'figure.png', { type: 'image/png' });
		const traversal = await incorporateDocumentImages('![Figure](../figure.png)', {
			files: [first]
		});
		expect(traversal.embedded).toBe(0);
		expect(traversal.issues).toHaveLength(1);
		const ambiguous = await incorporateDocumentImages('![Figure](images/figure.png)', {
			files: [first, second]
		});
		expect(ambiguous.embedded).toBe(0);
		expect(ambiguous.issues).toHaveLength(1);
	});
});

describe('encoded filename identity', () => {
	// The file chooser in Playwright sets only File.name. A selected folder also
	// sets webkitRelativePath, so the browser suite cannot build the conflicting
	// directory candidates that expose the wrong-file match.
	it.each([
		['images/figure%23public.png', 'vault/images/figure#private.png', 'figure#private.png'],
		['images/figure%3Fv1.png', 'vault/images/figure?v2.png', 'figure?v2.png']
	])('keeps %s unresolved instead of embedding %s', async (destination, relativePath, name) => {
		const file = selectedFile(name, relativePath, OTHER_PNG_BYTES);
		const source = `![Figure](${destination})`;
		const result = await incorporateDocumentImages(source, { files: [file] });
		expect(result.markdown).toBe(source);
		expect(result.embedded).toBe(0);
		expect(result.issues).toEqual([{ source: destination, reason: 'unreadable' }]);
	});

	it('embeds the exact bytes of the selected encoded filename', async () => {
		const file = selectedFile('figure#public.png', undefined, OTHER_PNG_BYTES);
		const result = await incorporateDocumentImages('![Figure](images/figure%23public.png)', {
			files: [file]
		});
		expect(result.embedded).toBe(1);
		expect(result.markdown).toBe(`![Figure](data:image/png;base64,${OTHER_PNG_BASE64})`);
	});

	it('does not fall back to a basename in another directory', async () => {
		const file = selectedFile('figure.png', 'other/figure.png', PNG_BYTES);
		const source = '![Figure](images/figure.png)';
		const result = await incorporateDocumentImages(source, { files: [file] });
		expect(result.markdown).toBe(source);
		expect(result.embedded).toBe(0);
		expect(result.issues).toEqual([{ source: 'images/figure.png', reason: 'unreadable' }]);
	});

	it('strips a genuine query and fragment before matching the file bytes', async () => {
		const file = selectedFile('figure.png', 'vault/images/figure.png', OTHER_PNG_BYTES);
		const result = await incorporateDocumentImages('![Figure](images/figure.png?size=large#view)', {
			files: [file]
		});
		expect(result.embedded).toBe(1);
		expect(result.markdown).toBe(`![Figure](data:image/png;base64,${OTHER_PNG_BASE64})`);
	});

	it.each(['images/%2e%2e/figure.png', 'images/%2e%2e%2ffigure.png'])(
		'rejects encoded traversal in %s',
		async (destination) => {
			const file = selectedFile('figure.png', 'vault/images/figure.png', PNG_BYTES);
			const source = `![Figure](${destination})`;
			const result = await incorporateDocumentImages(source, { files: [file] });
			expect(result.markdown).toBe(source);
			expect(result.embedded).toBe(0);
		}
	);

	it('decodes a percent sign once and keeps a literal percent sequence', async () => {
		const literal = selectedFile('figure%23public.png', undefined, OTHER_PNG_BYTES);
		const hash = selectedFile('figure#public.png', undefined, PNG_BYTES);
		const result = await incorporateDocumentImages('![Figure](images/figure%2523public.png)', {
			files: [literal, hash]
		});
		expect(result.embedded).toBe(1);
		expect(result.markdown).toBe(`![Figure](data:image/png;base64,${OTHER_PNG_BASE64})`);
	});
});

describe('mixed resource traversal', () => {
	it('finds HTML, SVG, nested alternatives, and escaped destinations outside code', () => {
		const source =
			'<img href="ignored" src="a.png?x=1&amp;y=2"><image xlink:href=svg.png /><img src=\'single.png\'><img src="">\n![a [b] \\]]( a\\(b\\).png "title")\n\\![escaped](skip.png) ![empty]() ![broken]\n``![code](skip.png) ` nested``\n~~~md\n![code](skip2.png)\n```\n~~~\n![last](last.png)';
		expect(markdownImageDestinations(source).map(({ source }) => source)).toEqual([
			'a.png?x=1&y=2',
			'svg.png',
			'single.png',
			'a(b).png',
			'last.png'
		]);
	});

	it('does not start without consent and ignores data URLs and fragments', async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		const result = await incorporateDocumentImages(
			'![remote](https://example.org/a.png) ![data](data:image/png;base64,a) ![fragment](#a)',
			{}
		);
		expect(result.issues).toEqual([{ source: 'https://example.org/a.png', reason: 'blocked' }]);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('replaces matching HTML and Markdown from one explicit download', async () => {
		const fetchSpy = vi.fn(async () => ({
			ok: true,
			headers: new Headers({ 'content-type': 'image/png' }),
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(PNG_BYTES);
					controller.close();
				}
			})
		}));
		vi.stubGlobal('fetch', fetchSpy);
		const result = await incorporateDocumentImages(
			'<img src="https://example.org/a.png">\n![Alt](https://example.org/a.png)',
			{ allowNetwork: true }
		);
		expect(fetchSpy).toHaveBeenCalledOnce();
		expect(result.embedded).toBe(1);
		expect(result.markdown.match(/data:image\/png;base64,/g)).toHaveLength(2);
	});

	it('keeps text after a download error', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('offline');
			})
		);
		const source = '![Alt](https://example.org/a.png)';
		const result = await incorporateDocumentImages(source, { allowNetwork: true });
		expect(result.markdown).toBe(source);
		expect(result.issues).toEqual([{ source: 'https://example.org/a.png', reason: 'unreadable' }]);
	});

	it.each(['https://example.org/images/figure.png', './figure.png?version=1'])(
		'retrouve un nom unique sélectionné pour %s',
		async (source) => {
			const result = await incorporateDocumentImages(`![Alt](${source})`, {
				files: [new File([PNG_BYTES], 'figure.png', { type: 'image/png' })]
			});
			expect(result.embedded).toBe(1);
		}
	);

	it.each(['%ZZ.png', '%2e%2e/figure.png', 'https://[invalid/figure.png', '/'])(
		'refuse le chemin inexploitable %s',
		async (source) => {
			const result = await incorporateDocumentImages(`![Alt](${source})`, {
				files: [new File([PNG_BYTES], 'figure.png', { type: 'image/png' })]
			});
			expect(result.embedded).toBe(0);
			expect(result.issues).toHaveLength(1);
		}
	);

	it('limits selected files and keeps sources beyond the limit', async () => {
		const bytes = new Uint8Array(2 * 1024 * 1024);
		bytes.set(PNG_BYTES);
		const files = Array.from(
			{ length: 5 },
			(_, index) => new File([bytes], `${index}.png`, { type: 'image/png' })
		);
		const result = await incorporateDocumentImages(
			files.map((file) => `![Alt](${file.name})`).join('\n'),
			{ files }
		);
		expect(result.embedded).toBe(4);
		expect(result.issues).toEqual([{ source: '4.png', reason: 'too-large' }]);
		expect(result.markdown).toContain('![Alt](4.png)');
	});

	it('stops a pending network read on abort and never starts the next one', async () => {
		const source = '![A](https://example.org/a.png)\n![B](https://example.org/b.png)';
		let started = 0;
		const fetchSpy = vi.fn(
			(_input: RequestInfo | URL, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					started += 1;
					init?.signal?.addEventListener('abort', () =>
						reject(new DOMException('Operation cancelled', 'AbortError'))
					);
				})
		);
		vi.stubGlobal('fetch', fetchSpy);
		const controller = new AbortController();
		const pending = incorporateDocumentImages(source, {
			allowNetwork: true,
			signal: controller.signal
		});
		await vi.waitFor(() => expect(started).toBe(1));
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
		expect(started).toBe(1);
	});

	it('stops a local decode on abort and keeps the original Markdown', async () => {
		vi.stubGlobal(
			'createImageBitmap',
			vi.fn(() => new Promise(() => {}))
		);
		const source = '![Alt](figure.png)';
		const file = new File([PNG_BYTES], 'figure.png', { type: 'image/png' });
		const controller = new AbortController();
		const pending = incorporateDocumentImages(source, { files: [file], signal: controller.signal });
		await vi.waitFor(() => expect(createImageBitmap).toHaveBeenCalled());
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
	});

	it('does not read a remote image after the aggregate budget is full', async () => {
		const large = new Uint8Array(2 * 1024 * 1024);
		large.set(PNG_BYTES);
		const sources = Array.from({ length: 5 }, (_, index) => `https://example.org/${index}.png`);
		let reads = 0;
		const fetchSpy = vi.fn(async () => {
			reads += 1;
			return {
				ok: true,
				headers: new Headers({ 'content-type': 'image/png' }),
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(large);
						controller.close();
					}
				})
			} as unknown as Response;
		});
		vi.stubGlobal('fetch', fetchSpy);
		const markdown = sources.map((source) => `![Alt](${source})`).join('\n');
		const result = await incorporateDocumentImages(markdown, { allowNetwork: true });
		expect(result.embedded).toBe(4);
		expect(reads).toBe(4);
		expect(result.issues).toEqual([{ source: sources[4], reason: 'too-large' }]);
		expect(result.markdown).toContain(`![Alt](${sources[4]})`);
	});
});

describe('case-insensitive local schemes', () => {
	it('loads a BLOB URL and keeps an existing DATA URL', async () => {
		const fetchSpy = vi.fn(async () => ({
			ok: true,
			headers: new Headers({ 'content-type': 'image/png' }),
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(PNG_BYTES);
					controller.close();
				}
			})
		}));
		vi.stubGlobal('fetch', fetchSpy);
		const result = await incorporateDocumentImages(
			`![Blob](BLOB:${window.location.origin}/image)\n![Data](DATA:image/png;base64,AAAA)`,
			{}
		);
		expect(result.issues).toEqual([]);
		expect(result.embedded).toBe(1);
		expect(result.markdown).toContain('![Blob](data:image/png;base64,');
		expect(result.markdown).toContain('![Data](DATA:image/png;base64,AAAA)');
		expect(fetchSpy).toHaveBeenCalledOnce();
	});
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	embedImageFile,
	MAX_IMAGE_BYTES,
	MediaPreparationError,
	prepareHtmlMedia,
	prepareHtmlMediaOrThrow
} from './image-media';

const PNG_BASE64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDfoAAAAASUVORK5CYII=';
const PNG_BYTES = Uint8Array.from(atob(PNG_BASE64), (character) => character.charCodeAt(0));

function pngFile(name = 'figure.png') {
	return new File([PNG_BYTES], name, { type: 'image/png' });
}

beforeEach(() =>
	vi.stubGlobal(
		'createImageBitmap',
		vi.fn(async () => ({ width: 1, height: 1, close: vi.fn() }))
	)
);
afterEach(() => vi.unstubAllGlobals());

describe('durable embedding', () => {
	it('rejects a false PNG and active content', async () => {
		await expect(
			embedImageFile(new File(['<script>bad</script>'], 'fake.png', { type: 'image/png' }))
		).rejects.toMatchObject({ code: 'invalid-content' });
		await expect(
			embedImageFile(new File(['html'], 'fake.html', { type: 'text/html' }))
		).rejects.toMatchObject({ code: 'unsupported-type' });
	});

	it('rejects file size before reading and dimensions after decoding', async () => {
		await expect(
			embedImageFile(
				new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], 'large.png', { type: 'image/png' })
			)
		).rejects.toMatchObject({ code: 'too-large' });
		const close = vi.fn();
		vi.stubGlobal(
			'createImageBitmap',
			vi.fn(async () => ({ width: 20_000, height: 20_000, close }))
		);
		await expect(embedImageFile(pngFile())).rejects.toMatchObject({ code: 'dimensions' });
		expect(close).toHaveBeenCalledOnce();
	});

	it('removes network subresources from an embedded SVG', async () => {
		const svg =
			'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><filter id="f"><feImage href="https://tracker.example/pixel"/></filter><rect width="10" height="10" fill="red"/></svg>';
		const result = await embedImageFile(new File([svg], 'figure.svg', { type: 'image/svg+xml' }));
		const decoded = atob(result.dataUri.split(',')[1] ?? '');
		expect(decoded).toContain('<rect');
		expect(decoded).not.toContain('tracker.example');
		expect(decoded).not.toContain('feImage');
	});
});

describe('export policy and preparation', () => {
	it('does not start a request without consent', async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		const result = await prepareHtmlMedia(
			'<img data-mdsh-remote-src="https://images.example/figure.png" alt="Figure">',
			{ allowNetwork: false }
		);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(result.issues).toEqual([
			{ source: 'https://images.example/figure.png', reason: 'blocked' }
		]);
		await expect(
			prepareHtmlMediaOrThrow('<img src="relative.png">', { allowNetwork: false })
		).rejects.toBeInstanceOf(MediaPreparationError);
	});

	it('embeds an approved resource without credentials or referrer', async () => {
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
		const result = await prepareHtmlMedia(
			'<img data-mdsh-remote-src="https://images.example/figure.png" alt="Figure">',
			{ allowNetwork: true }
		);
		expect(fetchSpy).toHaveBeenCalledWith(
			'https://images.example/figure.png',
			expect.objectContaining({
				credentials: 'omit',
				referrerPolicy: 'no-referrer',
				signal: expect.any(AbortSignal)
			})
		);
		expect(result.issues).toEqual([]);
		expect(result.html).toContain(`src="data:image/png;base64,${PNG_BASE64}"`);
		expect(result.html).not.toContain('data-mdsh-remote-src');
	});

	it('reports a denied HTTP source and an unreadable image', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ ok: false, status: 404 }))
		);
		const missing = await prepareHtmlMedia('<img src="missing.png">', { allowNetwork: true });
		expect(missing.issues[0]?.reason).toBe('fetch-failed');
		const malformed = await prepareHtmlMedia('<img src="data:image/png;base64,AAAA">', {
			allowNetwork: false
		});
		expect(malformed.issues[0]?.reason).toBe('invalid-content');
	});

	it('limits the stream when Content-Length is missing or incorrect', async () => {
		const cancel = vi.fn();
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(new Uint8Array(MAX_IMAGE_BYTES + 1));
			},
			cancel
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({
				ok: true,
				headers: new Headers({ 'content-length': '10', 'content-type': 'image/png' }),
				body: stream
			}))
		);
		const result = await prepareHtmlMedia('<img src="https://images.example/large.png">', {
			allowNetwork: true
		});
		expect(result.issues[0]?.reason).toBe('too-large');
		expect(cancel).toHaveBeenCalledOnce();
	});

	it('rejects credentials, third-party HTTP, and foreign blobs without a request', async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		const result = await prepareHtmlMedia(
			'<img src="https://user:secret@images.example/a.png"><img src="http://images.example/b.png"><img src="blob:https://other.example/id">',
			{ allowNetwork: true }
		);
		expect(result.issues).toHaveLength(3);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('uses decoded dimensions for the ratio', async () => {
		vi.stubGlobal(
			'createImageBitmap',
			vi.fn(async () => ({ width: 192, height: 192, close: vi.fn() }))
		);
		const result = await prepareHtmlMedia(
			`<img src="data:image/png;base64,${PNG_BASE64}" data-mdsh-image-ratio="0.5">`,
			{ allowNetwork: false }
		);
		expect(result.html).toContain('width:min(50%,96px)');
		expect(result.issues).toEqual([]);
	});
});

describe('limit and read error validation', () => {
	it.each(['jpeg', 'gif', 'webp', 'avif', 'svg+xml'])(
		'refuse une signature invalide pour %s',
		async (type) => {
			await expect(
				embedImageFile(new File(['wrong'], 'image', { type: `image/${type}` }))
			).rejects.toMatchObject({ code: 'invalid-content' });
		}
	);

	it('rejects a file without an extension and SVG with external resources', async () => {
		await expect(embedImageFile(new File([PNG_BYTES], 'unknown'))).rejects.toMatchObject({
			code: 'unsupported-type'
		});
		await expect(
			embedImageFile(
				new File(
					[
						'<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.org/a.png"/></svg>'
					],
					'image.svg'
				)
			)
		).rejects.toMatchObject({ code: 'invalid-content' });
	});

	it.each(['error', 'invalid-result'])('reports FileReader mode %s', async (mode) => {
		vi.stubGlobal(
			'FileReader',
			class {
				result = 'invalid';
				onload?: () => void;
				onerror?: () => void;
				readAsArrayBuffer() {
					queueMicrotask(() => (mode === 'error' ? this.onerror?.() : this.onload?.()));
				}
			}
		);
		await expect(embedImageFile(pngFile())).rejects.toMatchObject({ code: 'unreadable' });
	});

	it.each([
		[0, 1],
		[1, 0],
		[1, 9000],
		[6000, 6000]
	])('rejette des dimensions %sx%s', async (width, height) => {
		vi.stubGlobal(
			'createImageBitmap',
			vi.fn(async () => ({ width, height, close: vi.fn() }))
		);
		await expect(embedImageFile(pngFile())).rejects.toMatchObject({
			code: width === 0 || height === 0 ? 'unreadable' : 'dimensions'
		});
	});

	it.each(['error', 'zero'])('uses WebKit decoding without decode: %s', async (mode) => {
		vi.stubGlobal('createImageBitmap', undefined);
		vi.stubGlobal(
			'Image',
			class {
				naturalWidth = mode === 'zero' ? 0 : 1;
				naturalHeight = 1;
				onload?: () => void;
				onerror?: () => void;
				set src(_value: string) {
					queueMicrotask(() => (mode === 'error' ? this.onerror?.() : this.onload?.()));
				}
				removeAttribute() {}
			}
		);
		await expect(embedImageFile(pngFile())).rejects.toMatchObject({ code: 'unreadable' });
	});

	it('stops an unresponsive WebKit decode', async () => {
		vi.useFakeTimers();
		vi.stubGlobal('createImageBitmap', undefined);
		vi.stubGlobal(
			'Image',
			class {
				removeAttribute() {}
			}
		);
		const file = pngFile();
		Object.defineProperty(file, 'arrayBuffer', { value: async () => PNG_BYTES.buffer });
		const assertion = expect(embedImageFile(file)).rejects.toMatchObject({ code: 'unreadable' });
		await vi.advanceTimersByTimeAsync(10_000);
		await assertion;
		vi.useRealTimers();
	});

	it('accepts percent-encoded data and rejects invalid variants', async () => {
		const svg = encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"/>');
		expect(
			(await prepareHtmlMedia(`<img src="data:image/svg+xml,${svg}">`, { allowNetwork: false }))
				.issues
		).toEqual([]);
		for (const source of [
			'data:broken',
			'data:image/png;base64,??',
			'data:image/png,%ZZ',
			`data:image/png;base64,${'A'.repeat(MAX_IMAGE_BYTES * 1.5 + 1025)}`,
			'data:text/html;base64,YQ=='
		]) {
			expect(
				(await prepareHtmlMedia(`<img src="${source}">`, { allowNetwork: false })).issues
			).toHaveLength(1);
		}
	});

	it('reports missing sources, srcset, and expired blobs without data loss', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('expired');
			})
		);
		const blob = `blob:${window.location.origin}/expired`;
		const result = await prepareHtmlMedia(
			`<img><img alt="Absent"><img src="data:image/png;base64,${PNG_BASE64}" srcset="a.png 2x"><img src="data:image/png;base64,${PNG_BASE64}" data-mdsh-remote-srcset="b.png 2x"><img src="${blob}">`,
			{ allowNetwork: false }
		);
		expect(result.issues).toEqual([
			{ source: '', reason: 'unreadable' },
			{ source: 'Absent', reason: 'unreadable' },
			{ source: 'a.png 2x', reason: 'unsupported-srcset' },
			{ source: 'b.png 2x', reason: 'unsupported-srcset' },
			{ source: blob, reason: 'fetch-failed' }
		]);
		expect(result.html).toContain(`data-mdsh-media-src="${blob}"`);
		const repeated = await prepareHtmlMedia(result.html, { allowNetwork: false });
		expect(repeated.issues).toEqual(result.issues);
		expect(repeated.html).toBe(result.html);
	});

	it('checks the total limit before an additional request', async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		const result = await prepareHtmlMedia(
			`<img alt="A" src="data:image/png;base64,${PNG_BASE64}"><img src="next.png">`,
			{ allowNetwork: true, maxTotalBytes: 1 }
		);
		expect(result.issues.map((issue) => issue.reason)).toEqual(['too-large', 'too-large']);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it.each(['large-header', 'missing-stream'])('rejects response mode %s', async (mode) => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({
				ok: true,
				headers: new Headers(
					mode === 'large-header' ? { 'content-length': String(MAX_IMAGE_BYTES + 1) } : {}
				),
				body: null
			}))
		);
		const result = await prepareHtmlMedia('<img src="https://example.org/a.png">', {
			allowNetwork: true
		});
		expect(result.issues[0]?.reason).toBe(mode === 'large-header' ? 'too-large' : 'unreadable');
	});

	it('embeds SVG references and detects MIME without a file name', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({
				ok: true,
				headers: new Headers(),
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(PNG_BYTES);
						controller.close();
					}
				})
			}))
		);
		const result = await prepareHtmlMedia(
			'<svg><image href="https://example.org/a.png"/><image data-mdsh-remote-xlink-href="https://example.org/b.png"/></svg>',
			{ allowNetwork: true }
		);
		expect(result.embedded).toBe(2);
		expect(result.issues).toEqual([]);
		expect(result.html).not.toContain('https://');
	});
});

describe('exported image schemes and fragments', () => {
	it('rejects an image fragment but keeps internal SVG references', async () => {
		const fragment = '<svg><defs><g id="drawing"/></defs><image href="#drawing"/></svg>';
		await expect(
			prepareHtmlMediaOrThrow(`<img src="#drawing">${fragment}`, { allowNetwork: false })
		).rejects.toMatchObject({ issues: [{ source: '#drawing', reason: 'invalid-content' }] });
		expect(await prepareHtmlMediaOrThrow(fragment, { allowNetwork: false })).toContain(
			'href="#drawing"'
		);
	});
});

import { describe, it, expect, vi, afterEach, beforeEach, type Mock } from 'vitest';
import { buildPrintDocument, printInIframe, PrintImageError, waitForPrintImages } from './print';

describe('image decoding before print', () => {
	it('rejects an unreadable image before it opens an incomplete PDF', async () => {
		const doc = document.implementation.createHTMLDocument();
		doc.body.innerHTML = '<img src="data:image/png;base64,AAAA" alt="Figure">';
		const image = doc.querySelector('img')!;
		image.decode = vi.fn(async () => {
			throw new Error('decode failed');
		});
		await expect(waitForPrintImages(doc)).rejects.toBeInstanceOf(PrintImageError);
	});

	it('stops during decoding after cancellation', async () => {
		const doc = document.implementation.createHTMLDocument();
		doc.body.innerHTML = '<img src="data:image/png;base64,AAAA">';
		doc.querySelector('img')!.decode = () => new Promise(() => {});
		const controller = new AbortController();
		const pending = waitForPrintImages(doc, { signal: controller.signal });
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
	});
});

describe('buildPrintDocument - structure', () => {
	it('uses an explicit English or French language', () => {
		expect(buildPrintDocument({ title: 'T', bodyHtml: '', lang: 'fr' })).toContain(
			'<html lang="fr">'
		);
		expect(buildPrintDocument({ title: 'T', bodyHtml: '', lang: 'en' })).toContain(
			'<html lang="en">'
		);
	});
});

describe('buildPrintDocument - security', () => {
	it('escapes angle brackets and ampersands in the title', () => {
		const html = buildPrintDocument({
			title: '<script>alert(1)</script> & "quoted"',
			bodyHtml: ''
		});
		expect(html).not.toContain('<script>alert(1)</script>');
		expect(html).toContain('&lt;script&gt;');
		expect(html).toContain('&amp;');
		expect(html).toContain('&quot;');
	});

	it('includes a restrictive CSP that blocks scripts', () => {
		const html = buildPrintDocument({ title: 'T', bodyHtml: '' });
		expect(html).toMatch(/http-equiv="Content-Security-Policy"/i);
		expect(html).toMatch(/script-src 'none'/);
		expect(html).toMatch(/object-src 'none'/);
		expect(html).toMatch(/form-action 'none'/);
	});
});

describe('buildStandaloneHtmlDocument', () => {
	let buildStandaloneHtmlDocument: typeof import('./print').buildStandaloneHtmlDocument;

	// The standalone stylesheet cache lives for one module instance. Reload the
	// module for each case so a successful load cannot satisfy a later failure case.
	beforeEach(async () => {
		vi.resetModules();
		({ buildStandaloneHtmlDocument } = await import('./print'));
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	/** Mock `fetch` to return CSS text that is specific to each requested URL. */
	function stubCssFetch() {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				if (url.includes('/katex/fonts/')) {
					return {
						ok: true,
						status: 200,
						arrayBuffer: async () => new Uint8Array([0, 1, 2, 3]).buffer
					} as Response;
				}
				const body = url.includes('katex')
					? '.katex{font-size:1.1em}@font-face{src:url(fonts/KaTeX_Main.woff2)}'
					: '.print-body{color:#111}';
				return { ok: true, status: 200, text: async () => body } as Response;
			})
		);
	}

	it('keeps the restrictive script-src CSP', async () => {
		stubCssFetch();
		const html = await buildStandaloneHtmlDocument('T', '<p>x</p>');
		expect(html).toMatch(/script-src 'none'/);
	});

	it('escapes the title', async () => {
		stubCssFetch();
		const html = await buildStandaloneHtmlDocument('<b>Unsafe</b>', '');
		expect(html).toContain('&lt;b&gt;');
		expect(html).not.toContain('<title><b>Unsafe</b></title>');
	});

	it('fails when a required stylesheet cannot be embedded', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ ok: false, status: 404, text: async () => '' }) as Response)
		);
		await expect(buildStandaloneHtmlDocument('T', '<p>x</p>')).rejects.toThrow(
			'CSS /print/print.css : HTTP 404'
		);
	});

	it('fails when a required font cannot be embedded', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				if (url.includes('/katex/fonts/')) {
					return {
						ok: false,
						status: 500,
						arrayBuffer: async () => new ArrayBuffer(0)
					} as Response;
				}
				const body = url.includes('katex')
					? '@font-face{src:url(fonts/KaTeX_Main.woff2)}'
					: '.print-body{}';
				return { ok: true, status: 200, text: async () => body } as Response;
			})
		);
		await expect(buildStandaloneHtmlDocument('T', '<span class="katex">x</span>')).rejects.toThrow(
			'Font /katex/fonts/KaTeX_Main.woff2: HTTP 500'
		);
	});
});

describe('printInIframe', () => {
	// Intercept document.createElement('iframe') to spy on print and focus.
	// Keep the real jsdom iframe and its writable contentDocument.
	let printSpy: Mock<() => void>;
	let focusSpy: Mock<() => void>;
	let lastIframe: HTMLIFrameElement | null;
	let restoreCreate: () => void;

	function patchCreateElement(opts: { onIframe?: (f: HTMLIFrameElement) => void } = {}) {
		const realCreate = document.createElement.bind(document);
		const mocked = (tag: string) => {
			const el = realCreate(tag);
			if (tag.toLowerCase() === 'iframe') {
				const iframe = el as HTMLIFrameElement;
				lastIframe = iframe;
				// Append the iframe before contentWindow exists. Add the spies through a contentWindow getter.
				opts.onIframe?.(iframe);
			}
			return el;
		};
		document.createElement = mocked as typeof document.createElement;
		restoreCreate = () => {
			document.createElement = realCreate as typeof document.createElement;
		};
	}

	/** Add print and focus spies to contentWindow after the iframe is attached. */
	function spyOnWindow(iframe: HTMLIFrameElement) {
		// contentWindow exists only after appendChild. Replace its getter to return an object with spies.
		Object.defineProperty(iframe, 'contentWindow', {
			configurable: true,
			get() {
				const realWin = Object.getOwnPropertyDescriptor(
					HTMLIFrameElement.prototype,
					'contentWindow'
				)?.get?.call(iframe) as Window | null;
				if (realWin) {
					(realWin as Window & { print: typeof printSpy }).print = printSpy;
					(realWin as Window & { focus: typeof focusSpy }).focus = focusSpy;
				}
				return realWin;
			}
		});
	}

	beforeEach(() => {
		printSpy = vi.fn();
		focusSpy = vi.fn();
		lastIframe = null;
	});

	afterEach(() => {
		restoreCreate?.();
		vi.useRealTimers();
		// Remove remaining iframes.
		document.querySelectorAll('iframe').forEach((f) => f.remove());
	});

	it('removes the iframe from the DOM after afterprint', async () => {
		patchCreateElement({ onIframe: spyOnWindow });
		await printInIframe('<html><body>x</body></html>');
		const iframe = lastIframe!;
		expect(iframe.parentNode).not.toBeNull();
		// Simulate the end of printing.
		iframe.contentWindow?.dispatchEvent(new Event('afterprint'));
		expect(iframe.parentNode).toBeNull();
	});

	it('removes the iframe after the grace period without afterprint', async () => {
		vi.useFakeTimers();
		patchCreateElement({ onIframe: spyOnWindow });
		const p = printInIframe('<html><body>x</body></html>');
		// Advance the fake timers to resolve the microtasks and animation frame. Then await the promise.
		await vi.runAllTimersAsync();
		await p;
		const iframe = lastIframe!;
		// runAllTimersAsync already ran the cleanup timeout.
		expect(iframe.parentNode).toBeNull();
		vi.useRealTimers();
	});

	it('ignores a fonts.ready error', async () => {
		patchCreateElement({
			onIframe: (iframe) => {
				spyOnWindow(iframe);
				Object.defineProperty(iframe, 'contentDocument', {
					configurable: true,
					get() {
						const realDoc = Object.getOwnPropertyDescriptor(
							HTMLIFrameElement.prototype,
							'contentDocument'
						)?.get?.call(iframe) as Document | null;
						if (realDoc && !('fonts' in realDoc)) {
							Object.defineProperty(realDoc, 'fonts', {
								configurable: true,
								get: () => ({
									get ready() {
										return Promise.reject(new Error('fonts ko'));
									}
								})
							});
						}
						return realDoc;
					}
				});
			}
		});
		// The operation must resolve when fonts.ready fails.
		await expect(printInIframe('<html><body>x</body></html>')).resolves.toBe(true);
		expect(printSpy).toHaveBeenCalledOnce();
	});

	it('rejects and cleans up without contentDocument', async () => {
		patchCreateElement({
			onIframe: (iframe) => {
				Object.defineProperty(iframe, 'contentDocument', {
					configurable: true,
					get: () => null
				});
			}
		});
		await expect(printInIframe('<html></html>')).rejects.toThrow(/contentDocument/);
		// The catch block must remove the iframe from the DOM.
		expect(lastIframe?.parentNode).toBeNull();
	});

	it('rejects and cleans up without contentWindow', async () => {
		patchCreateElement({
			onIframe: (iframe) => {
				// contentDocument remains valid for writing, but contentWindow is null.
				Object.defineProperty(iframe, 'contentWindow', {
					configurable: true,
					get: () => null
				});
			}
		});
		await expect(printInIframe('<html><body>x</body></html>')).rejects.toThrow(/contentWindow/);
		expect(lastIframe?.parentNode).toBeNull();
	});
});

describe('bounded print preparation', () => {
	afterEach(() => vi.useRealTimers());

	it('rejects a canceled preparation without images', async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			waitForPrintImages(document.implementation.createHTMLDocument(), {
				signal: controller.signal
			})
		).rejects.toMatchObject({ name: 'AbortError' });
	});

	it('reports a missing source and a decoded image without height', async () => {
		const doc = document.implementation.createHTMLDocument();
		doc.body.innerHTML = '<img alt="Source absente"><img data-mdsh-remote-src="remote.png">';
		const image = doc.images[1]!;
		image.decode = vi.fn(async () => {});
		Object.defineProperty(image, 'naturalWidth', { value: 192 });
		await expect(waitForPrintImages(doc)).rejects.toMatchObject({
			sources: ['Source absente', 'remote.png']
		});
	});

	it.each(['load', 'error'])(
		'traite un navigateur sans decode avec événement %s',
		async (event) => {
			const doc = document.implementation.createHTMLDocument();
			doc.body.innerHTML = '<img src="image.png">';
			const image = doc.images[0]!;
			Object.defineProperties(image, {
				naturalWidth: { value: 192 },
				naturalHeight: { value: 192 }
			});
			const pending = waitForPrintImages(doc);
			image.dispatchEvent(new Event(event));
			if (event === 'load') await expect(pending).resolves.toBeUndefined();
			else await expect(pending).rejects.toBeInstanceOf(PrintImageError);
		}
	);

	it('stops waiting for an image that never decodes', async () => {
		vi.useFakeTimers();
		const doc = document.implementation.createHTMLDocument();
		doc.body.innerHTML = '<img src="stalled.png">';
		doc.images[0]!.decode = () => new Promise(() => {});
		const assertion = expect(waitForPrintImages(doc, { timeoutMs: 30 })).rejects.toMatchObject({
			sources: ['stalled.png']
		});
		await vi.advanceTimersByTimeAsync(30);
		await assertion;
	});
});

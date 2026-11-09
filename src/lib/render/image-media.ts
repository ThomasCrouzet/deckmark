import { applyRemoteImagePolicy, sanitizeHtml } from './sanitize-html';
import { abortable, checkAborted } from '../abort';
import { MAX_IMAGE_BYTES } from '../config';
export { MAX_IMAGE_BYTES } from '../config';

const IMAGE_MIME_TYPES = new Set([
	'image/avif',
	'image/gif',
	'image/jpeg',
	'image/png',
	'image/svg+xml',
	'image/webp'
]);

export const MAX_MEDIA_TOTAL_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 8192;
export const MAX_IMAGE_PIXELS = 32_000_000;
export const MEDIA_FETCH_TIMEOUT_MS = 10_000;

export type ImageFileErrorCode =
	'unsupported-type' | 'too-large' | 'invalid-content' | 'dimensions' | 'unreadable';

export class ImageFileError extends Error {
	constructor(
		public readonly code: ImageFileErrorCode,
		message: string
	) {
		super(message);
		this.name = 'ImageFileError';
	}
}

export interface EmbeddedImage {
	dataUri: string;
	alt: string;
	width: number;
	height: number;
	bytes: number;
	mime: string;
	/** Validated original bytes, reused by project asset creation. */
	data: Uint8Array;
}

export type MediaIssueReason =
	| 'blocked'
	| 'fetch-failed'
	| 'too-large'
	| 'unsupported-type'
	| 'invalid-content'
	| 'unreadable'
	| 'unsupported-srcset';

export interface MediaIssue {
	source: string;
	reason: MediaIssueReason;
}

export interface PreparedMedia {
	html: string;
	issues: MediaIssue[];
	embedded: number;
}

export class MediaPreparationError extends Error {
	constructor(public readonly issues: readonly MediaIssue[]) {
		super(`Media preparation failed for ${issues.length} source(s)`);
		this.name = 'MediaPreparationError';
	}

	get needsNetworkConsent(): boolean {
		return this.issues.some((issue) => issue.reason === 'blocked');
	}
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	const chunkSize = 0x8000;
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
	}
	return btoa(binary);
}

function blobBytes(blob: Blob): Promise<ArrayBuffer> {
	if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			if (reader.result instanceof ArrayBuffer) resolve(reader.result);
			else reject(new ImageFileError('unreadable', 'The image could not be read'));
		};
		reader.onerror = () => reject(new ImageFileError('unreadable', 'The image could not be read'));
		reader.readAsArrayBuffer(blob);
	});
}

function extensionMime(name: string): string | null {
	const extension = name.toLowerCase().match(/\.([a-z0-9]+)(?:[?#].*)?$/)?.[1];
	switch (extension) {
		case 'avif':
			return 'image/avif';
		case 'gif':
			return 'image/gif';
		case 'jpg':
		case 'jpeg':
			return 'image/jpeg';
		case 'png':
			return 'image/png';
		case 'svg':
			return 'image/svg+xml';
		case 'webp':
			return 'image/webp';
		default:
			return null;
	}
}

function normalizedMime(file: Blob & { name?: string }): string | null {
	const declared = file.type.toLowerCase().split(';', 1)[0]?.trim() ?? '';
	if (IMAGE_MIME_TYPES.has(declared)) return declared;
	if (declared !== '' && declared !== 'application/octet-stream') return null;
	return extensionMime(file.name ?? '');
}

function hasExpectedSignature(bytes: Uint8Array, mime: string): boolean {
	if (mime === 'image/png') {
		return [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
	}
	if (mime === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
	if (mime === 'image/gif') {
		const header = new TextDecoder('ascii').decode(bytes.subarray(0, 6));
		return header === 'GIF87a' || header === 'GIF89a';
	}
	if (mime === 'image/webp') {
		return (
			new TextDecoder('ascii').decode(bytes.subarray(0, 4)) === 'RIFF' &&
			new TextDecoder('ascii').decode(bytes.subarray(8, 12)) === 'WEBP'
		);
	}
	if (mime === 'image/avif') {
		const box = new TextDecoder('ascii').decode(bytes.subarray(4, 32));
		return box.includes('ftypavif') || box.includes('ftypavis');
	}
	const start = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 4096)));
	return /<svg(?:\s|>)/i.test(start) && !/<(?:script|foreignObject)(?:\s|>)/i.test(start);
}

function altFromName(name: string): string {
	const raw = name.replace(/\.[^.]+$/, '');
	return raw
		.replace(/[\r\n[\]()!]/g, '')
		.trim()
		.slice(0, 120);
}

/**
 * Sanitizes an SVG byte payload for a context that can be opened as a
 * standalone document. The caller must treat a rejection as a publication
 * failure; it must not fall back to the original bytes.
 */
export async function sanitizeSvgBytes(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
	if (bytes.byteLength > MAX_IMAGE_BYTES) {
		throw new ImageFileError('too-large', 'The SVG image exceeds its limit');
	}
	return sanitizeSvg(bytes);
}

async function sanitizeSvg(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
	const source = new TextDecoder().decode(bytes);
	const clean = applyRemoteImagePolicy(
		await sanitizeHtml(source, {
			USE_PROFILES: { svg: true, svgFilters: true },
			FORBID_TAGS: [
				'script',
				'style',
				'foreignObject',
				'feImage',
				'animate',
				'set',
				'animateMotion',
				'animateTransform',
				'mpath'
			],
			FORBID_ATTR: ['onload', 'onerror']
		}),
		false
	);
	if (!/<svg(?:\s|>)/i.test(clean)) {
		throw new ImageFileError('invalid-content', 'The SVG image is invalid');
	}
	if (clean.includes('data-mdsh-remote-')) {
		throw new ImageFileError(
			'invalid-content',
			'The SVG contains resources that must be embedded first'
		);
	}
	return new TextEncoder().encode(clean);
}

async function readDimensions(
	blob: Blob,
	dataUri: string
): Promise<{ width: number; height: number }> {
	try {
		if (typeof createImageBitmap === 'function') {
			// WebKit can display SVG while its bitmap decoder rejects that format.
			const bitmap = await createImageBitmap(blob).catch(() => null);
			if (bitmap) {
				const dimensions = { width: bitmap.width, height: bitmap.height };
				bitmap.close();
				if (dimensions.width > 0 && dimensions.height > 0) return dimensions;
				throw new Error('The decoded image has no pixels');
			}
		}
		const image = new Image();
		image.decoding = 'async';
		image.referrerPolicy = 'no-referrer';
		image.crossOrigin = 'anonymous';
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await new Promise<void>((resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error('Image decoding timed out')),
					MEDIA_FETCH_TIMEOUT_MS
				);
				image.onload = () => resolve();
				image.onerror = () => reject(new Error('Image decoding failed'));
				image.src = dataUri;
				if (typeof image.decode === 'function') void image.decode().then(resolve, reject);
			});
			if (image.naturalWidth === 0 || image.naturalHeight === 0)
				throw new Error('The decoded image has no pixels');
			return { width: image.naturalWidth, height: image.naturalHeight };
		} finally {
			clearTimeout(timer);
			image.onload = null;
			image.onerror = null;
			image.removeAttribute('src');
		}
	} catch {
		throw new ImageFileError('unreadable', 'The image cannot be decoded');
	}
}

export async function embedImageBlob(
	file: Blob & { name?: string },
	maxBytes = MAX_IMAGE_BYTES
): Promise<EmbeddedImage> {
	if (file.size > maxBytes) {
		throw new ImageFileError('too-large', `The image exceeds ${maxBytes} bytes`);
	}
	const mime = normalizedMime(file);
	if (!mime) throw new ImageFileError('unsupported-type', 'The image type is not supported');

	const original = new Uint8Array(await blobBytes(file));
	let bytes = original;
	if (!hasExpectedSignature(bytes, mime)) {
		throw new ImageFileError('invalid-content', 'The file content does not match its image type');
	}
	if (mime === 'image/svg+xml') bytes = await sanitizeSvg(bytes);
	const dataUri = `data:${mime};base64,${bytesToBase64(bytes)}`;
	const dimensions = await readDimensions(new Blob([bytes], { type: mime }), dataUri);
	if (
		dimensions.width > MAX_IMAGE_DIMENSION ||
		dimensions.height > MAX_IMAGE_DIMENSION ||
		dimensions.width * dimensions.height > MAX_IMAGE_PIXELS
	) {
		throw new ImageFileError('dimensions', 'The image dimensions exceed the supported limit');
	}

	return {
		dataUri,
		alt: altFromName(file.name ?? ''),
		width: dimensions.width,
		height: dimensions.height,
		bytes: bytes.byteLength,
		mime,
		data: original
	};
}

export async function embedImageFile(file: File): Promise<EmbeddedImage> {
	return embedImageBlob(file);
}

async function validateDataImage(source: string): Promise<EmbeddedImage> {
	const match = /^data:([^;,]+)(?:;charset=(?:utf-8|us-ascii))?(;base64)?,([\s\S]*)$/i.exec(source);
	if (!match?.[1] || match[3] === undefined) {
		throw new ImageFileError('invalid-content', 'Invalid embedded image');
	}
	if (source.length > MAX_IMAGE_BYTES * 1.5 + 1024) {
		throw new ImageFileError('too-large', 'The embedded image exceeds its limit');
	}
	let bytes: Uint8Array<ArrayBuffer>;
	try {
		if (match[2]) {
			const binary = atob(match[3]);
			bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
		} else {
			bytes = new TextEncoder().encode(decodeURIComponent(match[3]));
		}
	} catch {
		throw new ImageFileError('invalid-content', 'Invalid embedded image encoding');
	}
	return embedImageBlob(new Blob([bytes], { type: match[1] }));
}

export function isLocalImageSource(source: string): boolean {
	return /^(?:data:|blob:|#)/i.test(source.trim());
}

const BLOCKED_IMAGE_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180"><rect width="320" height="180" fill="#ddd"/><path d="M112 126l35-44 24 29 15-19 30 34H112z" fill="#777"/><circle cx="126" cy="61" r="12" fill="#777"/></svg>';

export const BLOCKED_IMAGE_DATA_URI = `data:image/svg+xml,${encodeURIComponent(BLOCKED_IMAGE_SVG)}`;

export function editorImageSource(source: string): string {
	return !source.trim() || isLocalImageSource(source) ? source : BLOCKED_IMAGE_DATA_URI;
}

function errorReason(error: unknown): MediaIssueReason {
	if (error instanceof ImageFileError) {
		if (
			error.code === 'too-large' ||
			error.code === 'unsupported-type' ||
			error.code === 'invalid-content'
		) {
			return error.code;
		}
		return 'unreadable';
	}
	return 'fetch-failed';
}

export async function fetchAndEmbedImage(
	source: string,
	remainingBytes = MAX_MEDIA_TOTAL_BYTES,
	signal?: AbortSignal
): Promise<EmbeddedImage> {
	const url = new URL(source, window.location.href);
	if (url.username || url.password) throw new Error('Image URLs cannot include credentials');
	const sameOrigin = url.origin === window.location.origin;
	if (url.protocol !== 'https:' && !(sameOrigin && ['http:', 'blob:'].includes(url.protocol))) {
		throw new Error('Image URL protocol is not allowed');
	}
	const controller = new AbortController();
	checkAborted(signal);
	const abort = () => controller.abort();
	signal?.addEventListener('abort', abort, { once: true });
	const timeout = setTimeout(() => controller.abort(), MEDIA_FETCH_TIMEOUT_MS);
	try {
		const response = await fetch(url.href, {
			signal: controller.signal,
			credentials: 'omit',
			referrerPolicy: 'no-referrer',
			redirect: 'error'
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const contentLength = Number(response.headers.get('content-length'));
		if (
			Number.isFinite(contentLength) &&
			contentLength > Math.min(MAX_IMAGE_BYTES, remainingBytes)
		) {
			throw new ImageFileError('too-large', 'The image exceeds the export limit');
		}
		const reader = response.body?.getReader();
		if (!reader) throw new ImageFileError('unreadable', 'The image response cannot be streamed');
		const chunks: Uint8Array<ArrayBuffer>[] = [];
		let total = 0;
		const limit = Math.min(MAX_IMAGE_BYTES, remainingBytes);
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				total += value.byteLength;
				if (total > limit) {
					await reader.cancel();
					throw new ImageFileError('too-large', 'The streamed image exceeds its limit');
				}
				chunks.push(new Uint8Array(value));
			}
		} finally {
			reader.releaseLock();
		}
		const name = url.pathname.split('/').pop() || 'image';
		const type =
			response.headers.get('content-type')?.split(';', 1)[0]?.trim() || extensionMime(name) || '';
		const file = new File(chunks, name, { type });
		return await abortable(embedImageBlob(file), controller.signal);
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener('abort', abort);
	}
}

interface MediaReference {
	node: Element;
	attribute: 'src' | 'href' | 'xlink:href';
	source: string;
}

function collectMediaReferences(root: DocumentFragment): MediaReference[] {
	const references: MediaReference[] = [];
	for (const image of root.querySelectorAll('img')) {
		const source =
			image.getAttribute('src') ??
			image.getAttribute('data-mdsh-remote-src') ??
			image.getAttribute('data-mdsh-media-src');
		if (source) references.push({ node: image, attribute: 'src', source });
	}
	for (const image of root.querySelectorAll('svg image')) {
		for (const attribute of ['href', 'xlink:href'] as const) {
			const marker = `data-mdsh-remote-${attribute.replace(':', '-')}`;
			const source = image.getAttribute(attribute) ?? image.getAttribute(marker);
			if (source) references.push({ node: image, attribute, source });
		}
	}
	return references;
}

export async function prepareHtmlMedia(
	html: string,
	opts: { allowNetwork: boolean; maxTotalBytes?: number; signal?: AbortSignal | undefined }
): Promise<PreparedMedia> {
	if (typeof document === 'undefined') return { html, issues: [], embedded: 0 };
	const template = document.createElement('template');
	// Keep browser-managed media inert. Approved images use the bounded fetch path below.
	template.innerHTML = applyRemoteImagePolicy(html, false);
	const issues: MediaIssue[] = [];
	let embedded = 0;
	let totalBytes = 0;
	for (const image of template.content.querySelectorAll('img')) {
		if (
			!image.getAttribute('src') &&
			!image.getAttribute('data-mdsh-remote-src') &&
			!image.getAttribute('data-mdsh-media-src')
		) {
			issues.push({ source: image.getAttribute('alt') ?? '', reason: 'unreadable' });
		}
	}

	for (const image of template.content.querySelectorAll(
		'img[data-mdsh-remote-srcset], source[data-mdsh-remote-srcset]'
	)) {
		const source = image.getAttribute('data-mdsh-remote-srcset') ?? '';
		issues.push({ source, reason: 'unsupported-srcset' });
	}
	for (const media of template.content.querySelectorAll(
		'audio, video, source, track, input[type="image"]'
	)) {
		for (const attribute of ['data-mdsh-remote-src', 'data-mdsh-remote-poster']) {
			const source = media.getAttribute(attribute);
			if (source) issues.push({ source, reason: 'unsupported-type' });
		}
	}

	for (const reference of collectMediaReferences(template.content)) {
		checkAborted(opts.signal);
		const source = reference.source.trim();
		if (source.startsWith('#')) {
			if (reference.node.tagName.toLowerCase() === 'img') {
				issues.push({ source, reason: 'invalid-content' });
			}
			continue;
		}
		if (/^data:/i.test(source)) {
			try {
				const result = await abortable(validateDataImage(source), opts.signal);
				totalBytes += result.bytes;
				if (totalBytes > (opts.maxTotalBytes ?? MAX_MEDIA_TOTAL_BYTES)) {
					throw new ImageFileError('too-large', 'The export media total exceeds its limit');
				}
				reference.node.setAttribute(reference.attribute, result.dataUri);
				const ratio = Number(reference.node.getAttribute('data-mdsh-image-ratio'));
				if (ratio > 0 && ratio <= 10 && result.width) {
					reference.node.setAttribute(
						'style',
						`width:min(${ratio * 100}%,${result.width * ratio}px);height:auto`
					);
				}
			} catch (error) {
				checkAborted(opts.signal);
				issues.push({
					source: reference.node.getAttribute('alt') || source.slice(0, 80),
					reason: errorReason(error)
				});
			}
			continue;
		}
		const network = !/^blob:/i.test(source);
		if (network && !opts.allowNetwork) {
			issues.push({ source, reason: 'blocked' });
			continue;
		}
		try {
			const remaining = (opts.maxTotalBytes ?? MAX_MEDIA_TOTAL_BYTES) - totalBytes;
			if (remaining <= 0)
				throw new ImageFileError('too-large', 'The export media limit is reached');
			const result = await fetchAndEmbedImage(source, remaining, opts.signal);
			totalBytes += result.bytes;
			embedded++;
			reference.node.setAttribute(reference.attribute, result.dataUri);
			reference.node.removeAttribute('data-mdsh-remote-src');
			reference.node.removeAttribute('data-mdsh-remote-href');
			reference.node.removeAttribute('data-mdsh-remote-xlink-href');
			reference.node.removeAttribute('data-mdsh-media-src');
			reference.node.classList.remove('mdsh-remote-image-blocked');
		} catch (error) {
			checkAborted(opts.signal);
			issues.push({ source, reason: errorReason(error) });
			if (/^blob:/i.test(source)) {
				reference.node.setAttribute('data-mdsh-media-src', source);
				reference.node.removeAttribute(reference.attribute);
			}
		}
	}

	return { html: template.innerHTML, issues, embedded };
}

export async function prepareHtmlMediaOrThrow(
	html: string,
	opts: { allowNetwork: boolean; maxTotalBytes?: number; signal?: AbortSignal | undefined }
): Promise<string> {
	const prepared = await prepareHtmlMedia(html, opts);
	if (prepared.issues.length > 0) throw new MediaPreparationError(prepared.issues);
	return prepared.html;
}

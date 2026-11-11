import { recordEditorCounter } from '../lib/editor-perf';
import { probeImageDimensions, type RasterDimensions } from './dimensions';

/**
 * Bounded visual previews for large local raster images.
 *
 * The editor keeps the original Markdown and the original image bytes. Only
 * the visual node receives a smaller, cached object URL when the decoded pixel
 * count is above the visual budget. A failed preview falls back to the original
 * source, so a note never loses an image because of a rendering optimization.
 */

/** Decoded visual budget per image. The upload budget stays in image-media. */
export const VISUAL_MAX_PIXELS = 2_000_000;
export const VISUAL_MAX_DIMENSION = 2048;
const VISUAL_CACHE_ENTRIES = 12;
const VISUAL_CONCURRENT_DECODES = 2;
const FIRST_HEADER_CHARS = 4096;
const LATE_HEADER_CHARS = 384 * 1024;

interface RasterInfo extends RasterDimensions {
	mime: string;
}

const cache = new Map<string, string>();
const inFlight = new Map<string, Promise<string>>();
let running = 0;
const waiting: (() => void)[] = [];

const stats = {
	generated: 0,
	cacheHits: 0,
	inFlightReuse: 0,
	fallbacks: 0,
	revoked: 0
};

export interface VisualPreviewStats {
	generated: number;
	cacheHits: number;
	inFlightReuse: number;
	fallbacks: number;
	revoked: number;
	entries: number;
	pending: number;
}

export function visualPreviewStats(): VisualPreviewStats {
	return { ...stats, entries: cache.size, pending: running + waiting.length };
}

export function resetVisualPreviewStats(): void {
	for (const key of Object.keys(stats) as (keyof typeof stats)[]) stats[key] = 0;
}

/** Revokes every retained object URL. The caller has already replaced the DOM. */
export function releaseVisualPreviews(): void {
	for (const url of cache.values()) {
		URL.revokeObjectURL(url);
		stats.revoked++;
	}
	cache.clear();
	inFlight.clear();
}

if (typeof window !== 'undefined') {
	(
		window as unknown as {
			__MDSH_VISUAL_PREVIEWS__?: {
				stats: typeof visualPreviewStats;
				reset: typeof resetVisualPreviewStats;
				release: typeof releaseVisualPreviews;
			};
		}
	).__MDSH_VISUAL_PREVIEWS__ = {
		stats: visualPreviewStats,
		reset: resetVisualPreviewStats,
		release: releaseVisualPreviews
	};
}

function base64Header(source: string, characters: number): Uint8Array | null {
	const comma = source.indexOf(',');
	if (comma === -1) return null;
	const header = source.slice(comma + 1, comma + 1 + characters);
	const aligned = header.slice(0, 4 * Math.floor(header.length / 4));
	try {
		const binary = atob(aligned);
		return Uint8Array.from(binary, (character) => character.charCodeAt(0));
	} catch {
		return null;
	}
}

function dataUriRasterInfo(source: string): RasterInfo | null {
	const match = /^data:(image\/(?:png|jpeg|gif|webp));(?:charset=[^;,]+;)?base64,/i.exec(source);
	if (!match?.[1]) return null;
	const mime = match[1].toLowerCase();
	let bytes = base64Header(source, FIRST_HEADER_CHARS);
	let dimensions = bytes ? probeImageDimensions(bytes, mime) : null;
	if (!dimensions && mime === 'image/jpeg') {
		bytes = base64Header(source, LATE_HEADER_CHARS);
		dimensions = bytes ? probeImageDimensions(bytes, mime) : null;
	}
	return dimensions ? { ...dimensions, mime } : null;
}

function scaledSize(info: RasterInfo): { width: number; height: number } | null {
	const pixels = info.width * info.height;
	if (pixels <= VISUAL_MAX_PIXELS && Math.max(info.width, info.height) <= VISUAL_MAX_DIMENSION)
		return null;
	const ratio = Math.min(
		1,
		Math.sqrt(VISUAL_MAX_PIXELS / pixels),
		VISUAL_MAX_DIMENSION / Math.max(info.width, info.height)
	);
	return {
		width: Math.max(1, Math.round(info.width * ratio)),
		height: Math.max(1, Math.round(info.height * ratio))
	};
}

function cacheKey(source: string, size: { width: number; height: number }): string {
	return `${size.width}x${size.height}:${source.length}:${source.slice(0, 32)}:${source.slice(-32)}`;
}

async function acquire(): Promise<void> {
	if (running < VISUAL_CONCURRENT_DECODES) {
		running++;
		return;
	}
	await new Promise<void>((resolve) => waiting.push(resolve));
	running++;
}

function release(): void {
	running--;
	const next = waiting.shift();
	if (next) next();
}

function remember(key: string, url: string): void {
	cache.set(key, url);
	while (cache.size > VISUAL_CACHE_ENTRIES) {
		const oldest = cache.keys().next().value!;
		URL.revokeObjectURL(cache.get(oldest)!);
		stats.revoked++;
		cache.delete(oldest);
	}
}

async function encode(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<Blob | null> {
	if (typeof OffscreenCanvas === 'function' && canvas instanceof OffscreenCanvas) {
		if (typeof canvas.convertToBlob !== 'function') return null;
		return canvas.convertToBlob({ type: 'image/webp', quality: 0.85 });
	}
	const element = canvas as HTMLCanvasElement;
	return new Promise((resolve) => element.toBlob(resolve, 'image/webp', 0.85));
}

function dataUriBlob(source: string, mime: string): Blob | null {
	const comma = source.indexOf(',');
	if (comma === -1) return null;
	try {
		const binary = atob(source.slice(comma + 1));
		const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
		return new Blob([bytes], { type: mime });
	} catch {
		return null;
	}
}

async function downscale(
	source: string,
	info: RasterInfo,
	size: { width: number; height: number }
): Promise<string | null> {
	if (typeof createImageBitmap !== 'function') return null;
	const blob = dataUriBlob(source, info.mime);
	if (!blob) return null;
	const bitmap = await createImageBitmap(blob, {
		resizeWidth: size.width,
		resizeHeight: size.height,
		resizeQuality: 'low'
	});
	try {
		const offscreenSupported =
			typeof OffscreenCanvas === 'function' &&
			typeof OffscreenCanvas.prototype.convertToBlob === 'function';
		const canvas = offscreenSupported
			? new OffscreenCanvas(size.width, size.height)
			: Object.assign(document.createElement('canvas'), {
					width: size.width,
					height: size.height
				});
		const context = canvas.getContext('2d') as
			CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
		if (!context) return null;
		context.drawImage(bitmap, 0, 0, size.width, size.height);
		const encoded = await encode(canvas);
		if (!encoded) return null;
		return URL.createObjectURL(encoded);
	} finally {
		bitmap.close();
	}
}

async function preview(
	source: string,
	info: RasterInfo,
	size: { width: number; height: number }
): Promise<string> {
	const key = cacheKey(source, size);
	const cached = cache.get(key);
	if (cached !== undefined) {
		stats.cacheHits++;
		recordEditorCounter('imagePreviewCacheHit');
		return cached;
	}
	const pending = inFlight.get(key);
	if (pending) {
		stats.inFlightReuse++;
		recordEditorCounter('imagePreviewInFlightReuse');
		return pending;
	}
	const task = (async () => {
		await acquire();
		try {
			const url = await downscale(source, info, size);
			if (!url) {
				stats.fallbacks++;
				recordEditorCounter('imagePreviewFallback');
				return source;
			}
			remember(key, url);
			stats.generated++;
			recordEditorCounter('imagePreviewGenerated');
			return url;
		} catch {
			stats.fallbacks++;
			recordEditorCounter('imagePreviewFallback');
			return source;
		} finally {
			release();
		}
	})();
	inFlight.set(key, task);
	try {
		return await task;
	} finally {
		if (inFlight.get(key) === task) inFlight.delete(key);
	}
}

/**
 * Returns a visual source for a self-contained local image. A string result is
 * ready now. A promise result means the preview needs a decode. Returns null
 * for a remote or project-relative source, which keeps its secured resolver.
 */
export function localVisualPreview(source: string): string | Promise<string> | null {
	const trimmed = source.trim();
	if (!trimmed) return source;
	if (trimmed.startsWith('#') || /^blob:/i.test(trimmed)) return source;
	if (!/^data:/i.test(trimmed)) return null;
	const info = dataUriRasterInfo(trimmed);
	if (!info) return source;
	const size = scaledSize(info);
	if (!size) return source;
	return preview(trimmed, info, size);
}

/** Applies the same bounded preview to a resolved project data URI. */
export async function resolvedVisualPreview(source: string): Promise<string> {
	const local = localVisualPreview(source);
	if (local === null) return source;
	return local;
}

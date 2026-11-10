import { checkAborted } from '../abort';
import { escapeHTML } from '../file-utils';
import { t } from '../i18n';
import { projectImageSource, projectMediaEpoch, type ProjectContext } from '../project-media';
import { applyRemoteImagePolicy } from '../render/sanitize-html';
import type { PresentationDeck, PresentationElement, PresentationSlide } from './model';

export interface PresentationRenderOptions {
	fileId?: string;
	projectContext?: ProjectContext;
	allowRemoteImages?: boolean;
	hideTextId?: string;
	signal?: AbortSignal;
	/** Active slide work goes ahead of offscreen thumbnail work. */
	priority?: 'active' | 'background';
}

export interface RenderedPresentation {
	html: string;
	source: string;
}

interface ContentCacheEntry {
	html: string;
	bytes: number;
}

export interface PresentationContentCacheStats {
	entries: number;
	bytes: number;
	limitBytes: number;
	limitEntries: number;
	hits: number;
	misses: number;
	evictions: number;
	oversized: number;
	inFlight: number;
}

const contentCache = new Map<string, ContentCacheEntry>();
const inFlightContent = new Map<string, Promise<string>>();
const CONTENT_CACHE_LIMIT_BYTES = 8 * 1024 * 1024;
const CONTENT_CACHE_LIMIT_ENTRIES = 512;
const MAX_CACHED_CONTENT_CHARS = 512 * 1024;
let contentCacheBytes = 0;
let contentCacheEpoch = projectMediaEpoch();
let contentCacheHits = 0;
let contentCacheMisses = 0;
let contentCacheEvictions = 0;
let contentCacheOversized = 0;

/**
 * A project asset write advances the media epoch. Drop completed HTML from the
 * older epoch so no data URI or embedded image survives an asset replacement.
 */
function syncContentEpoch(): number {
	const epoch = projectMediaEpoch();
	if (epoch !== contentCacheEpoch) {
		contentCacheEpoch = epoch;
		contentCache.clear();
		contentCacheBytes = 0;
	}
	return epoch;
}

function estimatedContentBytes(key: string, source: string, html: string): number {
	return 2 * (key.length + source.length + html.length) + 128;
}

function evictContentCache(): void {
	while (
		contentCache.size > 0 &&
		(contentCacheBytes > CONTENT_CACHE_LIMIT_BYTES ||
			contentCache.size > CONTENT_CACHE_LIMIT_ENTRIES)
	) {
		const oldest = contentCache.keys().next().value;
		if (oldest === undefined) return;
		const entry = contentCache.get(oldest);
		contentCache.delete(oldest);
		if (entry) contentCacheBytes -= entry.bytes;
		contentCacheEvictions++;
	}
}

function cacheContent(key: string, source: string, html: string): void {
	const bytes = estimatedContentBytes(key, source, html);
	if (bytes > CONTENT_CACHE_LIMIT_BYTES) {
		contentCacheOversized++;
		return;
	}
	const previous = contentCache.get(key);
	if (previous) {
		contentCache.delete(key);
		contentCacheBytes -= previous.bytes;
	}
	contentCache.set(key, { html, bytes });
	contentCacheBytes += bytes;
	evictContentCache();
}

/** Returns local cache occupancy and reuse counters for tests and diagnostics. */
export function presentationContentCacheStats(): PresentationContentCacheStats {
	return {
		entries: contentCache.size,
		bytes: contentCacheBytes,
		limitBytes: CONTENT_CACHE_LIMIT_BYTES,
		limitEntries: CONTENT_CACHE_LIMIT_ENTRIES,
		hits: contentCacheHits,
		misses: contentCacheMisses,
		evictions: contentCacheEvictions,
		oversized: contentCacheOversized,
		inFlight: inFlightContent.size
	};
}

if (typeof window !== 'undefined' && import.meta.env.VITE_SOURCE_FIDELITY_METRICS === '1') {
	(
		window as unknown as { __MDSH_PRESENTATION_CACHE__?: () => PresentationContentCacheStats }
	).__MDSH_PRESENTATION_CACHE__ = presentationContentCacheStats;
}

function finite(value: number, fallback = 0): number {
	return Number.isFinite(value) ? value : fallback;
}

function color(value: string, fallback: string): string {
	const candidate = value.trim();
	if (candidate.toLowerCase() === 'none') return 'transparent';
	if (
		/^(?:#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([\d.%+\-\s,]+\)|transparent|currentcolor)$/i.test(candidate)
	)
		return candidate;
	return fallback;
}

function contextKey(options: PresentationRenderOptions): string {
	const context = options.projectContext;
	return `${context?.projectId ?? ''}\u0000${context?.relativePath ?? ''}\u0000${options.fileId ?? ''}\u0000${options.allowRemoteImages === true ? '1' : '0'}`;
}

/** Completed HTML belongs to one media epoch as well as one render context. */
function contentKey(
	element: PresentationElement,
	options: PresentationRenderOptions,
	epoch: number
): string {
	const hidden = element.id === options.hideTextId ? 'hidden' : 'shown';
	return `${element.type}\u0000${element.content}\u0000${hidden}\u0000${contextKey(options)}\u0000${epoch}`;
}

async function resolveProjectContext(
	options: PresentationRenderOptions
): Promise<ProjectContext | undefined> {
	if (options.projectContext) return options.projectContext;
	if (!options.fileId) return undefined;
	const { projectContextFor } = await import('../project-media');
	return projectContextFor(options.fileId);
}

/** Renders only the content that depends on an element's text or image source. */
export async function renderPresentationElementContent(
	element: PresentationElement,
	options: PresentationRenderOptions = {}
): Promise<string> {
	checkAborted(options.signal);
	if (element.type !== 'image' && element.type !== 'line' && element.type !== 'arrow') {
		if (options.hideTextId === element.id) return '';
		const { renderMarkdown } = await import('../render/markdown');
		const projectContext = await resolveProjectContext(options);
		checkAborted(options.signal);
		return renderMarkdown(element.content, {
			...(projectContext ? { projectContext } : {}),
			showFrontmatter: false,
			wikiLinks: false,
			allowRemoteImages: options.allowRemoteImages === true,
			priority: options.priority ?? 'background'
		});
	}
	if (element.type !== 'image') return '';

	const source = element.content.trim();
	if (!source) return '';
	const projectContext = await resolveProjectContext(options);
	const projectSource = await projectImageSource(source, projectContext);
	checkAborted(options.signal);
	const resolved = projectSource ?? source;
	const image = `<img src="${escapeHTML(resolved)}" alt="" draggable="false">`;
	return applyRemoteImagePolicy(image, options.allowRemoteImages === true);
}

/** Reuses expensive Markdown, Mermaid, math, and project-image rendering. */
export function renderPresentationElementContentCached(
	element: PresentationElement,
	options: PresentationRenderOptions = {}
): Promise<string> {
	const epoch = syncContentEpoch();
	const key = contentKey(element, options, epoch);
	const existing = contentCache.get(key);
	if (existing) {
		contentCacheHits++;
		contentCache.delete(key);
		contentCache.set(key, existing);
		return Promise.resolve(existing.html);
	}
	if (element.content.length > MAX_CACHED_CONTENT_CHARS) {
		contentCacheOversized++;
		return renderPresentationElementContent(element, options);
	}
	// A cancellable render keeps its own promise. Sharing it would let one
	// thumbnail abort an active-slide render that did not abort.
	const active = options.signal ? undefined : inFlightContent.get(key);
	if (active) {
		contentCacheHits++;
		return active;
	}
	contentCacheMisses++;
	const owner: { promise: Promise<string> | null } = { promise: null };
	const rendered = (async () => {
		let html = await renderPresentationElementContent(element, options);
		if (projectMediaEpoch() !== epoch) {
			// An asset write finished during this render. Never publish HTML from
			// the old epoch into the current cache.
			const nextEpoch = syncContentEpoch();
			html = await renderPresentationElementContent(element, options);
			if (projectMediaEpoch() === nextEpoch)
				cacheContent(contentKey(element, options, nextEpoch), element.content, html);
			return html;
		}
		cacheContent(key, element.content, html);
		return html;
	})().then(
		(html) => {
			// Only the task that owns this map entry may remove it, so a stale
			// completion cannot erase a newer pending render for the same key.
			if (inFlightContent.get(key) === owner.promise) inFlightContent.delete(key);
			return html;
		},
		(error: unknown) => {
			if (inFlightContent.get(key) === owner.promise) inFlightContent.delete(key);
			throw error;
		}
	);
	owner.promise = rendered;
	// A caller-owned cancellable promise must never enter the shared map: an
	// unrelated unsignaled export or view could adopt and then lose it.
	if (!options.signal) inFlightContent.set(key, rendered);
	return rendered;
}

function elementCenter(element: PresentationElement): { x: number; y: number } {
	return {
		x: finite(element.x) + finite(element.width) / 2,
		y: finite(element.y) + finite(element.height) / 2
	};
}

export interface PresentationElementBox {
	left: number;
	top: number;
	width: number;
	height: number;
}

function connectorGeometry(
	element: PresentationElement,
	slide: PresentationSlide
): {
	left: number;
	top: number;
	width: number;
	height: number;
	x1: number;
	y1: number;
	x2: number;
	y2: number;
} {
	const startTarget = element.startId
		? slide.elements.find((candidate) => candidate.id === element.startId)
		: undefined;
	const endTarget = element.endId
		? slide.elements.find((candidate) => candidate.id === element.endId)
		: undefined;
	const start = startTarget ? elementCenter(startTarget) : { x: element.x, y: element.y };
	const end = endTarget
		? elementCenter(endTarget)
		: { x: element.x + element.width, y: element.y + element.height };
	const left = Math.min(start.x, end.x);
	const top = Math.min(start.y, end.y);
	const width = Math.max(Math.abs(end.x - start.x), 1);
	const height = Math.max(Math.abs(end.y - start.y), 1);
	return {
		left,
		top,
		width,
		height,
		x1: start.x - left,
		y1: start.y - top,
		x2: end.x - left,
		y2: end.y - top
	};
}

/** Returns normalized visible bounds for shapes and signed connectors. */
export function presentationElementBox(
	element: PresentationElement,
	slide: PresentationSlide
): PresentationElementBox {
	if (element.type === 'line' || element.type === 'arrow') return connectorGeometry(element, slide);
	return {
		left: finite(element.x),
		top: finite(element.y),
		width: Math.max(0, finite(element.width)),
		height: Math.max(0, finite(element.height))
	};
}

export function presentationElementStyle(
	element: PresentationElement,
	slide: PresentationSlide
): string {
	if (element.type === 'line' || element.type === 'arrow') {
		const box = presentationElementBox(element, slide);
		return `left:${box.left}px;top:${box.top}px;width:${box.width}px;height:${box.height}px;transform:rotate(${finite(element.rotation)}deg)`;
	}
	const box = presentationElementBox(element, slide);
	return `left:${box.left}px;top:${box.top}px;width:${box.width}px;height:${box.height}px;transform:rotate(${finite(element.rotation)}deg)`;
}

export function presentationElementClass(element: PresentationElement): string {
	const richText =
		element.type === 'image' || element.type === 'line' || element.type === 'arrow'
			? ''
			: ' mdsh-slide-element-rich';
	return `mdsh-slide-element mdsh-slide-element-${element.type}${richText}`;
}

export function presentationElementAppearance(element: PresentationElement): string {
	const fill = color(element.fill, 'transparent');
	const stroke = color(element.stroke, 'transparent');
	const textColor = color(element.color, '#0f172a');
	return `--element-fill:${fill};--element-stroke:${stroke};--element-stroke-width:${Math.max(0, finite(element.strokeWidth))}px;--element-color:${textColor};--element-font-size:${Math.max(1, finite(element.fontSize, 24))}px;--element-text-align:${element.textAlign}`;
}

export function renderPresentationConnector(
	element: PresentationElement,
	slide: PresentationSlide
): string {
	const box = connectorGeometry(element, slide);
	const stroke = color(element.stroke, '#334155');
	const strokeWidth = Math.max(1, finite(element.strokeWidth, 2));
	const markerId = `mdsh-arrow-${slide.id.replace(/[^a-z0-9_-]/gi, '_')}-${element.id.replace(/[^a-z0-9_-]/gi, '_')}`;
	const marker =
		element.type === 'arrow'
			? `<defs><marker id="${escapeHTML(markerId)}" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto" markerUnits="strokeWidth"><path d="M 0 0 L 10 5 L 0 10 z" fill="${escapeHTML(stroke)}"></path></marker></defs>`
			: '';
	const markerEnd = element.type === 'arrow' ? ` marker-end="url(#${escapeHTML(markerId)})"` : '';
	return `<svg class="mdsh-slide-connector" viewBox="0 0 ${box.width} ${box.height}" preserveAspectRatio="none" aria-hidden="true">${marker}<line x1="${box.x1}" y1="${box.y1}" x2="${box.x2}" y2="${box.y2}" stroke="${escapeHTML(stroke)}" stroke-width="${strokeWidth}" vector-effect="non-scaling-stroke"${markerEnd}></line></svg>`;
}

function renderElement(
	element: PresentationElement,
	slide: PresentationSlide,
	content: string
): string {
	const style = presentationElementStyle(element, slide);
	const className = presentationElementClass(element);
	if (element.type === 'line' || element.type === 'arrow') {
		return `<div class="${className}" data-element-id="${escapeHTML(element.id)}" style="${style}">${renderPresentationConnector(element, slide)}</div>`;
	}
	const appearance = presentationElementAppearance(element);
	return `<div class="${className}" data-element-id="${escapeHTML(element.id)}" style="${style};${appearance}"><div class="mdsh-slide-element-content">${content}</div></div>`;
}

export async function renderPresentationSlide(
	deck: PresentationDeck,
	slide: PresentationSlide,
	index: number,
	options: PresentationRenderOptions = {}
): Promise<string> {
	const content = await Promise.all(
		slide.elements.map((element) => renderPresentationElementContentCached(element, options))
	);
	checkAborted(options.signal);
	const elements = slide.elements
		.map((element, elementIndex) => renderElement(element, slide, content[elementIndex] ?? ''))
		.join('');
	return `<section class="mdsh-slide" data-slide-index="${index}" data-slide-id="${escapeHTML(slide.id)}" aria-label="${escapeHTML(t('slides.slide', { n: index + 1 }))}" style="width:${deck.width}px;height:${deck.height}px;--slide-background:${color(slide.background, '#ffffff')}">${elements}</section>`;
}

export async function renderPresentationDeck(
	deck: PresentationDeck,
	options: PresentationRenderOptions = {}
): Promise<RenderedPresentation> {
	const slides: string[] = [];
	for (let index = 0; index < deck.slides.length; index++) {
		const slide = deck.slides[index];
		if (!slide) continue;
		slides.push(await renderPresentationSlide(deck, slide, index, options));
		checkAborted(options.signal);
	}
	return {
		html: `<main class="mdsh-presentation" data-slide-width="${deck.width}" data-slide-height="${deck.height}" data-theme="${escapeHTML(deck.theme)}">${slides.join('')}</main>`,
		source: deck.slides
			.flatMap((slide) => slide.elements)
			.filter(
				(element) => element.type !== 'image' && element.type !== 'line' && element.type !== 'arrow'
			)
			.map((element) => element.content)
			.join('\n\n')
	};
}

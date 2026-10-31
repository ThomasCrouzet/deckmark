import { checkAborted } from '../abort';
import { escapeHTML } from '../file-utils';
import { t } from '../i18n';
import { projectImageSource, type ProjectContext } from '../project-media';
import { applyRemoteImagePolicy } from '../render/sanitize-html';
import type { PresentationDeck, PresentationElement, PresentationSlide } from './model';

export interface PresentationRenderOptions {
	fileId?: string;
	projectContext?: ProjectContext;
	allowRemoteImages?: boolean;
	hideTextId?: string;
	signal?: AbortSignal;
}

export interface RenderedPresentation {
	html: string;
	source: string;
}

const contentCache = new Map<string, Promise<string>>();
const MAX_CONTENT_CACHE_ENTRIES = 256;
const MAX_CACHED_CONTENT_CHARS = 512 * 1024;

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
			allowRemoteImages: options.allowRemoteImages === true
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
	if (options.signal || element.content.length > MAX_CACHED_CONTENT_CHARS) {
		return renderPresentationElementContent(element, options);
	}
	const key = `${element.type}\u0000${element.content}\u0000${element.id === options.hideTextId ? 'hidden' : 'shown'}\u0000${contextKey(options)}`;
	const existing = contentCache.get(key);
	if (existing) return existing;
	if (contentCache.size >= MAX_CONTENT_CACHE_ENTRIES) contentCache.clear();
	const rendered = renderPresentationElementContent(element, options).catch((error) => {
		contentCache.delete(key);
		throw error;
	});
	contentCache.set(key, rendered);
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

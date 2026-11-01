import {
	isPresentation,
	nextPresentationFence as nextFence,
	presentationContentStart,
	PRESENTATION_METADATA_MARKER as METADATA_MARKER,
	PRESENTATION_SOURCE_ESCAPE_MARKER as SOURCE_ESCAPE_MARKER
} from './detect';
export { isPresentation } from './detect';

export const PRESENTATION_VERSION = 1 as const;
export const DEFAULT_SLIDE_WIDTH = 1280;
export const DEFAULT_SLIDE_HEIGHT = 720;
export const PRESENTATION_ASPECT_RATIOS = {
	'16:9': { width: 1280, height: 720 },
	'4:3': { width: 960, height: 720 }
} as const;

export type PresentationElementType =
	'text' | 'image' | 'rectangle' | 'rounded-rectangle' | 'ellipse' | 'line' | 'arrow';
export type TextAlign = 'left' | 'center' | 'right';

export interface PresentationElement {
	id: string;
	type: PresentationElementType;
	x: number;
	y: number;
	width: number;
	height: number;
	rotation: number;
	fill: string;
	stroke: string;
	strokeWidth: number;
	color: string;
	fontSize: number;
	textAlign: TextAlign;
	content: string;
	groupId?: string;
	startId?: string;
	endId?: string;
}

export interface PresentationSlide {
	id: string;
	background: string;
	notes: string;
	elements: PresentationElement[];
}

export interface PresentationDeck {
	version: 1;
	width: number;
	height: number;
	theme: string;
	slides: PresentationSlide[];
	frontmatter?: string;
	/** Original source for a document that has no presentation metadata. */
	original?: string;
	/** Fingerprint of the deck at import time, used to keep an unedited file unchanged. */
	originalFingerprint?: string;
}

export type PresentationFormatErrorCode =
	'INVALID_JSON' | 'INVALID_METADATA' | 'INVALID_SOURCE' | 'UNSUPPORTED_VERSION';

export class PresentationFormatError extends Error {
	readonly code: PresentationFormatErrorCode;

	constructor(message: string, code: PresentationFormatErrorCode = 'INVALID_METADATA') {
		super(message);
		this.name = 'PresentationFormatError';
		this.code = code;
	}
}

const ELEMENT_TYPES = new Set<PresentationElementType>([
	'text',
	'image',
	'rectangle',
	'rounded-rectangle',
	'ellipse',
	'line',
	'arrow'
]);
const TEXT_ALIGNS = new Set<TextAlign>(['left', 'center', 'right']);
const SOURCE_ELEMENT_TYPES = new Set<PresentationElementType>(['text', 'image']);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const THEME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PAINT_PATTERN = /^(?:none|transparent|#[0-9A-Fa-f]{3,8})$/;
const SLIDE_SEPARATOR = /^ {0,3}-{3,}[ \t]*\r?$/;
const METADATA_END = /^[ \t]*--!?>[ \t]*\r?$/;
const SLIDE_MARKER = /^[ \t]*<!-- mdsh-slide:([A-Za-z0-9][A-Za-z0-9._:-]{0,127}) -->[ \t]*\r?$/;
const ELEMENT_MARKER = /^[ \t]*<!-- mdsh-element:([A-Za-z0-9][A-Za-z0-9._:-]{0,127}) -->[ \t]*\r?$/;
const ELEMENT_END_MARKER =
	/^[ \t]*<!-- mdsh-end-element:([A-Za-z0-9][A-Za-z0-9._:-]{0,127}) gap=([01])(?: fence=([bt])([0-9]+))? -->[ \t]*\r?$/;
const SOURCE_ESCAPE_LINE = '<!-- mdsh-literal -->';
const MAX_METADATA_LENGTH = 64 * 1024 * 1024;
const MAX_TEXT_LENGTH = 2 * 1024 * 1024;
const MAX_IMAGE_SOURCE_LENGTH = 48 * 1024 * 1024;
const MAX_NOTES_LENGTH = 2 * 1024 * 1024;
const MAX_SLIDES = 1000;
const MAX_ELEMENTS_PER_SLIDE = 2000;
const MIN_DECK_SIZE = 320;
const MAX_DECK_SIZE = 7680;

let fallbackIdSequence = 0;

function createId(prefix: string): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return `${prefix}-${crypto.randomUUID()}`;
	}
	fallbackIdSequence += 1;
	return `${prefix}-${Date.now().toString(36)}-${fallbackIdSequence.toString(36)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractFrontmatter(markdown: string): { content: string; raw: string } {
	const contentStart = presentationContentStart(markdown);
	if (contentStart === 0) return { content: markdown, raw: '' };
	return { content: markdown.slice(contentStart), raw: markdown.slice(0, contentStart) };
}

function fail(message: string, code: PresentationFormatErrorCode = 'INVALID_METADATA'): never {
	throw new PresentationFormatError(message, code);
}

function assertKnownKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
	path: string
): void {
	const known = new Set(keys);
	for (const key of Object.keys(value)) {
		if (!known.has(key)) fail(`${path}.${key} is not supported.`);
	}
}

function readString(value: unknown, path: string, maxLength: number, pattern?: RegExp): string {
	if (typeof value !== 'string') fail(`${path} must be a string.`);
	if (value.length > maxLength) fail(`${path} is too long.`);
	if (pattern && !pattern.test(value)) fail(`${path} has an invalid value.`);
	return value;
}

function readNumber(value: unknown, path: string, minimum: number, maximum: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		fail(`${path} must be a finite number.`);
	}
	if (value < minimum || value > maximum) fail(`${path} is outside the supported range.`);
	return value;
}

function readId(value: unknown, path: string): string {
	return readString(value, path, 128, ID_PATTERN);
}

function readPaint(value: unknown, path: string): string {
	return readString(value, path, 32, PAINT_PATTERN);
}

function optionalId(value: Record<string, unknown>, key: string, path: string): string | undefined {
	if (!(key in value)) return undefined;
	return readId(value[key], `${path}.${key}`);
}

function validateElement(
	value: unknown,
	path: string,
	deckWidth: number,
	deckHeight: number
): PresentationElement {
	if (!isRecord(value)) fail(`${path} must be an object.`);
	assertKnownKeys(
		value,
		[
			'id',
			'type',
			'x',
			'y',
			'width',
			'height',
			'rotation',
			'fill',
			'stroke',
			'strokeWidth',
			'color',
			'fontSize',
			'textAlign',
			'content',
			'groupId',
			'startId',
			'endId'
		],
		path
	);
	const id = readId(value.id, `${path}.id`);
	const type = readString(value.type, `${path}.type`, 24) as PresentationElementType;
	if (!ELEMENT_TYPES.has(type)) fail(`${path}.type is not supported.`);
	const x = readNumber(value.x, `${path}.x`, 0, deckWidth);
	const y = readNumber(value.y, `${path}.y`, 0, deckHeight);
	const isConnector = type === 'line' || type === 'arrow';
	const width = readNumber(value.width, `${path}.width`, isConnector ? -deckWidth : 1, deckWidth);
	const height = readNumber(
		value.height,
		`${path}.height`,
		isConnector ? -deckHeight : 1,
		deckHeight
	);
	if (isConnector) {
		if (x + width < 0 || x + width > deckWidth) fail(`${path} ends outside the slide.`);
		if (y + height < 0 || y + height > deckHeight) fail(`${path} ends outside the slide.`);
	} else if (x + width > deckWidth || y + height > deckHeight) {
		fail(`${path} extends outside the slide.`);
	}
	const contentLimit = type === 'image' ? MAX_IMAGE_SOURCE_LENGTH : MAX_TEXT_LENGTH;
	const content = readString(value.content, `${path}.content`, contentLimit);
	if (type === 'image' && /[\r\n\0]/.test(content))
		fail(`${path}.content has an invalid image source.`);
	const textAlign = readString(value.textAlign, `${path}.textAlign`, 8) as TextAlign;
	if (!TEXT_ALIGNS.has(textAlign)) fail(`${path}.textAlign is not supported.`);
	const result: PresentationElement = {
		id,
		type,
		x,
		y,
		width,
		height,
		rotation: readNumber(value.rotation, `${path}.rotation`, -3600, 3600),
		fill: readPaint(value.fill, `${path}.fill`),
		stroke: readPaint(value.stroke, `${path}.stroke`),
		strokeWidth: readNumber(value.strokeWidth, `${path}.strokeWidth`, 0, 64),
		color: readPaint(value.color, `${path}.color`),
		fontSize: readNumber(value.fontSize, `${path}.fontSize`, 1, 512),
		textAlign,
		content
	};
	const groupId = optionalId(value, 'groupId', path);
	const startId = optionalId(value, 'startId', path);
	const endId = optionalId(value, 'endId', path);
	if (groupId !== undefined) result.groupId = groupId;
	if (startId !== undefined) result.startId = startId;
	if (endId !== undefined) result.endId = endId;
	if (!isConnector && (startId !== undefined || endId !== undefined)) {
		fail(`${path} can attach endpoints only for a line or arrow.`);
	}
	return result;
}

function validateSlide(
	value: unknown,
	path: string,
	deckWidth: number,
	deckHeight: number
): PresentationSlide {
	if (!isRecord(value)) fail(`${path} must be an object.`);
	assertKnownKeys(value, ['id', 'background', 'notes', 'elements'], path);
	if (!Array.isArray(value.elements)) fail(`${path}.elements must be an array.`);
	if (value.elements.length > MAX_ELEMENTS_PER_SLIDE) fail(`${path} has too many elements.`);
	const elements = value.elements.map((element, index) =>
		validateElement(element, `${path}.elements[${index}]`, deckWidth, deckHeight)
	);
	const ids = new Set<string>();
	for (const element of elements) {
		if (ids.has(element.id)) fail(`${path} has duplicate element ID ${element.id}.`);
		ids.add(element.id);
	}
	for (const element of elements) {
		for (const endpoint of [element.startId, element.endId]) {
			if (endpoint !== undefined && (!ids.has(endpoint) || endpoint === element.id)) {
				fail(`${path} has an invalid connector reference.`);
			}
		}
	}
	return {
		id: readId(value.id, `${path}.id`),
		background: readPaint(value.background, `${path}.background`),
		notes: readString(value.notes, `${path}.notes`, MAX_NOTES_LENGTH),
		elements
	};
}

function validateDeck(value: unknown, allowFrontmatter: boolean): PresentationDeck {
	if (!isRecord(value)) fail('Presentation metadata must be an object.');
	const keys = ['version', 'width', 'height', 'theme', 'slides'];
	if (allowFrontmatter) keys.push('frontmatter');
	assertKnownKeys(value, keys, 'presentation');
	if (value.version !== PRESENTATION_VERSION) {
		fail(`Presentation version ${String(value.version)} is not supported.`, 'UNSUPPORTED_VERSION');
	}
	const width = readNumber(value.width, 'presentation.width', MIN_DECK_SIZE, MAX_DECK_SIZE);
	const height = readNumber(value.height, 'presentation.height', MIN_DECK_SIZE, MAX_DECK_SIZE);
	const theme = readString(value.theme, 'presentation.theme', 64, THEME_PATTERN);
	if (!Array.isArray(value.slides)) fail('presentation.slides must be an array.');
	if (value.slides.length === 0) fail('presentation.slides must contain one slide.');
	if (value.slides.length > MAX_SLIDES) fail('presentation.slides has too many slides.');
	const slides = value.slides.map((slide, index) =>
		validateSlide(slide, `presentation.slides[${index}]`, width, height)
	);
	const slideIds = new Set<string>();
	const elementIds = new Set<string>();
	for (const slide of slides) {
		if (slideIds.has(slide.id)) fail(`Presentation has duplicate slide ID ${slide.id}.`);
		slideIds.add(slide.id);
		for (const element of slide.elements) {
			if (elementIds.has(element.id)) {
				fail(`Presentation has duplicate element ID ${element.id}.`);
			}
			elementIds.add(element.id);
		}
	}
	const result: PresentationDeck = { version: PRESENTATION_VERSION, width, height, theme, slides };
	if ('frontmatter' in value) {
		const frontmatter = readString(value.frontmatter, 'presentation.frontmatter', 1024 * 1024);
		if (frontmatter) {
			const parsed = extractFrontmatter(frontmatter);
			if (parsed.raw !== frontmatter || parsed.content !== '') {
				fail('presentation.frontmatter must be one complete front matter block.');
			}
			result.frontmatter = frontmatter;
		}
	}
	return result;
}

export function createElement(
	type: PresentationElementType,
	overrides: Partial<Omit<PresentationElement, 'type'>> = {}
): PresentationElement {
	if (!ELEMENT_TYPES.has(type)) fail(`Element type ${String(type)} is not supported.`);
	const isConnector = type === 'line' || type === 'arrow';
	const base: PresentationElement = {
		id: createId('element'),
		type,
		x: isConnector ? 160 : 80,
		y: isConnector ? 180 : 80,
		width: isConnector ? 320 : type === 'image' ? 640 : 480,
		height: isConnector ? 0 : type === 'text' ? 180 : type === 'image' ? 360 : 240,
		rotation: 0,
		fill: type === 'text' || type === 'image' || isConnector ? 'transparent' : '#dbeafe',
		stroke: type === 'text' || type === 'image' ? 'none' : '#1f2937',
		strokeWidth: type === 'text' || type === 'image' ? 0 : 3,
		color: '#111827',
		fontSize: 40,
		textAlign: 'left',
		content: ''
	};
	return { ...base, ...overrides, type };
}

export function createSlide(overrides: Partial<PresentationSlide> = {}): PresentationSlide {
	return {
		id: overrides.id ?? createId('slide'),
		background: overrides.background ?? '#ffffff',
		notes: overrides.notes ?? '',
		elements: overrides.elements?.map((element) => ({ ...element })) ?? []
	};
}

export function createDeck(overrides: Partial<PresentationDeck> = {}): PresentationDeck {
	const result: PresentationDeck = {
		version: PRESENTATION_VERSION,
		width: overrides.width ?? DEFAULT_SLIDE_WIDTH,
		height: overrides.height ?? DEFAULT_SLIDE_HEIGHT,
		theme: overrides.theme ?? 'light',
		slides: overrides.slides?.map((slide) => createSlide(slide)) ?? [createSlide()]
	};
	if (overrides.frontmatter !== undefined) result.frontmatter = overrides.frontmatter;
	return validateDeck(result, true);
}

interface SourceLine {
	text: string;
	start: number;
	end: number;
	next: number;
}

function sourceLines(source: string): SourceLine[] {
	const lines: SourceLine[] = [];
	let start = 0;
	while (start < source.length) {
		const newline = source.indexOf('\n', start);
		const end = newline === -1 ? source.length : newline;
		lines.push({
			text: source.slice(start, end),
			start,
			end,
			next: newline === -1 ? end : end + 1
		});
		if (newline === -1) break;
		start = newline + 1;
	}
	if (source.length === 0) lines.push({ text: '', start: 0, end: 0, next: 0 });
	return lines;
}

function framedElementEndPositions(source: string): Map<string, number> {
	const positions = new Map<string, number>();
	if (!source.includes('<!-- mdsh-end-element:')) return positions;
	for (const line of sourceLines(source)) {
		const match = ELEMENT_END_MARKER.exec(line.text);
		if (match) positions.set(match[1]!, line.start);
	}
	return positions;
}

interface MetadataRange {
	start: number;
	jsonStart: number;
	jsonEnd: number;
	end: number;
}

function findMetadataRange(markdown: string): MetadataRange | undefined {
	let fence = '';
	let escapedLine = false;
	let framedElementId = '';
	const presentationContent = markdown.slice(presentationContentStart(markdown));
	const framedEnds = framedElementEndPositions(presentationContent);
	const hasFramedElements = framedEnds.size > 0;
	const starts: SourceLine[] = [];
	const contentStart = presentationContentStart(markdown);
	for (const line of sourceLines(presentationContent)) {
		const framedEnd = ELEMENT_END_MARKER.exec(line.text);
		if (
			framedElementId &&
			framedEnd?.[1] === framedElementId &&
			framedEnds.get(framedElementId) === line.start
		) {
			framedElementId = '';
			fence = '';
			escapedLine = false;
			continue;
		}
		if (!fence && !escapedLine && SOURCE_ESCAPE_MARKER.test(line.text)) {
			escapedLine = true;
		} else {
			if (!fence && !escapedLine && hasFramedElements) {
				if (!framedElementId) {
					framedElementId = ELEMENT_MARKER.exec(line.text)?.[1] ?? '';
				}
			}
			if (!fence && !escapedLine && !framedElementId && METADATA_MARKER.test(line.text)) {
				starts.push({
					...line,
					start: line.start + contentStart,
					next: line.next + contentStart
				});
			}
			escapedLine = false;
		}
		fence = nextFence(line.text, fence);
	}
	if (starts.length === 0) return undefined;
	if (starts.length > 1)
		fail('The document has multiple presentation metadata blocks.', 'INVALID_SOURCE');
	const start = starts[0]!;
	const close = sourceLines(markdown.slice(start.next)).find((line) =>
		METADATA_END.test(line.text)
	);
	if (!close) fail('The presentation metadata block is not closed.', 'INVALID_JSON');
	const jsonEnd = start.next + close.start;
	const end = start.next + close.next;
	if (markdown.slice(end).trim().length > 0) {
		fail('The presentation metadata block must be the last document content.', 'INVALID_SOURCE');
	}
	return { start: start.start, jsonStart: start.next, jsonEnd, end };
}

function removeEndingLineBreaks(value: string, count: number): string {
	let result = value;
	for (let index = 0; index < count; index += 1) {
		if (result.endsWith('\r\n')) result = result.slice(0, -2);
		else if (result.endsWith('\n')) result = result.slice(0, -1);
		else break;
	}
	return result;
}

function removeStartingLineBreak(value: string): string {
	if (value.startsWith('\r\n')) return value.slice(2);
	if (value.startsWith('\n')) return value.slice(1);
	return value;
}

function splitMarkdownSlides(body: string): string[] {
	const slides: string[] = [];
	let fence = '';
	let escapedLine = false;
	let framedElementId = '';
	const framedEnds = framedElementEndPositions(body);
	const hasFramedElements = framedEnds.size > 0;
	let start = 0;
	let removeLeadingGap = false;
	for (const line of sourceLines(body)) {
		const framedEnd = ELEMENT_END_MARKER.exec(line.text);
		if (
			framedElementId &&
			framedEnd?.[1] === framedElementId &&
			framedEnds.get(framedElementId) === line.start
		) {
			framedElementId = '';
			fence = '';
			escapedLine = false;
			continue;
		}
		if (!fence && !escapedLine && SOURCE_ESCAPE_MARKER.test(line.text)) {
			escapedLine = true;
			continue;
		}
		if (!fence && !escapedLine && hasFramedElements) {
			if (!framedElementId) {
				framedElementId = ELEMENT_MARKER.exec(line.text)?.[1] ?? '';
			}
		}
		if (!fence && !escapedLine && !framedElementId && SLIDE_SEPARATOR.test(line.text)) {
			let slide = removeEndingLineBreaks(body.slice(start, line.start), 2);
			if (removeLeadingGap) slide = removeStartingLineBreak(slide);
			slides.push(slide);
			start = line.next;
			removeLeadingGap = true;
			continue;
		}
		escapedLine = false;
		fence = nextFence(line.text, fence);
	}
	let finalSlide = body.slice(start);
	if (removeLeadingGap) finalSlide = removeStartingLineBreak(finalSlide);
	slides.push(finalSlide);
	return slides;
}

interface ParsedSlideSource {
	slideId?: string;
	blocks: Array<{ elementId: string; content: string }>;
	unmarked: string;
}

interface FramedElementEnd {
	id: string;
	line: SourceLine;
	gap: boolean;
	fence?: string;
}

function removeOneEndingLineBreak(value: string, path: string): string {
	if (value.endsWith('\r\n')) return value.slice(0, -2);
	if (value.endsWith('\n')) return value.slice(0, -1);
	fail(`${path} has invalid source framing.`, 'INVALID_SOURCE');
}

function decodeLiteralEscapes(value: string, path: string): string {
	let fence = '';
	let escapedLine = false;
	let result = '';
	for (const line of sourceLines(value)) {
		const raw = value.slice(line.start, line.next);
		if (!fence && !escapedLine && SOURCE_ESCAPE_MARKER.test(line.text)) {
			escapedLine = true;
			continue;
		}
		result += raw;
		fence = nextFence(line.text, fence);
		if (escapedLine) escapedLine = false;
	}
	if (escapedLine) fail(`${path} ends with an incomplete literal escape.`, 'INVALID_SOURCE');
	return result;
}

function decodeFramedContent(value: string, end: FramedElementEnd, path: string): string {
	let content = value;
	if (end.fence) {
		content = removeOneEndingLineBreak(content, path);
		if (!content.endsWith(end.fence)) {
			fail(`${path} has an invalid synthetic fence.`, 'INVALID_SOURCE');
		}
		content = content.slice(0, -end.fence.length);
	}
	if (end.gap) content = removeOneEndingLineBreak(content, path);
	return decodeLiteralEscapes(content, path);
}

function hasFramedElementEnd(source: string): boolean {
	return framedElementEndPositions(source).size > 0;
}

function parseFramedSlideSource(source: string): ParsedSlideSource {
	let fence = '';
	let escapedLine = false;
	let slideId: string | undefined;
	let active: { id: string; line: SourceLine } | undefined;
	let cursor = 0;
	const blocks: Array<{ elementId: string; content: string }> = [];
	const unmarkedParts: string[] = [];
	const framedEnds = framedElementEndPositions(source);
	for (const line of sourceLines(source)) {
		const forcedEnd = active ? ELEMENT_END_MARKER.exec(line.text) : null;
		if (active && forcedEnd?.[1] === active.id && framedEnds.get(active.id) === line.start) {
			const fenceLength = forcedEnd[4] ? Number(forcedEnd[4]) : 0;
			if (
				forcedEnd[3] &&
				(!Number.isSafeInteger(fenceLength) ||
					fenceLength < 3 ||
					fenceLength > source.length ||
					fenceLength > MAX_TEXT_LENGTH)
			) {
				fail('An element end marker has an invalid fence.', 'INVALID_SOURCE');
			}
			const end: FramedElementEnd = {
				id: forcedEnd[1]!,
				line,
				gap: forcedEnd[2] === '1'
			};
			if (forcedEnd[3]) {
				end.fence = (forcedEnd[3] === 'b' ? '`' : '~').repeat(fenceLength);
			}
			blocks.push({
				elementId: active.id,
				content: decodeFramedContent(
					source.slice(active.line.next, line.start),
					end,
					`Element ${active.id}`
				)
			});
			cursor = line.next;
			active = undefined;
			fence = '';
			escapedLine = false;
			continue;
		}
		if (!fence && !escapedLine && SOURCE_ESCAPE_MARKER.test(line.text)) {
			escapedLine = true;
			continue;
		}
		if (!fence && !escapedLine && !active) {
			const slideMatch = SLIDE_MARKER.exec(line.text);
			if (slideMatch) {
				if (slideId !== undefined) {
					fail('A slide has multiple source identity markers.', 'INVALID_SOURCE');
				}
				if (source.slice(0, line.start).trim().length > 0) {
					fail('A slide source identity marker must precede its content.', 'INVALID_SOURCE');
				}
				slideId = slideMatch[1]!;
				cursor = line.next;
			} else {
				const elementMatch = ELEMENT_MARKER.exec(line.text);
				if (elementMatch) {
					unmarkedParts.push(source.slice(cursor, line.start));
					active = { id: elementMatch[1]!, line };
				}
			}
		}
		fence = nextFence(line.text, fence);
		if (escapedLine) escapedLine = false;
	}
	if (active) fail(`Element ${active.id} has no end marker.`, 'INVALID_SOURCE');
	if (blocks.length === 0)
		fail('A slide has an element end marker without a start.', 'INVALID_SOURCE');
	unmarkedParts.push(source.slice(cursor));
	const unmarked = unmarkedParts.join('');
	return slideId === undefined ? { blocks, unmarked } : { slideId, blocks, unmarked };
}

function parseSlideSource(source: string): ParsedSlideSource {
	if (hasFramedElementEnd(source)) return parseFramedSlideSource(source);
	let fence = '';
	let escapedLine = false;
	let slideId: string | undefined;
	let slideMarker: SourceLine | undefined;
	const elementMarkers: Array<{ id: string; line: SourceLine }> = [];
	const elementEnds: FramedElementEnd[] = [];
	for (const line of sourceLines(source)) {
		if (!fence && !escapedLine && SOURCE_ESCAPE_MARKER.test(line.text)) {
			escapedLine = true;
			continue;
		}
		if (!fence && !escapedLine) {
			const slideMatch = SLIDE_MARKER.exec(line.text);
			if (slideMatch) {
				if (slideId !== undefined)
					fail('A slide has multiple source identity markers.', 'INVALID_SOURCE');
				slideId = slideMatch[1]!;
				slideMarker = line;
			} else {
				const elementMatch = ELEMENT_MARKER.exec(line.text);
				if (elementMatch) {
					elementMarkers.push({ id: elementMatch[1]!, line });
				} else {
					const endMatch = ELEMENT_END_MARKER.exec(line.text);
					if (endMatch) {
						const fenceLength = endMatch[4] ? Number(endMatch[4]) : 0;
						if (
							endMatch[3] &&
							(!Number.isSafeInteger(fenceLength) ||
								fenceLength < 3 ||
								fenceLength > source.length ||
								fenceLength > MAX_TEXT_LENGTH)
						) {
							fail('An element end marker has an invalid fence.', 'INVALID_SOURCE');
						}
						const end: FramedElementEnd = {
							id: endMatch[1]!,
							line,
							gap: endMatch[2] === '1'
						};
						if (endMatch[3]) {
							end.fence = (endMatch[3] === 'b' ? '`' : '~').repeat(fenceLength);
						}
						elementEnds.push(end);
					}
				}
			}
		}
		fence = nextFence(line.text, fence);
		if (escapedLine) escapedLine = false;
	}
	if (slideMarker && source.slice(0, slideMarker.start).trim().length > 0) {
		fail('A slide source identity marker must precede its content.', 'INVALID_SOURCE');
	}
	const contentStart = slideMarker?.next ?? 0;
	if (elementEnds.length > 0) {
		if (elementMarkers.length !== elementEnds.length) {
			fail('A slide has incomplete element source framing.', 'INVALID_SOURCE');
		}
		const blocks: Array<{ elementId: string; content: string }> = [];
		const unmarkedParts: string[] = [];
		let cursor = contentStart;
		for (let index = 0; index < elementMarkers.length; index += 1) {
			const marker = elementMarkers[index]!;
			const end = elementEnds[index]!;
			const nextMarker = elementMarkers[index + 1];
			if (
				marker.id !== end.id ||
				marker.line.start < cursor ||
				end.line.start < marker.line.next ||
				(nextMarker && nextMarker.line.start < end.line.next)
			) {
				fail('A slide has invalid element source framing.', 'INVALID_SOURCE');
			}
			unmarkedParts.push(source.slice(cursor, marker.line.start));
			blocks.push({
				elementId: marker.id,
				content: decodeFramedContent(
					source.slice(marker.line.next, end.line.start),
					end,
					`Element ${marker.id}`
				)
			});
			cursor = end.line.next;
		}
		unmarkedParts.push(source.slice(cursor));
		const unmarked = unmarkedParts.join('');
		return slideId === undefined ? { blocks, unmarked } : { slideId, blocks, unmarked };
	}
	const firstElementStart = elementMarkers[0]?.line.start ?? source.length;
	let unmarked = source.slice(contentStart, firstElementStart);
	if (elementMarkers.length > 0) unmarked = removeEndingLineBreaks(unmarked, 2);
	const blocks = elementMarkers.map((marker, index) => {
		const next = elementMarkers[index + 1];
		let content = source.slice(marker.line.next, next?.line.start ?? source.length);
		if (next) content = removeEndingLineBreaks(content, 2);
		return { elementId: marker.id, content };
	});
	return slideId === undefined ? { blocks, unmarked } : { slideId, blocks, unmarked };
}

function parseImageBlock(content: string, path: string): string {
	const match = /^!\[[^\]\r\n]*\]\(([\s\S]*)\)$/.exec(content);
	if (!match) fail(`${path} must contain one Markdown image.`, 'INVALID_SOURCE');
	let result = '';
	const source = match[1]!;
	for (let index = 0; index < source.length; index += 1) {
		const character = source[index]!;
		if (character === '\\' && index + 1 < source.length) {
			index += 1;
			result += source[index]!;
		} else {
			result += character;
		}
	}
	if (/[\r\n\0]/.test(result)) fail(`${path} has an invalid image source.`, 'INVALID_SOURCE');
	return result;
}

function syncSlideSource(base: PresentationSlide, source: ParsedSlideSource): PresentationSlide {
	const existingById = new Map(base.elements.map((element) => [element.id, element]));
	const seen = new Set<string>();
	const updates = new Map<string, PresentationElement>();
	for (const block of source.blocks) {
		if (seen.has(block.elementId)) {
			fail(`Slide ${base.id} repeats element marker ${block.elementId}.`, 'INVALID_SOURCE');
		}
		seen.add(block.elementId);
		const element = existingById.get(block.elementId);
		if (!element || !SOURCE_ELEMENT_TYPES.has(element.type)) {
			fail(`Slide ${base.id} refers to an unknown source element.`, 'INVALID_SOURCE');
		}
		updates.set(
			element.id,
			element.type === 'image'
				? { ...element, content: parseImageBlock(block.content, `Element ${element.id}`) }
				: { ...element, content: block.content }
		);
	}
	const unmarked = source.unmarked;
	let unmarkedElement: PresentationElement | undefined;
	if (unmarked.trim().length > 0) {
		const availableText = base.elements.filter(
			(element) => element.type === 'text' && !seen.has(element.id)
		);
		if (availableText.length > 1) {
			fail(`Slide ${base.id} has ambiguous unmarked text.`, 'INVALID_SOURCE');
		}
		unmarkedElement = availableText[0]
			? { ...availableText[0], content: unmarked }
			: createElement('text', { content: unmarked });
	}
	const hasSourceMarkers = source.blocks.length > 0;
	const elements: PresentationElement[] = [];
	for (const element of base.elements) {
		if (!SOURCE_ELEMENT_TYPES.has(element.type)) {
			elements.push(element);
			continue;
		}
		const updated = updates.get(element.id);
		if (updated) elements.push(updated);
		else if (unmarkedElement?.id === element.id) elements.push(unmarkedElement);
		else if (!hasSourceMarkers && unmarked.trim().length === 0) {
			// An empty body removes source-backed elements but keeps shapes.
		}
	}
	if (unmarkedElement && !existingById.has(unmarkedElement.id)) elements.push(unmarkedElement);
	return { ...base, elements };
}

function importOrdinaryMarkdown(markdown: string): PresentationDeck {
	const frontmatter = extractFrontmatter(markdown);
	const slides = splitMarkdownSlides(frontmatter.content).map((content) => {
		const slide = createSlide();
		const normalized = content.trim().length === 0 ? '' : content;
		if (normalized) slide.elements.push(createElement('text', { content: normalized }));
		return slide;
	});
	const deck = createDeck({ slides });
	if (frontmatter.raw) deck.frontmatter = frontmatter.raw;
	deck.original = markdown;
	deck.originalFingerprint = deckFingerprint(deck);
	return deck;
}

function deckFingerprint(deck: PresentationDeck): string {
	return JSON.stringify({
		version: deck.version,
		width: deck.width,
		height: deck.height,
		theme: deck.theme,
		slides: deck.slides,
		frontmatter: deck.frontmatter ?? null
	});
}

function syncDeckSource(deck: PresentationDeck, body: string): PresentationDeck {
	if (body.length === 0 && deck.slides.length > 1) {
		fail('The Markdown body is missing slide content.', 'INVALID_SOURCE');
	}
	const sources = splitMarkdownSlides(body).map(parseSlideSource);
	const byId = new Map(deck.slides.map((slide) => [slide.id, slide]));
	const used = new Set<string>();
	const slides = sources.map((source, index) => {
		let base: PresentationSlide | undefined;
		if (source.slideId) base = byId.get(source.slideId);
		if (!base)
			base =
				deck.slides[index] && !used.has(deck.slides[index]!.id) ? deck.slides[index] : undefined;
		if (!base) base = createSlide(source.slideId ? { id: source.slideId } : {});
		if (source.slideId && base.id !== source.slideId) {
			fail(`Slide marker ${source.slideId} has no matching metadata.`, 'INVALID_SOURCE');
		}
		if (used.has(base.id)) fail(`Slide marker ${base.id} is duplicated.`, 'INVALID_SOURCE');
		used.add(base.id);
		return syncSlideSource(base, source);
	});
	return validateDeck({ ...deck, slides }, true);
}

export function parsePresentation(markdown: string): PresentationDeck {
	if (!isPresentation(markdown)) return importOrdinaryMarkdown(markdown);
	const range = findMetadataRange(markdown);
	if (!range) fail('The presentation metadata block is invalid.', 'INVALID_JSON');
	const json = markdown.slice(range.jsonStart, range.jsonEnd).trim();
	if (json.length === 0 || json.length > MAX_METADATA_LENGTH) {
		fail('The presentation metadata has an invalid size.', 'INVALID_JSON');
	}
	let raw: unknown;
	try {
		raw = JSON.parse(json) as unknown;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		fail(`The presentation metadata is not valid JSON: ${message}`, 'INVALID_JSON');
	}
	const beforeMetadata = markdown.slice(0, range.start);
	const parsedFrontmatter = extractFrontmatter(beforeMetadata);
	const body = removeEndingLineBreaks(parsedFrontmatter.content, 2);
	const deck = validateDeck(raw, false);
	if (parsedFrontmatter.raw) deck.frontmatter = parsedFrontmatter.raw;
	return syncDeckSource(deck, body);
}

function escapeImageSource(source: string): string {
	return source.replace(/[\\() \t]/g, (character) => `\\${character}`);
}

interface EncodedSourceContent {
	content: string;
	gap: boolean;
	fence?: string;
}

function isSourceFramingLine(line: string): boolean {
	return (
		SOURCE_ESCAPE_MARKER.test(line) ||
		SLIDE_SEPARATOR.test(line) ||
		SLIDE_MARKER.test(line) ||
		ELEMENT_MARKER.test(line) ||
		ELEMENT_END_MARKER.test(line) ||
		METADATA_MARKER.test(line)
	);
}

function encodeSourceContent(value: string): EncodedSourceContent {
	let fence = '';
	let content = '';
	for (const line of sourceLines(value)) {
		const raw = value.slice(line.start, line.next);
		if (!fence && isSourceFramingLine(line.text)) {
			const lineBreak = raw.endsWith('\r\n') ? '\r\n' : '\n';
			content += SOURCE_ESCAPE_LINE + lineBreak;
		}
		content += raw;
		fence = nextFence(line.text, fence);
	}
	const gap = !content.endsWith('\n');
	if (fence) {
		return { content: content + (gap ? '\n' : '') + fence + '\n', gap, fence };
	}
	return { content: content + (gap ? '\n' : ''), gap };
}

function serializeSourceElement(element: PresentationElement): string {
	const source =
		element.type === 'image' ? `![Image](${escapeImageSource(element.content)})` : element.content;
	const encoded = encodeSourceContent(source);
	const fence = encoded.fence
		? ` fence=${encoded.fence[0] === '`' ? 'b' : 't'}${encoded.fence.length}`
		: '';
	return `<!-- mdsh-element:${element.id} -->\n${encoded.content}<!-- mdsh-end-element:${element.id} gap=${encoded.gap ? '1' : '0'}${fence} -->`;
}

function serializeSlideSource(slide: PresentationSlide): string {
	const blocks = [`<!-- mdsh-slide:${slide.id} -->`];
	for (const element of slide.elements) {
		if (SOURCE_ELEMENT_TYPES.has(element.type)) blocks.push(serializeSourceElement(element));
	}
	return blocks.join('\n\n');
}

export function serializePresentation(input: PresentationDeck): string {
	if (input.original !== undefined && input.originalFingerprint === deckFingerprint(input)) {
		return input.original;
	}
	const { original: _original, originalFingerprint: _fingerprint, ...candidate } = input;
	void _original;
	void _fingerprint;
	const deck = validateDeck(candidate, true);
	const body = deck.slides.map(serializeSlideSource).join('\n\n---\n\n');
	const slides = deck.slides.map((slide) => ({
		...slide,
		elements: slide.elements.map((element) =>
			SOURCE_ELEMENT_TYPES.has(element.type) ? { ...element, content: '' } : element
		)
	}));
	const metadata = JSON.stringify({
		version: deck.version,
		width: deck.width,
		height: deck.height,
		theme: deck.theme,
		slides
	}).replace(/[<>]/g, (character) => (character === '<' ? '\\u003c' : '\\u003e'));
	let result = deck.frontmatter ?? '';
	if (result && result !== '\uFEFF' && !result.endsWith('\n')) result += '\n';
	result += body;
	if (body) result += '\n\n';
	result += `<!-- mdsh-presentation\n${metadata}\n-->`;
	return result;
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}

export function clampElementToSlide(
	element: PresentationElement,
	deck: Pick<PresentationDeck, 'width' | 'height'>
): PresentationElement {
	if (element.type === 'line' || element.type === 'arrow') {
		const startX = clamp(element.x, 0, deck.width);
		const startY = clamp(element.y, 0, deck.height);
		const endX = clamp(element.x + element.width, 0, deck.width);
		const endY = clamp(element.y + element.height, 0, deck.height);
		return { ...element, x: startX, y: startY, width: endX - startX, height: endY - startY };
	}
	const width = clamp(element.width, 1, deck.width);
	const height = clamp(element.height, 1, deck.height);
	return {
		...element,
		x: clamp(element.x, 0, deck.width - width),
		y: clamp(element.y, 0, deck.height - height),
		width,
		height
	};
}

export function translateElements(
	elements: readonly PresentationElement[],
	deltaX: number,
	deltaY: number,
	deck: Pick<PresentationDeck, 'width' | 'height'>
): PresentationElement[] {
	return elements.map((element) =>
		clampElementToSlide({ ...element, x: element.x + deltaX, y: element.y + deltaY }, deck)
	);
}

export function resizeElement(
	element: PresentationElement,
	rect: Pick<PresentationElement, 'x' | 'y' | 'width' | 'height'>,
	deck: Pick<PresentationDeck, 'width' | 'height'>
): PresentationElement {
	return clampElementToSlide({ ...element, ...rect }, deck);
}

export function insertSlide(
	deck: PresentationDeck,
	index: number,
	slide: PresentationSlide = createSlide()
): PresentationDeck {
	const slides = [...deck.slides];
	slides.splice(clamp(Math.trunc(index), 0, slides.length), 0, slide);
	return validateDeck({ ...deck, slides }, true);
}

export function removeSlide(deck: PresentationDeck, slideId: string): PresentationDeck {
	const slides = deck.slides.filter((slide) => slide.id !== slideId);
	return validateDeck({ ...deck, slides: slides.length > 0 ? slides : [createSlide()] }, true);
}

export function moveSlide(
	deck: PresentationDeck,
	slideId: string,
	index: number
): PresentationDeck {
	const current = deck.slides.findIndex((slide) => slide.id === slideId);
	if (current < 0) return deck;
	const slides = [...deck.slides];
	const [slide] = slides.splice(current, 1);
	slides.splice(clamp(Math.trunc(index), 0, slides.length), 0, slide!);
	return { ...deck, slides };
}

function cloneElementsWithIds(elements: readonly PresentationElement[]): PresentationElement[] {
	const idMap = new Map(elements.map((element) => [element.id, createId('element')]));
	const groupMap = new Map<string, string>();
	return elements.map((element) => {
		const clone: PresentationElement = { ...element, id: idMap.get(element.id)! };
		if (element.groupId) {
			if (!groupMap.has(element.groupId)) groupMap.set(element.groupId, createId('group'));
			clone.groupId = groupMap.get(element.groupId)!;
		}
		if (element.startId && idMap.has(element.startId)) clone.startId = idMap.get(element.startId)!;
		if (element.endId && idMap.has(element.endId)) clone.endId = idMap.get(element.endId)!;
		return clone;
	});
}

export function duplicateSlide(deck: PresentationDeck, slideId: string): PresentationDeck {
	const index = deck.slides.findIndex((slide) => slide.id === slideId);
	if (index < 0) return deck;
	const source = deck.slides[index]!;
	const clone = createSlide({
		...source,
		id: createId('slide'),
		elements: cloneElementsWithIds(source.elements)
	});
	return insertSlide(deck, index + 1, clone);
}

export function insertElement(
	deck: PresentationDeck,
	slideId: string,
	element: PresentationElement,
	index?: number
): PresentationDeck {
	const slides = deck.slides.map((slide) => {
		if (slide.id !== slideId) return slide;
		const elements = [...slide.elements];
		elements.splice(
			index === undefined ? elements.length : clamp(Math.trunc(index), 0, elements.length),
			0,
			element
		);
		return { ...slide, elements };
	});
	return validateDeck({ ...deck, slides }, true);
}

export function updateElement(
	deck: PresentationDeck,
	slideId: string,
	elementId: string,
	changes: Partial<Omit<PresentationElement, 'id' | 'type'>>
): PresentationDeck {
	const slides = deck.slides.map((slide) =>
		slide.id === slideId
			? {
					...slide,
					elements: slide.elements.map((element) =>
						element.id === elementId ? { ...element, ...changes } : element
					)
				}
			: slide
	);
	return validateDeck({ ...deck, slides }, true);
}

export function removeElements(
	deck: PresentationDeck,
	slideId: string,
	elementIds: ReadonlySet<string>
): PresentationDeck {
	const slides = deck.slides.map((slide) => {
		if (slide.id !== slideId) return slide;
		const elements = slide.elements
			.filter((element) => !elementIds.has(element.id))
			.map((element) => {
				const clone = { ...element };
				if (clone.startId && elementIds.has(clone.startId)) delete clone.startId;
				if (clone.endId && elementIds.has(clone.endId)) delete clone.endId;
				return clone;
			});
		return { ...slide, elements };
	});
	return validateDeck({ ...deck, slides }, true);
}

export function duplicateElements(
	deck: PresentationDeck,
	slideId: string,
	elementIds: ReadonlySet<string>,
	offset = 24
): PresentationDeck {
	const slides = deck.slides.map((slide) => {
		if (slide.id !== slideId) return slide;
		const selected = slide.elements.filter((element) => elementIds.has(element.id));
		const clones = translateElements(cloneElementsWithIds(selected), offset, offset, deck);
		return { ...slide, elements: [...slide.elements, ...clones] };
	});
	return validateDeck({ ...deck, slides }, true);
}

export type ElementLayerMove = 'front' | 'back' | 'forward' | 'backward';

export function moveElementLayer(
	deck: PresentationDeck,
	slideId: string,
	elementId: string,
	move: ElementLayerMove
): PresentationDeck {
	const slides = deck.slides.map((slide) => {
		if (slide.id !== slideId) return slide;
		const current = slide.elements.findIndex((element) => element.id === elementId);
		if (current < 0) return slide;
		const elements = [...slide.elements];
		const [element] = elements.splice(current, 1);
		const target =
			move === 'front'
				? elements.length
				: move === 'back'
					? 0
					: move === 'forward'
						? Math.min(elements.length, current + 1)
						: Math.max(0, current - 1);
		elements.splice(target, 0, element!);
		return { ...slide, elements };
	});
	return { ...deck, slides };
}

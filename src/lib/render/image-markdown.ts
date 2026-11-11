/** Local stage duration. The editor performance module owns the full contract. */
function measureImageStage<T>(name: string, run: () => T): T {
	if (typeof window === 'undefined') return run();
	if (
		import.meta.env?.VITE_SOURCE_FIDELITY_METRICS !== '1' &&
		!(window as { __MDSH_EDITOR_PERF__?: boolean }).__MDSH_EDITOR_PERF__
	)
		return run();
	const startedAt = performance.now();
	try {
		return run();
	} finally {
		window.dispatchEvent(
			new CustomEvent('deckmark:editor-perf', {
				detail: { kind: 'duration', name, value: performance.now() - startedAt }
			})
		);
	}
}

/** Local stage counter. The editor performance module owns the full contract. */
function recordImageCounter(name: string): void {
	if (typeof window === 'undefined') return;
	if (
		import.meta.env?.VITE_SOURCE_FIDELITY_METRICS !== '1' &&
		!(window as { __MDSH_EDITOR_PERF__?: boolean }).__MDSH_EDITOR_PERF__
	)
		return;
	window.dispatchEvent(
		new CustomEvent('deckmark:editor-perf', { detail: { kind: 'counter', name } })
	);
}

// Match the backslash only in the escape branch. Separate branches prevent
// exponential backtracking in alternatives and captions.
const IMAGE_LINE =
	/^!\[((?:\\.|[^\]\\])*)\]\((<[^>]+>|\S+?)(?:\s+(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|\(((?:\\.|[^)\\])*)\)))?\)\s*$/;
const IMAGE_META_LINE = /^<!-- mdsh:image ratio=([0-9]+(?:\.[0-9]+)?) -->$/;

interface ParsedImageLine {
	alt: string;
	source: string;
	title: string;
}

interface ImageState {
	alt: string;
	ratio: number;
	/** Exact identity, used to verify a bounded fingerprint before reuse. */
	source: string;
	title: string;
	occurrence: number;
}

/** Bounded occurrence counter key. The long URI never enters the key. */
function occurrenceKey(source: string, title: string): string {
	return `${fingerprint(source)}:${fingerprint(title)}`;
}

/**
 * Milkdown image schemas require string titles. Markdown parsers use null when
 * an image has no title, so normalize both inline and block image nodes.
 */
export function normalizeImageTitlesForMilkdown(root: unknown): void {
	const pending = [root];
	while (pending.length > 0) {
		const value = pending.pop();
		if (!value || typeof value !== 'object') continue;
		const node = value as Record<string, unknown>;
		if ((node.type === 'image' || node.type === 'image-block') && node.title == null) {
			node.title = '';
		}
		if (Array.isArray(node.children)) pending.push(...node.children);
	}
}

function unescapeMarkdown(value: string): string {
	return value.replace(/\\([\\\][()'"])/g, '$1');
}

function escapeAlt(value: string): string {
	return value
		.replace(/\\/g, '\\\\')
		.replace(/([[\]])/g, '\\$1')
		.replace(/[\r\n]+/g, ' ');
}

function escapeTitle(value: string): string {
	return value
		.replace(/\\/g, '\\\\')
		.replace(/"/g, '\\"')
		.replace(/[\r\n]+/g, ' ');
}

function parseImageLine(line: string): ParsedImageLine | null {
	const match = IMAGE_LINE.exec(line);
	if (!match?.[2]) return null;
	return {
		alt: unescapeMarkdown(match[1] ?? ''),
		source: match[2],
		title: unescapeMarkdown(match[3] ?? match[4] ?? match[5] ?? '')
	};
}

function formatImageLine(image: ParsedImageLine): string {
	const title = image.title ? ` "${escapeTitle(image.title)}"` : '';
	return `![${escapeAlt(image.alt)}](${image.source}${title})`;
}

function imageKey(source: string, title: string, occurrence: number): string {
	// The title travels with the image through a reorder. The occurrence still
	// disambiguates identical source and caption pairs that have no stable node ID.
	// Long embedded data URIs stay out of the key so a map entry never copies them.
	return `${occurrence}:${fingerprint(source)}:${fingerprint(title)}`;
}

/**
 * Bounded 64-bit fingerprint. Two independent 32-bit mixes make an accidental
 * collision between distinct image sources negligible. The caller still checks
 * the exact identity before it trusts a stored occurrence.
 */
function fingerprint(value: string): string {
	let first = 0x811c9dc5;
	let second = 0x9e3779b9;
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		first = Math.imul(first ^ code, 0x01000193);
		second = Math.imul(second + code, 0x85ebca6b) ^ (second >>> 13);
	}
	return `${(first >>> 0).toString(36)}.${(second >>> 0).toString(36)}`;
}

function numericRatio(value: string): number | null {
	if (!/^[0-9]+(?:\.[0-9]+)?$/.test(value.trim())) return null;
	const ratio = Number(value);
	return Number.isFinite(ratio) && ratio >= 0.05 && ratio <= 10 ? ratio : null;
}

class FenceTracker {
	private marker = '';
	skip(line: string): boolean {
		const match = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
		if (match) {
			if (!this.marker) this.marker = match;
			else if (match[0] === this.marker[0] && match.length >= this.marker.length) this.marker = '';
			return true;
		}
		return this.marker !== '';
	}
}

export interface ImageChangeHint {
	previousFrom: number;
	previousTo: number;
	nextFrom: number;
	nextTo: number;
	/** True when the change inserts blocks, so the span keeps its separator. */
	insert?: boolean;
}

interface ImageRegion {
	inputStart: number;
	inputEnd: number;
	/** Rewritten output length minus input length up to this region end. */
	delta: number;
}

/** Syntax that can start an image, a fence or an HTML comment near a change. */
const SYNTAX_SENSITIVE = /[!<`~]/;
/** Unchanged characters inspected before and after the minimal change span. */
const SYNTAX_CONTEXT_CHARS = 4;
const FENCE_LINE_START = /^ {0,3}(?:`{3,}|~{3,})/;

/**
 * Narrows a block hint to the bytes that actually differ. The serializer scopes
 * a change to the complete top-level block, so unchanged punctuation in that
 * block must not travel to the syntax guard.
 */
function minimalChangeContext(
	previous: string,
	next: string
): { previous: string; next: string } | null {
	const limit = Math.min(previous.length, next.length);
	let prefix = 0;
	while (prefix < limit && previous.charCodeAt(prefix) === next.charCodeAt(prefix)) prefix += 1;
	let suffix = 0;
	while (
		suffix < limit - prefix &&
		previous.charCodeAt(previous.length - 1 - suffix) === next.charCodeAt(next.length - 1 - suffix)
	)
		suffix += 1;
	const previousEnd = previous.length - suffix;
	const nextEnd = next.length - suffix;
	if (previousEnd === prefix && nextEnd === prefix) return null;
	return {
		previous: previous.slice(
			Math.max(0, prefix - SYNTAX_CONTEXT_CHARS),
			Math.min(previous.length, previousEnd + SYNTAX_CONTEXT_CHARS)
		),
		next: next.slice(
			Math.max(0, prefix - SYNTAX_CONTEXT_CHARS),
			Math.min(next.length, nextEnd + SYNTAX_CONTEXT_CHARS)
		)
	};
}

/**
 * Counts lines that the full scanner must classify. A change that turns a text
 * line into an image, metadata or fence line needs the full occurrence-aware
 * scan even when the changed character is far from the syntax.
 */
function dangerousLineCount(span: string): number {
	let count = 0;
	let start = 0;
	while (start <= span.length) {
		const newline = span.indexOf('\n', start);
		const end = newline === -1 ? span.length : newline;
		const line = span.slice(start, end).replace(/\r$/, '');
		if (IMAGE_LINE.test(line) || IMAGE_META_LINE.test(line) || FENCE_LINE_START.test(line))
			count += 1;
		if (newline === -1) break;
		start = newline + 1;
	}
	return count;
}

/**
 * Accepts only a single-line prose change whose own bytes and immediate context
 * cannot introduce Markdown image, fence or comment syntax. Any uncertain
 * context keeps the full fallback.
 */
function scopedChangeIsSafe(previous: string, next: string): boolean {
	// An inserted empty block owns no bytes and cannot introduce syntax.
	if (previous === next) return previous.length === 0;
	const change = minimalChangeContext(previous, next);
	if (!change) return false;
	// Adding or removing a fence, image or metadata line changes the line state
	// that the occurrence-aware scan depends on.
	if (dangerousLineCount(next) !== dangerousLineCount(previous)) return false;
	return !SYNTAX_SENSITIVE.test(change.previous) && !SYNTAX_SENSITIVE.test(change.next);
}

/**
 * Adapts standalone images to the Crepe image block without letting its numeric
 * ratio overwrite Markdown alternative text. A small HTML comment stores a
 * non-default ratio while the standard image token keeps alt text and caption.
 */
export class ImageMarkdownRoundTrip {
	readonly editorMarkdown: string;
	/** The last scoped hint translated to restored offsets for the fidelity layer. */
	lastScopedHint: ImageChangeHint | null = null;
	private state = new Map<string, ImageState>();
	private uploadedAlt = new Map<string, string>();
	private regions: ImageRegion[] = [];
	private lastInput: string | null = null;
	private lastOutput = '';

	/** Read one accepted image occurrence, with an exact collision check. */
	private lookup(
		target: Map<string, ImageState>,
		source: string,
		title: string,
		occurrence: number
	): ImageState | undefined {
		const found = target.get(imageKey(source, title, occurrence));
		if (
			found &&
			found.source === source &&
			found.title === title &&
			found.occurrence === occurrence
		)
			return found;
		return target.get(`${occurrence}:${source}\u0000${title}`);
	}

	private store(
		target: Map<string, ImageState>,
		source: string,
		title: string,
		occurrence: number,
		alt: string,
		ratio: number
	): void {
		const value: ImageState = { alt, ratio, source, title, occurrence };
		const key = imageKey(source, title, occurrence);
		const current = target.get(key);
		if (
			current &&
			(current.source !== source || current.title !== title || current.occurrence !== occurrence)
		) {
			// A fingerprint collision keeps both exact identities apart.
			target.set(`${occurrence}:${source}\u0000${title}`, value);
			return;
		}
		target.set(key, value);
	}

	constructor(markdown: string) {
		const lines = markdown.split('\n');
		const starts = lineStarts(lines);
		const output: string[] = [];
		const occurrences = new Map<string, number>();
		const fences = new FenceTracker();
		let outputLength = 0;
		const push = (value: string) => {
			if (output.length) outputLength += 1;
			output.push(value);
			outputLength += value.length;
		};

		for (let index = 0; index < lines.length; index++) {
			const line = lines[index] ?? '';
			if (fences.skip(line)) {
				push(line);
				continue;
			}
			const image = parseImageLine(line);
			if (!image) {
				push(line);
				continue;
			}
			const identity = occurrenceKey(image.source, image.title);
			const occurrence = occurrences.get(identity) ?? 0;
			occurrences.set(identity, occurrence + 1);
			const meta = IMAGE_META_LINE.exec(lines[index + 1] ?? '');
			const ratio = meta ? (numericRatio(meta[1] ?? '') ?? 1) : 1;
			const alt = image.alt;
			this.store(this.state, image.source, image.title, occurrence, alt, ratio);
			push(formatImageLine({ ...image, alt: ratio.toFixed(2) }));
			if (meta) {
				push(lines[index + 1] ?? '');
				index++;
			}
			const inputEnd = starts[index]! + (lines[index] ?? '').length;
			this.regions.push({
				inputStart: starts[index - (meta ? 1 : 0)]!,
				inputEnd,
				delta: outputLength - inputEnd
			});
		}
		this.editorMarkdown = output.join('\n');
	}

	registerUpload(source: string, alt: string): void {
		this.uploadedAlt.set(source, alt);
	}

	get alternatives(): string[] {
		return [...this.state.values()].map((image) => image.alt);
	}

	restore(markdown: string, commit = true, hint?: ImageChangeHint): string {
		this.lastScopedHint = null;
		if (this.lastInput !== null && markdown === this.lastInput) return this.lastOutput;
		// A document without an image line needs no round-trip rewrite. The
		// cheap marker scan avoids splitting and scanning a large note on text
		// changes that cannot introduce an image.
		if (!markdown.includes('![')) return markdown;
		if (commit && hint && this.lastInput !== null) {
			const scoped = measureImageStage('imageMarkdownScopedStage', () =>
				this.restoreScoped(markdown, hint)
			);
			if (scoped !== null) {
				recordImageCounter('imageMarkdownScoped');
				return scoped;
			}
		}
		const result = measureImageStage('imageMarkdownFullStage', () =>
			this.restoreFull(markdown, commit)
		);
		recordImageCounter('imageMarkdownFull');
		return result;
	}

	/**
	 * Splices a prose change that does not touch an image line. The previous
	 * restored text and its image regions stay valid, so no line scan or
	 * occurrence map rebuild is necessary. An inserting change owns its leading
	 * separator, so the exact inserted bytes come from the new Markdown span.
	 */
	private restoreScoped(markdown: string, hint: ImageChangeHint): string | null {
		const lastInput = this.lastInput;
		if (!lastInput) return null;
		if (
			hint.previousFrom < 0 ||
			hint.previousTo < hint.previousFrom ||
			hint.previousTo > lastInput.length ||
			hint.nextFrom < 0 ||
			hint.nextTo < hint.nextFrom ||
			hint.nextTo > markdown.length
		)
			return null;
		if (
			!hint.insert &&
			hint.nextTo - hint.nextFrom !==
				hint.previousTo - hint.previousFrom + markdown.length - lastInput.length
		)
			return null;
		const changed = markdown.slice(hint.nextFrom, hint.nextTo);
		for (const region of this.regions) {
			const overlaps = hint.previousFrom < region.inputEnd && hint.previousTo > region.inputStart;
			// An insertion exactly at the region end follows the complete image
			// line and its metadata line, so it is safe.
			const insertionInside =
				hint.previousFrom === hint.previousTo &&
				hint.previousFrom >= region.inputStart &&
				hint.previousFrom < region.inputEnd;
			if (overlaps || insertionInside) return null;
		}
		// The serializer scopes the block, not the edited characters. Test the
		// actual change and its immediate context so an unchanged `!` elsewhere
		// in the paragraph does not force a full scan.
		if (!scopedChangeIsSafe(lastInput.slice(hint.previousFrom, hint.previousTo), changed))
			return null;
		let delta = 0;
		for (const region of this.regions) {
			if (region.inputEnd > hint.previousFrom) break;
			delta = region.delta;
		}
		const outputFrom = hint.previousFrom + delta;
		const outputTo = hint.previousTo + delta;
		if (outputFrom > outputTo || outputTo > this.lastOutput.length) return null;
		const result = this.lastOutput.slice(0, outputFrom) + changed + this.lastOutput.slice(outputTo);
		const shift = hint.nextTo - hint.nextFrom - (hint.previousTo - hint.previousFrom);
		for (const region of this.regions) {
			if (region.inputStart < hint.previousTo) continue;
			region.inputStart += shift;
			region.inputEnd += shift;
		}
		this.lastInput = markdown;
		this.lastOutput = result;
		this.lastScopedHint = {
			previousFrom: outputFrom,
			previousTo: outputTo,
			nextFrom: outputFrom,
			nextTo: outputFrom + changed.length,
			...(hint.insert ? { insert: true } : {})
		};
		return result;
	}

	private restoreFull(markdown: string, commit: boolean): string {
		const lines = markdown.split('\n');
		const starts = lineStarts(lines);
		const output: string[] = [];
		const occurrences = new Map<string, number>();
		const nextState = new Map<string, ImageState>();
		const regions: ImageRegion[] = [];
		const fences = new FenceTracker();
		let outputLength = 0;
		const push = (value: string) => {
			if (output.length) outputLength += 1;
			output.push(value);
			outputLength += value.length;
		};

		for (let index = 0; index < lines.length; index++) {
			const line = lines[index] ?? '';
			if (fences.skip(line)) {
				push(line);
				continue;
			}
			const image = parseImageLine(line);
			if (!image) {
				if (!IMAGE_META_LINE.test(line)) push(line);
				continue;
			}
			const regionStart = starts[index]!;
			const identity = occurrenceKey(image.source, image.title);
			const occurrence = occurrences.get(identity) ?? 0;
			occurrences.set(identity, occurrence + 1);
			const current = this.lookup(this.state, image.source, image.title, occurrence);
			const ratio = numericRatio(image.alt) ?? current?.ratio ?? 1;
			const alt = current?.alt ?? this.uploadedAlt.get(image.source) ?? image.title;
			this.store(nextState, image.source, image.title, occurrence, alt, ratio);
			push(formatImageLine({ ...image, alt }));
			if (Math.abs(ratio - 1) > 0.005) push(`<!-- mdsh:image ratio=${ratio.toFixed(2)} -->`);
			// The editor keeps the image block and a ratio comment as separate
			// top-level blocks, so blank lines can separate them. The portable
			// form keeps the comment directly after its image line. Consume the
			// whole unit so later offsets stay on one linear mapping.
			let metaIndex = index + 1;
			while (metaIndex < lines.length && (lines[metaIndex] ?? '') === '') metaIndex += 1;
			if (metaIndex > index && IMAGE_META_LINE.test(lines[metaIndex] ?? '')) index = metaIndex;
			const inputEnd = starts[index]! + (lines[index] ?? '').length;
			regions.push({ inputStart: regionStart, inputEnd, delta: outputLength - inputEnd });
		}

		const result = output.join('\n');
		if (commit) {
			this.state = nextState;
			this.lastInput = markdown;
			this.lastOutput = result;
			this.regions = regions;
		}
		return result;
	}
}

/** Start offset of every line in the original string. */
function lineStarts(lines: readonly string[]): number[] {
	const starts: number[] = [];
	let offset = 0;
	for (const line of lines) {
		starts.push(offset);
		offset += line.length + 1;
	}
	return starts;
}

export function applyImageMetadataToHtml(markdown: string, html: string): string {
	if (typeof document === 'undefined') return html;
	const lines = markdown.split('\n');
	const ratios = new Map<string, number[]>();
	const fences = new FenceTracker();
	for (let index = 0; index < lines.length; index++) {
		if (fences.skip(lines[index] ?? '')) continue;
		const image = parseImageLine(lines[index] ?? '');
		if (!image) continue;
		const meta = IMAGE_META_LINE.exec(lines[index + 1] ?? '');
		const ratio = meta ? (numericRatio(meta[1] ?? '') ?? 1) : 1;
		const source = image.source.startsWith('<') ? image.source.slice(1, -1) : image.source;
		const values = ratios.get(source) ?? [];
		values.push(ratio);
		ratios.set(source, values);
	}
	if (![...ratios.values()].some((values) => values.some((ratio) => ratio !== 1))) return html;
	const template = document.createElement('template');
	template.innerHTML = html;
	for (const image of template.content.querySelectorAll('img')) {
		const source = image.getAttribute('src');
		if (!source) continue;
		const ratio = ratios.get(source)?.shift();
		if (ratio !== undefined && ratio !== 1)
			image.setAttribute('data-mdsh-image-ratio', String(ratio));
	}
	return template.innerHTML;
}

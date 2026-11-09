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
	return `${occurrence}:${source}\u0000${title}`;
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

/**
 * Adapts standalone images to the Crepe image block without letting its numeric
 * ratio overwrite Markdown alternative text. A small HTML comment stores a
 * non-default ratio while the standard image token keeps alt text and caption.
 */
export class ImageMarkdownRoundTrip {
	readonly editorMarkdown: string;
	private state = new Map<string, ImageState>();
	private uploadedAlt = new Map<string, string>();

	constructor(markdown: string) {
		const lines = markdown.split('\n');
		const output: string[] = [];
		const occurrences = new Map<string, number>();
		const fences = new FenceTracker();

		for (let index = 0; index < lines.length; index++) {
			const line = lines[index] ?? '';
			if (fences.skip(line)) {
				output.push(line);
				continue;
			}
			const image = parseImageLine(line);
			if (!image) {
				output.push(line);
				continue;
			}
			const identity = `${image.source}\u0000${image.title}`;
			const occurrence = occurrences.get(identity) ?? 0;
			occurrences.set(identity, occurrence + 1);
			const meta = IMAGE_META_LINE.exec(lines[index + 1] ?? '');
			const ratio = meta ? (numericRatio(meta[1] ?? '') ?? 1) : 1;
			const alt = image.alt;
			this.state.set(imageKey(image.source, image.title, occurrence), { alt, ratio });
			output.push(formatImageLine({ ...image, alt: ratio.toFixed(2) }));
			if (meta) {
				output.push(lines[index + 1] ?? '');
				index++;
			}
		}
		this.editorMarkdown = output.join('\n');
	}

	registerUpload(source: string, alt: string): void {
		this.uploadedAlt.set(source, alt);
	}

	get alternatives(): string[] {
		return [...this.state.values()].map((image) => image.alt);
	}

	restore(markdown: string, commit = true): string {
		const lines = markdown.split('\n');
		const output: string[] = [];
		const occurrences = new Map<string, number>();
		const nextState = new Map<string, ImageState>();
		const fences = new FenceTracker();

		for (let index = 0; index < lines.length; index++) {
			const line = lines[index] ?? '';
			if (fences.skip(line)) {
				output.push(line);
				continue;
			}
			const image = parseImageLine(line);
			if (!image) {
				if (!IMAGE_META_LINE.test(line)) output.push(line);
				continue;
			}
			const identity = `${image.source}\u0000${image.title}`;
			const occurrence = occurrences.get(identity) ?? 0;
			occurrences.set(identity, occurrence + 1);
			const key = imageKey(image.source, image.title, occurrence);
			const current = this.state.get(key);
			const ratio = numericRatio(image.alt) ?? current?.ratio ?? 1;
			const alt = current?.alt ?? this.uploadedAlt.get(image.source) ?? image.title;
			nextState.set(key, { alt, ratio });
			output.push(formatImageLine({ ...image, alt }));
			if (Math.abs(ratio - 1) > 0.005) output.push(`<!-- mdsh:image ratio=${ratio.toFixed(2)} -->`);
			if (IMAGE_META_LINE.test(lines[index + 1] ?? '')) index++;
		}

		if (commit) this.state = nextState;
		return output.join('\n');
	}
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

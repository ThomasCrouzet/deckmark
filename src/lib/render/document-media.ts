import {
	embedImageFile,
	fetchAndEmbedImage,
	isLocalImageSource,
	MAX_MEDIA_TOTAL_BYTES,
	type MediaIssue
} from './image-media';
import { projectDestinations } from '../project-links';
import { MAX_IMAGE_BYTES } from '../config';
import { abortable, checkAborted, isAbortError } from '../abort';

export interface MarkdownImageDestination {
	start: number;
	end: number;
	source: string;
}

function escapedAt(source: string, index: number): boolean {
	let slashes = 0;
	for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor--) slashes++;
	return slashes % 2 === 1;
}

/** Finds inline Markdown image destinations while leaving code untouched. */
export function markdownImageDestinations(markdown: string): MarkdownImageDestination[] {
	const destinations: MarkdownImageDestination[] = projectDestinations(markdown)
		.filter((destination) => destination.image)
		.map(({ start, end, source }) => ({ start, end, source }));
	let fence: string | null = null;
	let inlineTicks = 0;
	for (let index = 0; index < markdown.length; index++) {
		if (index === 0 || markdown[index - 1] === '\n') {
			const end = markdown.indexOf('\n', index);
			const line = markdown.slice(index, end === -1 ? markdown.length : end);
			const match = /^ {0,3}(`{3,}|~{3,})/.exec(markdownContainerLine(line));
			if (match?.[1]) {
				const marker = match[1];
				if (!fence) fence = marker;
				else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
				index = end === -1 ? markdown.length : end;
				continue;
			}
		}
		if (fence) continue;
		if (markdown[index] === '`' && !escapedAt(markdown, index)) {
			let count = 1;
			while (markdown[index + count] === '`') count++;
			if (inlineTicks === 0) inlineTicks = count;
			else if (inlineTicks === count) inlineTicks = 0;
			index += count - 1;
			continue;
		}
		if (inlineTicks === 0 && markdown[index] === '<') {
			const tag = /^<(img|image)\b[^>]*>/i.exec(markdown.slice(index));
			if (tag?.[0]) {
				const attributes = /\b(src|href|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
				for (const attribute of tag[0].matchAll(attributes)) {
					if (tag[1]?.toLowerCase() === 'img' && attribute[1]?.toLowerCase() !== 'src') continue;
					const value = attribute[2] ?? attribute[3] ?? attribute[4] ?? '';
					if (!value) continue;
					const start = index + (attribute.index ?? 0) + attribute[0].lastIndexOf(value);
					const decoder =
						typeof document === 'undefined' ? null : document.createElement('textarea');
					if (decoder) decoder.innerHTML = value;
					destinations.push({ start, end: start + value.length, source: decoder?.value ?? value });
				}
				index += tag[0].length - 1;
				continue;
			}
		}
	}
	return destinations.toSorted((left, right) => left.start - right.start);
}

function markdownContainerLine(line: string): string {
	let value = line;
	while (true) {
		const quote = /^ {0,3}>[ \t]?/.exec(value);
		if (quote) {
			value = value.slice(quote[0].length);
			continue;
		}
		const list = /^ {0,3}(?:[-+*]|\d+[.)])[ \t]+/.exec(value);
		if (!list) return value;
		value = value.slice(list[0].length);
	}
}

function normalizedImagePath(value: string): string | null {
	let path = value;
	try {
		if (/^https?:\/\//i.test(path)) path = new URL(path).pathname;
		path = decodeURIComponent(path);
	} catch {
		return null;
	}
	path = path.replace(/\\/g, '/').split(/[?#]/, 1)[0] ?? '';
	if (path.split('/').includes('..')) return null;
	return path.replace(/^\.\//, '').replace(/^\/+/, '');
}

interface FileMatcher {
	match(source: string): File | null;
}

/** Builds one normalized index for all selected files, then matches in O(1). */
function createFileMatcher(files: readonly File[]): FileMatcher {
	const byName = new Map<string, File[]>();
	const byNormalizedBasename = new Map<string, File[]>();
	for (const file of files) {
		const sameName = byName.get(file.name);
		if (sameName) sameName.push(file);
		else byName.set(file.name, [file]);
		const normalized = normalizedImagePath(file.webkitRelativePath || file.name);
		const basename = normalized?.split('/').pop();
		if (!basename) continue;
		const candidates = byNormalizedBasename.get(basename);
		if (candidates) candidates.push(file);
		else byNormalizedBasename.set(basename, [file]);
	}
	return {
		match(source: string): File | null {
			const path = normalizedImagePath(source);
			if (!path) return null;
			const basename = path.split('/').pop()!;
			// Only files with this basename can satisfy the exact or suffix rule.
			const candidates = byNormalizedBasename.get(basename) ?? [];
			const exact = candidates.filter((file) => {
				const selected = normalizedImagePath(file.webkitRelativePath || file.name);
				return selected === path || selected?.endsWith(`/${path}`);
			});
			if (exact.length === 1) return exact[0] ?? null;
			if (exact.length > 1) return null;
			const sameName = byName.get(basename) ?? [];
			return sameName.length === 1 ? (sameName[0] ?? null) : null;
		}
	};
}

export async function incorporateDocumentImages(
	markdown: string,
	opts: { files?: readonly File[]; allowNetwork?: boolean; signal?: AbortSignal }
): Promise<{ markdown: string; embedded: number; issues: MediaIssue[] }> {
	const replacements = new Map<string, string>();
	const issues: MediaIssue[] = [];
	let totalBytes = 0;
	const destinations = markdownImageDestinations(markdown);
	const matcher = opts.files ? createFileMatcher(opts.files) : null;
	for (const { source } of destinations) {
		checkAborted(opts.signal);
		const isBlob = /^blob:/i.test(source.trim());
		if (isLocalImageSource(source) && !isBlob) continue;
		if (replacements.has(source)) continue;
		try {
			const file = matcher ? matcher.match(source) : null;
			if (opts.files && !file) {
				issues.push({ source, reason: 'unreadable' });
				continue;
			}
			if (!file && !opts.allowNetwork && !isBlob) {
				issues.push({ source, reason: 'blocked' });
				continue;
			}
			const remaining = MAX_MEDIA_TOTAL_BYTES - totalBytes;
			if (file && file.size > Math.min(MAX_IMAGE_BYTES, remaining)) {
				// Reject before decode. Oversized files must not allocate pixels.
				issues.push({ source, reason: 'too-large' });
				continue;
			}
			if (!file && remaining <= 0) {
				// Do not start a network read only to discover a full budget.
				issues.push({ source, reason: 'too-large' });
				continue;
			}
			const image = file
				? await abortable(embedImageFile(file), opts.signal)
				: await fetchAndEmbedImage(source, remaining, opts.signal);
			// A late result must not reach the source after a file change or Stop.
			checkAborted(opts.signal);
			if (totalBytes + image.bytes > MAX_MEDIA_TOTAL_BYTES) {
				issues.push({ source, reason: 'too-large' });
				continue;
			}
			totalBytes += image.bytes;
			replacements.set(source, image.dataUri);
		} catch (error) {
			// A normal Stop or file switch is not a broken image.
			checkAborted(opts.signal);
			if (isAbortError(error)) throw error;
			issues.push({ source, reason: 'unreadable' });
		}
	}
	// Assemble all changed destinations in one pass. Repeated string slicing
	// copies most of a multi-megabyte note for every embedded image.
	const chunks: string[] = [];
	let cursor = 0;
	for (const destination of destinations.toSorted((a, b) => a.start - b.start)) {
		const replacement = replacements.get(destination.source);
		if (!replacement) continue;
		if (destination.start < cursor) break;
		chunks.push(markdown.slice(cursor, destination.start), replacement);
		cursor = destination.end;
	}
	chunks.push(markdown.slice(cursor));
	return { markdown: chunks.join(''), embedded: replacements.size, issues };
}

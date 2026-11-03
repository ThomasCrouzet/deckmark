// Offline documentation audit. The module reads a project snapshot and returns
// a deterministic report. It does not write files, start requests, or use
// storage. Run it in a worker to keep large projects off the main thread.

import { documentHeadings } from './document-navigation';
import { parseFrontmatter } from './frontmatter';
import { isPresentation } from './presentation/detect';
import { parsePresentation, type PresentationDeck } from './presentation/model';
import { projectDestinations, projectLinkReport } from './project-links';
import {
	isExternalDestination,
	pathKey,
	projectWikiCandidates,
	resolveProjectPath
} from './project-paths';
import { slugify, wikiLinkOccurrences } from './wiki-links';

export type DocsCheckSeverity = 'error' | 'warning';

export type DocsCheckCode =
	| 'anchor-missing'
	| 'fence-unclosed'
	| 'frontmatter-invalid'
	| 'frontmatter-unclosed'
	| 'heading-duplicate'
	| 'heading-hierarchy'
	| 'image-alt-missing'
	| 'image-missing'
	| 'image-remote'
	| 'link-ambiguous'
	| 'link-missing'
	| 'link-outside-project'
	| 'presentation-image-empty'
	| 'presentation-parse-failed'
	| 'presentation-resource-missing';

export interface DocsCheckDocument {
	id: string;
	relativePath: string;
	content: string;
}

export interface DocsCheckInput {
	documents: DocsCheckDocument[];
	/** Project asset paths. The checker does not read image bytes. */
	assets: string[];
}

export interface DocsCheckIssue {
	code: DocsCheckCode;
	severity: DocsCheckSeverity;
	documentId: string;
	path: string;
	/** 1-based line in the document source. */
	line: number;
	/** 1-based column in the document source. */
	column: number;
	/** Link, anchor, or resource that caused the issue. */
	target?: string;
	/** Stable English message for the JSON report. The UI localizes the code. */
	message: string;
}

export interface DocsCheckSkipped {
	check: string;
	reason: string;
}

export interface DocsCheckReport {
	schema: 'mdsh-docs-check/1';
	documents: number;
	summary: { errors: number; warnings: number };
	issues: DocsCheckIssue[];
	/** Checks that need a renderer or network access. They are not errors. */
	skipped: DocsCheckSkipped[];
}

const SKIPPED: DocsCheckSkipped[] = [
	{
		check: 'presentation-layout',
		reason: 'Text overflow needs layout measurement. The model clamps element bounds.'
	},
	{
		check: 'remote-resources',
		reason: 'Remote resources are not downloaded. The checker reports them as warnings.'
	},
	{
		check: 'html-content',
		reason: 'Raw HTML content is not validated.'
	},
	{
		check: 'external-anchors',
		reason: 'Anchors in external pages are not checked.'
	}
];

interface FrontmatterBlock {
	start: number;
	end: number;
	closed: boolean;
}

interface DocumentAnchorIndex {
	ids: Set<string>;
	duplicates: Array<{ line: number; base: string }>;
}

interface PositionedIssue extends Omit<DocsCheckIssue, 'line' | 'column'> {
	offset: number;
}

function frontmatterBlock(markdown: string): FrontmatterBlock | null {
	const prefix = markdown.startsWith('\uFEFF') ? 1 : 0;
	const body = markdown.slice(prefix);
	const open = /^---[ \t]*\r?\n/.exec(body);
	if (!open) return null;
	const contentStart = prefix + open[0].length;
	const close = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(markdown.slice(contentStart));
	if (!close) return { start: 0, end: markdown.length, closed: false };
	return {
		start: 0,
		end: contentStart + close.index + close[0].length,
		closed: true
	};
}

function lineStarts(markdown: string): number[] {
	const starts = [0];
	for (let index = 0; index < markdown.length; index++) {
		if (markdown[index] === '\n') starts.push(index + 1);
	}
	return starts;
}

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function position(starts: number[], offset: number): { line: number; column: number } {
	let low = 0;
	let high = starts.length - 1;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (starts[middle]! <= offset) low = middle;
		else high = middle - 1;
	}
	return { line: low + 1, column: Math.max(1, offset - starts[low]! + 1) };
}

function escaped(text: string, index: number): boolean {
	let count = 0;
	for (let at = index - 1; at >= 0 && text[at] === '\\'; at--) count++;
	return count % 2 === 1;
}

/** Marks code and front matter so image and definition scans skip them. */
function maskedMarkdown(markdown: string): string {
	const characters = markdown.split('');
	const masked = new Uint8Array(markdown.length);
	const mask = (start: number, end: number): void => {
		for (let index = start; index < end; index++) {
			masked[index] = 1;
			if (characters[index] !== '\n' && characters[index] !== '\r') characters[index] = ' ';
		}
	};

	const block = frontmatterBlock(markdown);
	if (block) mask(block.start, block.end);

	let fence = '';
	let lineStart = block?.end ?? 0;
	while (lineStart < markdown.length) {
		const newline = markdown.indexOf('\n', lineStart);
		const lineEnd = newline < 0 ? markdown.length : newline;
		const line = markdown.slice(lineStart, lineEnd);
		const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (fence) {
			mask(lineStart, lineEnd);
			if (
				marker &&
				marker[1]![0] === fence[0] &&
				marker[1]!.length >= fence.length &&
				!marker[2]!.trim()
			)
				fence = '';
		} else if (marker) {
			fence = marker[1]!;
			mask(lineStart, lineEnd);
		}
		lineStart = newline < 0 ? markdown.length : newline + 1;
	}

	for (let index = 0; index < markdown.length; index++) {
		if (masked[index]) continue;
		if (markdown.startsWith('<!--', index)) {
			const end = markdown.indexOf('-->', index + 4);
			const stop = end < 0 ? markdown.length : end + 3;
			mask(index, stop);
			index = stop - 1;
			continue;
		}
		if (markdown[index] !== '`' || escaped(markdown, index)) continue;
		let count = 1;
		while (markdown[index + count] === '`') count++;
		const run = '`'.repeat(count);
		let end = markdown.indexOf(run, index + count);
		while (end >= 0 && (markdown[end - 1] === '`' || markdown[end + count] === '`')) {
			end = markdown.indexOf(run, end + count);
		}
		const stop = end < 0 ? index + count : end + count;
		mask(index, stop);
		index = stop - 1;
	}
	return characters.join('');
}

function referenceLabel(value: string): string {
	return value.replace(/\\(.)/g, '$1').trim().replace(/\s+/g, ' ').toLowerCase();
}

function referenceDefinitions(masked: string): Map<string, string> {
	const definitions = new Map<string, string>();
	const pattern = /^ {0,3}\[([^\]\n]+)\]:[ \t]*(?:<([^>\n]+)>|(\S+))/gm;
	for (const match of masked.matchAll(pattern)) {
		const label = referenceLabel(match[1]!);
		const source = match[2] ?? match[3];
		if (source) definitions.set(label, source);
	}
	return definitions;
}

function fenceIssues(document: DocsCheckDocument, start: number): PositionedIssue[] {
	const markdown = document.content;
	const issues: PositionedIssue[] = [];
	let fence = '';
	let fenceStart = 0;
	let lineStart = start;
	while (lineStart < markdown.length) {
		const newline = markdown.indexOf('\n', lineStart);
		const lineEnd = newline < 0 ? markdown.length : newline;
		const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(markdown.slice(lineStart, lineEnd));
		if (fence) {
			if (
				marker &&
				marker[1]![0] === fence[0] &&
				marker[1]!.length >= fence.length &&
				!marker[2]!.trim()
			)
				fence = '';
		} else if (marker) {
			fence = marker[1]!;
			fenceStart = lineStart;
		}
		lineStart = newline < 0 ? markdown.length : newline + 1;
	}
	if (fence) {
		issues.push({
			code: 'fence-unclosed',
			severity: 'warning',
			documentId: document.id,
			path: document.relativePath,
			offset: fenceStart,
			message: 'Code fence is not closed.'
		});
	}
	return issues;
}

function anchorIndexes(documents: DocsCheckDocument[]): Map<string, DocumentAnchorIndex> {
	const indexes = new Map<string, DocumentAnchorIndex>();
	for (const document of documents) {
		const ids = new Set<string>();
		const counts = new Map<string, number>();
		const duplicates: Array<{ line: number; base: string }> = [];
		for (const heading of documentHeadings(document.content)) {
			const base = slugify(heading.text).slice(0, 80) || `section-${heading.level}`;
			const seen = counts.get(base) ?? 0;
			counts.set(base, seen + 1);
			if (seen > 0) duplicates.push({ line: heading.line, base });
			let id = base;
			let suffix = 2;
			while (ids.has(id)) id = `${base}-${suffix++}`;
			ids.add(id);
		}
		indexes.set(pathKey(document.relativePath), { ids, duplicates });
	}
	return indexes;
}

function headingIssues(document: DocsCheckDocument, index: DocumentAnchorIndex): PositionedIssue[] {
	const issues: PositionedIssue[] = [];
	const starts = lineStarts(document.content);
	for (const duplicate of index.duplicates) {
		issues.push({
			code: 'heading-duplicate',
			severity: 'warning',
			documentId: document.id,
			path: document.relativePath,
			offset: starts[duplicate.line - 1] ?? 0,
			target: duplicate.base,
			message: `Duplicate heading anchor "${duplicate.base}".`
		});
	}

	let previous = 0;
	for (const heading of documentHeadings(document.content)) {
		if (previous > 0 && heading.level > previous + 1) {
			issues.push({
				code: 'heading-hierarchy',
				severity: 'warning',
				documentId: document.id,
				path: document.relativePath,
				offset: starts[heading.line - 1] ?? 0,
				target: heading.text,
				message: `Heading level jumps from ${previous} to ${heading.level}.`
			});
		}
		previous = heading.level;
	}
	return issues;
}

function fragmentOf(source: string): string | null {
	const hash = source.indexOf('#');
	if (hash < 0) return null;
	try {
		return decodeURIComponent(source.slice(hash + 1));
	} catch {
		return source.slice(hash + 1);
	}
}

function anchorExists(index: DocumentAnchorIndex | undefined, fragment: string): boolean {
	if (!index) return false;
	if (!fragment || fragment.startsWith('mdsh-wiki-')) return true;
	return index.ids.has(fragment);
}

function anchorIssues(
	documents: DocsCheckDocument[],
	indexes: Map<string, DocumentAnchorIndex>
): PositionedIssue[] {
	const byPath = new Map(documents.map((document) => [pathKey(document.relativePath), document]));
	const wikiDocuments = documents.map((document) => ({
		id: document.id,
		projectId: 'project',
		relativePath: document.relativePath
	}));
	const issues: PositionedIssue[] = [];
	for (const document of documents) {
		for (const destination of projectDestinations(document.content)) {
			if (destination.image) continue;
			const source = destination.source;
			if (!source || source.startsWith('data:') || isExternalDestination(source)) continue;
			const fragment = fragmentOf(source);
			if (fragment === null) continue;
			const pathPart = source.slice(0, source.indexOf('#'));
			let targetIndex: DocumentAnchorIndex | undefined;
			if (!pathPart) {
				targetIndex = indexes.get(pathKey(document.relativePath));
			} else {
				const target = resolveProjectPath(document.relativePath, pathPart);
				if (!target) continue;
				targetIndex = indexes.get(pathKey(target));
				if (!targetIndex) continue;
			}
			if (anchorExists(targetIndex, fragment)) continue;
			issues.push({
				code: 'anchor-missing',
				severity: 'warning',
				documentId: document.id,
				path: document.relativePath,
				offset: destination.start,
				target: source,
				message: `Missing anchor "${fragment}".`
			});
		}

		for (const occurrence of wikiLinkOccurrences(document.content)) {
			const fragment = fragmentOf(occurrence.target);
			if (fragment === null || !fragment) continue;
			const candidates = projectWikiCandidates(
				{ projectId: 'project', relativePath: document.relativePath },
				occurrence.target,
				wikiDocuments
			);
			if (candidates.length !== 1) continue;
			const target = byPath.get(pathKey(candidates[0]!.relativePath!));
			if (!target) continue;
			if (anchorExists(indexes.get(pathKey(target.relativePath)), fragment)) continue;
			issues.push({
				code: 'anchor-missing',
				severity: 'warning',
				documentId: document.id,
				path: document.relativePath,
				offset: occurrence.start,
				target: occurrence.target,
				message: `Missing anchor "${fragment}".`
			});
		}
	}
	return issues;
}

function imageIssues(document: DocsCheckDocument): PositionedIssue[] {
	const masked = maskedMarkdown(document.content);
	const definitions = referenceDefinitions(masked);
	const issues: PositionedIssue[] = [];
	const pattern = /!\[([^\]\n]*)\](?:\(([^)\n]*)\)|\[([^\]\n]*)\])?/g;
	for (const match of masked.matchAll(pattern)) {
		const start = match.index;
		if (start === undefined || escaped(masked, start)) continue;
		const alt = match[1] ?? '';
		const inline = match[2];
		const reference = match[3];
		const label = reference === undefined ? alt : reference || alt;
		if (reference !== undefined) {
			const target = definitions.get(referenceLabel(label));
			if (!target) {
				issues.push({
					code: 'image-missing',
					severity: 'error',
					documentId: document.id,
					path: document.relativePath,
					offset: start,
					target: label,
					message: `Missing reference definition "${label}".`
				});
			}
		} else if (inline === undefined && definitions.get(referenceLabel(label)) === undefined) {
			// A shortcut reference without a definition is plain text, not an image.
			continue;
		}
		if (!alt.trim()) {
			issues.push({
				code: 'image-alt-missing',
				severity: 'warning',
				documentId: document.id,
				path: document.relativePath,
				offset: start,
				message: 'Image has no alt text.'
			});
		}
	}

	return issues;
}

function presentationIssues(
	document: DocsCheckDocument,
	assets: Set<string>,
	deck: PresentationDeck
): PositionedIssue[] {
	const issues: PositionedIssue[] = [];
	for (const slide of deck.slides) {
		for (const element of slide.elements) {
			const marker = `<!-- mdsh-element:${element.id} -->`;
			const markerAt = document.content.indexOf(marker);
			const offsetFor = (source?: string): number => {
				if (source) {
					const found = document.content.indexOf(source, markerAt < 0 ? 0 : markerAt);
					if (found >= 0) return found;
				}
				return markerAt < 0 ? 0 : markerAt;
			};
			if (element.type === 'text') {
				for (const destination of projectDestinations(element.content)) {
					if (!destination.image) continue;
					const source = destination.source;
					if (source.startsWith('data:')) continue;
					if (isExternalDestination(source)) {
						issues.push({
							code: 'image-remote',
							severity: 'warning',
							documentId: document.id,
							path: document.relativePath,
							offset: offsetFor(source),
							target: source,
							message: `Remote image "${source}" is not downloaded.`
						});
						continue;
					}
					const target = resolveProjectPath(document.relativePath, source);
					if (!target || !assets.has(pathKey(target))) {
						issues.push({
							code: 'presentation-resource-missing',
							severity: 'error',
							documentId: document.id,
							path: document.relativePath,
							offset: offsetFor(source),
							target: source,
							message: `Missing presentation image "${source}".`
						});
					}
				}
				continue;
			}
			if (element.type !== 'image') continue;
			const source = element.content.trim();
			const offset = offsetFor(source);
			if (!source) {
				issues.push({
					code: 'presentation-image-empty',
					severity: 'warning',
					documentId: document.id,
					path: document.relativePath,
					offset,
					message: 'Presentation image has no source.'
				});
				continue;
			}
			if (source.startsWith('data:')) continue;
			if (isExternalDestination(source)) {
				issues.push({
					code: 'image-remote',
					severity: 'warning',
					documentId: document.id,
					path: document.relativePath,
					offset,
					target: source,
					message: `Remote image "${source}" is not downloaded.`
				});
				continue;
			}
			const target = resolveProjectPath(document.relativePath, source);
			if (!target || !assets.has(pathKey(target))) {
				issues.push({
					code: 'presentation-resource-missing',
					severity: 'error',
					documentId: document.id,
					path: document.relativePath,
					offset,
					target: source,
					message: `Missing presentation image "${source}".`
				});
			}
		}
	}
	return issues;
}

function linkIssue(
	document: DocsCheckDocument,
	issue: ReturnType<typeof projectLinkReport>[number]
): PositionedIssue {
	const code: DocsCheckCode =
		issue.reason === 'ambiguous'
			? 'link-ambiguous'
			: issue.reason === 'outside-project'
				? 'link-outside-project'
				: issue.reason === 'remote'
					? 'image-remote'
					: issue.image === true
						? 'image-missing'
						: 'link-missing';
	const message =
		code === 'link-ambiguous'
			? `Several documents match "${issue.destination}".`
			: code === 'link-outside-project'
				? `"${issue.destination}" is outside the project.`
				: code === 'image-remote'
					? `Remote image "${issue.destination}" is not downloaded.`
					: code === 'image-missing'
						? `Missing image "${issue.destination}".`
						: `Missing link target "${issue.destination}".`;
	return {
		code,
		severity: code === 'image-remote' ? 'warning' : 'error',
		documentId: document.id,
		path: document.relativePath,
		offset: issue.start ?? 0,
		target: issue.destination,
		message
	};
}

/** Runs every supported check and returns a stable, sorted report. */
export async function runDocsCheck(input: DocsCheckInput): Promise<DocsCheckReport> {
	const documents = input.documents.map((document) => ({
		...document,
		relativePath: document.relativePath
	}));
	const noteDocuments = documents.filter((document) => !isPresentation(document.content));
	const presentationDocuments = documents.filter((document) => isPresentation(document.content));
	const assetKeys = new Set(input.assets.map((path) => pathKey(path)));
	const indexes = anchorIndexes(noteDocuments);
	const issues: PositionedIssue[] = [];

	for (const document of noteDocuments) {
		const block = frontmatterBlock(document.content);
		if (block && !block.closed) {
			issues.push({
				code: 'frontmatter-unclosed',
				severity: 'error',
				documentId: document.id,
				path: document.relativePath,
				offset: block.start,
				message: 'Front matter is not closed.'
			});
		} else if (block) {
			const parsed = await parseFrontmatter(document.content);
			if (parsed.error) {
				issues.push({
					code: 'frontmatter-invalid',
					severity: 'error',
					documentId: document.id,
					path: document.relativePath,
					offset: block.start,
					message: 'Invalid YAML front matter.'
				});
			}
		}

		const index = indexes.get(pathKey(document.relativePath))!;
		issues.push(...headingIssues(document, index));
		issues.push(...fenceIssues(document, block?.end ?? 0));
		issues.push(...imageIssues(document));
	}
	issues.push(...anchorIssues(noteDocuments, indexes));

	const linkIssues = projectLinkReport(
		noteDocuments.map((document) => ({
			id: document.id,
			relativePath: document.relativePath,
			content: document.content
		})),
		input.assets,
		{ withSource: true }
	);
	for (const issue of linkIssues) {
		const document = noteDocuments.find((entry) => entry.relativePath === issue.document);
		if (document) issues.push(linkIssue(document, issue));
	}

	for (const document of presentationDocuments) {
		try {
			const deck = parsePresentation(document.content);
			issues.push(...presentationIssues(document, assetKeys, deck));
		} catch {
			issues.push({
				code: 'presentation-parse-failed',
				severity: 'error',
				documentId: document.id,
				path: document.relativePath,
				offset: 0,
				message: 'Presentation metadata is invalid.'
			});
		}
	}

	const starts = new Map(documents.map((document) => [document.id, lineStarts(document.content)]));
	const seen = new Set<string>();
	const positioned = issues
		.map((issue) => {
			const { line, column } = position(starts.get(issue.documentId) ?? [0], issue.offset);
			const { offset: _offset, ...rest } = issue;
			void _offset;
			return { ...rest, line, column };
		})
		.filter((issue) => {
			const key = [
				issue.path,
				issue.line,
				issue.column,
				issue.code,
				issue.target ?? '',
				issue.message
			].join('\u0000');
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.sort(
			(a, b) =>
				compareText(a.path, b.path) ||
				a.line - b.line ||
				a.column - b.column ||
				compareText(a.code, b.code) ||
				compareText(a.target ?? '', b.target ?? '') ||
				compareText(a.message, b.message)
		);

	return {
		schema: 'mdsh-docs-check/1',
		documents: documents.length,
		summary: {
			errors: positioned.filter((issue) => issue.severity === 'error').length,
			warnings: positioned.filter((issue) => issue.severity === 'warning').length
		},
		issues: positioned,
		skipped: SKIPPED.map((entry) => ({ ...entry }))
	};
}

/** Serializes the report with stable key order and no time or locale data. */
export function serializeDocsCheckReport(report: DocsCheckReport): string {
	return `${JSON.stringify(report, null, 2)}\n`;
}

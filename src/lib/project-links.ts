import {
	isExternalDestination,
	projectWikiCandidates,
	relativeDestination,
	resolveProjectPath
} from './project-paths';
import { extractWikiLinkTargets } from './wiki-links';

export interface ProjectDestination {
	start: number;
	end: number;
	source: string;
	image: boolean;
}

function escaped(text: string, index: number): boolean {
	let count = 0;
	for (let at = index - 1; at >= 0 && text[at] === '\\'; at--) count++;
	return count % 2 === 1;
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

function referenceLabel(value: string): string {
	return value.replace(/\\(.)/g, '$1').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Find source ranges without changing code, front matter, labels, or titles. */
export function projectDestinations(markdown: string): ProjectDestination[] {
	const prefix = /^\uFEFF+/.exec(markdown)?.[0].length ?? 0;
	if (prefix)
		return projectDestinations(markdown.slice(prefix)).map((destination) => ({
			...destination,
			start: destination.start + prefix,
			end: destination.end + prefix
		}));
	const out: ProjectDestination[] = [];
	const definitions: Array<{ destination: ProjectDestination; label: string }> = [];
	const imageReferences = new Set<string>();
	const frontmatter = /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(markdown);
	let fence = '';
	let htmlBlock = '';
	for (let index = frontmatter?.[0].length ?? 0; index < markdown.length; index++) {
		if (index === 0 || markdown[index - 1] === '\n') {
			const lineEnd = markdown.indexOf('\n', index);
			const end = lineEnd < 0 ? markdown.length : lineEnd;
			const line = markdown.slice(index, end);
			const containerLine = markdownContainerLine(line);
			const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(containerLine);
			if (
				marker &&
				(!fence ||
					(marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim()))
			) {
				fence = fence ? '' : marker[1]!;
				index = end;
				continue;
			}
			if (fence || /^(?: {4}|\t)/.test(line)) {
				index = end;
				continue;
			}
			if (htmlBlock) {
				if (new RegExp(`</${htmlBlock}[ \\t]*>`, 'i').test(containerLine)) htmlBlock = '';
				index = end;
				continue;
			}
			const html = /^ {0,3}<(pre|script|style|textarea)(?:[ \t>]|$)/i.exec(containerLine);
			if (html) {
				htmlBlock = html[1]!.toLowerCase();
				if (new RegExp(`</${htmlBlock}[ \\t]*>`, 'i').test(containerLine)) htmlBlock = '';
				index = end;
				continue;
			}
			const definition = /^ {0,3}\[([^\]\n]+)\]:[ \t]*/.exec(line);
			if (definition) {
				const destination = readDestination(markdown, index + definition[0].length);
				if (destination) {
					const item = { ...destination, image: false };
					out.push(item);
					definitions.push({ destination: item, label: referenceLabel(definition[1]!) });
				}
				index = end;
				continue;
			}
		}
		if (markdown.startsWith('<!--', index)) {
			const end = markdown.indexOf('-->', index + 4);
			index = end < 0 ? markdown.length : end + 2;
			continue;
		}
		if (markdown[index] === '`' && !escaped(markdown, index)) {
			let count = 1;
			while (markdown[index + count] === '`') count++;
			const run = '`'.repeat(count);
			let end = markdown.indexOf(run, index + count);
			while (end >= 0 && (markdown[end - 1] === '`' || markdown[end + count] === '`'))
				end = markdown.indexOf(run, end + count);
			if (end >= 0) index = end + count - 1;
			else index += count - 1;
			continue;
		}
		if (markdown[index] !== '[' || escaped(markdown, index) || markdown[index + 1] === '[')
			continue;
		let cursor = index + 1;
		let depth = 1;
		for (; cursor < markdown.length; cursor++) {
			if (escaped(markdown, cursor)) continue;
			if (markdown[cursor] === '[') depth++;
			if (markdown[cursor] === ']' && --depth === 0) break;
		}
		const image = index > 0 && markdown[index - 1] === '!' && !escaped(markdown, index - 1);
		if (markdown[cursor + 1] !== '(') {
			if (image) {
				const text = markdown.slice(index + 1, cursor);
				if (markdown[cursor + 1] === '[') {
					const close = markdown.indexOf(']', cursor + 2);
					if (close >= 0)
						imageReferences.add(referenceLabel(markdown.slice(cursor + 2, close) || text));
				} else imageReferences.add(referenceLabel(text));
			}
			continue;
		}
		cursor += 2;
		while (/\s/.test(markdown[cursor] ?? '') && cursor < markdown.length) cursor++;
		const destination = readDestination(markdown, cursor);
		if (destination) {
			out.push({
				...destination,
				image
			});
			index = destination.end;
		}
	}
	for (const definition of definitions) {
		if (imageReferences.has(definition.label)) definition.destination.image = true;
	}
	return out;
}

function readDestination(text: string, at: number): Omit<ProjectDestination, 'image'> | null {
	const angle = text[at] === '<';
	const start = angle ? at + 1 : at;
	let depth = 0;
	let end = start;
	for (; end < text.length; end++) {
		if (escaped(text, end)) continue;
		const character = text[end]!;
		if (angle) {
			if (character === '>') break;
			if (character === '\n') return null;
		} else {
			if (character === '(') depth++;
			if (character === ')') {
				if (depth === 0) break;
				depth--;
			}
			if (/\s/.test(character) && depth === 0) break;
		}
	}
	if (end === start || (angle && text[end] !== '>')) return null;
	return { start, end, source: text.slice(start, end).replace(/\\([()])/g, '$1') };
}

export function rewriteProjectDestinations(
	markdown: string,
	rewrite: (destination: ProjectDestination) => string | null
): string {
	let result = markdown;
	for (const destination of projectDestinations(markdown).toReversed()) {
		const replacement = rewrite(destination);
		if (replacement !== null && replacement !== destination.source) {
			result = result.slice(0, destination.start) + replacement + result.slice(destination.end);
		}
	}
	return result;
}

export function renameProjectLinks(
	markdown: string,
	from: string,
	oldPath: string,
	newPath: string
): string {
	return rewriteProjectDestinations(markdown, ({ source }) => {
		const target = resolveProjectPath(from, source);
		if (!target) return null;
		const nextFrom = from === oldPath ? newPath : from;
		if (target !== oldPath && nextFrom === from) return null;
		const suffix = source.match(/[?#].*$/)?.[0] ?? '';
		return relativeDestination(nextFrom, target === oldPath ? newPath : target) + suffix;
	});
}

export interface ProjectLinkIssue {
	document: string;
	destination: string;
	reason: 'missing' | 'ambiguous' | 'outside-project' | 'remote';
}

export function projectLinkReport(
	documents: { id?: string; relativePath: string; content: string }[],
	assets: string[]
): ProjectLinkIssue[] {
	const paths = new Set([...documents.map((doc) => doc.relativePath), ...assets]);
	const wikiDocuments = documents.map((document) => ({
		id: document.id ?? document.relativePath,
		projectId: 'project',
		relativePath: document.relativePath
	}));
	return documents.flatMap((doc) => [
		...extractWikiLinkTargets(doc.content).flatMap((target): ProjectLinkIssue[] => {
			const candidates = projectWikiCandidates(
				{ projectId: 'project', relativePath: doc.relativePath },
				target,
				wikiDocuments
			);
			if (candidates.length === 1) return [];
			return [
				{
					document: doc.relativePath,
					destination: target,
					reason: candidates.length ? 'ambiguous' : 'missing'
				}
			];
		}),
		...projectDestinations(doc.content).flatMap(({ source, image }): ProjectLinkIssue[] => {
			if (source.startsWith('#') || source.startsWith('data:')) return [];
			if (isExternalDestination(source))
				return image ? [{ document: doc.relativePath, destination: source, reason: 'remote' }] : [];
			const target = resolveProjectPath(doc.relativePath, source);
			if (target && paths.has(target)) return [];
			return [
				{
					document: doc.relativePath,
					destination: source,
					reason: target ? 'missing' : 'outside-project'
				}
			];
		})
	]);
}

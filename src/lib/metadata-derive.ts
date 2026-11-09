import { stripMdExtension } from './file-names';
import { extractWikiLinkTargets } from './wiki-links';
import { getTitle as getFmTitle, stripFrontmatter } from './frontmatter-fields';

export interface MetadataSource {
	name: string;
	content: string;
	isNote: boolean;
}

export interface MetadataValues {
	title: string;
	documentTitle: string;
	tags: string[];
	targets: string[];
}

export interface MetadataSnapshot extends MetadataSource, MetadataValues {
	frontmatterEnd: number;
}

function frontmatterLines(raw: string): string[] {
	const lines = raw
		.replace(/^\uFEFF/, '')
		.replace(/\r\n?/g, '\n')
		.split('\n');
	if (lines[0]?.trim() === '---') lines.shift();
	while (lines.length > 0 && lines.at(-1)!.trim() === '---') lines.pop();
	return lines;
}

/** Removes a YAML comment that is outside quoted text. */
function stripYamlComment(value: string): string {
	let single = false;
	let double = false;
	for (let index = 0; index < value.length; index++) {
		const character = value[index];
		if (character === "'" && !double) {
			if (single && value[index + 1] === "'") index++;
			else single = !single;
		} else if (character === '"' && !single) {
			if (double && value[index - 1] === '\\') continue;
			double = !double;
		} else if (character === '#' && !single && !double) {
			if (index === 0 || /\s/.test(value[index - 1]!)) return value.slice(0, index);
		}
	}
	return value;
}

function splitYamlList(value: string): string[] {
	const items: string[] = [];
	let current = '';
	let single = false;
	let double = false;
	for (let index = 0; index < value.length; index++) {
		const character = value[index]!;
		if (character === "'" && !double) {
			if (single && value[index + 1] === "'") {
				current += "''";
				index++;
				continue;
			}
			single = !single;
			current += character;
		} else if (character === '"' && !single) {
			if (double && value[index - 1] === '\\') {
				current += character;
				continue;
			}
			double = !double;
			current += character;
		} else if (character === ',' && !single && !double) {
			items.push(current);
			current = '';
		} else current += character;
	}
	items.push(current);
	return items.map(unquoteYamlScalar).filter(Boolean);
}

function unquoteYamlScalar(value: string): string {
	const trimmed = stripYamlComment(value.trim()).trim();
	if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
		return trimmed.slice(1, -1).replaceAll("''", "'").trim();
	}
	if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
		return trimmed
			.slice(1, -1)
			.replace(/\\(["\\/bfnrt])/g, (_match, code: string) => {
				const escapes: Record<string, string> = {
					'"': '"',
					'\\': '\\',
					'/': '/',
					b: '\b',
					f: '\f',
					n: '\n',
					r: '\r',
					t: '\t'
				};
				return escapes[code] ?? code;
			})
			.trim();
	}
	return trimmed;
}

function blockScalar(
	lines: string[],
	start: number,
	indicator: string
): { value: string; end: number } {
	const folded = indicator.startsWith('>');
	const chomp = indicator.includes('-') ? 'strip' : indicator.includes('+') ? 'keep' : 'clip';
	const collected: string[] = [];
	let index = start;
	let indentation: number | null = null;
	for (; index < lines.length; index++) {
		const line = lines[index]!;
		if (line.trim() === '') {
			collected.push('');
			continue;
		}
		const indent = /^[ \t]*/.exec(line)![0].length;
		if (indent === 0) break;
		indentation ??= indent;
		collected.push(line.slice(Math.min(indent, indentation)));
	}
	while (collected.length > 0 && collected.at(-1) === '') collected.pop();
	let value: string;
	if (folded) {
		value = '';
		for (let position = 0; position < collected.length; position++) {
			const line = collected[position]!;
			if (line === '') {
				value = value.replace(/ $/, '') + '\n';
				continue;
			}
			const previous = collected[position - 1];
			value +=
				value === '' || value.endsWith('\n') || previous === undefined || previous === ''
					? line
					: ` ${line}`;
		}
	} else value = collected.join('\n');
	if (chomp === 'strip') value = value.replace(/\n+$/, '');
	else if (chomp === 'clip') value = value.replace(/\n+$/, '') + (value ? '\n' : '');
	return { value, end: index };
}

/** Reads the top-level `title` and `tags` keys from a bounded YAML prefix. */
export function fastFrontmatter(raw: string): { title?: string; tags?: string[] } {
	const lines = frontmatterLines(raw);
	const result: { title?: string; tags?: string[] } = {};
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		if (/^[ \t]/.test(line)) continue;
		const match = /^(title|tags):(?:[ \t]*(.*))?$/.exec(line);
		if (!match) continue;
		const key = match[1] as 'title' | 'tags';
		const value = (match[2] ?? '').trim();
		if (key === 'title') {
			if (value === '' || /^[|>][+-]?\d*$/.test(value)) {
				if (value === '') continue;
				const block = blockScalar(lines, index + 1, value);
				result.title = block.value;
				index = block.end - 1;
			} else {
				result.title = unquoteYamlScalar(value);
			}
			continue;
		}
		const tagValue = stripYamlComment(value).trim();
		if (tagValue === '') {
			const tags: string[] = [];
			let cursor = index + 1;
			for (; cursor < lines.length; cursor++) {
				const item = lines[cursor]!;
				if (item.trim() === '') continue;
				if (!/^[ \t]+-/.test(item)) break;
				const tag = unquoteYamlScalar(item.replace(/^[ \t]+-[ \t]*/, ''));
				if (tag) tags.push(tag);
			}
			result.tags = tags;
			index = cursor - 1;
		} else if (tagValue.startsWith('[') && tagValue.endsWith(']')) {
			result.tags = splitYamlList(tagValue.slice(1, -1));
		} else {
			result.tags = splitYamlList(tagValue);
		}
	}
	if (result.tags) result.tags = [...new Set(result.tags)];
	return result;
}

export function deriveMetadata(source: MetadataSource): MetadataSnapshot {
	const fallback = stripMdExtension(source.name);
	const { content, raw } = stripFrontmatter(source.content);
	const fast = raw ? fastFrontmatter(raw) : {};
	let title = fallback;
	if (raw) {
		title = fast.title?.trim() || getFmTitle({}, content, fallback);
	}
	let tags: string[] = [];
	if (raw && source.isNote) {
		tags = fast.tags ?? [];
	}
	return {
		...source,
		frontmatterEnd: raw.length,
		title,
		documentTitle: raw ? title : getFmTitle({}, content, fallback),
		tags,
		targets: source.isNote ? extractWikiLinkTargets(source.content) : []
	};
}

export function updateMetadata(
	previous: MetadataSnapshot | undefined,
	source: MetadataSource
): { snapshot: MetadataSnapshot; incremental: boolean } {
	if (previous && previous.name === source.name && previous.isNote === source.isNote) {
		const old = previous.content;
		const next = source.content;
		let from = 0;
		while (from < old.length && from < next.length && old[from] === next[from]) from++;
		let oldEnd = old.length;
		let nextEnd = next.length;
		while (oldEnd > from && nextEnd > from && old[oldEnd - 1] === next[nextEnd - 1]) {
			oldEnd--;
			nextEnd--;
		}
		const start = old.lastIndexOf('\n', from - 1) + 1;
		const oldLineEnd = old.indexOf('\n', oldEnd);
		const nextLineEnd = next.indexOf('\n', nextEnd);
		// Only plain, non-indented body lines can bypass the shared syntax parser.
		const plain = /^[A-Za-z0-9][A-Za-z0-9 ,.!?]*$/;
		if (
			start >= previous.frontmatterEnd &&
			plain.test(old.slice(start, oldLineEnd === -1 ? old.length : oldLineEnd)) &&
			plain.test(next.slice(start, nextLineEnd === -1 ? next.length : nextLineEnd))
		) {
			return { snapshot: { ...previous, ...source }, incremental: true };
		}
	}
	return { snapshot: deriveMetadata(source), incremental: false };
}

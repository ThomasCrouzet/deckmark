import { stripMdExtension } from './file-names';
import { extractWikiLinkTargets } from './wiki-links';
import {
	getTags as getFmTags,
	getTitle as getFmTitle,
	stripFrontmatter
} from './frontmatter-fields';

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

export function deriveMetadata(source: MetadataSource): MetadataSnapshot {
	const fallback = stripMdExtension(source.name);
	const { content, raw } = stripFrontmatter(source.content);
	let title = fallback;
	if (raw) {
		const m = /^title:[ \t]*(.+)$/m.exec(raw);
		const yamlTitle = m?.[1]?.trim().replace(/^['"]|['"]$/g, '') ?? '';
		title = yamlTitle || getFmTitle({}, content, fallback);
	}
	let tags: string[] = [];
	if (raw && source.isNote) {
		const m = /^tags:[ \t]*(.+)$/m.exec(raw);
		if (m) {
			const value = m[1]!.trim();
			if (value.startsWith('[') && value.endsWith(']')) {
				tags = getFmTags({
					tags: value
						.slice(1, -1)
						.split(',')
						.map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
						.filter(Boolean)
				});
			} else tags = getFmTags({ tags: value });
		}
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

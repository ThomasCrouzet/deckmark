// §A2.1 / §A2.2 - Metadata index of the file corpus.
//
// Pure class (no Svelte runes): directly testable in Vitest/jsdom.
// The `FilesStore` store instantiates it, passing an accessor `() => FileItem[]`,
// and delegates all reads (tags / backlinks / displayTitle / etc.).
//
// The store supplies loaded files. Parsed metadata and wiki references stay
// cached until invalidation. Candidate buckets do not read storage.
//
// Front-matter fast path (synchronous, no js-yaml):
//   - `title:` single-line scalar (optional quotes)
//   - `tags:` flow sequence `[a, b]` OR single-line CSV `a, b`
// Multiline YAML, nested maps, and complex tags are intentionally out of
// scope here so the sidebar can stay sync on every keystroke. Full YAML
// for display/export goes through async `parseFrontmatter` in frontmatter.ts.
// Parity for the supported subset is covered in `meta-index.test.ts`.

import type { FileItem } from './types';
import { documentKindForFile } from './document-kind';
import { stripMdExtension } from './file-utils';
import { extractWikiLinkTargets } from './wiki-links';
import { getTags as getFmTags, getTitle as getFmTitle, stripFrontmatter } from './frontmatter';
import { WikiLinkIndex } from './wiki-link-index';

/** Per-file cache entry. */
interface MetaEntry {
	name: string;
	isNote: boolean;
	sourceKind: FileItem['kind'];
	/** Content fingerprint: we invalidate if `content !== file.content`. */
	content: string;
	title: string;
	documentTitle: string;
	tags: string[];
	targets: string[];
}

export class MetaIndex {
	private metaCache = new Map<string, MetaEntry>();
	private wikiIndex: WikiLinkIndex | null = null;
	/** Sorted unique tags; rebuilt lazily after a metadata change. */
	private allTagsCache: string[] | null = null;

	/** Reference to the current files state (injected by the store). */
	private getFiles: () => readonly FileItem[];
	constructor(
		getFiles: () => readonly FileItem[],
		private onPublish?: () => void
	) {
		this.getFiles = getFiles;
	}

	// §A2.1 - Reads the cache for `file.id` and revalidates it if `content` changed.
	// All meta reads (title/tags/targets) go through here.
	getMeta(file: FileItem): MetaEntry {
		const cached = this.metaCache.get(file.id);
		if (
			cached &&
			cached.content === file.content &&
			cached.name === file.name &&
			cached.sourceKind === file.kind
		)
			return cached;

		const fallback = stripMdExtension(file.name);
		const isNote = documentKindForFile(file) === 'note';
		const { content, raw } = stripFrontmatter(file.content);

		// Title: YAML > first H1 > filename. We reproduce the logic of the old
		// `displayTitle` but without re-parsing on every call.
		// Horizontal whitespace only after the colon so multiline YAML is ignored
		// (full parse stays on async `parseFrontmatter` / js-yaml).
		let title = fallback;
		if (raw) {
			const m = /^title:[ \t]*(.+)$/m.exec(raw);
			// m[1] is guaranteed if m is non-null (mandatory capture group `.+`),
			// but noUncheckedIndexedAccess requires optional chaining on the slot.
			const yamlTitle = m?.[1]?.trim().replace(/^['"]|['"]$/g, '') ?? '';
			title = yamlTitle || getFmTitle({}, content, fallback);
		}

		// YAML tags - accepts same-line `[a, b]` or CSV `a, b` only.
		let tags: string[] = [];
		if (raw && isNote) {
			const m = /^tags:[ \t]*(.+)$/m.exec(raw);
			if (m) {
				// invariant: m[1] is guaranteed non-undefined (mandatory capture group `.+`).
				const value = m[1]!.trim();
				if (value.startsWith('[') && value.endsWith(']')) {
					tags = getFmTags({
						tags: value
							.slice(1, -1)
							.split(',')
							.map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
							.filter(Boolean)
					});
				} else {
					tags = getFmTags({ tags: value });
				}
			}
		}

		const targets = isNote ? extractWikiLinkTargets(file.content) : [];

		const entry: MetaEntry = {
			name: file.name,
			isNote,
			sourceKind: file.kind,
			content: file.content,
			title,
			documentTitle: raw ? title : getFmTitle({}, content, fallback),
			tags,
			targets
		};
		this.metaCache.set(file.id, entry);
		return entry;
	}

	// §A2.1+A2.2 - Invalidation: called on write (updateContent), rename
	// (which can change the fallback title), close, restore. A single-file change
	// removes that file's old contributions and adds its new contributions. The
	// backlinks index and the tag counts stay usable, so the next read does not
	// rebuild them over the whole library.
	invalidateMeta(id: string): void {
		const file = this.getFiles().find((entry) => entry.id === id);
		const current = file ? this.getMeta(file) : null;
		this.wikiIndex?.updateLocation(id, file, current?.isNote);
		if (!file) this.metaCache.delete(id);
		this.allTagsCache = null;
		this.wikiIndex?.publishTargets(id, current?.targets ?? null);
		this.onPublish?.();
	}

	/** Invalidates the backlinks index and the tag cache (e.g. a bulk change). */
	invalidateBacklinksIndex(): void {
		this.wikiIndex = null;
		this.allTagsCache = null;
		const live = new Set(this.getFiles().map((file) => file.id));
		for (const id of this.metaCache.keys()) if (!live.has(id)) this.metaCache.delete(id);
		this.onPublish?.();
	}

	private wikiLinks(): WikiLinkIndex {
		return (this.wikiIndex ??= new WikiLinkIndex(
			this.getFiles,
			(file) => this.getMeta(file).targets,
			(file) => this.getMeta(file).isNote
		));
	}

	projectBacklinks(targetId: string): FileItem[] {
		return this.wikiLinks().backlinks(targetId);
	}

	/**
	 * Front-matter tags of a file - synchronous parsing via regex.
	 * §A2.1 - O(1) lookup via `metaCache` after the first parse.
	 */
	getTags(id: string): string[] {
		const file = this.getFiles().find((f) => f.id === id);
		if (!file) return [];
		return this.getMeta(file).tags;
	}

	/**
	 * Lists all unique tags present in the corpus, sorted alphabetically.
	 * §A2.1 - `getMeta(file)` caches the parsing per file. The tag counts and the
	 * sorted list are memoized until the next invalidation. A single-file change
	 * updates the counts in place.
	 */
	get allTags(): string[] {
		if (this.allTagsCache) return this.allTagsCache;
		const set = new Set<string>();
		for (const file of this.getFiles()) {
			for (const t of this.getMeta(file).tags) set.add(t);
		}
		this.allTagsCache = [...set].sort((a, b) => a.localeCompare(b));
		return this.allTagsCache;
	}

	/**
	 * Priority title: front-matter `title` > first H1 > filename without extension.
	 * §A2.1 - O(1) lookup via `metaCache`.
	 */
	displayTitle(id: string): string {
		const file = this.getFiles().find((f) => f.id === id);
		if (!file) return '';
		return this.getMeta(file).title;
	}

	documentTitle(id: string): string {
		const file = this.getFiles().find((entry) => entry.id === id);
		return file ? this.getMeta(file).documentTitle : '';
	}

	/**
	 * Backlinks: lists the files that contain a wiki-link pointing to the targeted
	 * file (by name without extension OR by id).
	 *
	 * Project targets use resolved references. Library targets keep raw name/ID matching.
	 */
	backlinks(targetId: string): FileItem[] {
		const wiki = this.wikiLinks();
		const target = wiki.file(targetId);
		if (!target || !wiki.isNote(targetId)) return [];
		return target.projectId ? wiki.backlinks(targetId) : wiki.rawBacklinks(targetId);
	}

	/**
	 * Wiki-link resolution: returns the id of the file that matches `target` by
	 * name (without extension) or by exact id. `null` if not found.
	 *
	 * Case-insensitive on the name (consistent with `backlinks()`).
	 */
	resolveWikiLink(target: string, sourceId?: string): string | null {
		return this.wikiLinks().resolve(target, sourceId);
	}

	wikiLinkCandidates(target: string, sourceId?: string): FileItem[] {
		return this.wikiLinks().candidates(target, sourceId);
	}

	/**
	 * @internal - exposed for tests / the outgoing links UI.
	 * §A2.1 - O(1) lookup via `metaCache`.
	 */
	wikiLinkTargets(id: string): string[] {
		const file = this.getFiles().find((f) => f.id === id);
		if (!file) return [];
		return this.getMeta(file).targets;
	}
}

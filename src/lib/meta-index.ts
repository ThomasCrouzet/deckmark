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

import type { ChangeSet } from '@codemirror/state';
import type { FileItem } from './types';
import { documentKindForFile } from './document-kind';
import { stripMdExtension } from './file-utils';
import { deriveMetadata, type MetadataSource, type MetadataValues } from './metadata-derive';
import type { MetadataRequest, MetadataResponse } from './metadata.worker';
import type { WikiLinkIndex } from './wiki-link-index';
import type { MetadataRunner } from './metadata-runner';
import type { DocumentEdits } from './document-revisions';
import { reportWarning } from './report';

const META_METRICS = import.meta.env.VITE_SOURCE_FIDELITY_METRICS === '1';

/** One accepted edit chain entry, from `base` to `next` document revision. */
interface EditRecord {
	base: number;
	next: number;
	changes: ChangeSet;
}

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
	/** The store loads the module during boot; tests inject the class. */
	private wikiClass: typeof WikiLinkIndex | null;
	/** Sorted unique tags; rebuilt lazily after a metadata change. */
	private allTagsCache: string[] | null = null;
	private tagCounts: Map<string, number> | null = null;
	private pending = new Map<string, number>();
	/** Document revision of the content currently held by `file.content`. */
	private contentRevisions = new Map<string, number>();
	private revision = 0;
	private runner: MetadataRunner | null = null;
	private disposed = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private active: MetadataRequest | null = null;
	/** Accepted edit chains per file, coalesced until the next Worker job. */
	private editChains = new Map<string, EditRecord[]>();

	/** Reference to the current files state (injected by the store). */
	private getFiles: () => readonly FileItem[];
	constructor(
		getFiles: () => readonly FileItem[],
		private onPublish?: (id: string) => void,
		indexClass?: typeof WikiLinkIndex,
		private getActiveFile?: () => string | null
	) {
		this.getFiles = getFiles;
		this.wikiClass = indexClass ?? null;
	}

	// §A2.1 - Reads the cache for `file.id` and revalidates it if `content` changed.
	// All meta reads (title/tags/targets) go through here.
	getMeta(file: FileItem): MetaEntry {
		const cached = this.metaCache.get(file.id);
		if (this.onPublish && this.pending.has(file.id)) return cached ?? this.placeholder(file);
		if (file.contentDeferred && file.derivedMetadata) {
			const durable = file.derivedMetadata;
			const entry: MetaEntry = {
				name: file.name,
				isNote: documentKindForFile(file) === 'note',
				sourceKind: file.kind,
				content: file.content,
				title: durable.title,
				documentTitle: durable.documentTitle,
				tags: durable.tags,
				targets: durable.targets
			};
			this.metaCache.set(file.id, entry);
			return entry;
		}
		if (
			cached &&
			cached.content === file.content &&
			cached.name === file.name &&
			cached.sourceKind === file.kind
		)
			return cached;
		if (cached && this.onPublish) {
			this.invalidateMeta(file.id);
			return cached;
		}
		if (META_METRICS) performance.mark('meta-index-parse');
		const entry = this.entry(file, deriveMetadata(this.source(file)));
		this.publish(file.id, entry);
		return entry;
	}

	private source(file: FileItem): MetadataSource {
		return { name: file.name, content: file.content, isNote: documentKindForFile(file) === 'note' };
	}

	private entry(file: FileItem, values: MetadataValues): MetaEntry {
		const { title, documentTitle, tags, targets } = values;
		return {
			name: file.name,
			isNote: documentKindForFile(file) === 'note',
			sourceKind: file.kind,
			content: file.content,
			title,
			documentTitle,
			tags,
			targets
		};
	}

	private placeholder(file: FileItem): MetaEntry {
		const title = stripMdExtension(file.name);
		return this.entry(file, { title, documentTitle: title, tags: [], targets: [] });
	}

	// §A2.1+A2.2 - Invalidation: called on write (updateContent), rename
	// (which can change the fallback title), close, restore. A single-file change
	// removes that file's old contributions and adds its new contributions. The
	// backlinks index and the tag counts stay usable, so the next read does not
	// rebuild them over the whole library.
	//
	// `documentRevision` is passed only by the document publish path. It keeps
	// the accepted edit chain, which the next job may send as one delta.
	invalidateMeta(id: string, documentRevision?: number): void {
		if (this.disposed) return;
		if (documentRevision !== undefined) {
			this.contentRevisions.set(id, documentRevision);
		} else {
			this.editChains.delete(id);
			this.contentRevisions.delete(id);
		}
		const file = this.getFiles().find((entry) => entry.id === id);
		this.wikiIndex?.updateLocation(id, file, file ? documentKindForFile(file) === 'note' : false);
		if (!file) {
			this.pending.delete(id);
			this.editChains.delete(id);
			this.contentRevisions.delete(id);
			this.publish(id, null);
			this.onPublish?.(id);
		} else if (this.onPublish) {
			this.pending.set(id, ++this.revision);
			this.schedule();
		} else this.getMeta(file);
	}

	/**
	 * Records one accepted editor change. The chain is usable while it stays
	 * contiguous and ends at the published content revision. Only the compact
	 * change set is retained; the editor state is not.
	 */
	recordEdit(id: string, base: number, next: number, edits: DocumentEdits): void {
		if (this.disposed) return;
		const changes = edits.kind === 'codemirror' ? edits.changes : null;
		if (!changes) {
			this.editChains.delete(id);
			return;
		}
		const current = this.editChains.get(id) ?? [];
		current.push({ base, next, changes });
		this.editChains.set(id, current);
	}

	private publish(id: string, current: MetaEntry | null): void {
		const previous = this.metaCache.get(id);
		const same = (a: string[] = [], b: string[] = []) => {
			const set = new Set(a);
			return set.size === b.length && b.every((value) => set.has(value));
		};
		const file = this.getFiles().find((entry) => entry.id === id);
		this.wikiIndex?.updateLocation(id, file, current?.isNote ?? false);
		this.wikiIndex?.publishTargets(id, current?.targets ?? null);
		if (!same(previous?.tags, current?.tags)) {
			if (this.tagCounts) {
				for (const tag of previous?.tags ?? []) {
					const count = this.tagCounts.get(tag)! - 1;
					if (count === 0) {
						this.tagCounts.delete(tag);
						this.allTagsCache = null;
					} else this.tagCounts.set(tag, count);
				}
				for (const tag of current?.tags ?? []) {
					const count = this.tagCounts.get(tag) ?? 0;
					this.tagCounts.set(tag, count + 1);
					if (count === 0) this.allTagsCache = null;
				}
			} else this.allTagsCache = null;
		}
		if (current) this.metaCache.set(id, current);
		else this.metaCache.delete(id);
	}

	private schedule(): void {
		if (this.disposed || this.active || this.timer !== undefined || !this.pending.size) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.runNext();
		}, 0);
	}

	private runNext(): void {
		const active = this.getActiveFile?.() ?? null;
		const next: [string, number] | undefined =
			active && this.pending.has(active)
				? [active, this.pending.get(active)!]
				: this.pending.entries().next().value;
		if (!next || this.disposed) return;
		const [id, revision] = next;
		const file = this.getFiles().find((file) => file.id === id);
		if (!file) {
			this.invalidateMeta(id);
			this.schedule();
			return;
		}
		const documentRevision = this.contentRevisions.get(id);
		const full: Extract<MetadataRequest, { kind: 'full' }> = {
			kind: 'full',
			id,
			revision,
			documentRevision: documentRevision ?? -1,
			source: this.source(file)
		};
		this.active = full;
		void import('./draft-access')
			.then(({ buildRequest, MetadataRunner }) => {
				if (this.disposed) return null;
				const request = buildRequest({
					id,
					revision,
					full,
					documentRevision,
					chain: this.editChains.get(id),
					previous: this.metaCache.get(id),
					source: full.source
				});
				if (this.active) this.active = request;
				this.runner ??= new MetadataRunner();
				return this.runner.run(request);
			})
			.then((response) => {
				if (response) this.finish(response);
			})
			.catch(() => {
				if (this.disposed) return;
				reportWarning('metadata runner unavailable');
				this.editChains.delete(id);
				this.timer = setTimeout(() => {
					this.timer = undefined;
					if (META_METRICS) performance.mark('meta-index-parse');
					this.finish({
						id,
						revision,
						documentRevision: this.contentRevisions.get(id) ?? -1,
						values: deriveMetadata(this.source(file)),
						incremental: false,
						mode: 'fallback',
						workerMs: 0
					});
				}, 0);
			});
	}

	private finish(response: MetadataResponse): void {
		const request = this.active;
		if (
			!request ||
			this.disposed ||
			request.id !== response.id ||
			request.revision !== response.revision
		)
			return;
		this.active = null;
		if (response.mode === 'rejected') {
			// The Worker does not hold the required baseline. Drop the edit chain
			// and send one full snapshot for the still-pending revision.
			this.editChains.delete(response.id);
			this.schedule();
			return;
		}
		if (response.mode === 'fallback') {
			// A synchronous fallback did not enter the Worker baseline cache.
			this.editChains.delete(response.id);
		} else {
			this.trimEdits(response.id, response.documentRevision);
		}
		const file = this.getFiles().find((file) => file.id === request.id);
		if (this.pending.get(request.id) === request.revision) {
			this.pending.delete(request.id);
			if (
				file &&
				response.values &&
				file.name === (request.kind === 'full' ? request.source.name : request.name) &&
				(request.kind === 'full'
					? file.content === request.source.content
					: this.contentRevisions.get(request.id) === response.documentRevision)
			) {
				this.publish(file.id, this.entry(file, response.values));
				if (META_METRICS)
					performance.mark(
						response.incremental ? 'meta-index-worker-reuse' : 'meta-index-worker-full'
					);
				this.onPublish?.(file.id);
			} else if (!this.pending.has(request.id)) this.invalidateMeta(request.id);
		}
		this.schedule();
	}

	private trimEdits(id: string, documentRevision: number): void {
		const chain = this.editChains.get(id);
		if (!chain) return;
		const remaining = chain.filter((record) => record.next > documentRevision);
		if (remaining.length) this.editChains.set(id, remaining);
		else this.editChains.delete(id);
	}

	dispose(): void {
		this.disposed = true;
		clearTimeout(this.timer);
		this.runner?.dispose();
		this.runner = null;
		this.active = null;
		this.pending.clear();
		this.contentRevisions.clear();
		this.metaCache.clear();
		this.editChains.clear();
		this.wikiIndex = null;
		this.tagCounts = null;
		this.allTagsCache = null;
	}

	/** Invalidates the backlinks index and the tag cache (e.g. a bulk change). */
	invalidateBacklinksIndex(): void {
		this.wikiIndex = null;
		this.allTagsCache = null;
		this.tagCounts = null;
		const ids = new Set(this.getFiles().map((file) => file.id));
		for (const id of this.metaCache.keys()) if (!ids.has(id)) this.metaCache.delete(id);
		for (const id of this.pending.keys()) if (!ids.has(id)) this.pending.delete(id);
		for (const id of this.contentRevisions.keys())
			if (!ids.has(id)) this.contentRevisions.delete(id);
		for (const id of this.editChains.keys()) if (!ids.has(id)) this.editChains.delete(id);
	}

	/**
	 * Loads the index module as a separate chunk during the store load. The boot
	 * bundle keeps only this loader. A test can inject the class in the constructor.
	 */
	async load(): Promise<void> {
		if (this.wikiClass) return;
		const { WikiLinkIndex: Index } = await import('./wiki-link-index');
		this.wikiClass = Index;
	}

	private createWikiIndex(Index: typeof WikiLinkIndex): WikiLinkIndex {
		return new Index(
			this.getFiles,
			(file) => this.getMeta(file).targets,
			(file) => this.getMeta(file).isNote
		);
	}

	private wikiLinks(): WikiLinkIndex {
		const loaded = this.wikiIndex;
		if (loaded) return loaded;
		const Index = this.wikiClass;
		if (!Index) throw new Error('Wiki link index is not loaded');
		return (this.wikiIndex = this.createWikiIndex(Index));
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
		if (!this.tagCounts) {
			const counts = new Map<string, number>();
			for (const file of this.getFiles()) {
				for (const tag of this.getMeta(file).tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
			}
			this.tagCounts = counts;
		}
		this.allTagsCache = [...this.tagCounts.keys()].sort((a, b) => a.localeCompare(b));
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

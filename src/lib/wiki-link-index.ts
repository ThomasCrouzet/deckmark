import { documentKindForFile } from './document-kind';
import { stripMdExtension } from './file-names';
import { pathKey, resolveProjectPath } from './project-paths';
import type { FileItem } from './types';

const METRICS = import.meta.env.VITE_SOURCE_FIDELITY_METRICS === '1';
const SEP = '\u0001';

/** Project path candidates in the exact priority order of projectWikiCandidates. */
function projectWikiPathKeys(from: string, value: string): string[] {
	const keys: string[] = [];
	const names = /\.(?:md|markdown|mdx|txt)$/i.test(value) ? [value] : [value, `${value}.md`];
	for (const name of names) {
		const encodedName = name
			.split('/')
			.map((part) => {
				try {
					const decoded = decodeURIComponent(part);
					return encodeURIComponent(
						decoded.includes('/') || decoded.includes('\\') ? part : decoded
					);
				} catch {
					return encodeURIComponent(part);
				}
			})
			.join('/');
		const relative = resolveProjectPath(from, encodedName);
		if (relative) keys.push(pathKey(relative));
		try {
			keys.push(pathKey(name));
		} catch {
			/* A relative parent path has no root-relative candidate. */
		}
	}
	return keys;
}

interface Entry {
	file: FileItem;
	project: string | undefined;
	path: string | undefined;
	note: boolean;
	keys: string[];
}

interface Refs {
	queries: string[][];
	deps: Set<string>;
	dests: Set<string>;
}

function key(scope: string, kind: string, value: string): string {
	return `${scope}${SEP}${kind}${SEP}${value}`;
}

/** Candidate keys in the exact priority order of projectWikiCandidates. */
function query(source: Entry | undefined, target: string): string[] {
	if (source && !source.note) return [];
	if (!source?.project) {
		const value = target.trim();
		return value ? [key('', 'id', value), key('', 'name', value.toLowerCase())] : [];
	}
	const project = source.project;
	const value = target.trim().split('#', 1)[0]!;
	if (!value || !source.path) return [];
	const keys = [key(project, 'id', value)];
	for (const path of projectWikiPathKeys(source.path, value)) keys.push(key(project, 'path', path));
	if (!value.includes('/'))
		keys.push(key(project, 'stem', value.replace(/\.(md|markdown|mdx|txt)$/i, '').toLowerCase()));
	return [...new Set(keys)];
}

function entry(file: FileItem, note: boolean): Entry {
	const project = file.projectId;
	const path = file.relativePath;
	const keys: string[] = [];
	if (note) {
		keys.push(key('', 'id', file.id), key('', 'name', stripMdExtension(file.name).toLowerCase()));
		if (project && path) {
			keys.push(
				key(project, 'id', file.id),
				key(project, 'path', pathKey(path)),
				key(
					project,
					'stem',
					path
						.split('/')
						.pop()!
						.replace(/\.(md|markdown|mdx|txt)$/i, '')
						.toLowerCase()
				)
			);
		}
	}
	return { file, project, path, note, keys };
}

function add(map: Map<string, Set<string>>, id: string, key: string): void {
	let set = map.get(key);
	if (!set) map.set(key, (set = new Set()));
	set.add(id);
}

/** Drops an empty bucket so deleted or renamed keys do not accumulate. */
function drop(map: Map<string, Set<string>>, id: string, key: string): void {
	const set = map.get(key);
	if (set?.delete(id) && !set.size) map.delete(key);
}

/** Indexes loaded metadata only. Missing candidates stay as dependencies. */
export class WikiLinkIndex {
	private entries = new Map<string, Entry>();
	private buckets = new Map<string, Set<string>>();
	private deps = new Map<string, Set<string>>();
	private refs = new Map<string, Refs>();
	private published = new Map<string, readonly string[]>();
	private incoming = new Map<string, Set<string>>();
	private cache = new Map<string, FileItem[]>();
	private cacheVersion = -1;
	private version = 0;
	private ready = false;
	private orderSource: readonly FileItem[] | null = null;
	private ranks = new Map<string, number>();

	constructor(
		private getFiles: () => readonly FileItem[],
		private getTargets: (file: FileItem) => readonly string[],
		isNote: (file: FileItem) => boolean = (file) => documentKindForFile(file) === 'note'
	) {
		if (METRICS) {
			performance.mark('project-wiki-index-rebuild');
			performance.mark('meta-index-rebuild');
		}
		for (const file of getFiles()) {
			const item = entry(file, isNote(file));
			this.entries.set(file.id, item);
			for (const key of item.keys) add(this.buckets, file.id, key);
		}
	}

	private match(keys: readonly string[]): Set<string> | undefined {
		for (const key of keys) {
			const ids = this.buckets.get(key);
			if (ids?.size) return ids;
		}
		return undefined;
	}

	/** Sorted by library order. A replaced array refreshes retained ranks. */
	private sorted(ids: Iterable<string>): FileItem[] {
		const files = this.getFiles();
		if (files !== this.orderSource) {
			this.orderSource = files;
			this.ranks.clear();
			files.forEach((file, index) => this.ranks.set(file.id, index));
		}
		const rank = (id: string) => this.ranks.get(id) ?? Number.MAX_SAFE_INTEGER;
		return [...ids].sort((a, b) => rank(a) - rank(b)).map((id) => this.entries.get(id)!.file);
	}

	candidates(target: string, sourceId?: string): FileItem[] {
		return this.sorted(this.match(query(this.entries.get(sourceId ?? ''), target)) ?? []);
	}

	resolve(target: string, sourceId?: string): string | null {
		const ids = this.match(query(this.entries.get(sourceId ?? ''), target));
		return ids?.size === 1 ? ids.values().next().value! : null;
	}

	file(id: string): FileItem | undefined {
		return this.entries.get(id)?.file;
	}

	isNote(id: string): boolean {
		return this.entries.get(id)?.note ?? false;
	}

	private detach(id: string): void {
		const refs = this.refs.get(id);
		if (!refs) return;
		for (const key of refs.deps) drop(this.deps, id, key);
		for (const dest of refs.dests) drop(this.incoming, id, dest);
		this.refs.delete(id);
	}

	private destinations(id: string, refs: Refs): void {
		for (const dest of refs.dests) drop(this.incoming, id, dest);
		refs.dests.clear();
		for (const keys of refs.queries) {
			const ids = this.match(keys);
			if (ids?.size === 1) refs.dests.add(ids.values().next().value!);
		}
		for (const dest of refs.dests) add(this.incoming, id, dest);
	}

	private attach(item: Entry, targets: readonly string[]): void {
		this.detach(item.file.id);
		if (!item.note) return;
		const queries = targets.map((target) => query(item, target));
		const refs: Refs = { queries, deps: new Set(queries.flat()), dests: new Set() };
		for (const target of targets) {
			refs.deps.add(key('', 'raw', target.toLowerCase()));
			refs.deps.add(key('', 'exact', target));
		}
		this.refs.set(item.file.id, refs);
		for (const key of refs.deps) add(this.deps, item.file.id, key);
		this.destinations(item.file.id, refs);
	}

	/** Location, type, project, membership, and cross-tab changes. Never reads content. */
	updateLocation(id: string, file: FileItem | undefined, isNote?: boolean): void {
		const before = this.entries.get(id);
		const note = file
			? (isNote ??
				(file.kind
					? file.kind === 'note'
					: documentKindForFile({ name: file.name }) === 'note' && (before?.note ?? true)))
			: false;
		const after = file ? entry(file, note) : undefined;
		const oldKeys = new Set(before?.keys);
		const newKeys = new Set(after?.keys);
		const changed = [...oldKeys]
			.filter((key) => !newKeys.has(key))
			.concat([...newKeys].filter((key) => !oldKeys.has(key)));
		const affected = new Set<string>();
		for (const key of changed) for (const source of this.deps.get(key) ?? []) affected.add(source);
		this.detach(id);
		for (const key of before?.keys ?? []) drop(this.buckets, id, key);
		this.version += 1;
		if (after) {
			this.entries.set(id, after);
			for (const key of after.keys) add(this.buckets, id, key);
		} else {
			this.entries.delete(id);
			this.published.delete(id);
		}
		const targets = this.published.get(id);
		if (this.ready && after && targets) this.attach(after, targets);
		for (const source of affected) {
			if (source === id) continue;
			const refs = this.refs.get(source);
			if (refs) this.destinations(source, refs);
		}
	}

	/** Replaces one source's complete targets. Null removes its snapshot. */
	publishTargets(id: string, targets: readonly string[] | null): void {
		const item = this.entries.get(id);
		this.version += 1;
		if (!item) return;
		if (targets === null) {
			this.published.delete(id);
			this.detach(id);
			return;
		}
		const complete = [...targets];
		this.published.set(id, complete);
		if (this.ready) this.attach(item, complete);
	}

	private references(): void {
		if (this.ready) return;
		this.ready = true;
		for (const item of this.entries.values()) {
			if (!item.note) continue;
			this.published.set(
				item.file.id,
				this.published.get(item.file.id) ?? this.getTargets(item.file)
			);
			this.attach(item, this.published.get(item.file.id)!);
		}
	}

	private results(id: string): FileItem[] {
		if (this.getFiles() !== this.orderSource) this.cache.clear();
		if (this.cacheVersion !== this.version) {
			this.cache.clear();
			this.cacheVersion = this.version;
		}
		let result = this.cache.get(id);
		if (!result) {
			result = this.sorted([...(this.incoming.get(id) ?? [])].filter((source) => source !== id));
			this.cache.set(id, result);
		}
		return result;
	}

	rawBacklinks(targetId: string): FileItem[] {
		this.references();
		const target = this.entries.get(targetId);
		if (!target?.note) return [];
		const ids = new Set(
			this.deps.get(key('', 'raw', stripMdExtension(target.file.name).toLowerCase()))
		);
		for (const id of this.deps.get(key('', 'exact', targetId)) ?? []) ids.add(id);
		ids.delete(targetId);
		return this.sorted(ids);
	}

	backlinks(targetId: string): FileItem[] {
		if (!this.entries.get(targetId)?.note) return [];
		this.references();
		return this.results(targetId);
	}
}

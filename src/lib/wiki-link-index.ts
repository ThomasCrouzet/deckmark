import { documentKindForFile } from './document-kind';
import { stripMdExtension } from './file-names';
import { pathKey, resolveProjectPath } from './project-paths';
import type { FileItem } from './types';

const METRICS = import.meta.env.VITE_SOURCE_FIDELITY_METRICS === '1';

interface Entry {
	file: FileItem;
	projectId: string | undefined;
	path: string | undefined;
	note: boolean;
	keys: string[];
}

interface References {
	queries: string[][];
	dependencies: Set<string>;
	destinations: Set<string>;
}

function key(project: string, kind: string, value: string): string {
	return JSON.stringify([project, kind, value]);
}

function query(source: Entry | undefined, target: string): string[] {
	if (source && !source.note) return [];
	if (!source?.projectId) {
		const value = target.trim();
		return value ? [key('', 'id', value), key('', 'name', value.toLowerCase())] : [];
	}
	const project = source.projectId;
	const value = target.trim().split('#', 1)[0]!;
	if (!value || !source.path) return [];
	const keys = [key(project, 'id', value)];
	const names = /\.(?:md|markdown|mdx|txt)$/i.test(value) ? [value] : [value, `${value}.md`];
	for (const name of names) {
		const encoded = name
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
		const relative = resolveProjectPath(source.path, encoded);
		if (relative) keys.push(key(project, 'path', pathKey(relative)));
		try {
			keys.push(key(project, 'path', pathKey(name)));
		} catch {
			// Parent paths have no root-relative candidate.
		}
	}
	if (!value.includes('/'))
		keys.push(key(project, 'stem', value.replace(/\.(md|markdown|mdx|txt)$/i, '').toLowerCase()));
	return [...new Set(keys)];
}

function snapshot(file: FileItem, note: boolean): Entry {
	const projectId = file.projectId;
	const path = file.relativePath;
	const keys: string[] = [];
	if (note) {
		keys.push(key('', 'id', file.id), key('', 'name', stripMdExtension(file.name).toLowerCase()));
		if (projectId && path)
			keys.push(
				key(projectId, 'id', file.id),
				key(projectId, 'path', pathKey(path)),
				key(
					projectId,
					'stem',
					path
						.split('/')
						.pop()!
						.replace(/\.(md|markdown|mdx|txt)$/i, '')
						.toLowerCase()
				)
			);
	}
	return { file, projectId, path, note, keys };
}

function add(map: Map<string, Set<string>>, key: string, id: string): void {
	let ids = map.get(key);
	if (!ids) {
		ids = new Set();
		map.set(key, ids);
	}
	ids.add(id);
}

function remove(map: Map<string, Set<string>>, key: string, id: string): void {
	const ids = map.get(key);
	if (ids?.delete(id) && !ids.size) map.delete(key);
}

/** Index only loaded metadata. Dependencies include currently missing candidates. */
export class WikiLinkIndex {
	private entries = new Map<string, Entry>();
	private buckets = new Map<string, Set<string>>();
	private dependents = new Map<string, Set<string>>();
	private references = new Map<string, References>();
	private published = new Map<string, readonly string[]>();
	private incoming = new Map<string, Set<string>>();
	private cached = new Map<string, { version: number; files: FileItem[] }>();
	private versions = new Map<string, number>();
	private referencesReady = false;
	private orderSource: readonly FileItem[] | null = null;
	private orderLength = -1;
	private ranks = new Map<string, number>();

	constructor(
		private getFiles: () => readonly FileItem[],
		private getTargets: (file: FileItem) => readonly string[],
		isNoteFile: (file: FileItem) => boolean = (file) => documentKindForFile(file) === 'note'
	) {
		if (METRICS) performance.mark('project-wiki-index-rebuild');
		for (const file of getFiles()) {
			const entry = snapshot(file, isNoteFile(file));
			this.entries.set(file.id, entry);
			for (const key of entry.keys) add(this.buckets, key, file.id);
		}
	}

	private match(keys: readonly string[]): Set<string> | undefined {
		for (const key of keys) {
			const ids = this.buckets.get(key);
			if (ids?.size) return ids;
		}
		return undefined;
	}

	private order(): void {
		const files = this.getFiles();
		if (files === this.orderSource && files.length === this.orderLength) return;
		this.orderSource = files;
		this.orderLength = files.length;
		this.ranks.clear();
		files.forEach((file, index) => this.ranks.set(file.id, index));
		this.cached.clear();
	}

	private sorted(ids: Iterable<string>): FileItem[] {
		this.order();
		return [...ids]
			.sort((a, b) => this.ranks.get(a)! - this.ranks.get(b)!)
			.map((id) => this.entries.get(id)!.file);
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

	private dropReferences(id: string): void {
		const previous = this.references.get(id);
		if (!previous) return;
		for (const key of previous.dependencies) remove(this.dependents, key, id);
		for (const target of previous.destinations) {
			remove(this.incoming, target, id);
			this.touch(target);
		}
		this.references.delete(id);
	}

	private touch(id: string): void {
		this.cached.delete(id);
		if (this.entries.has(id)) this.versions.set(id, (this.versions.get(id) ?? 0) + 1);
		else this.versions.delete(id);
	}

	private resolveReferences(id: string, refs: References): void {
		for (const target of refs.destinations) {
			remove(this.incoming, target, id);
			this.touch(target);
		}
		refs.destinations.clear();
		for (const keys of refs.queries) {
			const ids = this.match(keys);
			if (ids?.size === 1) refs.destinations.add(ids.values().next().value!);
		}
		for (const target of refs.destinations) {
			add(this.incoming, target, id);
			this.touch(target);
		}
	}

	private addReferences(entry: Entry, targets: readonly string[]): void {
		this.dropReferences(entry.file.id);
		if (!entry.note) return;
		const queries = targets.map((target) => query(entry, target));
		const refs: References = {
			queries,
			dependencies: new Set(queries.flat()),
			destinations: new Set()
		};
		this.references.set(entry.file.id, refs);
		for (const key of refs.dependencies) add(this.dependents, key, entry.file.id);
		this.resolveReferences(entry.file.id, refs);
	}

	updateLocation(id: string, file: FileItem | undefined, isNote?: boolean): void {
		const before = this.entries.get(id);
		// Pending content keeps its last complete classification unless the producer supplies one.
		const eligible = file
			? (isNote ??
				(file.kind
					? file.kind === 'note'
					: documentKindForFile({ name: file.name }) === 'note' && (before?.note ?? true)))
			: false;
		const after = file ? snapshot(file, eligible) : undefined;
		const oldKeys = new Set(before?.keys);
		const newKeys = new Set(after?.keys);
		const changed = [...oldKeys]
			.filter((key) => !newKeys.has(key))
			.concat([...newKeys].filter((key) => !oldKeys.has(key)));
		const affected = new Set<string>();
		for (const key of changed)
			for (const source of this.dependents.get(key) ?? []) affected.add(source);
		this.dropReferences(id);
		for (const key of before?.keys ?? []) remove(this.buckets, key, id);
		if (after) {
			this.entries.set(id, after);
			for (const key of after.keys) add(this.buckets, key, id);
		} else {
			this.entries.delete(id);
			this.cached.delete(id);
			this.versions.delete(id);
			this.published.delete(id);
		}
		const targets = this.published.get(id);
		if (this.referencesReady && after && targets) this.addReferences(after, targets);
		for (const source of affected) {
			if (source === id) continue;
			const refs = this.references.get(source);
			if (refs) this.resolveReferences(source, refs);
		}
	}

	publishTargets(id: string, targets: readonly string[] | null): void {
		const entry = this.entries.get(id);
		if (!entry) return;
		if (targets === null) {
			this.published.delete(id);
			this.dropReferences(id);
			return;
		}
		const complete = [...targets];
		this.published.set(id, complete);
		if (this.referencesReady) this.addReferences(entry, complete);
	}

	backlinks(targetId: string): FileItem[] {
		if (!this.entries.get(targetId)?.note) return [];
		if (!this.referencesReady) {
			this.referencesReady = true;
			for (const entry of this.entries.values()) {
				if (entry.note)
					this.publishTargets(
						entry.file.id,
						this.published.get(entry.file.id) ?? this.getTargets(entry.file)
					);
			}
		}
		this.order();
		const version = this.versions.get(targetId) ?? 0;
		let cached = this.cached.get(targetId);
		if (!cached || cached.version !== version) {
			cached = {
				version,
				files: this.sorted([...(this.incoming.get(targetId) ?? [])].filter((id) => id !== targetId))
			};
			this.cached.set(targetId, cached);
		}
		return cached.files;
	}
}

import { parseFrontmatter } from './frontmatter';
import { documentKindForFile } from './document-kind';
import type { FileItem } from './types';

export type CollectionValue = string | number | boolean | string[];

export interface CollectionRow {
	id: string;
	name: string;
	title: string;
	projectId?: string;
	relativePath?: string;
	updatedAt: number;
	values: Record<string, CollectionValue>;
	/** Lower-case corpus for the filter field. Built once per parsed document. */
	searchText: string;
}

export interface CollectionView {
	id: string;
	name: string;
	filter: string;
	sortKey: string;
	sortDirection: 'asc' | 'desc';
	groupKey: string;
	mode: 'table' | 'board';
}

export interface CollectionBuildStats {
	/** Notes whose front matter was parsed in this build. */
	parsed: number;
	/** Notes whose cached or durable projection was reused. */
	reused: number;
	/** Deferred bodies read from IndexedDB in this build. */
	bodyReads: number;
	batches: number;
}

export interface CollectionBuildOptions {
	signal?: AbortSignal;
	/** Receives the count of processed notes after each bounded batch. */
	onProgress?: (done: number, total: number) => void;
	/** Reports the work done by this build. */
	onStats?: (stats: CollectionBuildStats) => void;
	/** Number of notes processed before the build yields to the page. Defaults to 24. */
	batchSize?: number;
	/** Reads exact bodies for deferred files. Defaults to the draft-access reader. */
	readBodies?: (files: readonly FileItem[]) => Promise<ReadonlyMap<string, string>>;
	/** Set to false for callers that do not need the durable projection. */
	persist?: boolean;
}

const STORAGE_KEY = 'mdsh:collection-views';
const PROJECTION_PREFIX = 'collection-row:';
const PROJECTION_VERSION = 1;
const DEFAULT_BATCH_SIZE = 24;
const PROJECTION_WRITE_BATCH = 200;

interface CachedCollectionRow {
	/** Exact source for a resident body. Undefined for a deferred projection. */
	source?: string | undefined;
	name: string;
	revision: string;
	title: string;
	values: Record<string, CollectionValue>;
	searchText: string;
}

interface StoredCollectionRow {
	v: number;
	revision: string;
	title: string;
	values: Record<string, CollectionValue>;
}

const parsedRows = new Map<string, CachedCollectionRow>();

/** Drops every cached projection. Used by tests and by a full storage reset. */
export function clearCollectionCache(): void {
	parsedRows.clear();
}

function scalar(value: unknown): CollectionValue | null {
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
		return value;
	if (Array.isArray(value)) return value.map((item) => String(item));
	if (value instanceof Date) return value.toISOString().slice(0, 10);
	return null;
}

function valuesOf(data: Record<string, unknown>): Record<string, CollectionValue> {
	const values: Record<string, CollectionValue> = {};
	for (const [key, raw] of Object.entries(data)) {
		const value = scalar(raw);
		if (value !== null) values[key] = value;
	}
	return values;
}

function searchTextOf(
	name: string,
	title: string,
	relativePath: string | undefined,
	values: Record<string, CollectionValue>
): string {
	const parts = [title, name, relativePath ?? ''];
	for (const value of Object.values(values))
		parts.push(Array.isArray(value) ? value.join(' ') : String(value));
	return parts.join(' ').toLowerCase();
}

function fallbackTitle(file: FileItem): string {
	return file.name.replace(/\.[^.]+$/, '');
}

/**
 * FNV-1a base36, with the same result as the durable draft metadata encoder.
 * It is an indexing hint only. A resident body is compared by exact source.
 */
function contentHash(content: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < content.length; index++) {
		hash ^= content.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(36);
}

/** Identity of one source revision: name, durable time, length and hash. */
function revisionOf(file: FileItem, content: string): string {
	return `${file.name}\u0000${file.updatedAt}\u0000${content.length}\u0000${contentHash(content)}`;
}

/**
 * Identity that the durable draft row reports for a deferred body. The row
 * keeps the same name, update time, length and hash. A mismatch reads the body.
 */
function durableRevision(file: FileItem): string | null {
	const meta = file.derivedMetadata;
	if (!meta) return null;
	return `${file.name}\u0000${file.updatedAt}\u0000${meta.contentLength}\u0000${meta.contentHash}`;
}

function projectionKey(id: string): string {
	return `${PROJECTION_PREFIX}${id}`;
}

async function loadStoredRows(ids: readonly string[]): Promise<Map<string, StoredCollectionRow>> {
	const stored = new Map<string, StoredCollectionRow>();
	if (ids.length === 0) return stored;
	try {
		const { db } = await import('./db');
		for (let offset = 0; offset < ids.length; offset += PROJECTION_WRITE_BATCH) {
			const batch = ids.slice(offset, offset + PROJECTION_WRITE_BATCH);
			const rows = await db.metadata.bulkGet(batch.map(projectionKey));
			for (let index = 0; index < batch.length; index++) {
				const row = rows[index];
				if (!row) continue;
				try {
					const parsed = JSON.parse(row.value) as Partial<StoredCollectionRow>;
					if (
						parsed.v !== PROJECTION_VERSION ||
						typeof parsed.revision !== 'string' ||
						typeof parsed.title !== 'string' ||
						!parsed.values ||
						typeof parsed.values !== 'object'
					)
						continue;
					stored.set(batch[index]!, {
						v: PROJECTION_VERSION,
						revision: parsed.revision,
						title: parsed.title,
						values: parsed.values as Record<string, CollectionValue>
					});
				} catch {
					// A damaged projection is a cache miss, not a load failure.
				}
			}
		}
	} catch {
		// Storage can be unavailable. The caller then parses the exact bodies.
	}
	return stored;
}

async function saveStoredRows(
	rows: ReadonlyMap<string, StoredCollectionRow>,
	live: ReadonlySet<string>
): Promise<void> {
	if (rows.size === 0) return;
	try {
		const { db } = await import('./db');
		const values = [...rows].map(([id, row]) => ({
			key: projectionKey(id),
			value: JSON.stringify(row)
		}));
		for (let index = 0; index < values.length; index += PROJECTION_WRITE_BATCH)
			await db.metadata.bulkPut(values.slice(index, index + PROJECTION_WRITE_BATCH));
		const keys = await db.metadata.where('key').startsWith(PROJECTION_PREFIX).primaryKeys();
		const stale = keys.filter((key) => !live.has(String(key).slice(PROJECTION_PREFIX.length)));
		if (stale.length > 0) await db.metadata.bulkDelete(stale);
	} catch {
		// The durable projection is an optimisation. The rows stay correct.
	}
}

async function defaultReadBodies(files: readonly FileItem[]): Promise<ReadonlyMap<string, string>> {
	const { buildSearchCorpus } = await import('./draft-access');
	const entries = await buildSearchCorpus(files);
	return new Map(entries.map((entry) => [entry.id, entry.content]));
}

function abortError(): Error {
	return typeof DOMException === 'function'
		? new DOMException('Collection load aborted', 'AbortError')
		: new Error('Collection load aborted');
}

/** True when a rejected promise carries the cancellation reason. */
export function isCollectionAbort(error: unknown): boolean {
	return error instanceof Error && error.name === 'AbortError';
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw abortError();
}

function yieldToPage(): Promise<void> {
	return new Promise((resolve) => {
		if (typeof setTimeout === 'function') setTimeout(resolve, 0);
		else resolve();
	});
}

/** Reads front matter into a table-friendly shape. Image and code files are skipped. */
export async function buildCollection(
	files: readonly FileItem[],
	options: CollectionBuildOptions = {}
): Promise<CollectionRow[]> {
	const notes = files.filter((file) => documentKindForFile(file) === 'note');
	const live = new Set(notes.map((file) => file.id));
	const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
	const signal = options.signal;
	const stats: CollectionBuildStats = { parsed: 0, reused: 0, bodyReads: 0, batches: 0 };
	const writes = new Map<string, StoredCollectionRow>();

	const deferred = notes.filter((file) => file.contentDeferred);
	throwIfAborted(signal);
	const stored =
		options.persist === false ? new Map() : await loadStoredRows(deferred.map((file) => file.id));
	throwIfAborted(signal);
	for (const file of deferred) {
		const revision = durableRevision(file);
		const projection = stored.get(file.id);
		if (!revision || projection?.revision !== revision) continue;
		parsedRows.set(file.id, {
			name: file.name,
			revision,
			title: projection.title,
			values: projection.values,
			searchText: searchTextOf(file.name, projection.title, file.relativePath, projection.values)
		});
	}

	const rows: CollectionRow[] = [];
	for (let offset = 0; offset < notes.length; offset += batchSize) {
		throwIfAborted(signal);
		const batch = notes.slice(offset, offset + batchSize);
		const missing: FileItem[] = [];
		for (const file of batch) {
			if (!file.contentDeferred) continue;
			const cached = parsedRows.get(file.id);
			const revision = durableRevision(file);
			if (cached && revision && cached.revision === revision) continue;
			missing.push(file);
		}
		let bodies: ReadonlyMap<string, string> = new Map();
		if (missing.length > 0) {
			bodies = await (options.readBodies ?? defaultReadBodies)(missing);
			throwIfAborted(signal);
			stats.bodyReads += missing.length;
		}
		for (const file of batch) {
			const content = file.contentDeferred ? bodies.get(file.id) : file.content;
			const cached = parsedRows.get(file.id);
			let entry: CachedCollectionRow;
			let changed = false;
			if (content === undefined) {
				// A durable projection supplied every displayed value.
				if (!cached) continue;
				entry = cached;
				stats.reused += 1;
			} else if (cached && cached.name === file.name && cached.source === content) {
				entry = cached;
				stats.reused += 1;
			} else {
				const parsed = await parseFrontmatter(content);
				throwIfAborted(signal);
				const values = valuesOf(parsed.data);
				const title =
					typeof parsed.data.title === 'string' && parsed.data.title.trim()
						? parsed.data.title.trim()
						: fallbackTitle(file);
				entry = {
					...(file.contentDeferred ? {} : { source: content }),
					name: file.name,
					revision: revisionOf(file, content),
					title,
					values,
					searchText: searchTextOf(file.name, title, file.relativePath, values)
				};
				parsedRows.set(file.id, entry);
				stats.parsed += 1;
				changed = true;
			}
			const revision = durableRevision(file) ?? revisionOf(file, content ?? '');
			if (entry.revision !== revision || entry.name !== file.name) {
				entry = {
					...entry,
					name: file.name,
					revision,
					searchText: searchTextOf(file.name, entry.title, file.relativePath, entry.values)
				};
				parsedRows.set(file.id, entry);
				changed = true;
			}
			if (changed && options.persist !== false) {
				const written = writes.get(file.id);
				const storedRow = {
					v: PROJECTION_VERSION,
					revision: entry.revision,
					title: entry.title,
					values: entry.values
				};
				if (
					!written ||
					written.revision !== storedRow.revision ||
					written.title !== storedRow.title
				)
					writes.set(file.id, storedRow);
			}
			rows.push({
				id: file.id,
				name: file.name,
				title: entry.title,
				...(file.projectId ? { projectId: file.projectId } : {}),
				...(file.relativePath ? { relativePath: file.relativePath } : {}),
				updatedAt: file.updatedAt,
				values: entry.values,
				searchText: entry.searchText
			});
		}
		stats.batches += 1;
		options.onProgress?.(Math.min(offset + batch.length, notes.length), notes.length);
		if (offset + batch.length < notes.length) await yieldToPage();
	}

	for (const id of [...parsedRows.keys()]) if (!live.has(id)) parsedRows.delete(id);
	throwIfAborted(signal);
	if (options.persist !== false) await saveStoredRows(writes, live);
	options.onStats?.(stats);
	return rows;
}

export function collectionColumns(rows: readonly CollectionRow[]): string[] {
	const keys = new Set<string>();
	for (const row of rows) for (const key of Object.keys(row.values)) keys.add(key);
	return [...keys].sort((a, b) => a.localeCompare(b));
}

function comparable(value: CollectionValue | undefined): string | number {
	if (value === undefined) return '';
	if (Array.isArray(value)) return value.join(', ').toLowerCase();
	if (typeof value === 'number') return value;
	if (typeof value === 'boolean') return value ? 0 : 1;
	return value.toLowerCase();
}

const sortCaches = new WeakMap<CollectionRow, Map<string, string | number>>();

function sortValue(row: CollectionRow, key: string): string | number {
	if (key === 'title') return row.title.toLowerCase();
	if (key === 'updatedAt') return row.updatedAt;
	let cache = sortCaches.get(row);
	if (!cache) {
		cache = new Map();
		sortCaches.set(row, cache);
	}
	const cached = cache.get(key);
	if (cached !== undefined) return cached;
	const value = comparable(row.values[key]);
	cache.set(key, value);
	return value;
}

export function filterRows(rows: readonly CollectionRow[], query: string): CollectionRow[] {
	const value = query.trim().toLowerCase();
	if (!value) return [...rows];
	return rows.filter((row) => row.searchText.includes(value));
}

export function sortRows(
	rows: readonly CollectionRow[],
	key: string,
	direction: 'asc' | 'desc'
): CollectionRow[] {
	const factor = direction === 'asc' ? 1 : -1;
	return [...rows].sort((a, b) => {
		const left = sortValue(a, key);
		const right = sortValue(b, key);
		if (left < right) return -1 * factor;
		if (left > right) return factor;
		return a.title.localeCompare(b.title);
	});
}

export function groupRows(
	rows: readonly CollectionRow[],
	key: string
): Array<{ key: string; rows: CollectionRow[] }> {
	if (!key) return [{ key: '', rows: [...rows] }];
	const groups = new Map<string, CollectionRow[]>();
	for (const row of rows) {
		const raw = key === 'title' ? row.title : row.values[key];
		const value = Array.isArray(raw) ? raw.join(', ') : raw === undefined ? '' : String(raw);
		const label = value.trim() || 'None';
		const list = groups.get(label) ?? [];
		list.push(row);
		groups.set(label, list);
	}
	return [...groups.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([group, list]) => ({ key: group, rows: list }));
}

export function readCollectionViews(): CollectionView[] {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return [];
		const values = JSON.parse(raw) as unknown;
		return Array.isArray(values)
			? values.filter((value): value is CollectionView => {
					if (!value || typeof value !== 'object') return false;
					const view = value as Partial<CollectionView>;
					return (
						typeof view.id === 'string' &&
						typeof view.name === 'string' &&
						typeof view.filter === 'string' &&
						typeof view.sortKey === 'string' &&
						(view.sortDirection === 'asc' || view.sortDirection === 'desc') &&
						typeof view.groupKey === 'string' &&
						(view.mode === 'table' || view.mode === 'board')
					);
				})
			: [];
	} catch {
		return [];
	}
}

export function saveCollectionViews(views: readonly CollectionView[]): void {
	localStorage.setItem(STORAGE_KEY, JSON.stringify(views));
}

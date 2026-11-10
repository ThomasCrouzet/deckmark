import { db, type DraftRow } from './db';
import { pathKey, resolveProjectPath } from './project-paths';
import { embedImageBlob, MAX_MEDIA_TOTAL_BYTES } from './render/image-media';
import { abortable, checkAborted } from './abort';
import { decodeDraftManifest } from './draft-manifest';
import { DRAFT_MANIFEST_VERSION } from './draft-manifest-key';

/** A sanitized image cache key includes this policy version. */
const IMAGE_CACHE_VERSION = 1;
const IMAGE_CACHE_BYTES = 8 * 1024 * 1024;
const IMAGE_CACHE_ENTRIES = 128;
const CONTEXT_CACHE_ENTRIES = 512;

const imageCache = new Map<string, string>();
let imageCacheBytes = 0;
const contextCache = new Map<string, ProjectContext | undefined>();
const contextInFlight = new Map<string, Promise<ProjectContext | undefined>>();
const imageInFlight = new Map<string, { promise: Promise<ImageResult>; epoch: number }>();
const assetIndexes = new Map<string, AssetIndex>();

interface AssetIndexEntry {
	path: string;
	id: string;
	ambiguous: boolean;
}

interface AssetIndex {
	entries: Map<string, AssetIndexEntry>;
}

interface ImageResult {
	uri: string | null;
	epoch: number;
}

let mediaEpoch = 1;
let invalidationInstalled = false;
let mediaChannel: BroadcastChannel | null = null;

function notifyAssetChange(): void {
	try {
		mediaChannel?.postMessage({ type: 'project-assets-changed' });
	} catch {
		// A closed or restricted channel must not block a media render.
	}
}

const stats = {
	contextReads: 0,
	assetReads: 0,
	assetIndexBuilds: 0,
	assetKeysVisited: 0,
	decodeCalls: 0,
	imageCacheHits: 0,
	imageCacheMisses: 0
};

export interface ProjectMediaCacheStats {
	contextEntries: number;
	imageEntries: number;
	imageBytes: number;
	contextReads: number;
	assetReads: number;
	assetIndexBuilds: number;
	assetKeysVisited: number;
	decodeCalls: number;
	imageCacheHits: number;
	imageCacheMisses: number;
	epoch: number;
}

/** Returns the current media generation. A renderer cache key can include it. */
export function projectMediaEpoch(): number {
	return mediaEpoch;
}

/** Returns bounded cache and IO counters for the retained media test. */
export function projectMediaCacheStats(): ProjectMediaCacheStats {
	return {
		contextEntries: contextCache.size,
		imageEntries: imageCache.size,
		imageBytes: imageCacheBytes,
		...stats,
		epoch: mediaEpoch
	};
}

/** Resets the IO counters without dropping valid cached media. */
export function resetProjectMediaStats(): void {
	for (const key of Object.keys(stats) as (keyof typeof stats)[]) stats[key] = 0;
}

/** Drops cached previews after an asset write or a project location change. */
export function invalidateProjectMediaCache(): void {
	mediaEpoch++;
	imageCache.clear();
	imageCacheBytes = 0;
	contextCache.clear();
	contextInFlight.clear();
	imageInFlight.clear();
	assetIndexes.clear();
}

function dropContext(fileId: string): void {
	mediaEpoch++;
	contextCache.delete(fileId);
	contextInFlight.delete(fileId);
}

/**
 * Watches local writes and cross-tab notifications. A draft save keeps its
 * cached context; a project or path change drops that one entry at the write.
 */
function installInvalidation(): void {
	if (invalidationInstalled) return;
	invalidationInstalled = true;
	db.drafts.hook('creating', (_primaryKey, row) => {
		dropContext(row.id);
	});
	db.drafts.hook('updating', (modifications, primaryKey, row) => {
		const next = modifications as Partial<DraftRow>;
		const changed =
			(next.projectId !== undefined && next.projectId !== row.projectId) ||
			(next.relativePath !== undefined && next.relativePath !== row.relativePath);
		if (changed) dropContext(String(primaryKey));
	});
	db.drafts.hook('deleting', (primaryKey) => {
		dropContext(String(primaryKey));
	});
	db.projectAssets.hook('creating', () => {
		invalidateProjectMediaCache();
		notifyAssetChange();
	});
	db.projectAssets.hook('updating', () => {
		invalidateProjectMediaCache();
		notifyAssetChange();
	});
	db.projectAssets.hook('deleting', () => {
		invalidateProjectMediaCache();
		notifyAssetChange();
	});
	if (typeof BroadcastChannel === 'undefined') return;
	try {
		const channel = new BroadcastChannel('mdsh');
		mediaChannel = channel;
		channel.onmessage = (event: MessageEvent) => {
			const message = event.data as { type?: string; id?: string } | null;
			if (!message || typeof message.type !== 'string') return;
			if (message.type === 'backup-applied' || message.type === 'project-assets-changed')
				invalidateProjectMediaCache();
			else if (
				(message.type === 'draft-written' || message.type === 'removed') &&
				typeof message.id === 'string'
			)
				dropContext(message.id);
		};
	} catch {
		// A restricted context can reject the channel. Local invalidation still works.
	}
}

const BYTE_HASH_SEEDS = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35] as const;

/**
 * Wide content identity for asset bytes. Four lanes plus the length keep a
 * same-ID, same-MIME replacement from aliasing the earlier image.
 */
function bytesFingerprint(data: Uint8Array): string {
	const lanes = BYTE_HASH_SEEDS.map((seed) => {
		let hash = seed >>> 0;
		for (const byte of data) {
			hash ^= byte;
			hash = Math.imul(hash, 0x01000193) >>> 0;
		}
		return hash.toString(16).padStart(8, '0');
	});
	return `${lanes.join('')}:${data.byteLength.toString(36)}`;
}

function cacheImage(key: string, dataUri: string): void {
	const existing = imageCache.get(key);
	if (existing !== undefined) imageCacheBytes -= existing.length;
	imageCache.delete(key);
	imageCache.set(key, dataUri);
	imageCacheBytes += dataUri.length;
	while (
		imageCache.size > 1 &&
		(imageCache.size > IMAGE_CACHE_ENTRIES || imageCacheBytes > IMAGE_CACHE_BYTES)
	) {
		const oldest = imageCache.keys().next().value!;
		const value = imageCache.get(oldest)!;
		imageCache.delete(oldest);
		imageCacheBytes -= value.length;
	}
}

function touchImage(key: string): string {
	const value = imageCache.get(key)!;
	imageCache.delete(key);
	imageCache.set(key, value);
	return value;
}

export interface ProjectContext {
	projectId: string;
	relativePath: string;
}

/** Reads the manifest index key only. The document body stays unread. */
async function readManifestContext(fileId: string): Promise<ProjectContext | undefined | null> {
	try {
		const database = db.backendDB();
		return await new Promise<ProjectContext | undefined | null>((resolve) => {
			let transaction: IDBTransaction;
			try {
				transaction = database.transaction('drafts', 'readonly');
			} catch {
				resolve(null);
				return;
			}
			const prefix = `${JSON.stringify([DRAFT_MANIFEST_VERSION, fileId]).slice(0, -1)},`;
			const request = transaction
				.objectStore('drafts')
				.index('manifest')
				.openKeyCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
			request.onerror = () => resolve(null);
			request.onsuccess = () => {
				const cursor = request.result;
				if (!cursor) {
					resolve(null);
					return;
				}
				const manifest = decodeDraftManifest(cursor.key);
				if (!manifest) {
					resolve(null);
					return;
				}
				resolve(
					manifest.projectId && manifest.relativePath
						? { projectId: manifest.projectId, relativePath: manifest.relativePath }
						: undefined
				);
			};
		});
	} catch {
		return null;
	}
}

async function readProjectContext(fileId: string): Promise<ProjectContext | undefined> {
	const projected = await readManifestContext(fileId);
	if (projected !== null) return projected;
	// A legacy or incomplete projection falls back to the record. This path is
	// rare and never runs for a row written by the current schema.
	const file = await db.drafts.get(fileId);
	return file?.projectId && file.relativePath
		? { projectId: file.projectId, relativePath: file.relativePath }
		: undefined;
}

function sharedContextRead(fileId: string): Promise<ProjectContext | undefined> {
	const existing = contextInFlight.get(fileId);
	if (existing) return existing;
	stats.contextReads++;
	const promise = readProjectContext(fileId).finally(() => {
		if (contextInFlight.get(fileId) === promise) contextInFlight.delete(fileId);
	});
	contextInFlight.set(fileId, promise);
	return promise;
}

function cacheContext(fileId: string, value: ProjectContext | undefined): void {
	contextCache.delete(fileId);
	contextCache.set(fileId, value);
	while (contextCache.size > CONTEXT_CACHE_ENTRIES)
		contextCache.delete(contextCache.keys().next().value!);
}

export async function projectContextFor(fileId: string): Promise<ProjectContext | undefined> {
	installInvalidation();
	if (contextCache.has(fileId)) return contextCache.get(fileId);
	for (let attempt = 0; attempt < 2; attempt++) {
		const epoch = mediaEpoch;
		const value = await sharedContextRead(fileId);
		if (epoch === mediaEpoch) {
			cacheContext(fileId, value);
			return value;
		}
		contextInFlight.delete(fileId);
	}
	const value = await sharedContextRead(fileId);
	cacheContext(fileId, value);
	return value;
}

interface AssetKeyRow {
	id: string;
	path: string;
}

/** Reads compound index keys only. No asset blob leaves IndexedDB. */
async function readAssetKeyRows(projectId: string): Promise<AssetKeyRow[] | null> {
	try {
		const database = db.backendDB();
		return await new Promise<AssetKeyRow[] | null>((resolve) => {
			let transaction: IDBTransaction;
			try {
				transaction = database.transaction('projectAssets', 'readonly');
			} catch {
				resolve(null);
				return;
			}
			const request = transaction
				.objectStore('projectAssets')
				.index('[projectId+path]')
				.openKeyCursor(IDBKeyRange.bound([projectId, ''], [projectId, '\uffff']));
			const rows: AssetKeyRow[] = [];
			request.onerror = () => resolve(null);
			request.onsuccess = () => {
				const cursor = request.result;
				if (!cursor) return;
				const key = cursor.key;
				if (
					Array.isArray(key) &&
					typeof key[1] === 'string' &&
					typeof cursor.primaryKey === 'string'
				)
					rows.push({ id: cursor.primaryKey, path: key[1] });
				cursor.continue();
			};
			transaction.oncomplete = () => resolve(rows);
			transaction.onerror = () => resolve(null);
			transaction.onabort = () => resolve(null);
		});
	} catch {
		return null;
	}
}

async function buildAssetIndex(projectId: string): Promise<AssetIndex | null> {
	const rows = await readAssetKeyRows(projectId);
	if (!rows) return null;
	stats.assetIndexBuilds++;
	const entries = new Map<string, AssetIndexEntry>();
	for (const row of rows) {
		stats.assetKeysVisited++;
		let key: string;
		try {
			key = pathKey(row.path);
		} catch {
			continue;
		}
		const existing = entries.get(key);
		if (existing) existing.ambiguous = true;
		else entries.set(key, { path: row.path, id: row.id, ambiguous: false });
	}
	const index = { entries };
	assetIndexes.set(projectId, index);
	return index;
}

/**
 * Finds the unique asset whose canonical project path matches. A duplicate
 * canonical key is rejected instead of choosing an arbitrary blob.
 */
async function canonicalAsset(projectId: string, canonical: string) {
	for (let attempt = 0; attempt < 2; attempt++) {
		const index = assetIndexes.get(projectId) ?? (await buildAssetIndex(projectId));
		if (!index) return null;
		const entry = index.entries.get(canonical);
		if (!entry || entry.ambiguous) return null;
		const asset = await db.projectAssets.get(entry.id);
		stats.assetReads++;
		if (!asset) {
			assetIndexes.delete(projectId);
			continue;
		}
		let assetKey: string;
		try {
			assetKey = pathKey(asset.path);
		} catch {
			return null;
		}
		if (asset.projectId !== projectId || assetKey !== canonical) {
			assetIndexes.delete(projectId);
			continue;
		}
		return asset;
	}
	return null;
}

function startAssetRead(
	context: ProjectContext,
	path: string,
	epoch: number
): Promise<ImageResult> {
	const batchKey = `${context.projectId}\u0000${path}`;
	const promise = (async (): Promise<ImageResult> => {
		let canonical: string;
		try {
			canonical = pathKey(path);
		} catch {
			return { uri: null, epoch };
		}
		const asset = await canonicalAsset(context.projectId, canonical);
		if (!asset || !asset.mime.startsWith('image/')) return { uri: null, epoch };
		// Content identity, not just id/size/MIME: a native refresh can replace
		// bytes on the same row without changing either of those fields.
		const key = `${IMAGE_CACHE_VERSION}:${asset.id}:${bytesFingerprint(asset.data)}:${asset.mime}`;
		const cached = imageCache.get(key);
		if (cached !== undefined) {
			stats.imageCacheHits++;
			return { uri: touchImage(key), epoch };
		}
		stats.imageCacheMisses++;
		const image = await embedImageBlob(
			new Blob([new Uint8Array(asset.data)], { type: asset.mime })
		);
		stats.decodeCalls++;
		if (epoch === mediaEpoch) cacheImage(key, image.dataUri);
		return { uri: image.dataUri, epoch };
	})();
	const entry = { promise, epoch };
	imageInFlight.set(batchKey, entry);
	void promise
		.finally(() => {
			if (imageInFlight.get(batchKey) === entry) imageInFlight.delete(batchKey);
		})
		.catch(() => undefined);
	return promise;
}

export async function projectImageSource(
	source: string,
	context?: ProjectContext,
	signal?: AbortSignal
): Promise<string | null> {
	checkAborted(signal);
	if (!context) return null;
	const path = resolveProjectPath(context.relativePath, source);
	if (!path) return null;
	installInvalidation();
	const batchKey = `${context.projectId}\u0000${path}`;
	for (let attempt = 0; attempt < 2; attempt++) {
		const epoch = mediaEpoch;
		const pending = imageInFlight.get(batchKey);
		const promise =
			pending && pending.epoch === epoch ? pending.promise : startAssetRead(context, path, epoch);
		const result = await abortable(promise, signal);
		if (result.epoch === mediaEpoch) return result.uri;
		// An asset write completed while this read was in flight. Never publish
		// the old data URI into the new epoch.
	}
	return null;
}

/** Resolve assets in an inert tree. The source document stays unchanged. */
export async function resolveProjectHtmlImages(
	html: string,
	context: ProjectContext,
	signal?: AbortSignal
): Promise<string> {
	const template = document.createElement('template');
	template.innerHTML = html;
	const sources = new Map<string, string | null>();
	let total = 0;
	for (const image of template.content.querySelectorAll('img')) {
		checkAborted(signal);
		const source = image.getAttribute('src');
		if (!source) continue;
		if (!sources.has(source)) {
			try {
				const resolved = await projectImageSource(source, context, signal);
				if (resolved) {
					total += Math.ceil(resolved.length * 0.75);
					if (total > MAX_MEDIA_TOTAL_BYTES) throw new Error('Project image budget');
				}
				sources.set(source, resolved);
			} catch {
				checkAborted(signal);
				sources.set(source, null);
			}
		}
		const resolved = sources.get(source);
		if (resolved) image.setAttribute('src', resolved);
	}
	return template.innerHTML;
}

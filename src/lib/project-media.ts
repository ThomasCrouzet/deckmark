import { db } from './db';
import { resolveProjectPath } from './project-paths';
import { embedImageBlob, MAX_MEDIA_TOTAL_BYTES } from './render/image-media';
import { abortable, checkAborted } from './abort';

const imageCache = new Map<string, string>();
const IMAGE_CACHE_BYTES = 8 * 1024 * 1024;

function bytesFingerprint(data: Uint8Array): string {
	let hash = 0x811c9dc5;
	for (const byte of data) {
		hash ^= byte;
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, '0');
}

/** Drops cached previews after an asset write or a project location change. */
export function invalidateProjectMediaCache(): void {
	imageCache.clear();
	contextCache.clear();
}

function cacheImage(key: string, dataUri: string): void {
	imageCache.delete(key);
	imageCache.set(key, dataUri);
	let bytes = 0;
	for (const value of imageCache.values()) bytes += value.length;
	while (imageCache.size > 1 && bytes > IMAGE_CACHE_BYTES) {
		const oldest = imageCache.keys().next().value!;
		bytes -= imageCache.get(oldest)!.length;
		imageCache.delete(oldest);
	}
}

export interface ProjectContext {
	projectId: string;
	relativePath: string;
}

const contextCache = new Map<string, { value: ProjectContext | undefined; at: number }>();
const CONTEXT_TTL_MS = 5000;

export async function projectContextFor(fileId: string): Promise<ProjectContext | undefined> {
	const cached = contextCache.get(fileId);
	if (cached && Date.now() - cached.at < CONTEXT_TTL_MS) return cached.value;
	const file = await db.drafts.get(fileId);
	const value =
		file?.projectId && file.relativePath
			? { projectId: file.projectId, relativePath: file.relativePath }
			: undefined;
	contextCache.set(fileId, { value, at: Date.now() });
	while (contextCache.size > 512) contextCache.delete(contextCache.keys().next().value!);
	return value;
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
	const asset = await db.projectAssets
		.where('[projectId+path]')
		.equals([context.projectId, path])
		.first();
	checkAborted(signal);
	if (!asset || !asset.mime.startsWith('image/')) return null;
	// Content identity, not just id/size/MIME: a native refresh can replace
	// bytes on the same row without changing either of those fields.
	const key = `${asset.id}:${bytesFingerprint(asset.data)}:${asset.mime}`;
	const cached = imageCache.get(key);
	if (cached) {
		cacheImage(key, cached);
		return cached;
	}
	const image = await abortable(
		embedImageBlob(new Blob([new Uint8Array(asset.data)], { type: asset.mime })),
		signal
	);
	cacheImage(key, image.dataUri);
	return image.dataUri;
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

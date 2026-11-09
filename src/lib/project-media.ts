import { db } from './db';
import { resolveProjectPath } from './project-paths';
import { embedImageBlob, MAX_MEDIA_TOTAL_BYTES } from './render/image-media';
import { abortable, checkAborted } from './abort';

const imageCache = new Map<string, string>();
const IMAGE_CACHE_BYTES = 8 * 1024 * 1024;

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

export async function projectContextFor(fileId: string): Promise<ProjectContext | undefined> {
	const file = await db.drafts.get(fileId);
	return file?.projectId && file.relativePath
		? { projectId: file.projectId, relativePath: file.relativePath }
		: undefined;
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
	const key = `${asset.id}:${asset.data.byteLength}:${asset.mime}`;
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

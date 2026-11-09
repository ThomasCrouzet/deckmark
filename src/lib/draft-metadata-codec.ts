// Codec for the durable draft metadata index key.
//
// This module has no parser import so the boot and conflict paths can read the
// projection without loading the frontmatter or wiki-link scanners.

export const DRAFT_METADATA_VERSION = 2;

export interface DraftMetadata {
	id: string;
	contentHash: string;
	contentLength: number;
	title: string;
	documentTitle: string;
	tags: string[];
	targets: string[];
	/** The body defines or includes a linked block. */
	hasBlocks: boolean;
	hasIncludes: boolean;
}

/** Decodes a metadata index key. Returns null for unknown or damaged values. */
export function decodeDraftMetadata(key: unknown): DraftMetadata | null {
	if (typeof key !== 'string') return null;
	let value: unknown;
	try {
		value = JSON.parse(key);
	} catch {
		return null;
	}
	if (!Array.isArray(value) || value.length !== 10) return null;
	const [
		version,
		id,
		contentHash,
		contentLength,
		title,
		documentTitle,
		tags,
		targets,
		hasBlocks,
		hasIncludes
	] = value;
	if (version !== DRAFT_METADATA_VERSION) return null;
	if (
		typeof id !== 'string' ||
		typeof contentHash !== 'string' ||
		typeof contentLength !== 'number' ||
		typeof title !== 'string' ||
		typeof documentTitle !== 'string' ||
		!Array.isArray(tags) ||
		!tags.every((tag) => typeof tag === 'string') ||
		!Array.isArray(targets) ||
		!targets.every((target) => typeof target === 'string') ||
		(hasBlocks !== 0 && hasBlocks !== 1) ||
		(hasIncludes !== 0 && hasIncludes !== 1)
	)
		return null;
	return {
		id,
		contentHash,
		contentLength,
		title,
		documentTitle,
		tags,
		targets,
		hasBlocks: hasBlocks === 1,
		hasIncludes: hasIncludes === 1
	};
}

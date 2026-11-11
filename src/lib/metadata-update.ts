import { deriveMetadata, type MetadataSnapshot, type MetadataSource } from './metadata-derive';
import { reuseMetadata, type MetadataEdit } from './metadata-delta';

/**
 * Applies the complete parser, or reuses the previous metadata when a known
 * edit only touches plain body lines.
 */
export function updateMetadata(
	previous: MetadataSnapshot | undefined,
	source: MetadataSource,
	edits?: readonly MetadataEdit[]
): { snapshot: MetadataSnapshot; incremental: boolean } {
	const reused = edits ? reuseMetadata(previous, source, edits) : null;
	if (reused) return { snapshot: reused, incremental: true };
	return { snapshot: deriveMetadata(source), incremental: false };
}

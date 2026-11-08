import type { DocumentRevision, DocumentSnapshot } from '#lib/document-revisions.js';

export type RejectedNativeResolution =
	| { readonly kind: 'adopt'; readonly revision: DocumentRevision }
	| { readonly kind: 'block'; readonly reason: 'missing' | 'diverged' };

/**
 * A rejected native change may resume only from an authoritative snapshot for
 * the same file whose text equals the text the editor already accepted.
 * Otherwise the editor keeps its local work and stops publishing.
 */
export function resolveRejectedNativeChange(
	fileId: string,
	acceptedText: string,
	snapshot: DocumentSnapshot | null
): RejectedNativeResolution {
	if (!snapshot || snapshot.revision.fileId !== fileId) {
		return { kind: 'block', reason: 'missing' };
	}
	if (snapshot.text !== acceptedText) return { kind: 'block', reason: 'diverged' };
	return { kind: 'adopt', revision: snapshot.revision };
}

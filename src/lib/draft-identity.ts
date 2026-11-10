// Revision-safe identity for a durable draft.
//
// Conflict detection must compare every persisted field that changes the
// meaning of the document. A name and text comparison alone loses a binary
// payload, a MIME type, a file kind or a project location. The timestamp is
// not part of the identity: a newer write with the same content is the same
// document, not a separate branch.

import type { DraftRow } from './db';

export type DraftIdentity = Pick<
	DraftRow,
	'name' | 'content' | 'projectId' | 'relativePath' | 'kind' | 'mime' | 'data'
>;

/** True when both rows describe the same document content and location. */
export function sameDraftIdentity(a: DraftIdentity, b: DraftIdentity): boolean {
	return (
		a.name === b.name &&
		a.content === b.content &&
		a.projectId === b.projectId &&
		a.relativePath === b.relativePath &&
		a.kind === b.kind &&
		a.mime === b.mime &&
		a.data === b.data
	);
}

// One-shot request to focus the visual editor after a new note mounts.
//
// The editor is lazy-loaded, so its DOM does not exist when the New File
// action completes. The request is keyed by file id and consumed by the
// editor instance once it is ready. A request for another file is discarded.

let pendingId: string | null = null;

/** Requests the caret in `fileId` when its visual editor is ready. */
export function requestEditorFocus(fileId: string): void {
	pendingId = fileId;
}

/** Returns true once for the matching file, then clears the request. */
export function consumeEditorFocus(fileId: string): boolean {
	if (pendingId !== fileId) return false;
	pendingId = null;
	return true;
}

/** Drops a pending request, for example when the document closes first. */
export function clearEditorFocus(): void {
	pendingId = null;
}

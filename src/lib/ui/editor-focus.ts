// One-shot request to focus an editor after it mounts.
//
// The editor is lazy-loaded, so its DOM does not exist when the New File
// action or a mode switch completes. The request is keyed by file id and
// consumed by the editor instance once it is ready. A request for another
// file is discarded.

import type { EditMode } from '#lib/types.js';

let pendingId: string | null = null;
let pendingMode: EditMode | null = null;

/** Requests the caret in `fileId` when its visual editor is ready. */
export function requestEditorFocus(fileId: string): void {
	pendingId = fileId;
	pendingMode = null;
}

/**
 * Requests the caret in `fileId` after a mode switch remounts its editor.
 * The mode keeps a request for one surface from being used by another.
 */
export function requestModeEditorFocus(fileId: string, mode: EditMode): void {
	pendingId = fileId;
	pendingMode = mode;
}

/**
 * Returns true once for the matching file, then clears the request. A request
 * made for one mode is discarded by a consumer of another mode.
 */
export function consumeEditorFocus(fileId: string, mode?: EditMode): boolean {
	if (pendingId !== fileId) return false;
	if (pendingMode !== null && mode !== pendingMode) return false;
	pendingId = null;
	pendingMode = null;
	return true;
}

/** Drops a pending request, for example when the document closes first. */
export function clearEditorFocus(): void {
	pendingId = null;
	pendingMode = null;
}

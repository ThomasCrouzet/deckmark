import type { ChangeSpec, EditorState } from '@codemirror/state';

/**
 * Above this many changed native characters, replace the whole document.
 * A large enclosing range costs as much as a full replacement and is harder
 * to verify.
 */
const MAX_PATCH_LENGTH = 1_000_000;

/** Above this changed fraction of a large document, replace the whole document. */
const MAX_PATCH_RATIO = 0.5;

/** Small documents always keep a bounded change so positions stay stable. */
const SMALL_DOCUMENT_LENGTH = 64 * 1024;

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Returns the smallest safe native change from the current editor text to
 * `incoming`, or null when the native text is already equal.
 *
 * CodeMirror stores native lines with `\n` separators, while callers keep the
 * raw source. The helper normalizes incoming line endings before it compares
 * them. One common prefix and suffix bound the changed interval, and the
 * boundaries never split a surrogate pair. A large or high-ratio change falls
 * back to a whole-document replacement.
 */
export function externalDocumentChange(state: EditorState, incoming: string): ChangeSpec | null {
	const current = state.doc.toString();
	const normalized = incoming.includes('\r') ? incoming.replace(/\r\n?/g, '\n') : incoming;
	if (current === normalized) return null;

	const max = Math.min(current.length, normalized.length);
	let prefix = 0;
	while (prefix < max && current.charCodeAt(prefix) === normalized.charCodeAt(prefix)) prefix++;

	let suffix = 0;
	const maxSuffix = max - prefix;
	while (
		suffix < maxSuffix &&
		current.charCodeAt(current.length - 1 - suffix) ===
			normalized.charCodeAt(normalized.length - 1 - suffix)
	)
		suffix++;

	// Keep both halves of a surrogate pair in the same region.
	if (
		prefix > 0 &&
		(isHighSurrogate(current.charCodeAt(prefix - 1)) ||
			isHighSurrogate(normalized.charCodeAt(prefix - 1)))
	)
		prefix--;
	if (
		suffix > 0 &&
		(isLowSurrogate(current.charCodeAt(current.length - suffix)) ||
			isLowSurrogate(normalized.charCodeAt(normalized.length - suffix)))
	)
		suffix--;

	const from = prefix;
	const to = current.length - suffix;
	const insert = normalized.slice(prefix, normalized.length - suffix);
	const changed = Math.max(to - from, insert.length);
	const largest = Math.max(current.length, normalized.length);

	if (
		largest > SMALL_DOCUMENT_LENGTH &&
		(changed > MAX_PATCH_LENGTH || changed > largest * MAX_PATCH_RATIO)
	)
		return { from: 0, to: current.length, insert: normalized };

	return { from, to, insert };
}

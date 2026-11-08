import type { EditorState, Extension, StateField, Text } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { isolateHistory } from '@codemirror/commands';
import { EDITOR_STATE_CACHE_BYTES, EDITOR_STATE_CACHE_LIMIT } from './editor-history-constants';
import { advanceHistoryBytes, initialHistoryBytes } from './editor-history';

export {
	advanceHistoryBytes,
	initialHistoryBytes,
	EDITOR_STATE_CACHE_BYTES,
	EDITOR_STATE_CACHE_LIMIT
};

/**
 * Retained inactive editor snapshot.
 *
 * `doc` is the immutable native document and `history` is the native history
 * field value. Both are shared by reference so a snapshot does not copy the
 * raw text into a serialized state blob. `estimatedBytes` is the running
 * charge declared in `accounting-contract.md`.
 */
export interface SourceStateSnapshot {
	content: string;
	doc: Text;
	history: unknown;
	estimatedBytes: number;
}

export interface EditorSelection {
	anchor: number;
	head: number;
}

export interface RestoreHistoryInput {
	EditorState: {
		create(spec: {
			doc: string | Text;
			extensions: Extension;
			selection?: EditorSelection;
		}): EditorState;
	};
	historyField: StateField<unknown>;
	content: string;
	cached: SourceStateSnapshot | undefined;
	savedPosition: EditorSelection | undefined;
	extensions: readonly Extension[];
}

export interface RestoreHistoryResult {
	state: EditorState;
	bytes: number;
	tracker: HistoryTracker;
}

const MAX_FILE_ID_LENGTH = 1024;

function boundedLimit(value: number, fallback: number): number {
	return Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : fallback;
}

function validFileId(fileId: string): boolean {
	return typeof fileId === 'string' && fileId.length > 0 && fileId.length <= MAX_FILE_ID_LENGTH;
}

/**
 * Native length after CodeMirror normalizes CRLF line breaks to LF.
 *
 * A lone CR keeps its length. The result clamps a restored selection to the
 * native document when the incoming raw text is shorter than the saved state.
 */
export function nativeTextLength(text: string): number {
	let length = text.length;
	for (let index = 0; index < text.length - 1; index++) {
		if (text.charCodeAt(index) === 13 && text.charCodeAt(index + 1) === 10) length--;
	}
	return length;
}

/**
 * Builds a fresh editor state for a retained snapshot or for the raw content.
 *
 * The snapshot restores the shared native document and the native history
 * field. Extensions are new, so no detached view callbacks or stale options
 * survive. A content mismatch refuses the history and keeps navigation only.
 */
export function restoreHistoryState(input: RestoreHistoryInput): RestoreHistoryResult {
	const { EditorState, historyField, content, cached, savedPosition, extensions } = input;
	const nativeLength = nativeTextLength(content);
	const selection = savedPosition
		? {
				anchor: Math.min(savedPosition.anchor, nativeLength),
				head: Math.min(savedPosition.head, nativeLength)
			}
		: undefined;
	const retained = cached?.content === content ? cached : undefined;
	const tracker = createHistoryTracker();
	const fullExtensions = [...extensions, tracker.extension];
	let state: EditorState | undefined;
	if (retained) {
		try {
			state = EditorState.create({
				doc: retained.doc,
				extensions: [...fullExtensions, historyField.init(() => retained.history)],
				...(selection ? { selection } : {})
			});
			// A restored group must not absorb the first new edit. Otherwise one
			// undo removes the keystroke typed before the mode switch as well.
			state = state.update({ annotations: isolateHistory.of('before') }).state;
		} catch {
			// Ignore an incompatible retained history.
		}
	}
	state ??= EditorState.create({
		doc: content,
		extensions: fullExtensions,
		...(selection ? { selection } : {})
	});
	const bytes =
		retained && state.doc === retained.doc
			? retained.estimatedBytes
			: initialHistoryBytes(content.length, state);
	tracker.bytes = bytes;
	return { state, bytes, tracker };
}

export interface HistoryTracker {
	extension: Extension;
	bytes: number;
}

/**
 * Creates a lazy extension that keeps the estimated history charge current.
 *
 * The tracker lives in the lazy history module, so the boot editor component
 * only reads `bytes` when it detaches. The charge never decreases.
 */
export function createHistoryTracker(): HistoryTracker {
	const tracker: HistoryTracker = {
		bytes: 0,
		extension: EditorView.updateListener.of((update) => {
			if (update.transactions.length > 0) {
				tracker.bytes = advanceHistoryBytes(tracker.bytes, update.transactions);
			}
		})
	};
	return tracker;
}

/** Captures the immutable document and native history without serializing them. */
export function captureHistoryState(
	view: { state: { doc: Text; field(field: StateField<unknown>): unknown } },
	historyField: StateField<unknown> | null,
	content: string,
	estimatedBytes: number
): SourceStateSnapshot {
	return {
		content,
		doc: view.state.doc,
		history: historyField ? view.state.field(historyField) : undefined,
		estimatedBytes
	};
}

/**
 * Bounds retained inactive history by count and estimated bytes.
 *
 * The cache never owns document content or durability. Eviction removes only
 * the least recently used snapshot, so navigation, the active editor and the
 * save queue stay intact. Invalid or oversized charges drop that file's old
 * snapshot and accept no new one.
 */
export class EditorHistoryCache {
	readonly limit: number;
	readonly byteLimit: number;
	#sources = new Map<string, SourceStateSnapshot>();
	#bytes = 0;

	constructor(limit = EDITOR_STATE_CACHE_LIMIT, byteLimit = EDITOR_STATE_CACHE_BYTES) {
		this.limit = boundedLimit(limit, EDITOR_STATE_CACHE_LIMIT);
		this.byteLimit = boundedLimit(byteLimit, EDITOR_STATE_CACHE_BYTES);
	}

	get(fileId: string): SourceStateSnapshot | undefined {
		const source = this.#sources.get(fileId);
		if (!source) return undefined;
		this.#sources.delete(fileId);
		this.#sources.set(fileId, source);
		return source;
	}

	set(fileId: string, snapshot: SourceStateSnapshot): void {
		if (!validFileId(fileId)) return;
		const bytes = snapshot.estimatedBytes;
		const accepted = Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= this.byteLimit;
		const previous = this.#sources.get(fileId);
		if (!accepted) {
			if (previous) {
				this.#sources.delete(fileId);
				this.#bytes -= previous.estimatedBytes;
			}
			return;
		}
		if (previous) {
			this.#sources.delete(fileId);
			this.#bytes -= previous.estimatedBytes;
		}
		this.#sources.set(fileId, snapshot);
		this.#bytes += bytes;
		while (this.#sources.size > this.limit || this.#bytes > this.byteLimit) {
			const oldest = this.#sources.keys().next().value as string | undefined;
			if (oldest === undefined) break;
			const evicted = this.#sources.get(oldest);
			if (!evicted) break;
			this.#sources.delete(oldest);
			this.#bytes -= evicted.estimatedBytes;
		}
	}

	delete(fileId: string): void {
		const removed = this.#sources.get(fileId);
		if (!removed) return;
		this.#sources.delete(fileId);
		this.#bytes -= removed.estimatedBytes;
	}

	clear(): void {
		this.#sources.clear();
		this.#bytes = 0;
	}

	get sourceSize(): number {
		return this.#sources.size;
	}

	get sourceBytes(): number {
		return this.#bytes;
	}
}

export const editorHistoryCache = new EditorHistoryCache();

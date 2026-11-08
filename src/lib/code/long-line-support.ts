// Physical-line guard for pathological code and source documents. One very
// long line can make grammar parsing, folding, bracket matching and wrapping
// expensive enough to block input. The guard keeps the document editable with
// a reduced extension set until every line is below the limit again.
//
// This module has no runtime CodeMirror import. The editor passes its document
// and change set through the small structural types below, so the source
// editor keeps its lazy CodeMirror chunk boundary.

/** Maximum physical line length in UTF-16 code units before the guard applies. */
export const LONG_LINE_LIMIT = 16_384;

/** Delay before a full recheck after an edit that can restore normal syntax. */
export const LONG_LINE_RECHECK_MS = 120;

interface LineLike {
	readonly length: number;
}

interface DocumentLike {
	iterLines(): Iterable<string>;
}

interface PositionedDocumentLike {
	lineAt(position: number): LineLike;
}

interface InsertedTextLike {
	readonly length: number;
	sliceString(from: number, to: number, lineSeparator: string): string;
}

export interface SourceSupportModule {
	markdown(): import('@codemirror/state').Extension;
	imageData(): import('@codemirror/state').Extension;
	longLineStatus(): import('@codemirror/state').Extension;
	lineWrapping: import('@codemirror/state').Extension;
}

export interface LongLineMonitor {
	readonly initial: boolean;
	track(doc: PositionedDocumentLike, changes: ChangeSetLike): void;
	external(text: string): void;
	dispose(): void;
}

export interface LongLineMonitorOptions {
	initial: string;
	getDocument: () => DocumentLike | null;
	onChange: (degraded: boolean) => void;
}

interface ChangeSetLike {
	iterChangedRanges(
		callback: (fromA: number, toA: number, fromB: number, toB: number) => void
	): void;
	iterChanges(
		callback: (
			fromA: number,
			toA: number,
			fromB: number,
			toB: number,
			inserted: InsertedTextLike
		) => void
	): void;
}

/** A raw string with LF, CRLF or bare CR line endings. */
export function textHasLongLine(text: string, limit = LONG_LINE_LIMIT): boolean {
	let start = 0;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code !== 10 && code !== 13) continue;
		if (index - start > limit) return true;
		if (code === 13 && text.charCodeAt(index + 1) === 10) index++;
		start = index + 1;
	}
	return text.length - start > limit;
}

/** Checks every line of a CodeMirror document. Use it only at mount or after a
 * debounced shrink, never for each key. */
export function documentHasLongLine(doc: DocumentLike, limit = LONG_LINE_LIMIT): boolean {
	for (const line of doc.iterLines()) {
		if (line.length > limit) return true;
	}
	return false;
}

/** Builds the source-editor support set or the reduced panel extension. */
export function sourceSupportExtensions(
	degraded: boolean,
	plainText: boolean,
	module: SourceSupportModule
): import('@codemirror/state').Extension {
	if (degraded) return module.longLineStatus();
	return [...(plainText ? [] : [module.markdown()]), module.imageData(), module.lineWrapping];
}

/**
 * Tracks the guard state for one mounted editor. It checks touched lines on
 * each change and runs one debounced full scan after a shrink.
 */
export function createLongLineMonitor(options: LongLineMonitorOptions): LongLineMonitor {
	let degraded = textHasLongLine(options.initial);
	let timer: ReturnType<typeof setTimeout> | null = null;
	const update = (next: boolean) => {
		if (next === degraded) return;
		degraded = next;
		options.onChange(next);
	};
	const recheck = () => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			const doc = options.getDocument();
			if (doc) update(documentHasLongLine(doc));
		}, LONG_LINE_RECHECK_MS);
	};
	return {
		initial: degraded,
		track(doc, changes) {
			if (changeCreatesLongLine(doc, changes)) update(true);
			else if (degraded) recheck();
		},
		external(text) {
			update(textHasLongLine(text));
		},
		dispose() {
			if (timer) clearTimeout(timer);
			timer = null;
		}
	};
}

/**
 * Checks the lines that a change can make long. Only touched lines and a large
 * inserted block are inspected. The caller must still schedule a full recheck
 * when the document was already degraded and the change can shrink content.
 */
export function changeCreatesLongLine(
	doc: PositionedDocumentLike,
	changes: ChangeSetLike,
	limit = LONG_LINE_LIMIT
): boolean {
	let risky = false;
	changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
		if (risky) return;
		if (doc.lineAt(fromB).length > limit || doc.lineAt(toB).length > limit) risky = true;
	});
	if (risky) return true;
	changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
		if (risky) return;
		if (inserted.length <= limit) return;
		const text = inserted.sliceString(0, inserted.length, '\n');
		if (textHasLongLine(text, limit)) risky = true;
	});
	return risky;
}

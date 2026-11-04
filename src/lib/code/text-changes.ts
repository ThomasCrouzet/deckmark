import type { ChangeSet, EditorState } from '@codemirror/state';

/**
 * Rebuilds the original source string from CodeMirror changes. CodeMirror
 * stores LF lines internally; this keeps the document's original CRLF or LF
 * separators and preserves every byte outside the changed ranges.
 */
export function applySourceChanges(
	source: string,
	startState: EditorState,
	changes: ChangeSet
): string {
	const lineStarts = [0];
	for (const match of source.matchAll(/\r\n?|\n/g)) lineStarts.push(match.index + match[0].length);
	const offset = (position: number) => {
		const line = startState.doc.lineAt(position);
		return lineStarts[line.number - 1]! + position - line.from;
	};
	const parts: string[] = [];
	let cursor = 0;
	changes.iterChanges((from, to, _newFrom, _newTo, inserted) => {
		const rawFrom = offset(from);
		const rawTo = offset(to);
		const separator =
			/\r\n?|\n/.exec(source.slice(rawFrom))?.[0] ?? /\r\n?|\n/.exec(source)?.[0] ?? '\n';
		parts.push(source.slice(cursor, rawFrom), inserted.sliceString(0, inserted.length, separator));
		cursor = rawTo;
	});
	parts.push(source.slice(cursor));
	return parts.join('');
}

export function detectLineEnding(text: string): '\n' | '\r\n' | '\r' {
	if (text.includes('\r\n')) return '\r\n';
	if (text.includes('\r')) return '\r';
	return '\n';
}

/** Converts every line break to the requested style. */
export function convertLineEndings(text: string, ending: '\n' | '\r\n' | '\r'): string {
	return text.replace(/\r\n?|\n/g, ending);
}

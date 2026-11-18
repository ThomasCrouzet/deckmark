// Composition of accepted edit spans across coalesced publications.
//
// The producer publishes one change at a time. A consumer that holds the
// oldest accepted source composes the chain into one span list. A range that
// would split an existing replacement is rejected instead of guessed.

import type { DocumentEditSpan } from './edit-spans';
import type { DocumentEdits } from './document-revisions';

export type SpanComposition =
	| { readonly spans: readonly DocumentEditSpan[] }
	| { readonly rejected: 'invalid-range' | 'overlap' | 'too-many' };

/**
 * The exact changed spans of an accepted edit, or null when the producer did
 * not know them. The consumers reuse this record instead of comparing the
 * complete strings.
 */
export function spansOfEdits(
	edits: DocumentEdits,
	nextText?: string
): readonly DocumentEditSpan[] | null {
	if (edits.kind === 'codemirror') {
		const spans: DocumentEditSpan[] = [];
		edits.changes.iterChanges((from, to, _fromB, _toB, inserted) =>
			spans.push({ from, to, insert: inserted.toString() })
		);
		return spans;
	}
	if (edits.kind !== 'source-edit' || nextText === undefined) return null;
	const edit = edits.edit;
	if (edit.space !== 'portable-source' || edit.kind === 'full') return null;
	if (edit.next.to > nextText.length || edit.previous.to < edit.previous.from) return null;
	return [
		{
			from: edit.previous.from,
			to: edit.previous.to,
			insert: nextText.slice(edit.next.from, edit.next.to)
		}
	];
}

function isSpan(value: DocumentEditSpan): boolean {
	return (
		Number.isInteger(value.from) &&
		Number.isInteger(value.to) &&
		value.from >= 0 &&
		value.to >= value.from
	);
}

/**
 * Maps an offset in the edited text back to the base text. Returns undefined
 * when the offset falls inside inserted text, where no base position exists.
 */
function mapToBase(spans: readonly DocumentEditSpan[], offset: number): number | undefined {
	let delta = 0;
	for (const span of spans) {
		const editedFrom = span.from + delta;
		const editedTo = editedFrom + span.insert.length;
		if (offset < editedFrom) return offset - delta;
		if (offset === editedFrom) return span.from;
		if (offset === editedTo) return span.to;
		if (offset < editedTo) return undefined;
		delta += span.insert.length - (span.to - span.from);
	}
	return offset - delta;
}

/**
 * Appends one accepted span list to the composed change. The new list is
 * expressed in the edited text of the composed change.
 */
function appendSpans(
	composed: readonly DocumentEditSpan[],
	next: readonly DocumentEditSpan[]
): DocumentEditSpan[] | null {
	if (!next.length) return [...composed];
	let result = [...composed];
	for (const span of next) {
		if (!isSpan(span)) return null;
		const from = mapToBase(result, span.from);
		const to = mapToBase(result, span.to);
		if (from === undefined || to === undefined || to < from) return null;
		const kept: DocumentEditSpan[] = [];
		for (const existing of result) {
			const inside = existing.from >= from && existing.to <= to;
			if (inside) continue;
			const overlaps = existing.from < to && existing.to > from;
			if (overlaps) return null;
			kept.push(existing);
		}
		kept.push({ from, to, insert: span.insert });
		kept.sort((a, b) => a.from - b.from || a.to - b.to);
		result = kept;
	}
	return result;
}

/**
 * Composes accepted changes into one span list against the oldest source.
 * Every record is a list of spans in the text that the previous record
 * produced.
 */
export function composeEditSpans(chain: readonly (readonly DocumentEditSpan[])[]): SpanComposition {
	if (!chain.length) return { rejected: 'invalid-range' };
	if (chain.some((record) => !record.length)) return { rejected: 'invalid-range' };
	let composed: DocumentEditSpan[] = [...chain[0]!];
	for (let index = 1; index < chain.length; index += 1) {
		const merged = appendSpans(composed, chain[index]!);
		if (!merged) return { rejected: 'overlap' };
		composed = merged;
		if (composed.length > 64) return { rejected: 'too-many' };
	}
	return { spans: composed };
}

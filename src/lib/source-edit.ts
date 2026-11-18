// Shared revision and changed-span contract for editor producers and derived
// consumers (#369, #574).
//
// The producer owns the offsets. A publication from the visual editor describes
// the editor Markdown snapshot, before frontmatter removal and before source
// restoration. A consumer that works on the portable source must map the span
// across that materialization boundary, or use a full fallback. The contract
// never claims that two coordinate spaces are equal.
//
// Source and Code edits use the same record in the `portable-source` space.
// Their accepted CodeMirror change sets compose into one span. A set that does
// not compose becomes an explicit `full` revision, so a consumer never patches
// derived state with a stale local range.

import type { ChangeSet } from '@codemirror/state';

export interface SourceSpan {
	readonly from: number;
	readonly to: number;
}

export type SourceEditSpace = 'editor-markdown' | 'portable-source';

export type SourceEditKind = 'insert' | 'replace' | 'full';

/** One accepted revision and its changed span. All fields are immutable. */
export interface SourceEdit {
	readonly documentId: string;
	readonly revision: number;
	/**
	 * Revision of the previous snapshot. Optional for producers that record one
	 * publication at a time. A consumer must not reuse the span when this value
	 * is present and does not equal the revision that it holds.
	 */
	readonly baseRevision?: number;
	readonly space: SourceEditSpace;
	readonly kind: SourceEditKind;
	/** Replaced span in the previous snapshot. */
	readonly previous: SourceSpan;
	/** Replacement span in the next snapshot. */
	readonly next: SourceSpan;
	/** Length of the previous snapshot in this coordinate space. */
	readonly previousLength?: number;
	/** Length of the next snapshot in this coordinate space. */
	readonly nextLength?: number;
}

/** The span shape that the incremental serializer and source fidelity emit. */
export interface SourceEditHint {
	readonly previousFrom: number;
	readonly previousTo: number;
	readonly nextFrom: number;
	readonly nextTo: number;
	/** True when the change only inserts blocks at the given point. */
	readonly insert?: boolean | undefined;
}

/**
 * One changed range in a source text, with its replacement text.
 * This is the payload of a bounded delta message, not an accepted revision.
 */
export interface SourceTextSpan {
	readonly from: number;
	readonly to: number;
	readonly insert: string;
}

function spansFit(hint: SourceEditHint, previousLength: number, nextLength: number): boolean {
	return (
		hint.previousFrom >= 0 &&
		hint.previousFrom <= hint.previousTo &&
		hint.previousTo <= previousLength &&
		hint.nextFrom >= 0 &&
		hint.nextFrom <= hint.nextTo &&
		hint.nextTo <= nextLength
	);
}

/**
 * Convert one accepted text hint into the shared contract. An absent or
 * out-of-range hint becomes a full revision instead of a stale local span.
 */
export function createSourceEdit(
	documentId: string,
	revision: number,
	space: SourceEditSpace,
	hint: SourceEditHint | null | undefined,
	previousLength: number,
	nextLength: number
): SourceEdit {
	if (!hint || !spansFit(hint, previousLength, nextLength)) {
		return {
			documentId,
			revision,
			space,
			kind: 'full',
			previous: { from: 0, to: previousLength },
			next: { from: 0, to: nextLength }
		};
	}
	return {
		documentId,
		revision,
		space,
		kind: hint.insert ? 'insert' : 'replace',
		previous: { from: hint.previousFrom, to: hint.previousTo },
		next: { from: hint.nextFrom, to: hint.nextTo }
	};
}

/**
 * Combines accepted CodeMirror change sets into spans against the original
 * text. Returns null when the sets do not compose.
 */
export function composeSourceTextSpans(changes: readonly ChangeSet[]): SourceTextSpan[] | null {
	let composed: ChangeSet | null = null;
	for (const change of changes) {
		try {
			composed = composed ? composed.compose(change) : change;
		} catch {
			return null;
		}
	}
	if (!composed) return null;
	const spans: SourceTextSpan[] = [];
	composed.iterChanges((from, to, _fromB, _toB, inserted) => {
		spans.push({ from, to, insert: inserted.toString() });
	});
	return spans;
}

/**
 * Builds the accepted edit for one source-mode publication. One changed range
 * stays exact. Multiple ranges, or a set that does not compose, become an
 * explicit full revision. A null result means that the text did not change.
 */
export function createSourceEditFromChanges(
	documentId: string,
	revision: number,
	baseRevision: number,
	changes: readonly ChangeSet[],
	previousLength: number,
	nextLength: number
): SourceEdit | null {
	const spans = composeSourceTextSpans(changes);
	if (spans && spans.length === 0) return null;
	if (spans && spans.length === 1) {
		const span = spans[0]!;
		return {
			documentId,
			revision,
			baseRevision,
			space: 'portable-source',
			kind: span.to > span.from ? 'replace' : 'insert',
			previous: { from: span.from, to: span.to },
			next: { from: span.from, to: span.from + span.insert.length },
			previousLength,
			nextLength
		};
	}
	return {
		documentId,
		revision,
		baseRevision,
		space: 'portable-source',
		kind: 'full',
		previous: { from: 0, to: previousLength },
		next: { from: 0, to: nextLength },
		previousLength,
		nextLength
	};
}

/**
 * Applies spans to the base text. Returns null when a range leaves the current
 * text, so a stale or forged record cannot replace accepted bytes.
 */
export function applySourceTextSpans(
	base: string,
	spans: readonly SourceTextSpan[]
): string | null {
	let content = base;
	let delta = 0;
	for (const span of spans) {
		const from = span.from + delta;
		const to = span.to + delta;
		if (
			!Number.isInteger(from) ||
			!Number.isInteger(to) ||
			from < 0 ||
			to < from ||
			to > content.length
		)
			return null;
		content = content.slice(0, from) + span.insert + content.slice(to);
		delta += span.insert.length - (span.to - span.from);
	}
	return content;
}

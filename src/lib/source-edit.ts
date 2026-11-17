// Shared revision and changed-span contract for editor producers and derived
// consumers (#369, #574).
//
// The producer owns the offsets. A publication from the visual editor describes
// the editor Markdown snapshot, before frontmatter removal and before source
// restoration. A consumer that works on the portable source must map the span
// across that materialization boundary, or use a full fallback. The contract
// never claims that two coordinate spaces are equal.

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
	readonly space: SourceEditSpace;
	readonly kind: SourceEditKind;
	/** Replaced span in the previous snapshot. */
	readonly previous: SourceSpan;
	/** Replacement span in the next snapshot. */
	readonly next: SourceSpan;
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

// Bounded text spans for the metadata projection delta. This module stays out
// of the boot graph: the metadata index loads it with the draft access chunk.

/** One changed range in a source text, with its replacement text. */
export interface SourceTextSpan {
	readonly from: number;
	readonly to: number;
	readonly insert: string;
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

// Shared edit-span contract (#369).
//
// The editor producer knows which bytes it accepted. It publishes that change
// once, and the metadata index and the statistics runtime reuse the same
// record. A consumer must not compare the complete previous and next strings
// to rediscover the change.
// The offset space of a span is the accepted source of the edit. Spans are
// ordered and must not overlap. A chain of accepted changes is composed into
// one span list against the oldest accepted source.

/** One changed range in an accepted source, with its replacement text. */
export interface DocumentEditSpan {
	/** Start offset in the accepted source. */
	readonly from: number;
	/** End offset in the accepted source. */
	readonly to: number;
	/** Text that replaces the range. */
	readonly insert: string;
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
 * Applies ordered spans to `base`. Returns null when a range is invalid, so a
 * caller never accepts a partial application.
 */
export function applyEditSpans(base: string, spans: readonly DocumentEditSpan[]): string | null {
	let content = base;
	let delta = 0;
	for (const span of spans) {
		if (!isSpan(span)) return null;
		const from = span.from + delta;
		const to = span.to + delta;
		if (to > content.length) return null;
		content = content.slice(0, from) + span.insert + content.slice(to);
		delta += span.insert.length - (span.to - span.from);
	}
	return content;
}

/** Length of the source after the spans, or null for an invalid range. */
export function editedLength(
	baseLength: number,
	spans: readonly DocumentEditSpan[]
): number | null {
	let length = baseLength;
	for (const span of spans) {
		if (!isSpan(span) || span.to > length) return null;
		length += span.insert.length - (span.to - span.from);
	}
	return length;
}

/** True when the spans describe a change that this contract can carry. */
export function validEditSpans(baseLength: number, spans: readonly DocumentEditSpan[]): boolean {
	if (!spans.length || spans.length > 64) return false;
	return editedLength(baseLength, spans) !== null;
}

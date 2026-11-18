// Source fingerprint for durable draft projections.
//
// The encoded value is a pure function of the source. The running state also
// accepts one known edit range without a complete source scan: each line
// contributes an order-free FNV-1a value, so a changed line replaces one
// contribution. The value is an indexing hint. A reuse decision that matters
// compares the exact source.
//
// The line combination is order-free. A permutation of identical lines keeps
// the same contribution. Length and line count take part in the final mix, and
// the durable revision also carries the update time, so a move is still a new
// revision for its consumers.

export interface ContentFingerprint {
	/** XOR of every line contribution. */
	readonly hash: number;
	/** UTF-16 code units. */
	readonly length: number;
	/** Lines between newline characters, including the final empty one. */
	readonly lines: number;
}

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const NEWLINE = 10;

function step(hash: number, code: number): number {
	return Math.imul(hash ^ code, FNV_PRIME) >>> 0;
}

function mix(hash: number, value: number): number {
	return Math.imul(hash ^ value, FNV_PRIME) >>> 0;
}

function lineContribution(content: string, from: number, to: number): number {
	let hash = FNV_OFFSET;
	for (let index = from; index < to; index++) hash = step(hash, content.charCodeAt(index));
	return hash;
}

/**
 * Removes the contributions of the whole lines in `[from, to)`. `from` must be
 * a line start. `to` is a line start or the end of the source, so the region
 * holds only complete lines.
 */
function toggleRegion(hash: number, content: string, from: number, to: number): number {
	let start = from;
	let next = hash;
	for (let index = from; index < to; index++) {
		if (content.charCodeAt(index) !== NEWLINE) continue;
		next ^= lineContribution(content, start, index);
		start = index + 1;
	}
	// The final line has no newline. At the end of the source it may be empty:
	// the complete fingerprint counts it, so the region toggles it too.
	if (start < to || to === content.length) next ^= lineContribution(content, start, to);
	return next >>> 0;
}

function newlinesBetween(content: string, from: number, to: number): number {
	let count = 0;
	for (let index = from; index < to; index++) if (content.charCodeAt(index) === NEWLINE) count++;
	return count;
}

/** Complete fingerprint. Cost is proportional to the source length. */
export function fingerprintContent(content: string): ContentFingerprint {
	let hash = 0;
	let start = 0;
	let lines = 1;
	for (let index = 0; index < content.length; index++) {
		if (content.charCodeAt(index) !== NEWLINE) continue;
		hash ^= lineContribution(content, start, index);
		start = index + 1;
		lines++;
	}
	hash ^= lineContribution(content, start, content.length);
	return { hash: hash >>> 0, length: content.length, lines };
}

/**
 * Applies one known edit range to a fingerprint. The caller passes the source
 * before and after the edit. Cost is proportional to the changed lines, not to
 * the source.
 */
export function fingerprintEdit(
	previous: ContentFingerprint,
	previousContent: string,
	nextContent: string,
	from: number,
	to: number
): ContentFingerprint {
	if (
		!Number.isInteger(from) ||
		!Number.isInteger(to) ||
		from < 0 ||
		to < from ||
		to > previousContent.length
	)
		return fingerprintContent(nextContent);
	const insertLength = nextContent.length - (previousContent.length - (to - from));
	if (insertLength < 0) return fingerprintContent(nextContent);
	// The edit can move the last valid position. The two line ranges below must
	// hold the same untouched neighbour lines on both sides.
	// A negative `from` is valid; `String.indexOf` would clamp it to 0 and find
	// a newline at the first character.
	const start = from === 0 ? 0 : previousContent.lastIndexOf('\n', from - 1) + 1;
	const previousEndBoundary = previousContent.indexOf('\n', to);
	const previousEnd = previousEndBoundary === -1 ? previousContent.length : previousEndBoundary + 1;
	// The old range end moves to the end of the inserted text in the new source.
	const shiftedEnd = from + insertLength;
	const nextEndBoundary = nextContent.indexOf('\n', shiftedEnd);
	const nextEnd = nextEndBoundary === -1 ? nextContent.length : nextEndBoundary + 1;
	if (start > previousEnd || start > nextEnd) return fingerprintContent(nextContent);
	let hash = toggleRegion(previous.hash, previousContent, start, previousEnd);
	hash = toggleRegion(hash, nextContent, start, nextEnd);
	return {
		hash,
		length: nextContent.length,
		lines:
			previous.lines -
			newlinesBetween(previousContent, start, previousEnd) +
			newlinesBetween(nextContent, start, nextEnd)
	};
}

/** Encodes the state as a short stable string for the metadata index key. */
export function encodeContentFingerprint(fingerprint: ContentFingerprint): string {
	let hash = FNV_OFFSET;
	hash = mix(hash, fingerprint.hash);
	hash = mix(hash, fingerprint.length);
	hash = mix(hash, fingerprint.lines);
	return hash.toString(36);
}

/** Complete fingerprint in one step. */
export function contentFingerprint(content: string): string {
	return encodeContentFingerprint(fingerprintContent(content));
}

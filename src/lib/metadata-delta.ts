import { stripFrontmatter } from './frontmatter-fields';
import type { MetadataSnapshot, MetadataSource } from './metadata-derive';
import type { MetadataRequest } from './metadata.worker';
import type { DocumentEditSpan, DocumentEdits } from './document-revisions';

/** One changed range in the previous content, with its replacement text. */
export type MetadataEdit = DocumentEditSpan;

/** One changed range against the original text, with its replacement. */
export type TextEditSpan = DocumentEditSpan;

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

/**
 * A changed line can hold plain prose only. It cannot open or close a fence,
 * add a heading, front-matter key, wiki link, HTML marker or escape.
 */
const PLAIN_LINE = /^[\p{L}\p{N}][\p{L}\p{N} ,.!?'’\-_*#]*$/u;

/**
 * Returns true when every changed line can only hold plain body text. Such a
 * line cannot add, remove or hide a front-matter key, heading, wiki link, code
 * fence or presentation marker, so the previous tags and targets stay exact.
 */
export function metadataEditReuse(
	previous: string,
	next: string,
	frontmatterEnd: number,
	edits: readonly MetadataEdit[]
): boolean {
	if (!edits.length) return false;
	let delta = 0;
	for (const edit of edits) {
		if (
			!Number.isInteger(edit.from) ||
			!Number.isInteger(edit.to) ||
			edit.from < 0 ||
			edit.to < edit.from ||
			edit.to > previous.length
		)
			return false;
		const oldStart = previous.lastIndexOf('\n', edit.from - 1) + 1;
		const oldEnd = previous.indexOf('\n', edit.to);
		const oldLine = previous.slice(oldStart, oldEnd === -1 ? previous.length : oldEnd);
		const from = edit.from + delta;
		const to = from + edit.insert.length;
		const newStart = next.lastIndexOf('\n', from - 1) + 1;
		const newEnd = next.indexOf('\n', to);
		const newLine = next.slice(newStart, newEnd === -1 ? next.length : newEnd);
		if (
			oldStart < frontmatterEnd ||
			newStart < frontmatterEnd ||
			!PLAIN_LINE.test(oldLine) ||
			!PLAIN_LINE.test(newLine)
		)
			return false;
		delta += edit.insert.length - (edit.to - edit.from);
	}
	return true;
}

/**
 * Returns the previous metadata with the new source fields when a known edit
 * only touches plain body lines. Null means the caller must run the complete
 * parser.
 */
export function reuseMetadata(
	previous: MetadataSnapshot | undefined,
	source: MetadataSource,
	edits: readonly MetadataEdit[]
): MetadataSnapshot | null {
	if (
		previous &&
		previous.name === source.name &&
		previous.isNote === source.isNote &&
		metadataEditReuse(previous.content, source.content, previous.frontmatterEnd, edits)
	) {
		return { ...previous, ...source };
	}
	return null;
}

/** Inputs for one metadata job. The caller passes the full request as the fallback. */
export interface DeltaInput {
	id: string;
	revision: number;
	full: Extract<MetadataRequest, { kind: 'full' }>;
	documentRevision: number | undefined;
	chain: readonly { base: number; next: number; edits: DocumentEdits }[] | undefined;
	previous: Pick<MetadataSnapshot, 'content'> | undefined;
	source: MetadataSource;
}

/**
 * Returns one delta request when the accepted edit chain ends at the published
 * content revision. The Worker confirms that it holds the matching baseline.
 * Every other case returns the full snapshot.
 */
export function buildRequest(input: DeltaInput): MetadataRequest {
	const { documentRevision, chain, previous } = input;
	if (documentRevision === undefined || !chain?.length) return input.full;
	if (chain.length > 256) return input.full;
	if (chain.at(-1)!.next !== documentRevision) return input.full;
	for (let index = 1; index < chain.length; index++) {
		if (chain[index]!.base !== chain[index - 1]!.next) return input.full;
	}
	if (!previous) return input.full;
	const base = chain[0]!.base;
	const lists = chain.map((record, index) =>
		spansOfEdits(record.edits, index === chain.length - 1 ? input.source.content : undefined)
	);
	if (lists.some((record) => !record)) return input.full;
	const composed = composeEditSpans(lists as readonly (readonly DocumentEditSpan[])[]);
	if ('rejected' in composed) return input.full;
	const spans = composed.spans;
	const frontmatterEnd = stripFrontmatter(previous.content).raw.length;
	if (!metadataEditReuse(previous.content, input.source.content, frontmatterEnd, spans))
		return input.full;
	return {
		kind: 'delta',
		id: input.id,
		revision: input.revision,
		documentRevision,
		base,
		name: input.source.name,
		isNote: input.source.isNote,
		length: input.source.content.length,
		edits: spans
	};
}

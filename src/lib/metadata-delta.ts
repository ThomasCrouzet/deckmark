import type { ChangeSet } from '@codemirror/state';
import { stripFrontmatter } from './frontmatter-fields';
import type { MetadataSnapshot, MetadataSource } from './metadata-derive';
import type { MetadataRequest } from './metadata.worker';

/** One changed range in the previous content, with its replacement text. */
export interface MetadataEdit {
	/** Start offset in the previous content. */
	from: number;
	/** End offset in the previous content. */
	to: number;
	/** Text inserted at the range. */
	insert: string;
}

/** One changed range against the original text, with its replacement. */
export interface TextEditSpan {
	readonly from: number;
	readonly to: number;
	readonly insert: string;
}

/**
 * A changed line can hold plain prose only. It cannot open or close a fence,
 * add a heading, front-matter key, wiki link, HTML marker or escape.
 */
const PLAIN_LINE = /^[\p{L}\p{N}][\p{L}\p{N} ,.!?'’\-_*#]*$/u;

/**
 * Combines accepted CodeMirror change sets into spans against the original
 * text. Returns null when the sets do not compose, so the caller falls back to
 * one full snapshot.
 */
export function composeTextEdits(changes: readonly ChangeSet[]): TextEditSpan[] | null {
	let composed: ChangeSet | null = null;
	for (const change of changes) {
		try {
			composed = composed ? composed.compose(change) : change;
		} catch {
			return null;
		}
	}
	if (!composed) return null;
	const spans: TextEditSpan[] = [];
	composed.iterChanges((from, to, _fromB, _toB, inserted) => {
		spans.push({ from, to, insert: inserted.toString() });
	});
	return spans;
}

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
	chain: readonly { base: number; next: number; changes: ChangeSet }[] | undefined;
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
	const spans = composeTextEdits(chain.map((record) => record.changes));
	if (!spans) return input.full;
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

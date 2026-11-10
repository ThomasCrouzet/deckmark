import type { CommentRow } from './db';
import { readPreference, writePreference } from './misc-2';

export type CommentAnchorState = 'attached' | 'moved' | 'ambiguous' | 'detached';

export interface CommentAnchor {
	state: CommentAnchorState;
	from: number;
	to: number;
}

/**
 * Resolves a stored quote against the current source. Exact offsets win. A
 * unique quote elsewhere is reported as moved; repeated or missing text is
 * reported instead of guessing.
 */
export function resolveCommentAnchor(content: string, comment: CommentRow): CommentAnchor {
	const { quote, from, to } = comment;
	if (!quote) return { state: 'detached', from, to };
	if (content.slice(from, to) === quote) return { state: 'attached', from, to };
	const first = content.indexOf(quote);
	if (first < 0) return { state: 'detached', from, to };
	if (content.indexOf(quote, first + 1) >= 0) return { state: 'ambiguous', from, to };
	return { state: 'moved', from: first, to: first + quote.length };
}

interface TrieNode {
	next: Map<string, number>;
	fail: number;
	outputs: number[];
}

interface QuoteMatch {
	first: number;
	count: number;
}

/**
 * Finds the first occurrence and the multiplicity of every distinct quote in
 * one content pass. Aho-Corasick visits the source once, so a large comment set
 * does not run one whole-note search per quote. Counts stop at two because the
 * anchor state only needs to know whether the quote is unique.
 */
function quoteMatches(content: string, quotes: readonly string[]): Map<string, QuoteMatch> {
	const patterns = [...new Set(quotes)].filter((quote) => quote.length > 0);
	const matches = new Map<string, QuoteMatch>();
	if (!patterns.length || !content.length) return matches;
	const nodes: TrieNode[] = [{ next: new Map(), fail: 0, outputs: [] }];
	for (let pattern = 0; pattern < patterns.length; pattern++) {
		let node = 0;
		const quote = patterns[pattern]!;
		for (let index = 0; index < quote.length; index++) {
			const char = quote[index]!;
			let child = nodes[node]!.next.get(char);
			if (child === undefined) {
				child = nodes.length;
				nodes.push({ next: new Map(), fail: 0, outputs: [] });
				nodes[node]!.next.set(char, child);
			}
			node = child;
		}
		nodes[node]!.outputs.push(pattern);
	}
	const queue: number[] = [];
	for (const child of nodes[0]!.next.values()) queue.push(child);
	for (let head = 0; head < queue.length; head++) {
		const node = queue[head]!;
		for (const [char, child] of nodes[node]!.next) {
			let fallback = nodes[node]!.fail;
			while (fallback && !nodes[fallback]!.next.has(char)) fallback = nodes[fallback]!.fail;
			const target = nodes[fallback]!.next.get(char);
			nodes[child]!.fail = target !== undefined && target !== child ? target : 0;
			if (nodes[nodes[child]!.fail]!.outputs.length)
				nodes[child]!.outputs.push(...nodes[nodes[child]!.fail]!.outputs);
			queue.push(child);
		}
	}
	let remaining = patterns.length;
	let node = 0;
	for (let index = 0; index < content.length && remaining > 0; index++) {
		const char = content[index]!;
		while (node && !nodes[node]!.next.has(char)) node = nodes[node]!.fail;
		node = nodes[node]!.next.get(char) ?? 0;
		for (const pattern of nodes[node]!.outputs) {
			const quote = patterns[pattern]!;
			const match = matches.get(quote);
			if (!match) {
				matches.set(quote, { first: index - quote.length + 1, count: 1 });
			} else if (match.count === 1) {
				match.count = 2;
				remaining -= 1;
			}
		}
	}
	return matches;
}

/**
 * Resolves every comment in one batch. Exact offsets and the shared quote index
 * replace per-comment `indexOf` scans.
 */
export function resolveCommentAnchors(
	content: string,
	comments: readonly CommentRow[]
): Record<string, CommentAnchor> {
	const result: Record<string, CommentAnchor> = {};
	const pending: CommentRow[] = [];
	for (const comment of comments) {
		if (!comment.quote) {
			result[comment.id] = { state: 'detached', from: comment.from, to: comment.to };
		} else if (content.slice(comment.from, comment.to) === comment.quote) {
			result[comment.id] = { state: 'attached', from: comment.from, to: comment.to };
		} else {
			pending.push(comment);
		}
	}
	if (pending.length) {
		const matches = quoteMatches(
			content,
			pending.map((comment) => comment.quote)
		);
		for (const comment of pending) {
			const match = matches.get(comment.quote);
			if (!match) {
				result[comment.id] = { state: 'detached', from: comment.from, to: comment.to };
			} else if (match.count > 1) {
				result[comment.id] = { state: 'ambiguous', from: comment.from, to: comment.to };
			} else {
				result[comment.id] = {
					state: 'moved',
					from: match.first,
					to: match.first + comment.quote.length
				};
			}
		}
	}
	return result;
}

/**
 * Re-resolves comments after an accepted edit. A shifted interval is only a
 * hint: a repeated quote can match at the shifted offset while the oracle
 * reports the first occurrence or ambiguity. The shared quote index stays the
 * source of truth, so the result always equals the full-scan state.
 */
export function shiftCommentAnchors(
	previousContent: string,
	content: string,
	comments: readonly CommentRow[],
	previous: Readonly<Record<string, CommentAnchor>> = {}
): Record<string, CommentAnchor> {
	void previousContent;
	void previous;
	return resolveCommentAnchors(content, comments);
}

/** Extracts a unique quote around the selection text, or null when ambiguous. */
export function createAnchor(
	content: string,
	quote: string
): { from: number; to: number; quote: string } | null {
	const text = quote.trim();
	if (!text) return null;
	const first = content.indexOf(text);
	if (first < 0 || content.indexOf(text, first + 1) >= 0) return null;
	return { from: first, to: first + text.length, quote: text };
}

const COMMENT_AUTHOR_KEY = 'mdsh:comment-author';

/** The last reviewer label is optional. A blocked read keeps the default. */
export function commentAuthor(): string {
	const value = readPreference(COMMENT_AUTHOR_KEY);
	return value && value.trim() ? value : '';
}

/** A failed store must not reject a comment that IndexedDB already saved. */
export function setCommentAuthor(name: string): void {
	const value = name.trim();
	writePreference(COMMENT_AUTHOR_KEY, value || null);
}

export function commentReport(comments: readonly CommentRow[], content: string): string {
	const anchors = resolveCommentAnchors(content, comments);
	return JSON.stringify(
		{
			format: 'mdsh-comments',
			schemaVersion: 1,
			comments: comments.map((comment) => ({
				id: comment.id,
				author: comment.author,
				status: comment.status,
				body: comment.body,
				quote: comment.quote,
				anchor: anchors[comment.id] ?? resolveCommentAnchor(content, comment),
				createdAt: comment.createdAt,
				updatedAt: comment.updatedAt
			}))
		},
		null,
		2
	);
}

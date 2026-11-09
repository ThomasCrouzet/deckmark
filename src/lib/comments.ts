import type { CommentRow } from './db';

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

function changeRange(
	before: string,
	after: string
): { from: number; oldTo: number; newTo: number } {
	let from = 0;
	while (from < before.length && from < after.length && before[from] === after[from]) from++;
	let suffix = 0;
	while (
		suffix < before.length - from &&
		suffix < after.length - from &&
		before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
	)
		suffix++;
	return { from, oldTo: before.length - suffix, newTo: after.length - suffix };
}

/**
 * Shifts previously resolved anchors by one accepted edit. Quotes outside the
 * changed range are verified directly instead of scanning the whole note again.
 */
export function shiftCommentAnchors(
	previousContent: string,
	content: string,
	comments: readonly CommentRow[],
	previous: Readonly<Record<string, CommentAnchor>> = {}
): Record<string, CommentAnchor> {
	const { oldTo, newTo } = changeRange(previousContent, content);
	const delta = newTo - oldTo;
	const result: Record<string, CommentAnchor> = {};
	for (const comment of comments) {
		const cached = previous[comment.id];
		if (cached && comment.quote) {
			const from = cached.from >= oldTo ? cached.from + delta : cached.from;
			const to = from + comment.quote.length;
			if (from >= 0 && content.slice(from, to) === comment.quote) {
				result[comment.id] = {
					state: from === comment.from ? 'attached' : 'moved',
					from,
					to
				};
				continue;
			}
		}
		result[comment.id] = resolveCommentAnchor(content, comment);
	}
	return result;
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

export function commentAuthor(): string {
	const value = localStorage.getItem('mdsh:comment-author');
	return value && value.trim() ? value : '';
}

export function setCommentAuthor(name: string): void {
	const value = name.trim();
	if (value) localStorage.setItem('mdsh:comment-author', value);
	else localStorage.removeItem('mdsh:comment-author');
}

export function commentReport(comments: readonly CommentRow[], content: string): string {
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
				anchor: resolveCommentAnchor(content, comment),
				createdAt: comment.createdAt,
				updatedAt: comment.updatedAt
			}))
		},
		null,
		2
	);
}

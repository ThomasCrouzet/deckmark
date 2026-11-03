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

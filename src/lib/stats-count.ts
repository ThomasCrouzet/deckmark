import { READING } from './config';

export interface DocStats {
	chars: number;
	words: number;
	lines: number;
	readMinutes: number;
}

export interface SelectionStats {
	chars: number;
	words: number;
	lines: number;
}

/**
 * A document change for a Worker that already holds the previous source.
 * The Worker rebuilds the exact text from its baseline before it counts.
 */
export interface StatsPatch {
	baseRevision: number;
	start: number;
	remove: number;
	insert: string;
}

export interface StatsRequest {
	token: number;
	text?: string;
	patch?: StatsPatch;
	mode?: 'document' | 'selection';
}

export interface StatsResponse {
	token: number;
	stats?: DocStats;
	selection?: SelectionStats;
	revision?: number;
	needFull?: boolean;
}

function isWhitespace(code: number): boolean {
	return code <= 0x20
		? code === 0x20 || (code >= 9 && code <= 13)
		: code === 0xa0 ||
				code === 0x1680 ||
				(code >= 0x2000 && code <= 0x200a) ||
				code === 0x2028 ||
				code === 0x2029 ||
				code === 0x202f ||
				code === 0x205f ||
				code === 0x3000 ||
				code === 0xfeff;
}

function isLineStart(code: number): boolean {
	return code === 10 || code === 13 || code === 0x2028 || code === 0x2029;
}

// Two bits per raw UTF-16 unit preserve ordered replacements without text copies.
// State 1 deletes a unit. State 2 replaces it with one space.
class StatsText {
	private flags: Uint8Array | null = null;
	constructor(readonly text: string) {}

	private state(index: number): number {
		return this.flags ? ((this.flags[index >> 2] ?? 0) >> ((index & 3) * 2)) & 3 : 0;
	}

	code(index: number): number {
		return this.state(index) === 2 ? 32 : this.text.charCodeAt(index);
	}

	next(index: number): number {
		if (!this.flags) return Math.min(index, this.text.length);
		while (index < this.text.length && this.state(index) === 1) {
			index += (index & 3) === 0 && this.flags[index >> 2] === 0x55 ? 4 : 1;
		}
		return Math.min(index, this.text.length);
	}

	find(character: string, from: number): number {
		let index = this.text.indexOf(character, from);
		while (index !== -1 && this.state(index) !== 0) {
			index = this.text.indexOf(character, index + 1);
		}
		return index;
	}

	private set(index: number, state: number): void {
		const shift = (index & 3) * 2;
		this.flags![index >> 2] = ((this.flags![index >> 2] ?? 0) & ~(3 << shift)) | (state << shift);
	}

	remove(start: number, end: number, space = false): void {
		this.flags ??= new Uint8Array(Math.ceil(this.text.length / 4));
		const first = start;
		while (start < end && (start & 3) !== 0) this.set(start++, 1);
		const alignedEnd = end - (end & 3);
		if (start < alignedEnd) {
			this.flags.fill(0x55, start >> 2, alignedEnd >> 2);
			start = alignedEnd;
		}
		while (start < end) this.set(start++, 1);
		if (space) this.set(first, 2);
	}
}

function removeCode(view: StatsText): void {
	let start = view.text.indexOf('```');
	while (start !== -1) {
		const end = view.text.indexOf('```', start + 3);
		if (end === -1) break;
		view.remove(start, end + 3, true);
		start = view.text.indexOf('```', end + 3);
	}
	start = view.find('`', 0);
	while (start !== -1) {
		const end = view.find('`', start + 1);
		if (end === -1) break;
		view.remove(start, end + 1, true);
		start = view.find('`', end + 1);
	}
}

function removeLinks(view: StatsText, images: boolean): void {
	let from = 0;
	let bracket = -1;
	let paren = -1;
	const length = view.text.length;
	while (from < length) {
		const start = view.find(images ? '!' : '[', from);
		if (start === -1) break;
		from = start + 1;
		const opening = images ? view.next(start + 1) : start;
		if (view.code(opening) !== 91) continue;
		const label = view.next(opening + 1);
		// Failed candidates share the next delimiter. Do not rescan an unmatched suffix.
		if (bracket < label) bracket = view.find(']', label);
		if (bracket === -1) break;
		if (!images && label === bracket) continue;
		const target = view.next(bracket + 1);
		if (view.code(target) !== 40) continue;
		if (paren < target + 1) paren = view.find(')', target + 1);
		if (paren === -1) break;
		if (images) {
			view.remove(start, paren + 1, true);
		} else {
			view.remove(start, start + 1);
			view.remove(bracket, paren + 1);
		}
		// A retained label is not matched again by the same replacement stage.
		from = paren + 1;
	}
}

/**
 * Counts selected plain text. Characters are Unicode code points, so a
 * surrogate pair counts once. Lines follow LF, CRLF and CR breaks.
 */
export function computeSelectionStats(text: string): SelectionStats {
	let chars = 0;
	let words = 0;
	let lines = text.length === 0 ? 0 : 1;
	let inWord = false;
	let previous = 0;
	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index);
		chars += 1;
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = text.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) index += 1;
		}
		if (code === 13 || (code === 10 && previous !== 13)) lines += 1;
		const whitespace = isWhitespace(code);
		if (!whitespace && !inWord) words += 1;
		inWord = !whitespace;
		previous = code;
	}
	return { chars, words, lines };
}

export function computeStats(markdown: string): DocStats {
	const view = new StatsText(markdown);
	removeCode(view);
	removeLinks(view, true);
	removeLinks(view, false);
	let words = 0;
	let inWord = false;
	let lineStart = true;
	let index = view.next(0);
	while (index < markdown.length) {
		const code = view.code(index);
		if (code === 35 && lineStart) {
			let end = view.next(index + 1);
			while (end < markdown.length && view.code(end) === 35) end = view.next(end + 1);
			if (end < markdown.length && isWhitespace(view.code(end))) {
				let last: number;
				do {
					last = view.code(end);
					end = view.next(end + 1);
				} while (end < markdown.length && isWhitespace(view.code(end)));
				lineStart = isLineStart(last);
				index = end;
				continue;
			}
		}
		const whitespace =
			isWhitespace(code) || code === 42 || code === 95 || code === 126 || code === 62;
		if (!whitespace && !inWord) words += 1;
		inWord = !whitespace;
		lineStart = isLineStart(code);
		index = view.next(index + 1);
	}
	let lines = markdown.length === 0 ? 0 : 1;
	for (let at = markdown.indexOf('\n'); at !== -1; at = markdown.indexOf('\n', at + 1)) lines += 1;
	return {
		chars: markdown.length,
		words,
		lines,
		readMinutes: words === 0 ? 0 : Math.max(1, Math.round(words / READING.wpm))
	};
}

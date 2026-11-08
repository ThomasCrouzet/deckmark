export type DiffLineKind = 'equal' | 'add' | 'remove' | 'skip';

export interface DiffLine {
	kind: DiffLineKind;
	oldLine: number | null;
	newLine: number | null;
	text: string;
	textTruncated: boolean;
	omittedOldLines: number;
	omittedNewLines: number;
}

export interface LineDiff {
	lines: DiffLine[];
	added: number;
	removed: number;
	truncated: boolean;
	approximate: boolean;
}

export interface LineDiffOptions {
	contextLines?: number;
	maxMatrixCells?: number;
	maxOutputLines?: number;
	maxLineCharacters?: number;
}

const DEFAULTS = {
	contextLines: 3,
	maxMatrixCells: 300_000,
	maxOutputLines: 500,
	maxLineCharacters: 2_000
} as const;

interface RawLine {
	kind: Exclude<DiffLineKind, 'skip'>;
	oldLine: number | null;
	newLine: number | null;
	text: string;
}

function splitLines(value: string): string[] {
	return value.length === 0 ? [] : value.split('\n');
}

function lcsLines(
	before: string[],
	after: string[],
	oldOffset: number,
	newOffset: number
): RawLine[] {
	const width = after.length + 1;
	const matrix = new Uint32Array((before.length + 1) * width);
	for (let oldIndex = before.length - 1; oldIndex >= 0; oldIndex--) {
		for (let newIndex = after.length - 1; newIndex >= 0; newIndex--) {
			const position = oldIndex * width + newIndex;
			matrix[position] =
				before[oldIndex] === after[newIndex]
					? matrix[(oldIndex + 1) * width + newIndex + 1]! + 1
					: Math.max(matrix[(oldIndex + 1) * width + newIndex]!, matrix[position + 1]!);
		}
	}

	const lines: RawLine[] = [];
	let oldIndex = 0;
	let newIndex = 0;
	while (oldIndex < before.length || newIndex < after.length) {
		if (
			oldIndex < before.length &&
			newIndex < after.length &&
			before[oldIndex] === after[newIndex]
		) {
			lines.push({
				kind: 'equal',
				oldLine: oldOffset + oldIndex + 1,
				newLine: newOffset + newIndex + 1,
				text: before[oldIndex]!
			});
			oldIndex++;
			newIndex++;
		} else if (
			newIndex < after.length &&
			(oldIndex === before.length ||
				matrix[oldIndex * width + newIndex + 1]! >= matrix[(oldIndex + 1) * width + newIndex]!)
		) {
			lines.push({
				kind: 'add',
				oldLine: null,
				newLine: newOffset + newIndex + 1,
				text: after[newIndex]!
			});
			newIndex++;
		} else {
			lines.push({
				kind: 'remove',
				oldLine: oldOffset + oldIndex + 1,
				newLine: null,
				text: before[oldIndex]!
			});
			oldIndex++;
		}
	}
	return lines;
}

function skipLine(oldCount: number, newCount: number): DiffLine {
	return {
		kind: 'skip',
		oldLine: null,
		newLine: null,
		text: '',
		textTruncated: false,
		omittedOldLines: oldCount,
		omittedNewLines: newCount
	};
}

function collapseEqualRuns(
	lines: Array<RawLine | DiffLine>,
	context: number
): Array<RawLine | DiffLine> {
	if (context < 0) return lines;
	const output: Array<RawLine | DiffLine> = [];
	let index = 0;
	while (index < lines.length) {
		if (lines[index]?.kind !== 'equal') {
			output.push(lines[index]!);
			index++;
			continue;
		}
		let end = index + 1;
		while (end < lines.length && lines[end]?.kind === 'equal') end++;
		const length = end - index;
		const atStart = index === 0;
		const atEnd = end === lines.length;
		const keepStart = atStart ? Math.min(context, length) : Math.min(context, length);
		const keepEnd = atEnd
			? Math.min(context, length - keepStart)
			: Math.min(context, length - keepStart);
		if (length <= keepStart + keepEnd + 1) {
			output.push(...lines.slice(index, end));
		} else {
			output.push(...lines.slice(index, index + keepStart));
			output.push(skipLine(length - keepStart - keepEnd, length - keepStart - keepEnd));
			output.push(...lines.slice(end - keepEnd, end));
		}
		index = end;
	}
	return output;
}

function boundedChangedLines(
	before: string[],
	after: string[],
	oldOffset: number,
	newOffset: number,
	limit: number
): Array<RawLine | DiffLine> {
	const perSide = Math.max(2, Math.floor((Math.max(6, limit) - 2) / 2));
	const sample = (
		values: string[],
		kind: 'add' | 'remove',
		offset: number
	): Array<RawLine | DiffLine> => {
		const head = Math.ceil(perSide / 2);
		const tail = Math.floor(perSide / 2);
		const toLine = (index: number): RawLine => ({
			kind,
			oldLine: kind === 'remove' ? offset + index + 1 : null,
			newLine: kind === 'add' ? offset + index + 1 : null,
			text: values[index]!
		});
		if (values.length <= perSide) return values.map((_value, index) => toLine(index));
		const omitted = values.length - head - tail;
		return [
			...values.slice(0, head).map((_value, index) => toLine(index)),
			skipLine(kind === 'remove' ? omitted : 0, kind === 'add' ? omitted : 0),
			...values
				.slice(values.length - tail)
				.map((_value, index) => toLine(values.length - tail + index))
		];
	};
	const removed = sample(before, 'remove', oldOffset);
	const added = sample(after, 'add', newOffset);
	return [...removed, ...added];
}

function finalizeLine(line: RawLine | DiffLine, maxCharacters: number): DiffLine {
	if (line.kind === 'skip') return line;
	const textTruncated = line.text.length > maxCharacters;
	return {
		...line,
		text: textTruncated ? `${line.text.slice(0, maxCharacters)}...` : line.text,
		textTruncated,
		omittedOldLines: 0,
		omittedNewLines: 0
	};
}

export function lineDiff(
	beforeText: string,
	afterText: string,
	options: LineDiffOptions = {}
): LineDiff {
	const contextLines = Math.max(0, options.contextLines ?? DEFAULTS.contextLines);
	const maxMatrixCells = Math.max(1, options.maxMatrixCells ?? DEFAULTS.maxMatrixCells);
	const maxOutputLines = Math.max(10, options.maxOutputLines ?? DEFAULTS.maxOutputLines);
	const maxLineCharacters = Math.max(80, options.maxLineCharacters ?? DEFAULTS.maxLineCharacters);
	const before = splitLines(beforeText);
	const after = splitLines(afterText);

	let prefix = 0;
	while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix])
		prefix++;
	let suffix = 0;
	while (
		suffix < before.length - prefix &&
		suffix < after.length - prefix &&
		before[before.length - suffix - 1] === after[after.length - suffix - 1]
	)
		suffix++;

	const beforeMiddle = before.slice(prefix, before.length - suffix);
	const afterMiddle = after.slice(prefix, after.length - suffix);
	const cells = (beforeMiddle.length + 1) * (afterMiddle.length + 1);
	const approximate = cells > maxMatrixCells;
	// Equal boundaries can contain tens of thousands of lines. Keep only the
	// context that a collapsed diff can display and summarize the rest.
	const equalBoundary = (
		values: string[],
		oldOffset: number,
		newOffset: number
	): Array<RawLine | DiffLine> => {
		const toLine = (index: number): RawLine => ({
			kind: 'equal',
			oldLine: oldOffset + index + 1,
			newLine: newOffset + index + 1,
			text: values[index]! as string
		});
		const keep = Math.max(1, contextLines);
		if (values.length <= keep * 2 + 1) return values.map((_value, index) => toLine(index));
		const omitted = values.length - keep * 2;
		return [
			...values.slice(0, keep).map((_value, index) => toLine(index)),
			skipLine(omitted, omitted),
			...values
				.slice(values.length - keep)
				.map((_value, index) => toLine(values.length - keep + index))
		];
	};
	const prefixLines = equalBoundary(before.slice(0, prefix), 0, 0);
	const suffixLines = equalBoundary(
		before.slice(before.length - suffix),
		before.length - suffix,
		after.length - suffix
	);
	const middle = approximate
		? boundedChangedLines(
				beforeMiddle,
				afterMiddle,
				prefix,
				prefix,
				maxOutputLines - 2 * contextLines
			)
		: lcsLines(beforeMiddle, afterMiddle, prefix, prefix);
	const exactAdded = middle.reduce((total, line) => total + (line.kind === 'add' ? 1 : 0), 0);
	const exactRemoved = middle.reduce((total, line) => total + (line.kind === 'remove' ? 1 : 0), 0);
	let combined: Array<RawLine | DiffLine> = [...prefixLines, ...middle, ...suffixLines];
	combined = collapseEqualRuns(combined, contextLines);

	if (combined.length > maxOutputLines) {
		const head = Math.floor((maxOutputLines - 1) / 2);
		const tail = maxOutputLines - head - 1;
		const hidden = combined.slice(head, combined.length - tail);
		combined = [
			...combined.slice(0, head),
			skipLine(
				hidden.reduce(
					(total, line) =>
						total + (line.kind === 'add' ? 0 : line.kind === 'skip' ? line.omittedOldLines : 1),
					0
				),
				hidden.reduce(
					(total, line) =>
						total + (line.kind === 'remove' ? 0 : line.kind === 'skip' ? line.omittedNewLines : 1),
					0
				)
			),
			...combined.slice(combined.length - tail)
		];
	}

	const lines = combined.map((line) => finalizeLine(line, maxLineCharacters));
	const added = approximate ? afterMiddle.length : exactAdded;
	const removed = approximate ? beforeMiddle.length : exactRemoved;
	return {
		lines,
		added,
		removed,
		truncated: approximate || lines.some((line) => line.kind === 'skip' || line.textTruncated),
		approximate
	};
}

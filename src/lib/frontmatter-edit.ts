// Byte-preserving front matter property edits. Only the edited value range
// changes; comments, ordering, indentation and unrelated keys stay intact.

export type FrontmatterValue = string | string[] | number | boolean | null;

export interface FrontmatterProperty {
	key: string;
	value: FrontmatterValue;
	kind: 'string' | 'tags' | 'number' | 'boolean' | 'date' | 'other';
	raw: string;
}

type BlockStyle =
	'inline' | 'block-sequence' | 'block-scalar' | 'mapping' | 'empty' | 'unsupported';

interface LineRange {
	key: string;
	start: number;
	end: number;
	valueStart: number;
	valueEnd: number;
	inline: string;
	/** Whitespace between an existing inline value and a trailing comment. */
	separator: string;
	comment: string;
	/** True when at least one space or tab follows the colon. */
	spaceBeforeValue: boolean;
	style: BlockStyle;
	items: string[];
	indent: string;
	/** End of the value region. A block sequence includes its item lines. */
	blockEnd: number;
}

interface Block {
	prefix: string;
	open: string;
	yaml: string;
	close: string;
	content: string;
	eol: string;
}

interface SourceLine {
	text: string;
	start: number;
	end: number;
}

function blockOf(markdown: string): Block | null {
	const prefix = markdown.startsWith('\uFEFF') ? '\uFEFF' : '';
	const body = markdown.slice(prefix.length);
	const match = /^(---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/.exec(body);
	if (!match) return null;
	return {
		prefix,
		open: match[1]!,
		yaml: match[2]!,
		close: match[3]!,
		content: body.slice(match[0].length),
		eol: match[1]!.includes('\r\n') ? '\r\n' : '\n'
	};
}

function splitLines(text: string, base: number): SourceLine[] {
	const lines: SourceLine[] = [];
	let start = 0;
	for (let index = 0; index <= text.length; index++) {
		if (index !== text.length && text[index] !== '\n') continue;
		const raw = text.slice(start, index);
		const value = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
		lines.push({ text: value, start: base + start, end: base + start + value.length });
		start = index + 1;
	}
	return lines;
}

/** Splits an inline value from a trailing YAML comment outside quoted text. */
function splitInlineComment(raw: string): { value: string; separator: string; comment: string } {
	let single = false;
	let double = false;
	for (let index = 0; index < raw.length; index++) {
		const character = raw[index]!;
		if (character === "'" && !double) {
			if (single && raw[index + 1] === "'") index++;
			else single = !single;
		} else if (character === '"' && !single) {
			if (double && raw[index - 1] === '\\') continue;
			double = !double;
		} else if (character === '#' && !single && !double) {
			if (index === 0 || /\s/.test(raw[index - 1]!)) {
				const before = raw.slice(0, index);
				const value = before.trimEnd();
				return { value, separator: before.slice(value.length), comment: raw.slice(index) };
			}
		}
	}
	const value = raw.trimEnd();
	return { value, separator: raw.slice(value.length), comment: '' };
}

function unquote(raw: string): string {
	const trimmed = raw.trim();
	if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'"))
		return trimmed.slice(1, -1).replaceAll("''", "'");
	if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
		return trimmed
			.slice(1, -1)
			.replace(/\\(["\\/bfnrt])/g, (_match, code: string) => {
				const escapes: Record<string, string> = {
					'"': '"',
					'\\': '\\',
					'/': '/',
					b: '\b',
					f: '\f',
					n: '\n',
					r: '\r',
					t: '\t'
				};
				return escapes[code] ?? code;
			})
			.trim();
	}
	return trimmed;
}

/** Splits a flow sequence body on commas that are outside quotes and brackets. */
function splitList(inner: string): string[] {
	const items: string[] = [];
	let current = '';
	let single = false;
	let double = false;
	let depth = 0;
	for (let index = 0; index < inner.length; index++) {
		const character = inner[index]!;
		if (character === "'" && !double) {
			if (single && inner[index + 1] === "'") {
				current += "''";
				index++;
				continue;
			}
			single = !single;
			current += character;
		} else if (character === '"' && !single) {
			if (double && inner[index - 1] === '\\') {
				current += character;
				continue;
			}
			double = !double;
			current += character;
		} else if (!single && !double && (character === '[' || character === '{')) {
			depth++;
			current += character;
		} else if (!single && !double && (character === ']' || character === '}')) {
			depth--;
			current += character;
		} else if (character === ',' && !single && !double && depth === 0) {
			items.push(current);
			current = '';
		} else current += character;
	}
	items.push(current);
	return items.map((item) => unquote(item)).filter(Boolean);
}

function parseSequenceItem(line: string): { item: string; indent: string } | null {
	const match = /^([ \t]+)-(?:[ \t]+(.*))?$/.exec(line);
	if (!match) return null;
	if (!match[2]) return null;
	const { value, comment } = splitInlineComment(match[2]);
	if (comment || !value) return null;
	const trimmed = value.trim();
	const quoted = /^['"]/.test(trimmed);
	if (!quoted) {
		// A nested sequence, mapping, explicit key or flow collection is not a
		// scalar tag. Keep it in the source instead of rewriting it as text.
		if (/^[-?:[{]/.test(trimmed)) return null;
		if (/:(\s|$)/.test(trimmed)) return null;
	}
	const item = unquote(value);
	return item ? { item, indent: match[1]! } : null;
}

function finishRange(range: LineRange, end: number, yaml: string): void {
	range.end = end;
	range.blockEnd = range.valueEnd;
	const newline = yaml.indexOf('\n', range.valueEnd);
	if (newline === -1 || newline >= end) {
		range.style = range.inline === '' ? 'empty' : 'inline';
		return;
	}
	const continuation = yaml.slice(newline + 1, end);
	const lines = splitLines(continuation, newline + 1).filter((line) => line.text.trim() !== '');
	if (lines.length === 0) {
		range.style = range.inline === '' ? 'empty' : 'inline';
		return;
	}
	const commentOnly = lines.filter((line) => /^[ \t]*#/.test(line.text));
	const meaningful = lines.filter((line) => !/^[ \t]*#/.test(line.text));
	if (meaningful.length === 0) {
		range.style = range.inline === '' ? 'empty' : 'inline';
		return;
	}
	if (range.inline !== '') {
		range.style = /^[|>]/.test(range.inline) ? 'block-scalar' : 'unsupported';
		return;
	}
	if (commentOnly.length > 0) {
		// A rewrite would remove an inner comment. Keep the source authoritative.
		range.style = 'unsupported';
		return;
	}
	const items: string[] = [];
	let indent = '';
	let blockEnd = range.valueEnd;
	for (const line of lines) {
		const parsed = parseSequenceItem(line.text);
		if (!parsed) {
			range.style = 'mapping';
			return;
		}
		indent ||= parsed.indent;
		if (parsed.indent !== indent) {
			range.style = 'unsupported';
			return;
		}
		items.push(parsed.item);
		blockEnd = line.end;
	}
	range.style = 'block-sequence';
	range.items = items;
	range.indent = indent;
	range.blockEnd = blockEnd;
}

function keyRanges(yaml: string): LineRange[] {
	const ranges: LineRange[] = [];
	let current: LineRange | null = null;
	for (const line of splitLines(yaml, 0)) {
		const match = /^([A-Za-z0-9_.-]+)[ \t]*:([ \t]*)(.*)$/.exec(line.text);
		if (!match) continue;
		if (current) finishRange(current, line.start, yaml);
		const key = match[1]!;
		const afterColon = match[2]!.length;
		const valueStart = line.start + key.length + 1 + afterColon;
		const { value, separator, comment } = splitInlineComment(match[3] ?? '');
		current = {
			key,
			start: line.start,
			end: yaml.length,
			valueStart,
			valueEnd: valueStart + value.length,
			inline: value,
			separator,
			comment,
			spaceBeforeValue: afterColon > 0,
			style: 'inline',
			items: [],
			indent: '  ',
			blockEnd: valueStart + value.length
		};
		ranges.push(current);
	}
	if (current) finishRange(current, yaml.length, yaml);
	return ranges;
}

/**
 * A decimal YAML number. The YAML parser also accepts a leading sign, a leading
 * dot, a trailing dot and an exponent. Underscores stay strings, as in the parser.
 */
const NUMERIC_LITERAL = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;

/**
 * Parses a complete numeric input. Returns null for blank text, an intermediate
 * sign or dot, an exponent marker alone and every non-finite result.
 */
export function parseNumericInput(text: string): number | null {
	const trimmed = text.trim();
	if (!NUMERIC_LITERAL.test(trimmed)) return null;
	const value = Number(trimmed);
	return Number.isFinite(value) ? value : null;
}

function classify(key: string, raw: string): FrontmatterProperty['kind'] {
	if (key === 'tags' || key === 'aliases') return 'tags';
	const trimmed = raw.trim();
	if (/^\[[\s\S]*\]$/.test(trimmed)) return 'tags';
	if (trimmed === '') return 'other';
	if (/^['"]/.test(trimmed)) return 'string';
	if (/^(true|false)$/i.test(trimmed)) return 'boolean';
	if (NUMERIC_LITERAL.test(trimmed)) return 'number';
	if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return 'date';
	return 'string';
}

function valueOf(kind: FrontmatterProperty['kind'], raw: string): FrontmatterValue {
	const text = unquote(raw);
	if (kind === 'tags') {
		const trimmed = raw.trim();
		if (trimmed.startsWith('[') && trimmed.endsWith(']')) return splitList(trimmed.slice(1, -1));
		return splitList(text);
	}
	if (kind === 'boolean') return text.toLowerCase() === 'true';
	if (kind === 'number') return Number(text);
	return text;
}

/** Returns top-level front matter properties without changing the source. */
export function readFrontmatterProperties(markdown: string): FrontmatterProperty[] {
	const block = blockOf(markdown);
	if (!block) return [];
	const properties: FrontmatterProperty[] = [];
	for (const range of keyRanges(block.yaml)) {
		if (range.style === 'block-sequence') {
			properties.push({
				key: range.key,
				kind: 'tags',
				raw: block.yaml.slice(range.valueStart, range.blockEnd),
				value: range.items
			});
			continue;
		}
		if (
			range.style === 'mapping' ||
			range.style === 'block-scalar' ||
			range.style === 'unsupported'
		)
			continue;
		const kind = classify(range.key, range.inline);
		properties.push({
			key: range.key,
			kind,
			raw: range.inline,
			value: valueOf(kind, range.inline)
		});
	}
	return properties;
}

/** Returns every top-level YAML key, including styles the panel cannot edit. */
export function readFrontmatterKeys(markdown: string): string[] {
	const block = blockOf(markdown);
	if (!block) return [];
	return [...new Set(keyRanges(block.yaml).map((range) => range.key))];
}

const YAML_NON_STRING = [
	/^(?:~|null|Null|NULL)$/,
	/^(?:true|True|TRUE|false|False|FALSE)$/,
	/^[-+]?[0-9][0-9_]*(?:\.[0-9_]*)?(?:[eE][-+]?[0-9]+)?$/,
	/^[-+]?\.[0-9_]+(?:[eE][-+]?[0-9]+)?$/,
	/^[-+]?0[xX][0-9a-fA-F_]+$/,
	/^[-+]?0[oO][0-7_]+$/,
	/^[-+]?0[bB][01_]+$/,
	/^[-+]?\.(?:inf|Inf|INF|nan|NaN|NAN)$/,
	/^\d{4}-\d{1,2}-\d{1,2}(?:[Tt ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s*(?:Z|[-+]\d{1,2}(?::\d{2})?))?)?$/
];

/**
 * Quotes a string when YAML would read the plain form as another type or when
 * the plain form is not valid at the start of a scalar.
 */
function hasControlCharacters(value: string): boolean {
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

function quote(value: string): string {
	if (hasControlCharacters(value)) return JSON.stringify(value);
	const needsQuotes =
		value.length === 0 ||
		value.trim() !== value ||
		/^[-?:,[\]{}#&*!|>'"%@`]/.test(value) ||
		/:\s|\s#/.test(value) ||
		/[[]{}]/.test(value) ||
		value.includes(':') ||
		YAML_NON_STRING.some((pattern) => pattern.test(value));
	if (!needsQuotes) return value;
	return `'${value.replaceAll("'", "''")}'`;
}

function quoteOrPlain(value: string): string {
	return quote(value);
}

function renderValue(
	value: FrontmatterValue,
	previous: LineRange | undefined,
	eol: string
): string {
	if (value === null) return '';
	if (Array.isArray(value)) {
		const items = value.map((item) => quoteOrPlain(String(item)));
		if (previous?.style === 'block-sequence')
			return `${eol}${items.map((item) => `${previous.indent}- ${item}`).join(eol)}`;
		return `[${items.join(', ')}]`;
	}
	if (typeof value === 'boolean') return value ? 'true' : 'false';
	if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
	return quote(value);
}

/** Applies one property. A null or empty string removes the key. */
export function setFrontmatterProperty(
	markdown: string,
	key: string,
	value: FrontmatterValue
): string {
	if (!/^[A-Za-z0-9_.-]+$/.test(key)) throw new Error('Invalid front matter key');
	const normalized = Array.isArray(value)
		? value.map((item) => item.trim()).filter(Boolean)
		: typeof value === 'string'
			? value.trim()
			: value;
	const remove =
		normalized === null ||
		normalized === '' ||
		(Array.isArray(normalized) && normalized.length === 0);
	const block = blockOf(markdown);
	if (!block) {
		if (remove) return markdown;
		const prefix = markdown.startsWith('\uFEFF') ? '\uFEFF' : '';
		const body = markdown.slice(prefix.length);
		const eol = body.includes('\r\n') ? '\r\n' : '\n';
		return `${prefix}---${eol}${key}: ${renderValue(normalized, undefined, eol)}${eol}---${eol}${eol}${body}`;
	}
	const ranges = keyRanges(block.yaml);
	const range = ranges.find((entry) => entry.key === key);
	if (remove) {
		if (!range) return markdown;
		const before = block.yaml.slice(0, range.start);
		const after = block.yaml.slice(range.end);
		const merged = before + after;
		if (merged === '' || merged === '\n' || merged === '\r\n') {
			// Do not leave a blank line between the delimiters.
			return `${block.prefix}${block.open.trimEnd()}${block.close}${block.content}`;
		}
		const yaml = merged.replace(/\r?\n$/, '');
		return `${block.prefix}${block.open}${yaml}${block.close}${block.content}`;
	}
	if (
		range?.style === 'mapping' ||
		range?.style === 'block-scalar' ||
		range?.style === 'unsupported'
	)
		throw new Error(`Unsupported YAML value for ${key}`);
	const renderedValue = renderValue(normalized, range, block.eol);
	let rendered = renderedValue;
	if (range && range.style !== 'block-sequence') {
		if (rendered !== '' && range.inline === '' && !range.spaceBeforeValue)
			rendered = ` ${rendered}`;
		if (rendered !== '' && range.comment !== '' && range.separator === '')
			rendered = `${rendered} `;
	}
	if (!range) {
		const yaml = `${block.yaml}${block.yaml ? block.eol : ''}${key}: ${rendered}`;
		return `${block.prefix}${block.open}${yaml}${block.close}${block.content}`;
	}
	const valueEnd = range.style === 'block-sequence' ? range.blockEnd : range.valueEnd;
	const yaml = block.yaml.slice(0, range.valueStart) + rendered + block.yaml.slice(valueEnd);
	return `${block.prefix}${block.open}${yaml}${block.close}${block.content}`;
}

/** Applies several properties in order. */
export function updateFrontmatter(
	markdown: string,
	changes: ReadonlyArray<{ key: string; value: FrontmatterValue }>
): string {
	return changes.reduce(
		(next, change) => setFrontmatterProperty(next, change.key, change.value),
		markdown
	);
}

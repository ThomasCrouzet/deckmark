// Lossless JSON tools. Formatting re-emits the original tokens and never
// parses then serializes values, so number lexemes, escapes and duplicate keys
// survive exactly.

export type JsonTokenType = 'string' | 'number' | 'literal' | 'punct' | 'other';

export interface JsonToken {
	type: JsonTokenType;
	raw: string;
	/** Zero-based source offset of the first character. */
	start: number;
}

export interface JsonAnalysis {
	valid: boolean;
	message?: string;
	line?: number;
	column?: number;
	duplicateKeys: string[];
}

export interface JsonFormatOptions {
	indent: string;
	eol: '\n' | '\r\n' | '\r';
}

export type JsonFormatResult = { ok: true; text: string } | { ok: false; reason: string };

function readString(text: string, start: number): number {
	let index = start + 1;
	while (index < text.length) {
		if (text[index] === '\\') {
			index += 2;
			continue;
		}
		if (text[index] === '"') return index + 1;
		index++;
	}
	return index;
}

/** Splits JSON into lexical tokens. Whitespace is not a token. */
export function tokenizeJson(text: string): JsonToken[] {
	const tokens: JsonToken[] = [];
	let index = 0;
	while (index < text.length) {
		const char = text[index]!;
		if (/\s/.test(char)) {
			index++;
			continue;
		}
		if (char === '"') {
			const end = readString(text, index);
			tokens.push({ type: 'string', raw: text.slice(index, end), start: index });
			index = end;
			continue;
		}
		if ('{}[]:,'.includes(char)) {
			tokens.push({ type: 'punct', raw: char, start: index });
			index++;
			continue;
		}
		const rest = text.slice(index);
		const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
		if (number) {
			tokens.push({ type: 'number', raw: number[0], start: index });
			index += number[0].length;
			continue;
		}
		const literal = /^(?:true|false|null)/.exec(rest);
		if (literal) {
			tokens.push({ type: 'literal', raw: literal[0], start: index });
			index += literal[0].length;
			continue;
		}
		tokens.push({ type: 'other', raw: char, start: index });
		index++;
	}
	return tokens;
}

/**
 * Structural validator that reports the first failing token. It locates the
 * error when the runtime JSON parser omits a source position.
 */
function findStructuralError(tokens: JsonToken[]): JsonToken | null {
	let index = 0;
	const fail = () => tokens[index] ?? tokens[tokens.length - 1] ?? null;
	const isValueStart = (token: JsonToken | undefined) =>
		!!token &&
		(token.raw === '{' ||
			token.raw === '[' ||
			token.type === 'string' ||
			token.type === 'number' ||
			token.type === 'literal');
	const parseValue = (): boolean => {
		const token = tokens[index];
		if (!token) return false;
		if (token.raw === '{' || token.raw === '[') {
			const close = token.raw === '{' ? '}' : ']';
			const object = token.raw === '{';
			index++;
			if (tokens[index]?.raw === close) {
				index++;
				return true;
			}
			while (index < tokens.length) {
				if (object) {
					if (tokens[index]?.type !== 'string') return false;
					index++;
					if (tokens[index]?.raw !== ':') return false;
					index++;
				}
				if (!parseValue()) return false;
				if (tokens[index]?.raw === ',') {
					index++;
					continue;
				}
				if (tokens[index]?.raw === close) {
					index++;
					return true;
				}
				return false;
			}
			return false;
		}
		if (!isValueStart(token)) return false;
		index++;
		return true;
	};
	if (!parseValue()) return fail();
	if (index !== tokens.length) return fail();
	return null;
}

function locate(text: string, position: number): { line: number; column: number } {
	const before = text.slice(0, Math.max(0, position));
	const lines = before.split(/\r\n?|\n/);
	return { line: lines.length, column: (lines[lines.length - 1]?.length ?? 0) + 1 };
}

/** Finds object keys that repeat within the same object. */
export function duplicateJsonKeys(tokens: JsonToken[]): string[] {
	const duplicates = new Set<string>();
	const stack: Array<Set<string> | null> = [];
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]!;
		if (token.raw === '{') {
			stack.push(new Set());
			continue;
		}
		if (token.raw === '[') {
			stack.push(null);
			continue;
		}
		if (token.raw === '}' || token.raw === ']') {
			stack.pop();
			continue;
		}
		if (token.type !== 'string') continue;
		const next = tokens[index + 1];
		const current = stack[stack.length - 1];
		if (!current || next?.raw !== ':') continue;
		if (current.has(token.raw)) duplicates.add(token.raw);
		else current.add(token.raw);
	}
	return [...duplicates];
}

export function analyzeJson(text: string): JsonAnalysis {
	if (text.trim() === '') {
		return { valid: false, message: 'Empty document', line: 1, column: 1, duplicateKeys: [] };
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const position = /position (\d+)/i.exec(message);
		const failing = position ? null : findStructuralError(tokenizeJson(text));
		const offset = position ? Number(position[1]) : failing?.start;
		const location = offset === undefined ? undefined : locate(text, offset);
		return {
			valid: false,
			message,
			...(location ? { line: location.line, column: location.column } : {}),
			duplicateKeys: []
		};
	}
	void value;
	return { valid: true, duplicateKeys: duplicateJsonKeys(tokenizeJson(text)) };
}

function emitIndent(depth: number, unit: string): string {
	return unit.repeat(Math.max(0, depth));
}

/** Re-indents JSON without changing any token value. */
export function formatJson(text: string, options: JsonFormatOptions): string {
	const tokens = tokenizeJson(text);
	let depth = 0;
	let output = '';
	let previous: JsonToken | undefined;
	const closing = (token: JsonToken) => token.raw === '}' || token.raw === ']';
	const emptyPair = (current: JsonToken) =>
		(previous?.raw === '{' && current.raw === '}') ||
		(previous?.raw === '[' && current.raw === ']');
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]!;
		if (token.raw === '{' || token.raw === '[') {
			output += token.raw;
			depth++;
			const next = tokens[index + 1];
			if (next && !closing(next)) output += options.eol + emitIndent(depth, options.indent);
		} else if (closing(token)) {
			depth--;
			if (emptyPair(token)) output += token.raw;
			else output += options.eol + emitIndent(depth, options.indent) + token.raw;
		} else if (token.raw === ',') {
			output += ',' + options.eol + emitIndent(depth, options.indent);
		} else if (token.raw === ':') {
			output += ': ';
		} else {
			output += token.raw;
		}
		previous = token;
	}
	return output;
}

export function minifyJson(text: string): string {
	return tokenizeJson(text)
		.map((token) => token.raw)
		.join('');
}

/** Validates JSON before a format or minify action. */
export function prepareJsonAction(
	text: string,
	action: 'format' | 'minify',
	options: JsonFormatOptions
): JsonFormatResult {
	const analysis = analyzeJson(text);
	if (!analysis.valid) {
		return {
			ok: false,
			reason: analysis.line
				? `Invalid JSON at line ${analysis.line}, column ${analysis.column}: ${analysis.message}`
				: (analysis.message ?? 'Invalid JSON')
		};
	}
	return {
		ok: true,
		text: action === 'format' ? formatJson(text, options) : minifyJson(text)
	};
}

/** Extension point for optional, local JSON Schema validation. */
export type JsonSchemaValidator = (value: unknown) => string[];
let schemaValidator: JsonSchemaValidator | null = null;

export function setJsonSchemaValidator(validator: JsonSchemaValidator | null): void {
	schemaValidator = validator;
}

export function validateJsonAgainstSchema(text: string): string[] {
	if (!schemaValidator) return [];
	try {
		return schemaValidator(JSON.parse(text));
	} catch {
		return [];
	}
}

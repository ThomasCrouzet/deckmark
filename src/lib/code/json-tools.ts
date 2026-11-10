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

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const LITERAL = /(?:true|false|null)/y;

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
		NUMBER.lastIndex = index;
		const number = NUMBER.exec(text);
		if (number) {
			tokens.push({ type: 'number', raw: number[0], start: index });
			index += number[0].length;
			continue;
		}
		LITERAL.lastIndex = index;
		const literal = LITERAL.exec(text);
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
	type Phase = 'keyOrEnd' | 'key' | 'colon' | 'valueOrEnd' | 'value' | 'commaOrEnd';
	const stack: { close: '}' | ']'; phase: Phase }[] = [];
	let rootRead = false;
	for (const token of tokens) {
		const frame = stack[stack.length - 1];
		if (frame) {
			if (
				(frame.phase === 'keyOrEnd' ||
					frame.phase === 'valueOrEnd' ||
					frame.phase === 'commaOrEnd') &&
				token.raw === frame.close
			) {
				stack.pop();
				continue;
			}
			if (frame.phase === 'commaOrEnd') {
				if (token.raw !== ',') return token;
				frame.phase = frame.close === '}' ? 'key' : 'value';
				continue;
			}
			if (frame.phase === 'key' || frame.phase === 'keyOrEnd') {
				if (token.type !== 'string') return token;
				frame.phase = 'colon';
				continue;
			}
			if (frame.phase === 'colon') {
				if (token.raw !== ':') return token;
				frame.phase = 'value';
				continue;
			}
			frame.phase = 'commaOrEnd';
		} else if (rootRead) return token;
		rootRead = true;
		if (token.raw === '{' || token.raw === '[') {
			stack.push({
				close: token.raw === '{' ? '}' : ']',
				phase: token.raw === '{' ? 'keyOrEnd' : 'valueOrEnd'
			});
		} else if (token.type !== 'string' && token.type !== 'number' && token.type !== 'literal')
			return token;
	}
	if (stack.length) return tokens[tokens.length - 1] ?? null;
	return null;
}

function locate(text: string, position: number): { line: number; column: number } {
	const before = text.slice(0, Math.max(0, position));
	const lines = before.split(/\r\n?|\n/);
	return { line: lines.length, column: (lines[lines.length - 1]?.length ?? 0) + 1 };
}

/**
 * Decodes a structurally valid JSON string token to its logical value. The fast
 * path avoids a parser call for the common unescaped key.
 */
function decodedJsonString(raw: string): string {
	if (!raw.includes('\\')) return raw.slice(1, -1);
	try {
		const value = JSON.parse(raw);
		return typeof value === 'string' ? value : raw;
	} catch {
		return raw;
	}
}

/**
 * Finds object keys that repeat within the same object. Keys compare by their
 * decoded value, so `"a"` and `"\u0061"` are the same JSON property. The raw
 * spelling of the repeated occurrence is kept for the diagnostic.
 */
export function duplicateJsonKeys(tokens: JsonToken[]): string[] {
	const duplicates = new Map<string, string>();
	const stack: Array<Map<string, string> | null> = [];
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]!;
		if (token.raw === '{') {
			stack.push(new Map());
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
		const key = decodedJsonString(token.raw);
		if (current.has(key)) {
			if (!duplicates.has(key)) duplicates.set(key, token.raw);
		} else current.set(key, token.raw);
	}
	return [...duplicates.values()];
}

export function analyzeJsonDocument(text: string): {
	analysis: JsonAnalysis;
	value?: unknown;
	tokens?: JsonToken[];
} {
	if (text.trim() === '') {
		return {
			analysis: { valid: false, message: 'Empty document', line: 1, column: 1, duplicateKeys: [] }
		};
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
			analysis: {
				valid: false,
				message,
				...(location ? { line: location.line, column: location.column } : {}),
				duplicateKeys: []
			}
		};
	}
	const tokens = tokenizeJson(text);
	return { analysis: { valid: true, duplicateKeys: duplicateJsonKeys(tokens) }, value, tokens };
}

export function analyzeJson(text: string): JsonAnalysis {
	return analyzeJsonDocument(text).analysis;
}

function emitIndent(depth: number, unit: string): string {
	return unit.repeat(Math.max(0, depth));
}

/** Re-indents JSON without changing any token value. */
export function formatJson(text: string, options: JsonFormatOptions): string {
	return formatJsonTokens(tokenizeJson(text), options);
}

function formatJsonTokens(tokens: JsonToken[], options: JsonFormatOptions): string {
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
	const { analysis, tokens } = analyzeJsonDocument(text);
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
		text:
			action === 'format'
				? formatJsonTokens(tokens!, options)
				: tokens!.map((token) => token.raw).join('')
	};
}

/** Extension point for optional, local JSON Schema validation. */
export type JsonSchemaValidator = (value: unknown) => string[];
let schemaValidator: JsonSchemaValidator | null = null;

export function setJsonSchemaValidator(validator: JsonSchemaValidator | null): void {
	schemaValidator = validator;
}

export function hasJsonSchemaValidator(): boolean {
	return schemaValidator !== null;
}

export type JsonSchemaStatus = 'none' | 'valid' | 'invalid' | 'failed' | 'unavailable';

export interface JsonSchemaResult {
	status: JsonSchemaStatus;
	issues: string[];
	message?: string;
}

/** Reports an explicit schema state. A throwing validator is never "valid". */
export function validateJsonValueAgainstSchemaDetailed(value: unknown): JsonSchemaResult {
	if (!schemaValidator) return { status: 'none', issues: [] };
	try {
		const issues = schemaValidator(value);
		return issues.length > 0 ? { status: 'invalid', issues } : { status: 'valid', issues: [] };
	} catch (error) {
		return {
			status: 'failed',
			issues: [],
			message: error instanceof Error ? error.message : String(error)
		};
	}
}

export function validateJsonValueAgainstSchema(value: unknown): string[] {
	const result = validateJsonValueAgainstSchemaDetailed(value);
	if (result.status === 'failed') throw new Error(result.message ?? 'Schema validation failed');
	return result.issues;
}

export function validateJsonAgainstSchema(text: string): string[] {
	if (!schemaValidator) return [];
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return [];
	}
	return validateJsonValueAgainstSchema(value);
}

import { describe, expect, it } from 'vitest';
import {
	analyzeJson,
	duplicateJsonKeys,
	formatJson,
	minifyJson,
	prepareJsonAction,
	tokenizeJson
} from './json-tools';

const options = { indent: '  ', eol: '\n' as const };

describe('JSON validation', () => {
	it('reports the line and column of a syntax error', () => {
		const result = analyzeJson('{\n  "a": 1,\n  "b":\n}');
		expect(result.valid).toBe(false);
		expect(result.line).toBe(4);
		expect(result.column).toBeGreaterThan(0);
	});

	it('keeps Unicode valid and reports empty input', () => {
		expect(analyzeJson('{"emoji":"🎉","accent":"cœur"}').valid).toBe(true);
		expect(analyzeJson('').valid).toBe(false);
	});

	it('detects duplicate keys at the same level only', () => {
		const tokens = tokenizeJson('{"a":1,"b":{"a":2},"a":3}');
		expect(duplicateJsonKeys(tokens)).toEqual(['"a"']);
		const analysis = analyzeJson('{"a":1,"a":2}');
		expect(analysis.valid).toBe(true);
		expect(analysis.duplicateKeys).toEqual(['"a"']);
	});
});

describe('lossless formatting', () => {
	const source =
		'{"big":12345678901234567890,"float":1.0,"escaped":"a\\u00e9","nested":[1,{"x":true}]}';

	it('formats and minifies to the same token stream', () => {
		const formatted = formatJson(source, options);
		expect(formatted).toContain('\n  "big": 12345678901234567890');
		expect(JSON.stringify(tokenizeJson(formatted).map((token) => token.raw))).toBe(
			JSON.stringify(tokenizeJson(source).map((token) => token.raw))
		);
		expect(minifyJson(formatted)).toBe(source);
	});

	it('preserves duplicate keys and number lexemes', () => {
		const text = '{"a":1,"a":2,"n":1e3,"zero":-0}';
		expect(minifyJson(formatJson(text, options))).toBe(text);
	});

	it('writes the requested line ending', () => {
		expect(formatJson('{"a":1,"b":2}', { indent: '    ', eol: '\r\n' })).toBe(
			'{\r\n    "a": 1,\r\n    "b": 2\r\n}'
		);
	});

	it('refuses invalid input before formatting', () => {
		expect(prepareJsonAction('{', 'format', options).ok).toBe(false);
		expect(prepareJsonAction('{"a":1}', 'minify', options)).toEqual({
			ok: true,
			text: '{"a":1}'
		});
	});
});

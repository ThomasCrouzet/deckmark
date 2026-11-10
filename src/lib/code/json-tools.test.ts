import { describe, expect, it, vi } from 'vitest';
import {
	analyzeJson,
	analyzeJsonDocument,
	duplicateJsonKeys,
	formatJson,
	minifyJson,
	prepareJsonAction,
	tokenizeJson,
	setJsonSchemaValidator,
	validateJsonAgainstSchema,
	validateJsonValueAgainstSchema,
	validateJsonValueAgainstSchemaDetailed
} from './json-tools';

const options = { indent: '  ', eol: '\n' as const };

describe('optional schema callback compatibility', () => {
	it('shares the parsed value and keeps callback output and exception behavior', () => {
		const parse = vi.spyOn(JSON, 'parse');
		try {
			setJsonSchemaValidator((value) => ((value as { n: number }).n === 2 ? ['schema issue'] : []));
			const document = analyzeJsonDocument('{"n":2}');
			expect(validateJsonValueAgainstSchema(document.value)).toEqual(['schema issue']);
			expect(parse).toHaveBeenCalledTimes(1);
			expect(validateJsonAgainstSchema('{"n":2}')).toEqual(['schema issue']);
			setJsonSchemaValidator(() => {
				throw new Error('validator failure');
			});
			expect(validateJsonValueAgainstSchemaDetailed(document.value)).toMatchObject({
				status: 'failed',
				issues: [],
				message: 'validator failure'
			});
			expect(() => validateJsonValueAgainstSchema(document.value)).toThrow('validator failure');
			expect(validateJsonAgainstSchema('{')).toEqual([]);
		} finally {
			setJsonSchemaValidator(null);
			parse.mockRestore();
		}
	});

	it('locates deeply nested invalid input when the engine omits the source position', () => {
		const parse = vi.spyOn(JSON, 'parse').mockImplementation(() => {
			throw new SyntaxError('Invalid JSON');
		});
		try {
			const result = analyzeJson('['.repeat(20_000) + '!' + ']'.repeat(20_000));
			expect(result.valid).toBe(false);
			expect(result.column).toBe(20_001);
		} finally {
			parse.mockRestore();
		}
	});
});

describe('large JSON tokenization', () => {
	it('keeps exact number lexemes for a large numeric array', () => {
		const text = `[${Array.from({ length: 100_000 }, (_, index) => `${index}.5e+2`).join(',')}]`;
		const tokens = tokenizeJson(text);
		expect(tokens).toHaveLength(200_001);
		expect(tokens[1]).toEqual({ type: 'number', raw: '0.5e+2', start: 1 });
		expect(formatJson(text, options).startsWith('[\n  0.5e+2,')).toBe(true);
		expect(minifyJson(formatJson(text, options))).toBe(text);
	});
});

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

describe('duplicate keys with equivalent spellings', () => {
	it('detects a key repeated through a Unicode escape', () => {
		expect(duplicateJsonKeys(tokenizeJson('{"a":1,"\\u0061":2}'))).toEqual(['"\\u0061"']);
		expect(duplicateJsonKeys(tokenizeJson('{"\\u0061":1,"a":2}'))).toEqual(['"a"']);
		expect(analyzeJson('{"a":1,"\\u0061":2}').duplicateKeys).toEqual(['"\\u0061"']);
	});

	it('detects escaped slash and quote spellings', () => {
		expect(duplicateJsonKeys(tokenizeJson('{"\\/":1,"/":2}'))).toEqual(['"/"']);
		expect(duplicateJsonKeys(tokenizeJson('{"\\"":1,"\\u0022":2}'))).toEqual(['"\\u0022"']);
	});

	it('detects equivalent surrogate pair spellings', () => {
		expect(duplicateJsonKeys(tokenizeJson('{"\\ud83c\\udf89":1,"🎉":2}'))).toEqual(['"🎉"']);
		expect(duplicateJsonKeys(tokenizeJson('{"🎉":1,"\\ud83c\\udf89":2}'))).toEqual([
			'"\\ud83c\\udf89"'
		]);
	});

	it('keeps different keys and separate nested scopes distinct', () => {
		expect(duplicateJsonKeys(tokenizeJson('{"\\u0061":1,"b":2}'))).toEqual([]);
		expect(duplicateJsonKeys(tokenizeJson('{"a":1,"b":{"a":2}}'))).toEqual([]);
		expect(duplicateJsonKeys(tokenizeJson('[{"a":1},{"a":2}]'))).toEqual([]);
		expect(duplicateJsonKeys(tokenizeJson('{"a":1,"\\u0062":2}'))).toEqual([]);
	});

	it('reports one diagnostic for three spellings of the same key', () => {
		expect(duplicateJsonKeys(tokenizeJson('{"a":1,"\\u0061":2,"\\u0061":3}'))).toEqual([
			'"\\u0061"'
		]);
	});

	it('stays linear on a large escaped-key document', () => {
		const text = `[${Array.from({ length: 20_000 }, () => '{"\\u0061":1,"a":2}').join(',')}]`;
		expect(duplicateJsonKeys(tokenizeJson(text))).toEqual(['"a"']);
		expect(formatJson(text, options)).toContain('"\\u0061": 1');
		expect(minifyJson(formatJson(text, options))).toBe(text);
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

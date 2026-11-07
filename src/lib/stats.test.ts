import { describe, it, expect } from 'vitest';
import { computeStats } from './stats';
import { computeSelectionStats } from './stats';
import fc from 'fast-check';
import { baselineSelection, baselineStats } from '../../e2e/fixtures/stats';

describe('computeStats', () => {
	it('ignores inline code markers', () => {
		const s = computeStats('Voir `npm run dev` pour lancer');
		expect(s.words).toBe(3);
	});

	it('removes Markdown heading markers', () => {
		const s = computeStats('# Titre\n\nUn paragraphe ici.');
		expect(s.words).toBe(4);
	});

	it('ignores code blocks', () => {
		const s = computeStats('Avant\n```\nconst x = 1\nconst y = 2\n```\nAprès');
		expect(s.words).toBe(2);
	});
});

describe('legacy statistics equivalence for issue 319', () => {
	const boundaries = [
		'',
		'\ufeff# Title\r\n\r\nword\rnext\u2028last\u2029end',
		'a\u0085b\u180ec\u200bd\u00a0e\u1680f\u2000g\u202fh\u205fi\u3000j',
		'a\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeffb',
		'\ud800a\udc00\ud83c\udf89\ud800\ud800\udc00',
		'```a```b`c`d``e``f```unclosed',
		'![a`x`b](u) [a```x```b](u) ![`](`)](u)',
		'[a ![alt](target) b](destination) [a](b)c [](d)',
		'[a\n# heading\nlabel](destination)\r## \n\ntext',
		'###\r\n\t\nword\n###no-space\n> # quoted\n***words___',
		'~~~code fence~~~\n$x y$ $$x y$$\n---\ntitle: words\n---',
		'![[nested](target) [nested [label](target) `a```b```c`',
		'a\r\nb\rc\nd\n',
		'`\n`# heading\n![x](\n)# heading\n',
		'![a](x)[b](y)![c](z) [x](a(b)c)'
	];

	it.each(boundaries)('preserves ordered stripping and raw UTF-16 counts for %j', (text) => {
		expect(computeStats(text)).toEqual(baselineStats(text));
		expect(computeSelectionStats(text)).toEqual(baselineSelection(text));
	});

	it('preserves malformed syntax and lone surrogates that editors can normalize', () => {
		const token = fc.constantFrom(
			'a',
			'b',
			' ',
			'\t',
			'\n',
			'\r',
			'\u2028',
			'\u2029',
			'\ufeff',
			'\u00a0',
			'\u200b',
			'\ud800',
			'\udc00',
			'🎉',
			'#',
			'*',
			'_',
			'~',
			'>',
			'!',
			'[',
			']',
			'(',
			')',
			'`',
			'```',
			'](',
			'![',
			'$',
			'## '
		);
		fc.assert(
			fc.property(fc.array(token, { maxLength: 100 }), (tokens) => {
				const text = tokens.join('');
				expect(computeStats(text)).toEqual(baselineStats(text));
				expect(computeSelectionStats(text)).toEqual(baselineSelection(text));
			}),
			{ seed: 319, numRuns: 10_000 }
		);
	});
});

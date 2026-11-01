import { describe, expect, it } from 'vitest';
import { remark } from 'remark';
import { stripFrontmatter } from './frontmatter';
import { SourceFidelity } from './source-fidelity';

const processor = remark();
const parse = (value: string) => processor.parse(value);
const normalize = (value: string) => String(processor.processSync(value));

function editor(source: string, baseline?: string) {
	return new SourceFidelity(source, baseline ?? normalize(source), parse, normalize);
}

describe('source span preservation', () => {
	it('changes one word and keeps nearby syntax', () => {
		const fidelity = editor('Heading\n=======\n\nA small bird. Keep &amp; this.\n');
		expect(fidelity.restore('# Heading\n\nA bright bird. Keep & this.\n')).toBe(
			'Heading\n=======\n\nA bright bird. Keep &amp; this.\n'
		);
	});

	it('replaces text across inline marks', () => {
		const fidelity = editor('Keep _this_.\n\nThe __small__ bird sings.\n');
		expect(fidelity.restore('Keep *this*.\n\nThe bright bird sings.\n')).toBe(
			'Keep _this_.\n\nThe bright bird sings.\n'
		);
	});

	it('targets the second identical sentence in one leaf', () => {
		const fidelity = editor('A small bird. Keep &amp; this. A small bird.\n');
		expect(fidelity.restore('A small bird. Keep & this. A bright bird.\n')).toBe(
			'A small bird. Keep &amp; this. A bright bird.\n'
		);
	});

	it('targets the second identical block', () => {
		const fidelity = editor('* A small bird.\n\nA small bird.\n\nA small bird.\n');
		expect(fidelity.restore('* A small bird.\n\nA bright bird.\n\nA small bird.\n')).toBe(
			'* A small bird.\n\nA bright bird.\n\nA small bird.\n'
		);
	});

	it('splits a block and keeps its neighbors', () => {
		const fidelity = editor('Heading\n=======\n\nFirst. Second.\n\n_Keep_.\n');
		expect(fidelity.restore('# Heading\n\nFirst.\n\nSecond.\n\n*Keep*.\n')).toBe(
			'Heading\n=======\n\nFirst.\n\nSecond.\n\n_Keep_.\n'
		);
	});

	it('joins blocks and keeps its neighbors', () => {
		const fidelity = editor('Heading\n=======\n\nFirst.\n\nSecond.\n\n_Keep_.\n');
		expect(fidelity.restore('# Heading\n\nFirst. Second.\n\n*Keep*.\n')).toBe(
			'Heading\n=======\n\nFirst. Second.\n\n_Keep_.\n'
		);
	});

	it('adds delimiters for a new mark', () => {
		const fidelity = editor('Keep _this_.\n\nA small bird.\n');
		expect(fidelity.restore('Keep *this*.\n\nA **small** bird.\n')).toBe(
			'Keep _this_.\n\nA **small** bird.\n'
		);
	});

	it('removes delimiters with a removed mark', () => {
		const fidelity = editor('Keep _this_.\n\nA __small__ bird.\n');
		expect(fidelity.restore('Keep *this*.\n\nA small bird.\n')).toBe(
			'Keep _this_.\n\nA small bird.\n'
		);
	});

	it('keeps CRLF when text and blocks change', () => {
		const fidelity = editor('Heading\r\n=======\r\n\r\nA small bird.\r\n');
		expect(fidelity.restore('# Heading\n\nA bright bird.\n\nAnother bird.\n')).toBe(
			'Heading\r\n=======\r\n\r\nA bright bird.\r\n\r\nAnother bird.\r\n'
		);
	});

	it('keeps the BOM prefix through the editor source boundary', () => {
		const source = '\uFEFF---\r\ntitle: Bird\r\n---\r\n\r\nA small bird.\r\n';
		const { raw, content } = stripFrontmatter(source);
		expect(raw + editor(content).restore('A bright bird.\n')).toBe(
			'\uFEFF---\r\ntitle: Bird\r\n---\r\n\r\nA bright bird.\r\n'
		);
	});

	it('keeps a document without a final newline', () => {
		expect(editor('A small bird.').restore('A bright bird.\n')).toBe('A bright bird.');
	});

	it('keeps empty input and inserts its first block', () => {
		const fidelity = editor('');
		expect(fidelity.restore('')).toBe('');
		expect(fidelity.restore('A bird.\n')).toBe('A bird.');
	});

	it('rejects an unsafe code delimiter patch and serializes the changed block', () => {
		const fidelity = editor('Heading\n=======\n\n`bird`\n');
		expect(fidelity.restore('# Heading\n\n``bi`rd``\n')).toBe('Heading\n=======\n\n``bi`rd``\n');
	});

	it('uses the full serializer when both candidates fail the semantic check', () => {
		// This parser retains definitions. Neither candidate can match an inline link.
		const fidelity = editor('[bird][ref]\n\n[ref]: /bird\n', '[bird](/bird)\n');
		expect(fidelity.restore('[bright bird](/bird)\n')).toBe('[bright bird](/bird)\n');
	});

	it('returns the exact source on undo after a cached edit', () => {
		const fidelity = editor('A __small__ bird.');
		expect(fidelity.restore('A **bright** bird.\n')).toBe('A __bright__ bird.');
		expect(fidelity.restore('A **bright** bird.\n')).toBe('A __bright__ bird.');
		expect(fidelity.restore('A **small** bird.\n')).toBe('A __small__ bird.');
	});
});

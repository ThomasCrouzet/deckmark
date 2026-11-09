import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { remark } from 'remark';
import { stripFrontmatter } from './frontmatter';
import { SourceFidelity } from './source-fidelity';
import { noteContent } from '../../scripts/benchmark-fixtures/corpus.mjs';

const processor = remark();
const parse = (value: string) => processor.parse(value);
const normalize = (value: string) => String(processor.processSync(value));
let paths: string[] = [];
const observe = (event: Event) => paths.push((event as CustomEvent<string>).detail);

beforeEach(() => {
	paths = [];
	vi.stubEnv('VITE_SOURCE_FIDELITY_METRICS', '1');
	window.addEventListener('deckmark:source-fidelity', observe);
});

afterEach((context) => {
	window.removeEventListener('deckmark:source-fidelity', observe);
	vi.unstubAllEnvs();
	Object.assign(context.task.meta, {
		pathCounts: {
			fastPath: paths.filter((path) => path === 'fastPath').length,
			blockFallback: paths.filter((path) => path === 'blockFallback').length,
			fullSerializer: paths.filter((path) => path === 'fullSerializer').length
		}
	});
});

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
		expect(paths).toEqual(['blockFallback']);
	});

	it('uses the full serializer when both candidates fail the semantic check', () => {
		// This parser retains definitions. Neither candidate can match an inline link.
		const fidelity = editor('[bird][ref]\n\n[ref]: /bird\n', '[bird](/bird)\n');
		expect(fidelity.restore('[bright bird](/bird)\n')).toBe('[bright bird](/bird)\n');
		expect(paths).toEqual(['fullSerializer']);
	});

	it('returns the exact source on undo after a cached edit', () => {
		const fidelity = editor('A __small__ bird.');
		expect(fidelity.restore('A **bright** bird.\n')).toBe('A __bright__ bird.');
		expect(fidelity.restore('A **bright** bird.\n')).toBe('A __bright__ bird.');
		expect(fidelity.restore('A **small** bird.\n')).toBe('A __small__ bird.');
		// Both the accepted edit and the undo stay on the scoped path.
		expect(paths).toEqual(['fastPath', 'fastPath']);
	});
});

describe('bounded paragraph reconciliation', () => {
	function observed(source: string) {
		const parsed: number[] = [];
		const normalized: number[] = [];
		const baseline = normalize(source);
		const fidelity = new SourceFidelity(
			source,
			baseline,
			(value) => {
				parsed.push(value.length);
				return parse(value);
			},
			(value) => {
				normalized.push(value.length);
				return normalize(value);
			}
		);
		parsed.length = 0;
		return { fidelity, baseline, parsed, normalized };
	}

	it(
		'keeps rich note bytes without full-note parses for text edits at each position',
		{ timeout: 20_000 },
		() => {
			const source = noteContent(777, 240_000);
			const { fidelity, baseline, parsed, normalized } = observed(source);
			const anchor = 'Local benchmark text keeps the same words in every run.';
			const rawOffsets = [...source.matchAll(new RegExp(anchor, 'g'))].map((match) => match.index);
			const offsets = [...baseline.matchAll(new RegExp(anchor, 'g'))].map((match) => match.index);
			for (const index of [0, Math.floor(offsets.length / 2), offsets.length - 1]) {
				const at = offsets[index]! + 10;
				const rawAt = rawOffsets[index]! + 10;
				expect(fidelity.restore(baseline.slice(0, at) + 'X' + baseline.slice(at), false)).toBe(
					source.slice(0, rawAt) + 'X' + source.slice(rawAt)
				);
			}
			expect(parsed.length).toBeGreaterThan(0);
			expect(
				Math.max(...parsed),
				'eligible text edits must parse only a bounded region'
			).toBeLessThan(64 * 1024);
			expect(Math.max(0, ...normalized), 'normalization must also stay local').toBeLessThan(
				64 * 1024
			);
		}
	);

	it('keeps entities, mixed EOL and separate edits without accepting a rejected snapshot', () => {
		const source =
			'Heading\r\n=======\r\n\r\nA small bird. Keep &amp; this. A small bird.\n\n_Keep_.\r\n';
		const { fidelity, baseline, parsed } = observed(source);
		const accepted = baseline.replace('A small bird.', 'A bright bird.');
		const rejected = accepted.replace('Keep & this.', 'Discard this.');
		expect(fidelity.restore(accepted)).toBe(source.replace('A small bird.', 'A bright bird.'));
		expect(fidelity.restore(rejected, false)).toBe(
			source.replace('A small bird.', 'A bright bird.').replace('Keep &amp; this.', 'Discard this.')
		);
		expect(fidelity.restore(accepted)).toBe(source.replace('A small bird.', 'A bright bird.'));
		const next = accepted.replace('bird.\n', 'wren.\n');
		expect(fidelity.restore(next)).toBe(
			source.replace('A small bird.', 'A bright bird.').replace('bird.\n', 'wren.\n')
		);
		expect(fidelity.restore(baseline)).toBe(source);
		expect(Math.max(...parsed)).toBeLessThan(64 * 1024);
	});

	it('keeps consecutive plain-text edits in separate paragraphs scoped', () => {
		const source = `First paragraph.\n\n${'Pad text '.repeat(12_000)}\n\nThird paragraph.\n`;
		const { fidelity, baseline, parsed } = observed(source);
		const first = baseline.replace('First paragraph.', 'Bright paragraph.');
		expect(fidelity.restore(first)).toBe(source.replace('First paragraph.', 'Bright paragraph.'));
		const second = first.replace('Third paragraph.', 'Last paragraph.');
		expect(fidelity.restore(second)).toBe(
			source
				.replace('First paragraph.', 'Bright paragraph.')
				.replace('Third paragraph.', 'Last paragraph.')
		);
		expect(paths).toEqual(['fastPath', 'fastPath']);
		expect(
			Math.max(...parsed),
			'consecutive text edits must parse only a bounded region'
		).toBeLessThan(64 * 1024);
	});

	it('rebases after a whole-document fallback so the next text edit stays scoped', () => {
		const source = `First paragraph.\n\n${'Pad text '.repeat(12_000)}\n\nThird paragraph.\n`;
		const { fidelity, baseline, parsed } = observed(source);
		const changed = baseline
			.replace('First paragraph.', 'Bright paragraph.')
			.replace('Third paragraph.', 'Last paragraph.');
		expect(fidelity.restore(changed)).toBe(
			source
				.replace('First paragraph.', 'Bright paragraph.')
				.replace('Third paragraph.', 'Last paragraph.')
		);
		expect(
			Math.max(...parsed),
			'the multi-block edit needs the whole-document check'
		).toBeGreaterThan(64 * 1024);
		parsed.length = 0;
		const next = changed.replace('Bright paragraph.', 'Brisk paragraph.');
		expect(fidelity.restore(next)).toBe(
			source
				.replace('First paragraph.', 'Brisk paragraph.')
				.replace('Third paragraph.', 'Last paragraph.')
		);
		expect(Math.max(...parsed), 'a later text edit must reuse the accepted baseline').toBeLessThan(
			64 * 1024
		);
	});

	it('keeps a whole-document fallback for changed block structure and multiple blocks', () => {
		const source = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n';
		const { fidelity, baseline, parsed } = observed(source);
		const next = baseline.replace('First', 'Bright').replace('Third', 'Last');
		expect(fidelity.restore(next, false)).toBe(
			source.replace('First', 'Bright').replace('Third', 'Last')
		);
		expect(parsed).toContain(next.length);
		parsed.length = 0;
		const split = baseline.replace('Second paragraph.', 'Second.\n\nNew paragraph.');
		expect(fidelity.restore(split, false)).toBe(
			source.replace('Second paragraph.', 'Second.\n\nNew paragraph.')
		);
		expect(parsed).toContain(split.length);
	});

	it('uses a transaction block hint without comparing the whole note', () => {
		const paragraphs = Array.from(
			{ length: 2_000 },
			(_, index) => `Paragraph ${index} keeps a stable sentence.`
		);
		const source = `${paragraphs.join('\n\n')}\n`;
		const { fidelity, baseline, parsed } = observed(source);
		const tree = parse(baseline);
		const block = tree.children?.[tree.children.length - 1];
		const blockFrom = block?.position?.start.offset;
		const blockTo = block?.position?.end.offset;
		expect(blockFrom).toBeTypeOf('number');
		const at = blockFrom! + 10;
		const next = `${baseline.slice(0, at)}X${baseline.slice(at)}`;
		const delta = next.length - baseline.length;
		const counters: string[] = [];
		const observeCounter = (event: Event) => {
			const detail = (event as CustomEvent<{ kind: string; name: string }>).detail;
			if (detail.kind === 'counter') counters.push(detail.name);
		};
		window.addEventListener('deckmark:editor-perf', observeCounter);
		try {
			expect(
				fidelity.restore(next, true, {
					previousFrom: blockFrom!,
					previousTo: blockTo!,
					nextFrom: blockFrom!,
					nextTo: blockTo! + delta
				})
			).toBe(`${source.slice(0, at)}X${source.slice(at)}`);
		} finally {
			window.removeEventListener('deckmark:editor-perf', observeCounter);
		}
		expect(counters).toContain('sourceFidelityScopedHint');
		expect(Math.max(...parsed), 'the hint must keep parser input local').toBeLessThan(64 * 1024);
	});

	it('ignores a hint that does not align with the accepted baseline', () => {
		const source = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n';
		const { fidelity, baseline } = observed(source);
		const next = baseline.replace('Third paragraph.', 'Last paragraph.');
		expect(
			fidelity.restore(next, true, {
				previousFrom: 1,
				previousTo: 16,
				nextFrom: 1,
				nextTo: 16
			})
		).toBe(source.replace('Third paragraph.', 'Last paragraph.'));
	});

	it('does not use a scoped paragraph for a large text block', () => {
		const source = `Before.\n\n${'long word '.repeat(7_000)}\n\nAfter.\n`;
		const { fidelity, baseline, parsed } = observed(source);
		const next = baseline.replace('long word', 'long term');
		expect(fidelity.restore(next, false)).toBe(source.replace('long word', 'long term'));
		expect(parsed).toContain(next.length);
	});

	it('keeps unresolved reference text on the whole-document semantic route', () => {
		const source = 'A [bird] sings.\n\n[bright]: /bird\n';
		const fidelity = new SourceFidelity(source, 'A \\[bird] sings.\n', parse, normalize);
		const target = 'A \\[bright] sings.\n';
		expect(fidelity.restore(target)).toBe(target);
		expect(paths).toEqual(['fullSerializer']);
	});

	it('does not discard a changed paragraph gap as an unchanged text leaf', () => {
		const source = 'First paragraph.\n\nLast paragraph.\n';
		const { fidelity, baseline, parsed } = observed(source);
		const next = baseline.replace('First paragraph.\n', 'First paragraph.\n\n');
		expect(fidelity.restore(next, false)).toBe(
			source.replace('First paragraph.\n', 'First paragraph.\n\n')
		);
		expect(parsed).toContain(next.length);
	});
});

import { describe, expect, it } from 'vitest';
import {
	completeRenderedHeadings,
	documentHeadings,
	documentMatches,
	HeadingIdAllocator,
	invalidateDocumentTextIndex,
	invalidateRenderedHeadings,
	navigationScanStats,
	resetNavigationScanStats,
	resetSourceHeadingIndexCache,
	sourceHeadingIndex
} from './document-navigation';

function originalAllocate(headings: readonly string[]): string[] {
	const used = new Set<string>();
	const result: string[] = [];
	for (const base of headings) {
		let slug = base;
		let suffix = 2;
		while (used.has(slug)) slug = `${base}-${suffix++}`;
		used.add(slug);
		result.push(slug);
	}
	return result;
}

describe('document navigation', () => {
	it('shares one rendered heading projection until a DOM mutation invalidates it', () => {
		const root = document.createElement('article');
		root.innerHTML = '<h1>One</h1><h2>Two</h2>';
		const first = completeRenderedHeadings(root);
		expect(first.map((heading) => heading.text)).toEqual(['One', 'Two']);
		expect(completeRenderedHeadings(root)).toBe(first);
		root.querySelector('h1')!.textContent = 'Changed';
		expect(completeRenderedHeadings(root)).toBe(first);
		invalidateRenderedHeadings(root);
		expect(completeRenderedHeadings(root).map((heading) => heading.text)).toEqual([
			'Changed',
			'Two'
		]);
	});
	it('allocates heading IDs with the original suffix order', () => {
		const cases = [
			['x', 'x', 'x'],
			['x', 'x-2', 'x', 'x-2', 'x'],
			['x', 'x', 'x-2', 'x-3', 'x'],
			['section', 'section', 'section', 'section'],
			['', 'section-1', 'x']
		];
		for (const bases of cases) {
			const allocator = new HeadingIdAllocator();
			expect(bases.map((base) => allocator.allocate(base))).toEqual(originalAllocate(bases));
		}
	});
	it('finds real headings, including setext and repeated headings', () => {
		const source =
			'---\ntitle: Hidden\n---\n# First\n\n```md\n# Example\n```\n\nSecond\n------\n\n## First ##\n    # Indented';
		expect(documentHeadings(source)).toEqual([
			{ text: 'First', level: 1, line: 4 },
			{ text: 'Second', level: 2, line: 10 },
			{ text: 'First', level: 2, line: 13 }
		]);
	});
	it('bounds the outline and handles an unfinished code fence', () => {
		expect(documentHeadings('# Title\n~~~~\n# Code')).toHaveLength(1);
		expect(documentHeadings('# Title\n'.repeat(500))).toHaveLength(300);
	});
	it('finds text across inline marks without matching across paragraphs or hidden text', () => {
		const root = document.createElement('article');
		root.innerHTML =
			'<p>Before <strong>hello</strong> world.</p><p>next</p><span aria-hidden="true">hello world</span>';
		expect(documentMatches(root, 'HELLO world').map((range) => range.toString())).toEqual([
			'hello world'
		]);
		expect(documentMatches(root, 'world.next')).toEqual([]);
		expect(documentMatches(root, '  ')).toEqual([]);
	});
	it('uses literal search and bounds matches', () => {
		const root = document.createElement('div');
		root.textContent = 'a+b '.repeat(300);
		expect(documentMatches(root, 'a+b')).toHaveLength(200);
	});
	it('reuses one text map and rebuilds it after an invalidation', () => {
		const root = document.createElement('div');
		root.innerHTML = '<p>alpha <strong>beta</strong></p>';
		expect(documentMatches(root, 'alpha beta')[0]?.toString()).toBe('alpha beta');
		root.append(' gamma');
		expect(documentMatches(root, 'gamma')).toHaveLength(0);
		invalidateDocumentTextIndex(root);
		expect(documentMatches(root, 'gamma')[0]?.toString()).toBe('gamma');
	});
});

function largeSource(): string {
	const lines: string[] = ['# Title', ''];
	for (let index = 0; index < 1000; index++) {
		lines.push(`## Section ${index}`, '');
		lines.push(`Paragraph ${index} ${'representative text '.repeat(24)}`, '');
	}
	return lines.join('\n');
}

function headingSignature(
	headings: readonly { text: string; level: number; line: number; offset: number }[]
) {
	return headings.map(({ text, level, line, offset }) => ({ text, level, line, offset }));
}

describe('incremental source heading projection', () => {
	it('reparses only the edited line window for a one-character change in 1 MB', () => {
		const source = largeSource();
		resetSourceHeadingIndexCache();
		resetNavigationScanStats();
		const first = sourceHeadingIndex(source);
		const baseline = navigationScanStats();
		const editOffset = source.indexOf('Paragraph 500 ');
		const edited = `${source.slice(0, editOffset)}Paragraph 500 updated${source.slice(
			editOffset + 'Paragraph 500'.length
		)}`;
		const second = sourceHeadingIndex(edited);
		const after = navigationScanStats();
		expect(second.revision).toBeGreaterThan(first.revision);
		expect(after.incrementalParses).toBe(baseline.incrementalParses + 1);
		expect(after.fullParses).toBe(baseline.fullParses);
		// A 1 MB source has far more than 400 lines. The incremental parser must
		// stay inside its checkpoint window instead of scanning every line.
		expect(after.linesScanned - baseline.linesScanned).toBeLessThan(400);
		const shift = edited.length - source.length;
		const expected = first.headings.map((heading) => ({
			...heading,
			offset: heading.offset > editOffset ? heading.offset + shift : heading.offset
		}));
		expect(headingSignature(second.headings)).toEqual(headingSignature(expected));
	});

	it('keeps inserted and deleted headings exact against a full parse', () => {
		const source = largeSource();
		const cases = [
			source.replace('## Section 750', '## Section 750\n\n### Added heading'),
			source.replace('## Section 250\n\nParagraph 250', 'Paragraph 250'),
			source.replace(/^Paragraph 400 .*$/m, 'Setext title\n------------')
		];
		for (const edited of cases) {
			resetSourceHeadingIndexCache();
			const oracle = sourceHeadingIndex(edited);
			resetSourceHeadingIndexCache();
			sourceHeadingIndex(source);
			const incremental = sourceHeadingIndex(edited);
			expect(headingSignature(incremental.headings)).toEqual(headingSignature(oracle.headings));
		}
	});

	it('falls back to a full parse when a fence or frontmatter boundary changes', () => {
		const source = largeSource();
		const editOffset = source.indexOf('Paragraph 300 ');
		const fenced = `${source.slice(0, editOffset)}\`\`\`\n# Not a heading\n\`\`\`\n${source.slice(
			editOffset
		)}`;
		resetSourceHeadingIndexCache();
		const oracle = sourceHeadingIndex(fenced);
		resetSourceHeadingIndexCache();
		sourceHeadingIndex(source);
		const incremental = sourceHeadingIndex(fenced);
		expect(headingSignature(incremental.headings)).toEqual(headingSignature(oracle.headings));
		expect(incremental.headings.some((heading) => heading.text === 'Not a heading')).toBe(false);
		const yaml = `---\ntitle: Changed\n---\n${source}`;
		resetSourceHeadingIndexCache();
		const yamlOracle = sourceHeadingIndex(yaml);
		resetSourceHeadingIndexCache();
		sourceHeadingIndex(source);
		expect(headingSignature(sourceHeadingIndex(yaml).headings)).toEqual(
			headingSignature(yamlOracle.headings)
		);
	});

	it('reuses A and B indexes across alternating document switches', () => {
		const first = largeSource();
		const second = first.replace('## Section 999', '## Section 999 changed');
		resetSourceHeadingIndexCache();
		resetNavigationScanStats();
		sourceHeadingIndex(first);
		sourceHeadingIndex(second);
		const parsed = navigationScanStats().fullParses + navigationScanStats().incrementalParses;
		sourceHeadingIndex(first);
		sourceHeadingIndex(second);
		expect(navigationScanStats().fullParses + navigationScanStats().incrementalParses).toBe(parsed);
	});
});

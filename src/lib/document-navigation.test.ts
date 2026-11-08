import { describe, expect, it } from 'vitest';
import {
	documentHeadings,
	documentMatches,
	invalidateDocumentTextIndex
} from './document-navigation';

describe('document navigation', () => {
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

import { describe, expect, it } from 'vitest';
import {
	readFrontmatterProperties,
	setFrontmatterProperty,
	updateFrontmatter
} from './frontmatter-edit';

const source = `---\ntitle: "Hello"\n# keep this comment\ntags: [a, b]\ndraft: true\ncount: 3\n---\n\n# Body\n`;

describe('front matter property edits', () => {
	it('reads typed properties', () => {
		const properties = readFrontmatterProperties(source);
		expect(properties.find((entry) => entry.key === 'title')).toMatchObject({
			value: 'Hello',
			kind: 'string'
		});
		expect(properties.find((entry) => entry.key === 'tags')?.value).toEqual(['a', 'b']);
		expect(properties.find((entry) => entry.key === 'draft')?.value).toBe(true);
		expect(properties.find((entry) => entry.key === 'count')?.value).toBe(3);
	});

	it('changes only the edited value and keeps comments and other bytes', () => {
		const next = setFrontmatterProperty(source, 'title', 'World');
		expect(next).toBe(source.replace('title: "Hello"', 'title: World'));
		expect(next).toContain('# keep this comment');
	});

	it('adds and removes keys without touching the body', () => {
		const added = setFrontmatterProperty(source, 'author', 'Thomas');
		expect(added).toContain('author: Thomas');
		expect(added.endsWith('\n\n# Body\n')).toBe(true);
		expect(setFrontmatterProperty(added, 'author', null)).toBe(source);
	});

	it('creates a block for a document without front matter', () => {
		const next = setFrontmatterProperty('# Body\n', 'title', 'New');
		expect(next).toBe('---\ntitle: New\n---\n\n# Body\n');
	});

	it('applies several keys deterministically', () => {
		const next = updateFrontmatter(source, [
			{ key: 'title', value: 'Updated' },
			{ key: 'tags', value: ['x', 'y'] }
		]);
		expect(next).toContain('title: Updated');
		expect(next).toContain('tags: [x, y]');
	});

	it('preserves CRLF line endings', () => {
		const crlf = '---\r\ntitle: Hello\r\n---\r\n\r\nBody\r\n';
		const next = setFrontmatterProperty(crlf, 'title', 'World');
		expect(next).toBe('---\r\ntitle: World\r\n---\r\n\r\nBody\r\n');
	});

	it('rejects unsafe keys', () => {
		expect(() => setFrontmatterProperty(source, 'a: b', 'x')).toThrow('Invalid');
	});
});

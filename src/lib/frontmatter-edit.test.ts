import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from './frontmatter';
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

	it('reads block-style sequence values', () => {
		const block = '---\ntags:\n  - old\n  - obsolete\nstatus: draft\n---\n\n# Body\n';
		const tags = readFrontmatterProperties(block).find((entry) => entry.key === 'tags');
		expect(tags?.value).toEqual(['old', 'obsolete']);
		expect(tags?.kind).toBe('tags');
	});

	it('replaces a block-style sequence without leaving the old items', () => {
		const block = '---\ntags:\n  - old\n  - obsolete\nstatus: draft\n---\n\n# Body\n';
		const next = setFrontmatterProperty(block, 'tags', ['new']);
		expect(next).toBe('---\ntags:\n  - new\nstatus: draft\n---\n\n# Body\n');
		expect(readFrontmatterProperties(next).find((entry) => entry.key === 'tags')?.value).toEqual([
			'new'
		]);
		expect(setFrontmatterProperty(next, 'tags', ['new'])).toBe(next);
	});

	it('keeps CRLF and the block indentation when replacing a block sequence', () => {
		const block =
			'---\r\ntags:\r\n    - old\r\n    - obsolete\r\nstatus: draft\r\n---\r\n\r\nBody\r\n';
		const next = setFrontmatterProperty(block, 'tags', ['one', 'two']);
		expect(next).toBe(
			'---\r\ntags:\r\n    - one\r\n    - two\r\nstatus: draft\r\n---\r\n\r\nBody\r\n'
		);
	});

	it('keeps the BOM when replacing a block sequence', () => {
		const block = '\uFEFF---\ntags:\n  - old\n---\n\nBody\n';
		const next = setFrontmatterProperty(block, 'tags', ['new']);
		expect(next).toBe('\uFEFF---\ntags:\n  - new\n---\n\nBody\n');
	});

	it('keeps a trailing comment on an inline sequence', () => {
		const inline = '---\ntags: [old, obsolete] # keep\n---\n\nBody\n';
		const next = setFrontmatterProperty(inline, 'tags', ['new']);
		expect(next).toBe('---\ntags: [new] # keep\n---\n\nBody\n');
	});

	it('does not alter an unchanged block sequence when another key changes', () => {
		const block = '---\ntags:\n  - old\n  - obsolete\nstatus: draft\n---\n\nBody\n';
		const next = setFrontmatterProperty(block, 'status', 'final');
		expect(next).toBe('---\ntags:\n  - old\n  - obsolete\nstatus: final\n---\n\nBody\n');
	});

	it('does not offer a nested mapping as an editable property', () => {
		const nested = '---\nmeta:\n  owner: Ada\n  state: ready\ntitle: Nested\n---\n\nBody\n';
		const keys = readFrontmatterProperties(nested).map((entry) => entry.key);
		expect(keys).toEqual(['title']);
	});

	it('does not offer nested sequence or mapping items as editable tags', () => {
		const nested = '---\ntags:\n  - - nested\nmeta:\n  - owner: Ada\ntitle: Kept\n---\n\nBody\n';
		const keys = readFrontmatterProperties(nested).map((entry) => entry.key);
		expect(keys).toEqual(['title']);
	});

	it('keeps a BOM at offset zero when it creates front matter with CRLF', async () => {
		const next = setFrontmatterProperty('\uFEFF# Heading\r\n', 'title', 'Hello');
		expect(next).toBe('\uFEFF---\r\ntitle: Hello\r\n---\r\n\r\n# Heading\r\n');
		expect(next.charCodeAt(0)).toBe(0xfeff);
		expect([...new TextEncoder().encode(next).slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
		const parsed = await parseFrontmatter(next);
		expect(parsed.data).toEqual({ title: 'Hello' });
		expect(parsed.raw.startsWith('\uFEFF---')).toBe(true);
		expect(parsed.content).toBe('\r\n# Heading\r\n');
	});

	it('keeps a BOM at offset zero with LF and an empty body', async () => {
		expect(setFrontmatterProperty('\uFEFF# Heading\n', 'title', 'Hello')).toBe(
			'\uFEFF---\ntitle: Hello\n---\n\n# Heading\n'
		);
		expect(setFrontmatterProperty('\uFEFF', 'title', 'Hello')).toBe(
			'\uFEFF---\ntitle: Hello\n---\n\n'
		);
		expect(setFrontmatterProperty('', 'title', 'Hello')).toBe('---\ntitle: Hello\n---\n\n');
	});

	it('keeps a BOM when it edits or removes an existing block', () => {
		const withBlock = '\uFEFF---\r\ntitle: Old\r\n---\r\n\r\nBody\r\n';
		const edited = setFrontmatterProperty(withBlock, 'title', 'New');
		expect(edited).toBe('\uFEFF---\r\ntitle: New\r\n---\r\n\r\nBody\r\n');
		expect(setFrontmatterProperty(edited, 'title', null)).toBe('\uFEFF---\r\n---\r\n\r\nBody\r\n');
	});

	it('uses the line style of an existing block for a new key', () => {
		const mixed = '---\ntitle: Mixed\n---\r\n\r\nBody\r\n';
		const next = setFrontmatterProperty(mixed, 'author', 'Ada');
		expect(next).toBe('---\ntitle: Mixed\nauthor: Ada\n---\r\n\r\nBody\r\n');
	});

	it('keeps YAML-like text as a string after a real parse', async () => {
		const values = [
			'true',
			'false',
			'null',
			'Null',
			'~',
			'123',
			'0123',
			'1e3',
			'.5',
			'.nan',
			'.inf',
			'0x1f',
			'2026-11-09',
			'TRUE',
			'#tag',
			'a: b',
			'- item'
		];
		for (const value of values) {
			const next = setFrontmatterProperty('---\nauthor: Alice\n---\n', 'author', value);
			const parsed = await parseFrontmatter(next);
			expect(parsed.data.author, value).toBe(value);
		}
	});

	it('keeps explicit boolean and number fields typed', async () => {
		const boolean = setFrontmatterProperty('---\ndraft: true\n---\n', 'draft', false);
		expect(boolean).toBe('---\ndraft: false\n---\n');
		expect((await parseFrontmatter(boolean)).data.draft).toBe(false);
		const number = setFrontmatterProperty('---\ncount: 1\n---\n', 'count', 42);
		expect(number).toBe('---\ncount: 42\n---\n');
		expect((await parseFrontmatter(number)).data.count).toBe(42);
	});

	it('keeps every tag as a string and stays stable on a repeated save', async () => {
		const once = setFrontmatterProperty('---\ntags: [a]\n---\n', 'tags', [
			'123',
			'true',
			"O'Reilly"
		]);
		const parsed = await parseFrontmatter(once);
		expect(parsed.data.tags).toEqual(['123', 'true', "O'Reilly"]);
		expect(setFrontmatterProperty(once, 'tags', ['123', 'true', "O'Reilly"])).toBe(once);
		expect(readFrontmatterProperties(once).find((entry) => entry.key === 'tags')?.value).toEqual([
			'123',
			'true',
			"O'Reilly"
		]);
	});
});

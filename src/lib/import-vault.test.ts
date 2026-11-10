import { describe, expect, it } from 'vitest';
import { detectVaultKind, normalizeImportedProject } from './import-vault';

const base = { name: 'Vault', assets: [] };

describe('vault detection', () => {
	it('detects Obsidian and Notion layouts', () => {
		expect(detectVaultKind(['.obsidian/app.json', 'notes/a.md'])).toBe('obsidian');
		expect(detectVaultKind(['Notes/Page 0123456789abcdef0123456789abcdef.md'])).toBe('notion');
		expect(detectVaultKind(['notes/a.md'])).toBe('generic');
	});
});

describe('normalizeImportedProject', () => {
	it('strips an Obsidian wrapper and internal folders while keeping assets', () => {
		const result = normalizeImportedProject({
			...base,
			documents: [
				{ relativePath: 'Vault/notes/a.md', content: '[[b]]' },
				{ relativePath: 'Vault/.obsidian/app.json', content: '{}' }
			],
			assets: [{ path: 'Vault/assets/image.png', mime: 'image/png', data: new Uint8Array([1]) }]
		});
		expect(result.report.kind).toBe('obsidian');
		expect(result.input.documents[0]?.relativePath).toBe('notes/a.md');
		expect(result.input.assets[0]?.path).toBe('assets/image.png');
		expect(result.report.skipped.length).toBe(1);
	});

	it('removes Notion identifiers and resolves name collisions deterministically', () => {
		const result = normalizeImportedProject({
			...base,
			documents: [
				{ relativePath: 'Page 0123456789abcdef0123456789abcdef.md', content: 'a' },
				{ relativePath: 'Page.md', content: 'b' }
			],
			assets: []
		});
		expect(result.report.kind).toBe('notion');
		expect(result.input.documents.map((entry) => entry.relativePath)).toEqual([
			'Page.md',
			'Page (2).md'
		]);
		expect(result.report.renamed).toHaveLength(2);
	});

	it('keeps the original folders of a generic archive', () => {
		const result = normalizeImportedProject({
			...base,
			documents: [{ relativePath: 'notes/guide.md', content: '# Guide' }],
			assets: []
		});
		expect(result.report.kind).toBe('generic');
		expect(result.input.documents[0]?.relativePath).toBe('notes/guide.md');
	});

	it('keeps unsupported files as assets and reports them', () => {
		const result = normalizeImportedProject({
			...base,
			documents: [],
			assets: [{ path: 'Canvas.canvas', mime: 'application/json', data: new Uint8Array([1]) }]
		});
		expect(result.report.unsupported).toEqual(['Canvas.canvas']);
		expect(result.input.assets).toHaveLength(1);
	});
});

describe('normalizeImportedProject link rewriting', () => {
	it('rewrites a Notion page link and keeps the fragment', () => {
		const result = normalizeImportedProject({
			...base,
			documents: [
				{
					relativePath: 'Index 0123456789abcdef0123456789abcdef.md',
					content: '[Page](Page%200123456789abcdef0123456789abcdef.md#section)'
				},
				{ relativePath: 'Page 0123456789abcdef0123456789abcdef.md', content: '# Page' }
			]
		});
		expect(result.input.documents[0]?.content).toBe('[Page](Page.md#section)');
	});

	it('rewrites relative asset references after a wrapper root is removed', () => {
		const result = normalizeImportedProject({
			...base,
			documents: [
				{
					relativePath: 'Export/notes/Index.md',
					content: '![Logo](../assets/Logo%200123456789abcdef0123456789abcdef.png)'
				}
			],
			assets: [
				{
					path: 'Export/assets/Logo 0123456789abcdef0123456789abcdef.png',
					mime: 'image/png',
					data: new Uint8Array([1])
				}
			]
		});
		expect(result.input.documents[0]?.content).toBe('![Logo](../assets/Logo.png)');
		expect(result.input.assets[0]?.path).toBe('assets/Logo.png');
	});

	it('keeps duplicate basename links on their original sibling', () => {
		const result = normalizeImportedProject({
			...base,
			documents: [
				{
					relativePath: 'a/Index 0123456789abcdef0123456789abcdef.md',
					content:
						'[One](Page%200123456789abcdef0123456789abcdef.md) [Two](Page%20fedcba9876543210fedcba9876543210.md)'
				},
				{ relativePath: 'a/Page 0123456789abcdef0123456789abcdef.md', content: 'a' },
				{ relativePath: 'a/Page fedcba9876543210fedcba9876543210.md', content: 'b' }
			]
		});
		expect(result.input.documents.map((entry) => entry.relativePath)).toEqual([
			'Index.md',
			'Page.md',
			'Page (2).md'
		]);
		expect(result.input.documents[0]?.content).toBe('[One](Page.md) [Two](Page%20%282%29.md)');
	});

	it('rewrites Obsidian wikilinks to the renamed target', () => {
		const result = normalizeImportedProject({
			...base,
			documents: [
				{ relativePath: 'Vault/index.md', content: 'See [[a|the page]] and [[a#Heading]].' },
				{ relativePath: 'Vault/notes/a.md', content: '# A' }
			]
		});
		expect(result.input.documents[0]?.content).toBe(
			'See [[notes/a|the page]] and [[notes/a#Heading]].'
		);
	});

	it('keeps unresolved and remote destinations and reports the unresolved one', () => {
		const result = normalizeImportedProject({
			...base,
			documents: [
				{
					relativePath: 'notes/index.md',
					content: '[Missing](missing.md) [Remote](https://example.com/a.md) [[absent]]'
				}
			]
		});
		expect(result.input.documents[0]?.content).toBe(
			'[Missing](missing.md) [Remote](https://example.com/a.md) [[absent]]'
		);
		expect(result.report.links).toEqual([
			{ document: 'notes/index.md', destination: 'missing.md', reason: 'unresolved' },
			{ document: 'notes/index.md', destination: 'absent', reason: 'unresolved' }
		]);
	});

	it('does not rewrite links inside code or front matter', () => {
		const content = [
			'---',
			'link: "Page 0123456789abcdef0123456789abcdef.md"',
			'---',
			'`[c](Page%200123456789abcdef0123456789abcdef.md)`',
			'```',
			'[c](Page%200123456789abcdef0123456789abcdef.md)',
			'```'
		].join('\n');
		const result = normalizeImportedProject({
			...base,
			documents: [
				{ relativePath: 'Index 0123456789abcdef0123456789abcdef.md', content },
				{ relativePath: 'Page 0123456789abcdef0123456789abcdef.md', content: '# Page' }
			]
		});
		expect(result.input.documents[0]?.content).toBe(content);
	});
});

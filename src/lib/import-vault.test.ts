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

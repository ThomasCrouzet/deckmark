import { describe, it, expect } from 'vitest';
import { MetaIndex } from './meta-index';
import { WikiLinkIndex } from './wiki-link-index';
import type { FileItem } from './types';

function makeFile(partial: Partial<FileItem> & { id: string; name: string }): FileItem {
	return {
		content: '',
		createdAt: 0,
		updatedAt: 0,
		dirty: false,
		...partial
	};
}

function makeIndex(initial: FileItem[] = []) {
	const files: FileItem[] = [...initial];
	const index = new MetaIndex(() => files, undefined, WikiLinkIndex);
	return { index, files };
}

describe('MetaIndex - displayTitle', () => {
	it('returns the file name without .md when front matter is absent', () => {
		const { index, files } = makeIndex();
		const f = makeFile({ id: '3', name: 'note.md', content: '# Premier Titre\n\nbody' });
		files.push(f);
		expect(index.displayTitle('3')).toBe('note');
		expect(index.documentTitle('3')).toBe('Premier Titre');
	});

	it('returns the H1 when front matter has no title', () => {
		const { index, files } = makeIndex();
		const f = makeFile({
			id: '3b',
			name: 'note.md',
			content: '---\ntags: [foo]\n---\n# Mon Titre H1\n\nbody'
		});
		files.push(f);
		expect(index.displayTitle('3b')).toBe('Mon Titre H1');
	});

	it('uses YAML title before H1 and file name', () => {
		const { index, files } = makeIndex();
		const f = makeFile({
			id: '4',
			name: 'doc.md',
			content: '---\ntitle: YAML gagne\n---\n# H1 perd\n\nbody'
		});
		files.push(f);
		expect(index.displayTitle('4')).toBe('YAML gagne');
	});

	it('supports single quotes in a YAML title', () => {
		const { index, files } = makeIndex();
		const f = makeFile({ id: '5', name: 'q.md', content: "---\ntitle: 'Mon titre'\n---\n" });
		files.push(f);
		expect(index.displayTitle('5')).toBe('Mon titre');
	});
});

describe('MetaIndex - allTags', () => {
	it('lists all unique tags in alphabetical order', () => {
		const { index, files } = makeIndex();
		files.push(makeFile({ id: 'x', name: 'x.md', content: '---\ntags: [svelte, dev]\n---\n' }));
		files.push(makeFile({ id: 'y', name: 'y.md', content: '---\ntags: [dev, typescript]\n---\n' }));
		expect(index.allTags).toEqual(['dev', 'svelte', 'typescript']);
	});
});

describe('MetaIndex - backlinks', () => {
	it('excludes self-links', () => {
		const { index, files } = makeIndex();
		const self = makeFile({ id: 's', name: 'Self.md', content: '[[Self]]' });
		files.push(self);
		expect(index.backlinks('s')).toEqual([]);
	});

	it('finds names without case sensitivity', () => {
		const { index, files } = makeIndex();
		const target = makeFile({ id: 'ci', name: 'CasseSens.md', content: '' });
		const linker = makeFile({ id: 'li', name: 'Linker.md', content: '[[cassesens]]' });
		files.push(target, linker);
		const bl = index.backlinks('ci');
		expect(bl.map((f) => f.id)).toContain('li');
	});
});

describe('MetaIndex - resolveWikiLink', () => {
	it('uses an exact ID first', () => {
		const { index, files } = makeIndex();
		files.push(makeFile({ id: 'abc-123', name: 'note.md', content: '' }));
		expect(index.resolveWikiLink('abc-123')).toBe('abc-123');
	});

	it('finds a name without its extension or case sensitivity', () => {
		const { index, files } = makeIndex();
		files.push(makeFile({ id: 'n1', name: 'Mon Document.md', content: '' }));
		expect(index.resolveWikiLink('mon document')).toBe('n1');
	});
});

describe('MetaIndex - invalidateMeta cache updates', () => {
	it('invalidates the backlinks index until the next access', () => {
		const { index, files } = makeIndex();
		const target = makeFile({ id: 't', name: 'Target.md', content: '' });
		const src = makeFile({ id: 's', name: 'Src.md', content: '[[Target]]' });
		files.push(target, src);
		expect(index.backlinks('t').map((f) => f.id)).toContain('s');
		files[1]!.content = 'plus de lien';
		index.invalidateMeta('s');
		expect(index.backlinks('t')).toEqual([]);
	});
});

describe('MetaIndex - getMeta', () => {
	it('recalculates after content changes', () => {
		const { index, files } = makeIndex();
		const f = makeFile({ id: 'c2', name: 'doc.md', content: '---\ntitle: Ancien\n---\n' });
		files.push(f);
		const before = index.getMeta(f);
		f.content = '---\ntitle: Nouveau\n---\n';
		index.invalidateMeta('c2');
		const after = index.getMeta(f);
		expect(after.title).toBe('Nouveau');
		expect(before).not.toBe(after);
	});
});

describe('MetaIndex - front-matter fast path (supported subset)', () => {
	it('title quoted and unquoted match', () => {
		const { index, files } = makeIndex();
		files.push(makeFile({ id: 't1', name: 'a.md', content: '---\ntitle: Hello\n---\n# body\n' }));
		files.push(
			makeFile({ id: 't2', name: 'b.md', content: '---\ntitle: "Hello quoted"\n---\n# body\n' })
		);
		expect(index.displayTitle('t1')).toBe('Hello');
		expect(index.displayTitle('t2')).toBe('Hello quoted');
	});

	it('tags flow sequence and CSV single-line', () => {
		const { index, files } = makeIndex();
		files.push(makeFile({ id: 'g1', name: 'g1.md', content: '---\ntags: [alpha, beta]\n---\n' }));
		files.push(makeFile({ id: 'g2', name: 'g2.md', content: '---\ntags: gamma, delta\n---\n' }));
		expect(index.getTags('g1').sort()).toEqual(['alpha', 'beta']);
		expect(index.getTags('g2').sort()).toEqual(['delta', 'gamma']);
	});

	it('multiline tags block is out of fast-path scope (empty tags, no crash)', () => {
		const { index, files } = makeIndex();
		files.push(
			makeFile({
				id: 'ml',
				name: 'ml.md',
				content: '---\ntags:\n  - one\n  - two\ntitle: Multi\n---\n'
			})
		);
		expect(index.displayTitle('ml')).toBe('Multi');
		expect(index.getTags('ml')).toEqual([]);
	});
});

import { describe, expect, it } from 'vitest';
import { MetaIndex } from './meta-index';
import { projectWikiCandidates } from './project-paths';
import { documentKindForFile } from './document-kind';
import { stripMdExtension } from './file-utils';
import { extractWikiLinkTargets } from './wiki-links';
import type { FileItem } from './types';
import { WikiLinkIndex } from './wiki-link-index';

function note(id: string, path: string, projectId = 'p', content = ''): FileItem {
	return {
		id,
		name: path.split('/').pop()!,
		relativePath: path,
		projectId,
		content,
		createdAt: 1,
		updatedAt: 1,
		dirty: false,
		kind: 'note'
	};
}

function oldResolve(files: FileItem[], target: string, sourceId?: string): string | null {
	const source = files.find((file) => file.id === sourceId);
	if (source && documentKindForFile(source) !== 'note') return null;
	const notes = files.filter((file) => documentKindForFile(file) === 'note');
	const matches = source?.projectId
		? projectWikiCandidates(source, target, notes)
		: notes.find((file) => file.id === target.trim())
			? [notes.find((file) => file.id === target.trim())!]
			: notes.filter(
					(file) => stripMdExtension(file.name).toLowerCase() === target.trim().toLowerCase()
				);
	return matches.length === 1 ? matches[0]!.id : null;
}

function oldBacklinks(files: FileItem[], id: string): string[] {
	return files
		.filter(
			(file) =>
				file.id !== id &&
				documentKindForFile(file) === 'note' &&
				extractWikiLinkTargets(file.content).some(
					(target) => oldResolve(files, target, file.id) === id
				)
		)
		.map((file) => file.id);
}

describe('project wiki index equivalence and retained scaling risks', () => {
	it('keeps complete targets until publication and never derives them on location changes', () => {
		let files = [
			note('source', 'a/source.md', 'p', '[[first]]'),
			note('first', 'a/first.md'),
			note('second', 'a/second.md')
		];
		let derives = 0;
		const index = new WikiLinkIndex(
			() => files,
			(file) => {
				derives++;
				return extractWikiLinkTargets(file.content);
			}
		);
		expect(index.backlinks('first').map((file) => file.id)).toEqual(['source']);
		const before = derives;
		files[0]!.content = '[[second]]';
		index.updateLocation('source', files[0]);
		expect(derives).toBe(before);
		expect(index.backlinks('first').map((file) => file.id)).toEqual(['source']);
		expect(index.backlinks('second')).toEqual([]);
		index.publishTargets('source', ['second']);
		expect(index.backlinks('first')).toEqual([]);
		expect(index.backlinks('second').map((file) => file.id)).toEqual(['source']);
		files[0]!.relativePath = 'b/source.md';
		index.updateLocation('source', files[0]);
		expect(derives).toBe(before);
		files = files.filter((file) => file.id !== 'source');
		index.updateLocation('source', undefined);
		index.publishTargets('source', ['second']);
		expect(index.backlinks('second')).toEqual([]);
	});

	it('keeps original candidate priority and confinement for generated and hostile paths', () => {
		const paths = [
			'index.md',
			'a/Index.md',
			'a/index.mdx',
			'a/b/index.md',
			'a/b/INDEX.md',
			'a/b/same.md',
			'c/same.md',
			'a/b/caf\u00e9.md',
			'a/b/space name.md',
			'a/b/a%2Fb.md',
			'a/b/a(b).md',
			'a/b/plain.txt'
		];
		const files = paths.map((path, i) => note(`id-${i}`, path));
		files.push(note('other', 'a/b/index.md', 'q'), {
			...note('code', 'a/b/code.md'),
			kind: 'code'
		});
		for (let i = 0; i < 40; i++) files.push(note(`generated-${i}`, `folder-${i % 5}/item-${i}.md`));
		const index = new MetaIndex(() => files, undefined, WikiLinkIndex);
		const targets = [
			'',
			' ',
			'#part',
			'index',
			'index.md#part',
			'INDEX',
			'same',
			'../index',
			'../../index.md',
			'../../../index',
			'/index.md',
			'https://bad.invalid/index.md',
			'a%2Fb',
			'a%252Fb',
			'caf%C3%A9',
			'cafe\u0301',
			'space%20name',
			'a(b)',
			'plain.txt',
			'%ZZ',
			'..',
			'CON',
			'nul.md',
			'a\\b',
			'id-0',
			'code',
			'other',
			...files.flatMap((file) => [file.relativePath!, file.id])
		];
		for (const source of files) {
			for (const target of targets) {
				expect(index.resolveWikiLink(target, source.id), `${source.relativePath}: ${target}`).toBe(
					oldResolve(files, target, source.id)
				);
			}
		}
	});

	it('updates shadowed, ambiguous, moved, removed, restored, and cross-project references', () => {
		let files = [
			note('source', 'a/source.md', 'p', '[[target]] [[../target]] [[id-target]]'),
			note('id-target', 'target.md'),
			note('local', 'a/target.md'),
			note('second', 'b/second.md', 'p', '[[target]]'),
			note('outsider', 'outside.md', '', '[[target]]')
		];
		const index = new MetaIndex(() => files, undefined, WikiLinkIndex);
		const compare = () => {
			for (const file of files.filter((file) => file.projectId)) {
				expect(
					index.projectBacklinks(file.id).map((entry) => entry.id),
					file.id
				).toEqual(oldBacklinks(files, file.id));
			}
		};
		compare();
		const collision = note('collision', 'a/TARGET.md');
		files.push(collision);
		index.invalidateMeta(collision.id);
		compare();
		collision.relativePath = 'b/new.md';
		collision.name = 'new.md';
		index.invalidateMeta(collision.id);
		compare();
		files[0]!.content = '[[new]] [[target]]';
		index.invalidateMeta('source');
		compare();
		files[2]!.kind = 'code';
		index.invalidateMeta('local');
		compare();
		files[2]!.kind = 'note';
		index.invalidateMeta('local');
		compare();
		files[0]!.kind = 'code';
		index.invalidateMeta('source');
		compare();
		files[0]!.kind = 'note';
		index.invalidateMeta('source');
		compare();
		files[2]!.projectId = 'q';
		index.invalidateMeta('local');
		compare();
		const removed = files.splice(1, 1)[0]!;
		index.invalidateMeta(removed.id);
		compare();
		files.unshift(removed);
		index.invalidateMeta(removed.id);
		compare();
		files = files.map((file) =>
			file.id === 'source'
				? { ...file, content: '[[id-target]]', relativePath: 'new/source.md' }
				: file
		);
		index.invalidateMeta('source');
		compare();
		files = files.toReversed();
		compare();
		index.invalidateBacklinksIndex();
		compare();
	});

	it('keeps raw non-project backlinks and refreshes note type metadata', () => {
		const files = [
			note('target', 'target.md'),
			{ ...note('global', 'source.md', '', '[[target]]'), kind: 'code' as const } as FileItem
		];
		const index = new MetaIndex(() => files, undefined, WikiLinkIndex);
		expect(index.projectBacklinks('target')).toEqual([]);
		files[1]!.kind = 'note';
		index.invalidateMeta('global');
		expect(index.projectBacklinks('target').map((file) => file.id)).toEqual(['global']);
		expect(index.resolveWikiLink('target', 'global')).toBe('target');
		files[0]!.projectId = '';
		index.invalidateMeta('target');
		expect(index.backlinks('target').map((file) => file.id)).toEqual(['global']);
	});

	it('does not read unrelated paths or contents on warm lookups and one-source edits', () => {
		let reads = 0;
		const files = Array.from({ length: 600 }, (_, i) => {
			const file = note(`n-${i}`, `folder-${i % 30}/note-${i}.md`, 'p', `[[n-${(i + 1) % 600}]]`);
			let path = file.relativePath;
			Object.defineProperty(file, 'relativePath', {
				get() {
					reads++;
					return path;
				},
				set(value: string) {
					path = value;
				},
				enumerable: true
			});
			return file;
		});
		const index = new MetaIndex(() => files, undefined, WikiLinkIndex);
		expect(index.projectBacklinks('n-1').map((file) => file.id)).toEqual(['n-0']);
		reads = 0;
		for (let i = 0; i < 600; i++) {
			expect(index.resolveWikiLink(`n-${(i + 1) % 600}`, `n-${i}`)).toBe(`n-${(i + 1) % 600}`);
			index.projectBacklinks(`n-${i}`);
		}
		expect(reads).toBeLessThan(20_000);
		reads = 0;
		files[0]!.content = '[[n-2]]';
		index.invalidateMeta('n-0');
		expect(index.projectBacklinks('n-1')).toEqual([]);
		expect(index.projectBacklinks('n-2').map((file) => file.id)).toEqual(['n-0', 'n-1']);
		expect(reads).toBeLessThan(100);
	});
});

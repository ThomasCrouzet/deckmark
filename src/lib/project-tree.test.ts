import { describe, expect, it } from 'vitest';
import type { FileItem } from './types';
import { buildProjectTree } from './project-tree';

function file(index: number, relativePath: string, name = `note-${index}.md`): FileItem {
	return {
		id: `file-${index}`,
		name,
		content: '# Note\n',
		projectId: 'project',
		relativePath,
		createdAt: index,
		updatedAt: index,
		dirty: false
	};
}

describe('project tree build', () => {
	it('indexes thousands of sibling folders without a sibling scan', () => {
		const documents = Array.from({ length: 3000 }, (_, index) =>
			file(index, `folder-${String(index).padStart(4, '0')}/note.md`)
		);
		const started = performance.now();
		const { roots, stats } = buildProjectTree(documents, [{ id: 'project', name: 'Project' }]);
		const elapsedMs = performance.now() - started;
		expect(roots[0]?.folders).toHaveLength(3000);
		// Every folder is reached through one Map lookup. A linear search of the
		// sibling list would record at least 3000 * 2999 / 2 comparisons here.
		expect(stats.siblingScans).toBe(0);
		expect(stats.pathSegments).toBe(3000);
		expect(stats.folders).toBe(3000);
		expect(elapsedMs).toBeLessThan(2000);
	});

	it('keeps deep paths, root sorting, and file identity', () => {
		const { roots } = buildProjectTree(
			[
				file(0, 'zeta/deep/a.md', 'a.md'),
				file(1, 'alpha/b.md', 'b.md'),
				file(2, 'alpha/aa.md', 'aa.md'),
				file(3, 'alpha/deep/c.md', 'c.md')
			],
			[{ id: 'project', name: 'Project' }]
		);
		const alpha = roots[0]!.folders.find((folder) => folder.name === 'alpha')!;
		expect(alpha.folders.map((folder) => folder.name)).toEqual(['deep']);
		// Nested files keep the library order; only root siblings sort by name.
		expect(alpha.files.map((item) => item.name)).toEqual(['b.md', 'aa.md']);
		const deep = alpha.folders[0]!;
		expect(deep.path).toBe('alpha/deep');
		expect(deep.files.map((item) => item.relativePath)).toEqual(['alpha/deep/c.md']);
		expect(roots[0]!.folders.map((folder) => folder.name)).toEqual(['alpha', 'zeta']);
	});

	it('keeps project order independent from document order', () => {
		const { roots } = buildProjectTree(
			[
				{ ...file(0, 'a.md'), projectId: 'second' },
				{ ...file(1, 'b.md'), projectId: 'first' }
			],
			[
				{ id: 'second', name: 'Second' },
				{ id: 'first', name: 'First' }
			]
		);
		expect(roots.map((root) => root.name)).toEqual(['First', 'Second']);
	});
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, type DraftRow, type ProjectRow } from './db';
import { PROJECT_SCALE_LIMITS } from './project-limits';
import { filesStore } from './files.svelte';
import { importProjectEntries, transferProjectSelection } from './project-transfer';
import { importProject } from './projects';

vi.mock('./disk-sync', () => ({
	openFromDisk: vi.fn(async () => []),
	openPathsFromDesktop: vi.fn(async () => ({ files: [], processedTokens: [] })),
	openDirectoryFromDisk: vi.fn(async () => []),
	saveToDisk: vi.fn(async () => true),
	renameOnDisk: vi.fn(async () => true),
	unlinkFromDisk: vi.fn(async () => {}),
	refreshBrokenLinks: vi.fn(async () => {}),
	invalidateBrokenLinkChecks: vi.fn(),
	isDiskLinkingAvailable: vi.fn(() => false)
}));

const limits = { ...PROJECT_SCALE_LIMITS };
let sequence = 0;
const now = 1_000;

function project(id: string): ProjectRow {
	return { id, name: id, createdAt: now, updatedAt: now };
}

function binaryFile(bytes: Uint8Array, name: string, type: string): File {
	const copy = new Uint8Array(bytes);
	const file = new File([copy.buffer], name, { type });
	const buffer = copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength);
	Object.defineProperty(file, 'arrayBuffer', { value: async () => buffer });
	return file;
}

function draft(overrides: Partial<DraftRow> & Pick<DraftRow, 'id' | 'name'>): DraftRow {
	return {
		content: '# note',
		createdAt: now,
		updatedAt: now,
		order: sequence++,
		open: false,
		...overrides
	};
}

beforeEach(async () => {
	Object.assign(PROJECT_SCALE_LIMITS, limits);
	await Promise.all([db.projects.clear(), db.drafts.clear(), db.projectAssets.clear()]);
	await filesStore.reload(false);
});

afterEach(() => {
	Object.assign(PROJECT_SCALE_LIMITS, limits);
});

describe('project aggregate capacity', () => {
	it('rejects an import that pushes the destination project past maxBytes', async () => {
		PROJECT_SCALE_LIMITS.maxBytes = 4_096;
		await db.projects.add(project('p'));
		await db.projectAssets.add({
			id: 'existing',
			projectId: 'p',
			path: 'assets/existing.png',
			mime: 'image/png',
			data: new Uint8Array(3_072)
		});
		const file = binaryFile(new Uint8Array(2_048), 'extra.png', 'image/png');
		await expect(
			importProjectEntries('p', 'assets', [{ file, relativePath: 'extra.png' }])
		).rejects.toThrow('Project size limit');
		expect(await db.projectAssets.count()).toBe(1);
	});

	it('rejects a copy that pushes the destination past maxDocuments', async () => {
		PROJECT_SCALE_LIMITS.maxDocuments = 2;
		PROJECT_SCALE_LIMITS.maxEntries = 100;
		PROJECT_SCALE_LIMITS.maxBytes = 1_000_000;
		await db.projects.add(project('p'));
		await db.drafts.bulkAdd([
			draft({ id: 'a', name: 'a.md', projectId: 'p', relativePath: 'notes/a.md' }),
			draft({ id: 'b', name: 'b.md', projectId: 'p', relativePath: 'notes/b.md' }),
			draft({ id: 'library', name: 'library.md' })
		]);
		await filesStore.reload(false);
		await expect(
			transferProjectSelection(
				{ documentIds: ['library'] },
				{ mode: 'copy', targetProjectId: 'p', targetFolder: 'notes' }
			)
		).rejects.toThrow('Project document limit');
		expect(await db.drafts.where('projectId').equals('p').count()).toBe(2);
	});

	it('counts planned documents by UTF-8 bytes, not UTF-16 code units', async () => {
		PROJECT_SCALE_LIMITS.maxBytes = 10;
		await db.projects.add(project('p'));
		await db.drafts.add(
			draft({
				id: 'unicode',
				name: 'unicode.md',
				projectId: 'p',
				relativePath: 'notes/unicode.md',
				content: 'ééééé'
			})
		);
		const file = binaryFile(new Uint8Array(1), 'tiny.png', 'image/png');
		await expect(
			importProjectEntries('p', 'assets', [{ file, relativePath: 'tiny.png' }])
		).rejects.toThrow('Project size limit');
		expect(await db.projectAssets.count()).toBe(0);
	});

	it('rejects a copy that pushes the destination past maxBytes', async () => {
		PROJECT_SCALE_LIMITS.maxDocuments = 10;
		PROJECT_SCALE_LIMITS.maxEntries = 100;
		PROJECT_SCALE_LIMITS.maxBytes = 20;
		await db.projects.add(project('p'));
		await db.drafts.bulkAdd([
			draft({ id: 'a', name: 'a.md', projectId: 'p', relativePath: 'notes/a.md', content: 'x' }),
			draft({ id: 'library', name: 'library.md', content: 'y'.repeat(20) })
		]);
		await filesStore.reload(false);
		await expect(
			transferProjectSelection(
				{ documentIds: ['library'] },
				{ mode: 'copy', targetProjectId: 'p', targetFolder: 'notes' }
			)
		).rejects.toThrow('Project size limit');
		expect(await db.drafts.where('projectId').equals('p').count()).toBe(1);
	});

	it('rejects an import that pushes the destination past maxEntries', async () => {
		PROJECT_SCALE_LIMITS.maxDocuments = 10;
		PROJECT_SCALE_LIMITS.maxEntries = 4;
		PROJECT_SCALE_LIMITS.maxBytes = 1_000;
		await db.projects.add(project('p'));
		await db.drafts.bulkAdd([
			draft({ id: 'a', name: 'a.md', projectId: 'p', relativePath: 'notes/a.md' })
		]);
		const file = binaryFile(new Uint8Array(1), 'tiny.png', 'image/png');
		await expect(
			importProjectEntries('p', 'assets', [{ file, relativePath: 'tiny.png' }])
		).rejects.toThrow('Project entry limit');
		expect(await db.projectAssets.count()).toBe(0);
	});

	it('rejects a ZIP or folder import that exceeds the document limit', async () => {
		PROJECT_SCALE_LIMITS.maxDocuments = 1;
		PROJECT_SCALE_LIMITS.maxEntries = 100;
		PROJECT_SCALE_LIMITS.maxBytes = 1_000;
		await expect(
			importProject({
				name: 'too-large',
				documents: [
					{ relativePath: 'a.md', content: '# a' },
					{ relativePath: 'b.md', content: '# b' }
				],
				assets: []
			})
		).rejects.toThrow('Project document limit');
		expect(await db.projects.count()).toBe(0);
		expect(await db.drafts.count()).toBe(0);
	});

	it('does not count an internal move as new destination bytes', async () => {
		PROJECT_SCALE_LIMITS.maxDocuments = 10;
		PROJECT_SCALE_LIMITS.maxEntries = 100;
		PROJECT_SCALE_LIMITS.maxBytes = 32;
		await db.projects.add(project('p'));
		await db.drafts.bulkAdd([
			draft({
				id: 'a',
				name: 'a.md',
				projectId: 'p',
				relativePath: 'notes/a.md',
				content: 'x'.repeat(30)
			}),
			draft({ id: 'b', name: 'b.md', projectId: 'p', relativePath: 'notes/b.md', content: 'y' })
		]);
		await filesStore.reload(false);
		await expect(
			transferProjectSelection(
				{ projectId: 'p', documentIds: ['a'] },
				{ mode: 'move', targetProjectId: 'p', targetFolder: 'archive' }
			)
		).resolves.toMatchObject({ status: 'done', documents: 1 });
		expect((await db.drafts.get('a'))?.relativePath).toBe('archive/a.md');
	});
});

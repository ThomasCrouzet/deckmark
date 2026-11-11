import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, type DraftRow, type ProjectRow } from './db';
import { PROJECT_SCALE_LIMITS, projectOccupancy } from './project-limits';
import { filesStore } from './files.svelte';
import { importProjectEntries, transferProjectSelection } from './project-transfer';
import { createProjectDocument, importProject } from './projects';
import { encodeDraftManifest } from './draft-manifest-key';
import { decodeDraftManifest } from './draft-manifest';

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

function binaryDataUrl(bytes: number): string {
	return `data:image/png;base64,${Buffer.from(new Uint8Array(bytes).fill(1)).toString('base64')}`;
}

/** Writes a row and its stored index key without the Dexie write hook. */
async function writeRawDraft(row: DraftRow, manifest: string): Promise<void> {
	const idb = db.backendDB();
	await new Promise<void>((resolve, reject) => {
		const transaction = idb.transaction('drafts', 'readwrite');
		transaction.objectStore('drafts').put({ ...row, manifest });
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error);
	});
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

describe('project binary payload accounting', () => {
	it('counts a typed binary document payload in project occupancy', async () => {
		await db.projects.add(project('p'));
		await db.drafts.add(
			draft({
				id: 'image',
				name: 'photo.png',
				projectId: 'p',
				relativePath: 'photo.png',
				content: '',
				kind: 'image',
				mime: 'image/png',
				data: binaryDataUrl(900)
			})
		);
		expect((await projectOccupancy('p')).bytes).toBe(900);
	});

	it('reads a legacy manifest once and counts its binary payload', async () => {
		const row = draft({
			id: 'legacy',
			name: 'scan.pdf',
			projectId: 'p',
			relativePath: 'scan.pdf',
			content: '',
			kind: 'pdf',
			mime: 'application/pdf',
			data: `data:application/pdf;base64,${Buffer.from(new Uint8Array(700).fill(2)).toString('base64')}`
		});
		await writeRawDraft(row, encodeDraftManifest(row).replace(/,700\]$/, ']'));
		expect((await projectOccupancy('p')).bytes).toBe(700);
	});

	it('rejects a typed binary document that pushes import past maxBytes', async () => {
		PROJECT_SCALE_LIMITS.maxBytes = 100;
		await expect(
			importProject({
				name: 'binary',
				documents: [
					{
						relativePath: 'photo.png',
						content: '',
						kind: 'image',
						mime: 'image/png',
						data: binaryDataUrl(200)
					}
				],
				assets: []
			})
		).rejects.toThrow('Project size limit');
		expect(await db.projects.count()).toBe(0);
		expect(await db.drafts.count()).toBe(0);
		expect(await db.projectAssets.count()).toBe(0);
	});

	it('rejects a new document that pushes its project past maxBytes', async () => {
		PROJECT_SCALE_LIMITS.maxBytes = 32;
		await db.projects.add(project('p'));
		await db.drafts.add(
			draft({
				id: 'a',
				name: 'a.md',
				projectId: 'p',
				relativePath: 'a.md',
				content: 'x'.repeat(30)
			})
		);
		await filesStore.reload(false);
		await expect(createProjectDocument('p', 'b.md', 'y'.repeat(10))).rejects.toThrow(
			'Project size limit'
		);
		expect(await db.drafts.where('projectId').equals('p').count()).toBe(1);
	});
});

describe('manifest binary byte projection', () => {
	it('encodes and decodes the decoded payload length', () => {
		const row = draft({
			id: 'image',
			name: 'photo.png',
			projectId: 'p',
			relativePath: 'photo.png',
			content: '',
			kind: 'image',
			mime: 'image/png',
			data: binaryDataUrl(321)
		});
		const manifest = decodeDraftManifest(encodeDraftManifest(row));
		expect(manifest).toMatchObject({ id: 'image', contentBytes: 0, binaryBytes: 321 });
	});
});

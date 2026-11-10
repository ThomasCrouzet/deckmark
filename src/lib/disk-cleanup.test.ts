import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db, type DraftRow } from './db';

vi.mock('./fsa', () => ({
	getPathLinkWithEpoch: vi.fn(),
	getFsaLink: vi.fn(),
	isSameFileHandle: vi.fn(async (first: unknown, second: unknown) => first === second),
	listDiskLinks: vi.fn(async () => []),
	deleteHandle: vi.fn(async () => {}),
	saveHandle: vi.fn(async () => {}),
	savePathLink: vi.fn(async () => {})
}));

vi.mock('./desktop', () => ({
	isDesktop: vi.fn(() => true)
}));

vi.mock('./disk-tauri', () => ({
	tauriForgetPath: vi.fn(async () => {})
}));

import * as fsa from './fsa';
import * as desktop from './desktop';
import * as diskTauri from './disk-tauri';
import { bumpDiskLinkGeneration, saveFencedPathLink } from './disk-2';
import { deleteUnownedDiskLink } from './disk-cleanup';

const pathLink = {
	record: { kind: 'path' as const, path: '/tmp/note.md' },
	epoch: 'epoch'
};

let links: Awaited<ReturnType<typeof fsa.listDiskLinks>> = [];

function draftRow(id: string): DraftRow {
	return {
		id,
		name: `${id}.md`,
		content: '',
		createdAt: 0,
		updatedAt: 0,
		order: 0
	};
}

beforeEach(async () => {
	vi.clearAllMocks();
	vi.mocked(desktop.isDesktop).mockReturnValue(true);
	links = [];
	vi.mocked(fsa.listDiskLinks).mockImplementation(async () => links);
	vi.mocked(fsa.deleteHandle).mockImplementation(async (id) => {
		links = links.filter((link) => link.id !== id);
	});
	vi.mocked(fsa.savePathLink).mockImplementation(async (id, record) => {
		links = links.filter((link) => link.id !== id);
		links.push({ id, kind: 'path', path: record.path, label: 'note.md' });
	});
	vi.mocked(diskTauri.tauriForgetPath).mockResolvedValue(undefined);
	vi.mocked(fsa.getPathLinkWithEpoch).mockResolvedValue(pathLink);
	vi.mocked(fsa.getFsaLink).mockResolvedValue(null);
	await db.drafts.clear();
	await db.trashed.clear();
	await db.metadata.clear();
});

describe('deleteUnownedDiskLink fences', () => {
	it('keeps the link when a new owner appears after the first owner read', async () => {
		let release!: (value: typeof pathLink) => void;
		let reads = 0;
		vi.mocked(fsa.getPathLinkWithEpoch).mockImplementation(() => {
			reads += 1;
			if (reads === 1) {
				return new Promise((resolve) => {
					release = resolve;
				});
			}
			return Promise.resolve(pathLink);
		});

		const cleanup = deleteUnownedDiskLink('D');
		await vi.waitFor(() => expect(reads).toBe(1));
		await db.drafts.put(draftRow('D'));
		release(pathLink);
		await cleanup;

		expect(fsa.deleteHandle).not.toHaveBeenCalled();
		expect(diskTauri.tauriForgetPath).not.toHaveBeenCalled();
	});

	it('does not delete a link that moved to another path after the capture', async () => {
		const replacement = {
			record: { kind: 'path' as const, path: '/tmp/replacement.md' },
			epoch: 'epoch'
		};
		let reads = 0;
		vi.mocked(fsa.getPathLinkWithEpoch).mockImplementation(async () => {
			reads += 1;
			return reads === 1 ? pathLink : replacement;
		});
		links = [{ id: 'D', kind: 'path', path: '/tmp/replacement.md', label: 'replacement.md' }];

		await deleteUnownedDiskLink('D');

		expect(fsa.deleteHandle).not.toHaveBeenCalled();
		expect(diskTauri.tauriForgetPath).not.toHaveBeenCalled();
	});

	it('does not delete after the durable link generation rotates', async () => {
		let release!: (value: typeof pathLink) => void;
		vi.mocked(fsa.getPathLinkWithEpoch).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = resolve;
				})
		);
		vi.mocked(fsa.getPathLinkWithEpoch).mockResolvedValue(pathLink);

		const cleanup = deleteUnownedDiskLink('D');
		await vi.waitFor(() => expect(fsa.getPathLinkWithEpoch).toHaveBeenCalled());
		await bumpDiskLinkGeneration('D');
		release(pathLink);
		await cleanup;

		expect(fsa.deleteHandle).not.toHaveBeenCalled();
	});

	it('removes the last link and revokes its native grant', async () => {
		links = [{ id: 'D', kind: 'path', path: '/tmp/note.md', label: 'note.md' }];

		await deleteUnownedDiskLink('D');

		expect(fsa.deleteHandle).toHaveBeenCalledWith('D');
		expect(diskTauri.tauriForgetPath).toHaveBeenCalledWith('/tmp/note.md');
	});

	it('keeps a shared native grant until the final owner is gone', async () => {
		links = [
			{ id: 'D', kind: 'path', path: '/tmp/shared.md', label: 'shared.md' },
			{ id: 'E', kind: 'path', path: '/tmp/shared.md', label: 'shared.md' }
		];
		vi.mocked(fsa.getPathLinkWithEpoch).mockResolvedValue({
			record: { kind: 'path', path: '/tmp/shared.md' },
			epoch: 'epoch'
		});

		await deleteUnownedDiskLink('D');

		expect(fsa.deleteHandle).toHaveBeenCalledWith('D');
		expect(diskTauri.tauriForgetPath).not.toHaveBeenCalled();
	});

	it('does not revoke the grant when the handle delete fails', async () => {
		vi.mocked(fsa.deleteHandle).mockRejectedValueOnce(new Error('IndexedDB'));

		await expect(deleteUnownedDiskLink('D')).rejects.toThrow('IndexedDB');

		expect(diskTauri.tauriForgetPath).not.toHaveBeenCalled();
	});

	it('deletes an unowned browser handle without a native grant', async () => {
		vi.mocked(desktop.isDesktop).mockReturnValue(false);
		vi.mocked(fsa.getPathLinkWithEpoch).mockResolvedValue(null);
		vi.mocked(fsa.getFsaLink).mockResolvedValue({
			handle: {} as FileSystemFileHandle,
			revision: null,
			epoch: 'epoch'
		});

		await deleteUnownedDiskLink('D');

		expect(fsa.deleteHandle).toHaveBeenCalledWith('D');
		expect(diskTauri.tauriForgetPath).not.toHaveBeenCalled();
	});

	it('removes a stale record that no longer matches the epoch', async () => {
		vi.mocked(fsa.getPathLinkWithEpoch).mockResolvedValue(null);
		vi.mocked(fsa.getFsaLink).mockResolvedValue(null);

		await deleteUnownedDiskLink('D');

		expect(fsa.deleteHandle).toHaveBeenCalledWith('D');
		expect(diskTauri.tauriForgetPath).not.toHaveBeenCalled();
	});

	it('lets a queued relink write before the last grant is revoked', async () => {
		links = [{ id: 'D', kind: 'path', path: '/tmp/note.md', label: 'note.md' }];
		let releaseDelete!: () => void;
		vi.mocked(fsa.deleteHandle).mockImplementationOnce(
			(id) =>
				new Promise<void>((resolve) => {
					releaseDelete = () => {
						links = links.filter((link) => link.id !== id);
						resolve();
					};
				})
		);

		const cleanup = deleteUnownedDiskLink('D');
		await vi.waitFor(() => expect(fsa.deleteHandle).toHaveBeenCalledWith('D'));
		const relink = saveFencedPathLink('E', { kind: 'path', path: '/tmp/note.md' }, 'epoch');
		await vi.waitFor(() =>
			expect(fsa.savePathLink).toHaveBeenCalledWith(
				'E',
				{ kind: 'path', path: '/tmp/note.md' },
				'epoch',
				undefined
			)
		);
		releaseDelete();
		await Promise.all([cleanup, relink]);

		expect(diskTauri.tauriForgetPath).not.toHaveBeenCalled();
	});

	it('keeps the record when the link read fails', async () => {
		vi.mocked(fsa.getPathLinkWithEpoch).mockRejectedValueOnce(new Error('IndexedDB'));

		await expect(deleteUnownedDiskLink('D')).rejects.toThrow('IndexedDB');

		expect(fsa.deleteHandle).not.toHaveBeenCalled();
		expect(diskTauri.tauriForgetPath).not.toHaveBeenCalled();
	});
});

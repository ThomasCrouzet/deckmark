import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db, type WorkspaceRow } from './db';
import { workspaceStore } from './workspaces.svelte';
import { filesStore } from './files.svelte';

// Test the workspace rune singleton with fake-indexeddb.
// The store opens and closes files through filesStore while keeping them in the database.

function wsRow(id: string, name: string, fileIds: string[] = [], updatedAt = 1000): WorkspaceRow {
	return { id, name, fileIds, activeId: fileIds[0] ?? null, createdAt: 1000, updatedAt };
}

beforeEach(async () => {
	await Promise.all([db.drafts.clear(), db.trashed.clear(), db.workspaces.clear()]);
	localStorage.clear();
	await filesStore.reload(false);
	workspaceStore.workspaces = [];
	workspaceStore.loaded = false;
});

describe('workspaceStore.restore', () => {
	it('reopens closed workspace files and activates the target', async () => {
		const a = filesStore.createNew('a.md', '# A');
		const b = filesStore.createNew('b.md', '# B');
		filesStore.setActive(b.id);
		await filesStore.flushPending();
		const ws = await workspaceStore.save('Both');

		// Close B without deleting it from the database.
		filesStore.close(b.id, { trash: false, keepDB: true });
		expect(filesStore.files.some((f) => f.id === b.id)).toBe(false);

		await workspaceStore.restore(ws!.id);
		// Reopen B and restore the activeId target.
		expect(filesStore.files.some((f) => f.id === b.id)).toBe(true);
		expect(filesStore.files.some((f) => f.id === a.id)).toBe(true);
		expect(filesStore.activeId).toBe(b.id);
	});

	it('ignores deleted files and a missing activeId', async () => {
		workspaceStore.workspaces = [
			{
				...wsRow('missing', 'Missing', ['deleted']),
				activeId: 'deleted'
			}
		];

		await workspaceStore.restore('missing');

		expect(filesStore.files).toEqual([]);
		expect(filesStore.activeId).toBeNull();
	});

	it('keeps only the latest workspace when an older restore is slow', async () => {
		const a = filesStore.createNew('a.md', '# A');
		const b = filesStore.createNew('b.md', '# B');
		await filesStore.flushPending();
		filesStore.closeMany([a.id, b.id], { trash: false, keepDB: true });
		workspaceStore.workspaces = [wsRow('one', 'One', [a.id]), wsRow('two', 'Two', [b.id])];
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const flush = vi.spyOn(filesStore, 'flushPendingAwait').mockReturnValueOnce(gate);
		const first = workspaceStore.restore('one');
		const second = workspaceStore.restore('two');
		release();
		await Promise.all([first, second]);
		expect(filesStore.files.map((file) => file.id)).toEqual([b.id]);
		expect(filesStore.activeId).toBe(b.id);
		flush.mockRestore();
	});

	it('closes tabs outside the workspace without database deletion', async () => {
		// The workspace has {a}, and the current session has {a, b}.
		// Restore must close b in the view but keep it in the database through closeMany's keepDB branch.
		const a = filesStore.createNew('a.md', '# A');
		filesStore.setActive(a.id);
		await filesStore.flushPending();
		const ws = await workspaceStore.save('SeulementA');

		const b = filesStore.createNew('b.md', '# B');
		await filesStore.flushPending();
		expect(filesStore.files.some((f) => f.id === b.id)).toBe(true);

		await workspaceStore.restore(ws!.id);

		// File b left the view.
		expect(filesStore.files.some((f) => f.id === b.id)).toBe(false);
		// It remains in the database because keepDB is true.
		expect(await db.drafts.get(b.id)).toBeTruthy();
		expect(filesStore.activeId).toBe(a.id);
	});
});

describe('workspaceStore - IndexedDB failure paths', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('restores fields and position after an update failure', async () => {
		// Deux workspaces : on edite le PLUS ANCIEN (en queue) pour observer le
		// Roll back its position. It moves to the start, then must move down again.
		filesStore.createNew('seed.md', '');
		const wsOld = await workspaceStore.save('Old');
		const wsNew = await workspaceStore.save('New');
		// After save, the newest workspace, wsNew, is first.
		expect(workspaceStore.workspaces[0]?.id).toBe(wsNew!.id);

		const target = workspaceStore.workspaces.find((w) => w.id === wsOld!.id)!;
		const prevFileIds = target.fileIds;
		const prevActiveId = target.activeId;
		const prevUpdatedAt = target.updatedAt;
		const prevIdx = workspaceStore.workspaces.indexOf(target);
		expect(prevIdx).toBe(1); // en queue

		// Change the current state, then make persistence fail.
		filesStore.createNew('extra.md', '');
		const putSpy = vi
			.spyOn(db.workspaces, 'put')
			.mockRejectedValueOnce(new Error('IDB write failed'));

		await workspaceStore.update(wsOld!.id);
		expect(putSpy).toHaveBeenCalled();

		// Roll back all fields to their original values.
		const after = workspaceStore.workspaces.find((w) => w.id === wsOld!.id)!;
		expect(after.fileIds).toEqual(prevFileIds);
		expect(after.activeId).toBe(prevActiveId);
		expect(after.updatedAt).toBe(prevUpdatedAt);
		// Roll back to the original position at the end of the list.
		expect(workspaceStore.workspaces.indexOf(after)).toBe(prevIdx);
	});

	it('does not create a workspace after a save failure', async () => {
		vi.spyOn(db.workspaces, 'put').mockRejectedValueOnce(new Error('IDB write failed'));

		await expect(workspaceStore.save('Impossible')).resolves.toBeNull();

		expect(workspaceStore.workspaces).toEqual([]);
	});

	it('restores the name and date after a rename failure', async () => {
		const ws = await workspaceStore.save('Stable');
		const previousUpdatedAt = ws!.updatedAt;
		vi.spyOn(db.workspaces, 'put').mockRejectedValueOnce(new Error('IDB write failed'));

		await workspaceStore.rename(ws!.id, 'Fantôme');

		expect(ws!.name).toBe('Stable');
		expect(ws!.updatedAt).toBe(previousUpdatedAt);
	});

	it('keeps the workspace visible after a delete failure', async () => {
		const ws = await workspaceStore.save('Conserver');
		vi.spyOn(db.workspaces, 'delete').mockRejectedValueOnce(new Error('IDB delete failed'));

		await workspaceStore.delete(ws!.id);

		expect(workspaceStore.workspaces.some((candidate) => candidate.id === ws!.id)).toBe(true);
	});

	it('reports a bulkGet restore failure and stops cleanly', async () => {
		// The workspace refers to a file that is in the database but closed in the view.
		const a = filesStore.createNew('a.md', '# A');
		await filesStore.flushPending();
		const ws = await workspaceStore.save('AvecA');
		filesStore.close(a.id, { trash: false, keepDB: true });
		expect(filesStore.files.some((f) => f.id === a.id)).toBe(false);

		const openSpy = vi
			.spyOn(filesStore, 'openWorkspace')
			.mockRejectedValueOnce(new Error('IDB read failed'));

		// Do not reject. The internal catch reports the persistence error and returns.
		await expect(workspaceStore.restore(ws!.id)).resolves.toBeUndefined();
		expect(openSpy).toHaveBeenCalled();
		// A read failure stops restore, so file a does not reopen.
		expect(filesStore.files.some((f) => f.id === a.id)).toBe(false);
	});

	it('restore keeps every tab and in-memory revision when flush fails', async () => {
		const a = filesStore.createNew('a.md', '# version mémoire');
		await filesStore.flushPendingAwait();
		const ws = await workspaceStore.save('Stable');
		const b = filesStore.createNew('b.md', '# ne pas fermer');
		filesStore.updateContent(a.id, '# dernière révision');
		vi.spyOn(db.drafts, 'put').mockRejectedValue(new Error('IDB unavailable'));

		await workspaceStore.restore(ws!.id);

		expect(filesStore.files.map((file) => file.id)).toEqual([a.id, b.id]);
		expect(filesStore.files.find((file) => file.id === a.id)?.content).toBe('# dernière révision');
		expect(filesStore.files.find((file) => file.id === b.id)?.content).toBe('# ne pas fermer');
	});
});

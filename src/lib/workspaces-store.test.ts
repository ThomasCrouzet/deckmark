import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db, type WorkspaceRow } from './db';
import { workspaceStore } from './workspaces.svelte';
import { filesStore } from './files.svelte';
import { notify } from './notify.svelte';

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
		const updateSpy = vi
			.spyOn(db.workspaces, 'update')
			.mockRejectedValueOnce(new Error('IDB write failed'));

		await workspaceStore.update(wsOld!.id);
		expect(updateSpy).toHaveBeenCalled();

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
		vi.spyOn(db.workspaces, 'update').mockRejectedValueOnce(new Error('IDB write failed'));

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

describe('workspaceStore - concurrent write fencing', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	interface ControlledWrite {
		settled: boolean;
		resolve: () => void;
		reject: () => void;
	}

	function installWriteGate() {
		const realPut = db.workspaces.put.bind(db.workspaces);
		const realUpdate = db.workspaces.update.bind(db.workspaces);
		const pending: ControlledWrite[] = [];

		function hold<T>(commit: () => Promise<T>): Promise<T> {
			return new Promise<T>((resolve, reject) => {
				const entry: ControlledWrite = {
					settled: false,
					resolve: () => {
						entry.settled = true;
						void commit().then(resolve, reject);
					},
					reject: () => {
						entry.settled = true;
						reject(new Error('IDB write failed'));
					}
				};
				pending.push(entry);
			});
		}

		vi.spyOn(db.workspaces, 'put').mockImplementation(
			(row) => hold(() => realPut(row)) as unknown as ReturnType<typeof realPut>
		);
		vi.spyOn(db.workspaces, 'update').mockImplementation(
			(id, patch) => hold(() => realUpdate(id, patch)) as unknown as ReturnType<typeof realUpdate>
		);

		async function next(): Promise<ControlledWrite> {
			for (let attempt = 0; attempt < 50; attempt += 1) {
				const entry = pending.find((candidate) => !candidate.settled);
				if (entry) return entry;
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
			throw new Error('No pending workspace write');
		}

		return {
			next,
			/** A write from another tab bypasses the gate. */
			commitExternal: (id: string, patch: Partial<WorkspaceRow>) => realUpdate(id, patch)
		};
	}

	it('keeps the newer name when an older rename fails after the newer write', async () => {
		await workspaceStore.save('Original');
		const ws = workspaceStore.workspaces[0]!;
		const gate = installWriteGate();
		notify.clear();

		const older = workspaceStore.rename(ws.id, 'Older');
		const newer = workspaceStore.rename(ws.id, 'Newer');

		(await gate.next()).reject();
		(await gate.next()).resolve();
		await Promise.all([older, newer]);

		expect(ws.name).toBe('Newer');
		expect((await db.workspaces.get(ws.id))?.name).toBe('Newer');
		expect(notify.toasts.some((toast) => toast.level === 'error')).toBe(true);
	});

	it('keeps the newer tab set when an older update fails after the newer write', async () => {
		filesStore.createNew('a.md', '');
		await filesStore.flushPending();
		await workspaceStore.save('Tabs');
		const ws = workspaceStore.workspaces[0]!;
		const gate = installWriteGate();

		filesStore.createNew('b.md', '');
		const older = workspaceStore.update(ws.id);
		const olderWrite = await gate.next();
		filesStore.createNew('c.md', '');
		const newer = workspaceStore.update(ws.id);
		const expected = filesStore.files.map((file) => file.id);

		olderWrite.reject();
		(await gate.next()).resolve();
		await Promise.all([older, newer]);

		const durable = await db.workspaces.get(ws.id);
		expect(ws.fileIds).toEqual(expected);
		expect(durable?.fileIds).toEqual(expected);
		expect(workspaceStore.workspaces[0]?.id).toBe(ws.id);
	});

	it('rolls a latest update failure back to the last durable state', async () => {
		filesStore.createNew('a.md', '');
		await filesStore.flushPending();
		await workspaceStore.save('Durable');
		const ws = workspaceStore.workspaces[0]!;
		const gate = installWriteGate();

		filesStore.createNew('b.md', '');
		const older = workspaceStore.update(ws.id);
		(await gate.next()).resolve();
		await older;

		filesStore.createNew('c.md', '');
		const newer = workspaceStore.update(ws.id);
		(await gate.next()).reject();
		await newer;

		const durable = await db.workspaces.get(ws.id);
		expect(durable?.fileIds).toEqual(filesStore.files.slice(0, 2).map((file) => file.id));
		expect(ws.fileIds).toEqual(durable?.fileIds);
		expect(ws.updatedAt).toBe(durable?.updatedAt);
	});

	it('does not resurrect a deleted workspace when a pending update completes', async () => {
		await workspaceStore.save('Doomed');
		const ws = workspaceStore.workspaces[0]!;
		filesStore.createNew('next.md', '');
		const gate = installWriteGate();

		const update = workspaceStore.update(ws.id);
		const pendingWrite = await gate.next();
		const remove = workspaceStore.delete(ws.id);
		pendingWrite.resolve();
		await Promise.all([update, remove]);

		expect(workspaceStore.workspaces.some((candidate) => candidate.id === ws.id)).toBe(false);
		expect(await db.workspaces.get(ws.id)).toBeUndefined();
	});

	it('keeps another tab field when a rename commits', async () => {
		await workspaceStore.save('Original');
		const ws = workspaceStore.workspaces[0]!;
		const gate = installWriteGate();

		const rename = workspaceStore.rename(ws.id, 'Renamed');
		const pendingWrite = await gate.next();
		await gate.commitExternal(ws.id, { fileIds: ['from-other-tab'] });
		pendingWrite.resolve();
		await rename;

		const durable = await db.workspaces.get(ws.id);
		expect(durable?.name).toBe('Renamed');
		expect(durable?.fileIds).toEqual(['from-other-tab']);
		expect(ws.fileIds).toEqual(['from-other-tab']);
	});

	it('reloads to the durable rows after overlapping rename and update', async () => {
		filesStore.createNew('a.md', '');
		await filesStore.flushPending();
		await workspaceStore.save('Restart');
		const ws = workspaceStore.workspaces[0]!;
		filesStore.createNew('b.md', '');

		await Promise.all([workspaceStore.rename(ws.id, 'Final'), workspaceStore.update(ws.id)]);

		const durable = await db.workspaces.get(ws.id);
		const displayed = workspaceStore.workspaces.find((candidate) => candidate.id === ws.id)!;
		expect(displayed.name).toBe(durable?.name);
		expect(displayed.fileIds).toEqual(durable?.fileIds);
		expect(displayed.activeId).toBe(durable?.activeId);
		expect(displayed.updatedAt).toBe(durable?.updatedAt);

		await workspaceStore.reload();
		const reloaded = workspaceStore.workspaces.find((candidate) => candidate.id === ws.id)!;
		expect(reloaded.name).toBe(durable?.name);
		expect(reloaded.fileIds).toEqual(durable?.fileIds);
		expect(reloaded.updatedAt).toBe(durable?.updatedAt);
	});
});

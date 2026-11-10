import * as versionHistory from './version-history';
import { ImportSession } from './import-limits';
import { IMPORT_LIMITS } from './config';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Dexie from 'dexie';
import { db, type DraftRow } from './db';

vi.mock('./disk-sync', () => ({
	openFromDisk: vi.fn(async () => []),
	openPathsFromDesktop: vi.fn(async () => ({ files: [], processedTokens: [] })),
	openDirectoryFromDisk: vi.fn(async () => []),
	saveToDisk: vi.fn(async () => true),
	renameOnDisk: vi.fn(async () => true),
	unlinkFromDisk: vi.fn(async () => {}),
	refreshBrokenLinks: vi.fn(async () => {}),
	invalidateBrokenLinkChecks: vi.fn(),
	isDiskLinkingAvailable: vi.fn(() => true)
}));

const crossTabHarness = vi.hoisted(() => ({
	onMessage: undefined as ((message: unknown) => void) | undefined,
	post: vi.fn(),
	close: vi.fn(),
	workspaceReload: vi.fn(async () => {}),
	templateReload: vi.fn(async () => {})
}));

vi.mock('./cross-tab', () => ({
	createCrossTab: vi.fn((onMessage: (message: unknown) => void) => {
		crossTabHarness.onMessage = onMessage;
		return { post: crossTabHarness.post, close: crossTabHarness.close };
	})
}));

vi.mock('./workspaces.svelte', () => ({
	workspaceStore: { reload: crossTabHarness.workspaceReload }
}));

vi.mock('./templates.svelte', () => ({
	templatesStore: { reload: crossTabHarness.templateReload }
}));

vi.mock('./fsa', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./fsa')>();
	return {
		...actual,
		isFSASupported: vi.fn(() => false),
		listDiskLinks: vi.fn(async () => []),
		getHandle: vi.fn(async () => null),
		getPathLink: vi.fn(async () => null),
		pickDirectoryFiles: vi.fn(async () => ({
			files: [],
			truncated: false,
			report: new ImportSession().publish()
		}))
	};
});

import * as diskSync from './disk-sync';
import * as fsa from './fsa';
import * as trashOps from './trash';
import { filesStore } from './files.svelte';
import { notify } from './notify.svelte';
import type { CrossTabMessage } from './cross-tab';

// Test the FilesStore rune singleton with fake-indexeddb.
// The injected pure logic has separate test suites.

function draftRow(id: string, name: string, content = '', order = 0): DraftRow {
	return { id, name, content, createdAt: 1000, updatedAt: 1000, order };
}

function mdFile(name: string, content = '# x'): File {
	const f = new File([content], name, { type: 'text/markdown' });
	// jsdom's File may lack `.text()`; shim it so importFiles can read content.
	if (typeof f.text !== 'function') {
		Object.defineProperty(f, 'text', { value: async () => content });
	}
	return f;
}

function receiveCrossTab(message: CrossTabMessage): void {
	if (!crossTabHarness.onMessage) throw new Error('cross-tab non initialisé');
	crossTabHarness.onMessage(message);
}

beforeEach(async () => {
	vi.mocked(fsa.isFSASupported).mockReturnValue(false);
	vi.mocked(fsa.listDiskLinks).mockResolvedValue([]);
	vi.mocked(fsa.getHandle).mockResolvedValue(null);
	vi.mocked(fsa.getPathLink).mockResolvedValue(null);
	vi.mocked(fsa.pickDirectoryFiles).mockResolvedValue({
		files: [],
		truncated: false,
		report: new ImportSession().publish()
	});
	crossTabHarness.post.mockClear();
	crossTabHarness.workspaceReload.mockClear();
	crossTabHarness.templateReload.mockClear();
	notify.clear();
	await Promise.all([
		db.drafts.clear(),
		db.trashed.clear(),
		db.versions.clear(),
		db.workspaces.clear()
	]);
	localStorage.clear();
	// reload(false) cancels pending saves and timers, clears rune state, and reads the empty database.
	// This resets the singleton between tests.
	await filesStore.reload(false);
});

afterEach(() => {
	filesStore.selectionClear();
	notify.clear();
});

describe('close and restore from trash', () => {
	it('closes a view without document or history loss after reload', async () => {
		const file = filesStore.createNew('conserver.md', 'texte jamais exporté');
		await filesStore.flushPendingAwait();
		await db.versions.put({
			id: 'history',
			draftId: file.id,
			name: file.name,
			content: 'avant',
			createdAt: Date.now()
		});
		filesStore.updateContent(file.id, 'dernières frappes');
		filesStore.close(file.id);
		await filesStore.flushPendingAwait();
		await filesStore.reload(false);
		expect(filesStore.files).toEqual([]);
		expect(filesStore.closedFiles.find((entry) => entry.id === file.id)?.content).toBe(
			'dernières frappes'
		);
		expect(await db.versions.get('history')).toBeDefined();
		expect(filesStore.reopen(file.id)?.content).toBe('dernières frappes');
		await filesStore.flushPendingAwait();
		expect((await db.drafts.get(file.id))?.open).toBe(true);
	});

	it('keeps a deleted document recoverable after five seconds', async () => {
		const file = filesStore.createNew('supprimer.md', 'récupérable');
		await filesStore.flushPendingAwait();
		filesStore.delete(file.id);
		await vi.waitFor(async () => expect(await db.trashed.get(file.id)).toBeDefined());
		await db.trashed.update(file.id, { trashedAt: Date.now() - 60_000 });
		await filesStore.reload(false);
		expect(filesStore.trash.find((entry) => entry.file.id === file.id)?.file.content).toBe(
			'récupérable'
		);
		expect(filesStore.restore(file.id)?.content).toBe('récupérable');
		await vi.waitFor(async () =>
			expect((await db.drafts.get(file.id))?.content).toBe('récupérable')
		);
	});

	it('flushes pending edits before keepDB close', async () => {
		const f = filesStore.createNew('a.md', '# A');
		await filesStore.flushPendingAwait();
		// Edit inside the debounce window - cancel() would drop this; flush must persist it.
		filesStore.updateContent(f.id, '# Edited before workspace switch');
		filesStore.close(f.id, { trash: false, keepDB: true });
		await vi.waitFor(async () => {
			const row = await db.drafts.get(f.id);
			expect(row?.content).toBe('# Edited before workspace switch');
		});
	});

	it('does not restore a draft deleted during a write', async () => {
		let deletedId = '';
		const put = vi.spyOn(db.drafts, 'put').mockImplementationOnce((row) => {
			deletedId = row.id;
			queueMicrotask(() => Dexie.ignoreTransaction(() => filesStore.delete(row.id)));
			return Promise.resolve(row.id) as ReturnType<typeof db.drafts.put>;
		});
		try {
			const file = filesStore.createNew('a.md', '# A');
			filesStore.flushPending();
			await vi.waitFor(() => expect(deletedId).toBe(file.id));
			await vi.waitFor(async () => {
				expect(await db.drafts.get(file.id)).toBeUndefined();
				expect(await db.trashed.get(file.id)).toBeDefined();
			});
		} finally {
			put.mockRestore();
		}
	});

	it('uses invalidate during reload and keeps the database draft', async () => {
		const f = filesStore.createNew('keep.md', '# keep');
		await filesStore.flushPendingAwait();
		expect(await db.drafts.get(f.id)).toBeTruthy();
		// Armed timer without waiting for put: invalidate must cancel without delete.
		filesStore.updateContent(f.id, '# local dirty');
		await filesStore.reload(false);
		// Row must still exist (discard reverse-delete would have removed it).
		expect(await db.drafts.get(f.id)).toBeTruthy();
	});

	it('waits for moveToTrash before restoreFromTrash', async () => {
		// Fast Undo: if restoreFromTrash runs before moveToTrash finishes, a late
		// moveToTrash would delete the restored drafts row. restore must await
		// the pending move first.
		let releaseGate: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			releaseGate = resolve;
		});
		const realMove = trashOps.moveToTrash.bind(trashOps);
		const moveSpy = vi.spyOn(trashOps, 'moveToTrash').mockImplementation(async (...args) => {
			await gate;
			return realMove(...(args as Parameters<typeof trashOps.moveToTrash>));
		});
		try {
			const f = filesStore.createNew('race.md', '# race');
			await filesStore.flushPendingAwait();
			filesStore.delete(f.id);
			expect(filesStore.trash.some((t) => t.file.id === f.id)).toBe(true);
			// Undo immediately while moveToTrash is still gated.
			filesStore.restore(f.id);
			expect(filesStore.files.some((x) => x.id === f.id)).toBe(true);
			// Release moveToTrash; restore awaits it then restoreFromTrash.
			releaseGate?.();
			await vi.waitFor(async () => {
				expect(await db.drafts.get(f.id)).toBeTruthy();
				expect(await db.trashed.get(f.id)).toBeUndefined();
			});
		} finally {
			releaseGate?.();
			moveSpy.mockRestore();
		}
	});

	it('waits for a deleted write before draft restoration', async () => {
		let restoredId = '';
		const put = vi.spyOn(db.drafts, 'put').mockImplementationOnce((row) => {
			queueMicrotask(() =>
				Dexie.ignoreTransaction(() => {
					filesStore.delete(row.id);
					filesStore.restore(row.id);
					restoredId = row.id;
				})
			);
			return Promise.resolve(row.id) as ReturnType<typeof db.drafts.put>;
		});
		try {
			const file = filesStore.createNew('undo.md', '# undo-me');
			filesStore.flushPending();
			await vi.waitFor(() => expect(restoredId).toBe(file.id));
			await vi.waitFor(async () => {
				expect(filesStore.files.some((entry) => entry.id === file.id)).toBe(true);
				expect((await db.drafts.get(file.id))?.content).toBe('# undo-me');
				expect(await db.trashed.get(file.id)).toBeUndefined();
			});
		} finally {
			put.mockRestore();
		}
	});

	it('reverts the UI when restoreFromTrash fails', async () => {
		const f = filesStore.createNew('a.md', '# A');
		await filesStore.flushPendingAwait();
		filesStore.delete(f.id);
		expect(filesStore.trash.some((t) => t.file.id === f.id)).toBe(true);

		const trashMod = await import('./trash');
		const spy = vi.spyOn(trashMod, 'restoreFromTrash').mockResolvedValue(false);
		try {
			filesStore.restore(f.id);
			// Optimistic open then rollback.
			await vi.waitFor(() => {
				expect(filesStore.files.some((x) => x.id === f.id)).toBe(false);
				expect(filesStore.trash.some((t) => t.file.id === f.id)).toBe(true);
			});
		} finally {
			spy.mockRestore();
		}
	});
});

describe('workspace navigation and disk operations', () => {
	it('waits for a linked rename before saving to its new target', async () => {
		const file = filesStore.createNew('old.md', 'local edits');
		file.linkedToDisk = true;
		let finish!: (success: boolean) => void;
		vi.mocked(diskSync.renameOnDisk).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				})
		);
		const renaming = filesStore.rename(file.id, 'new');
		const saving = filesStore.saveToDisk(file.id);
		await vi.waitFor(() => expect(diskSync.renameOnDisk).toHaveBeenCalled());
		expect(diskSync.saveToDisk).not.toHaveBeenCalled();
		expect(filesStore.active?.name).toBe('old.md');
		finish(true);
		expect(await renaming).toBe(true);
		expect(await saving).toBe(true);
		expect(filesStore.active?.name).toBe('new.md');
		await filesStore.flushPendingAwait();
		expect((await db.drafts.get(file.id))?.name).toBe('new.md');
	});

	it('keeps the durable draft name after a failed disk rename', async () => {
		const file = filesStore.createNew('keep.md');
		file.linkedToDisk = true;
		vi.mocked(diskSync.renameOnDisk).mockResolvedValueOnce(false);
		expect(await filesStore.rename(file.id, 'blocked')).toBe(false);
		expect(await filesStore.rename(file.id, 'keep.md')).toBe(true);
		await filesStore.flushPendingAwait();
		expect((await db.drafts.get(file.id))?.name).toBe('keep.md');
	});

	it('keeps a completed native rename when its tab closes during the operation', async () => {
		const file = filesStore.createNew('old.md');
		file.linkedToDisk = true;
		let finish!: (success: boolean) => void;
		vi.mocked(diskSync.renameOnDisk).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				})
		);
		const renaming = filesStore.rename(file.id, 'new');
		await vi.waitFor(() => expect(finish).toBeDefined());
		filesStore.close(file.id);
		finish(true);
		expect(await renaming).toBe(true);
		await filesStore.flushPendingAwait();
		expect(filesStore.closedFiles.find((entry) => entry.id === file.id)?.name).toBe('new.md');
		expect(await db.drafts.get(file.id)).toMatchObject({ name: 'new.md', open: false });
	});

	it('reuses an exact linked import and keeps distinct or edited documents', async () => {
		const linked = filesStore.createNew('same.md', '# Original');
		linked.linkedToDisk = true;
		const imported = await filesStore.importFiles([mdFile('same.md', '# Original')]);
		expect(imported.created.map((file) => file.id)).toEqual([linked.id]);
		expect(filesStore.files).toHaveLength(1);
		const different = await filesStore.importFiles([mdFile('same.md', '# Different')]);
		expect(different.created[0]?.id).not.toBe(linked.id);
		expect(filesStore.files).toHaveLength(2);
		filesStore.close(linked.id);
		await filesStore.importFiles([mdFile('same.md', '# Original')]);
		expect(filesStore.activeId).toBe(linked.id);
		expect(filesStore.closedFiles.some((file) => file.id === linked.id)).toBe(false);
	});
});

describe('load', () => {
	it('defers large closed content until an operation asks for it', async () => {
		const content = '# Large\n\n' + 'marker '.repeat(IMPORT_LIMITS.largeDocumentChars / 7);
		const large = { ...draftRow('large', 'large.md', content, 0), open: false };
		const open = { ...draftRow('open', 'open.md', 'open body', 1), open: true };
		await db.drafts.bulkPut([large, open]);

		await filesStore.reload(false);

		const closed = filesStore.closedFiles.find((file) => file.id === 'large');
		expect(closed?.contentDeferred).toBe(true);
		expect(closed?.content).toBe('');
		expect(filesStore.files.find((file) => file.id === 'open')?.content).toBe('open body');

		const corpus = await filesStore.searchCorpus(filesStore.library);
		expect(corpus.find((file) => file.id === 'large')?.content).toBe(content);

		filesStore.openDocument('large');
		await vi.waitFor(() => {
			expect(filesStore.activeId).toBe('large');
			expect(filesStore.active?.content).toBe(content);
			expect(filesStore.active?.contentDeferred).toBe(false);
		});
	});

	it('reports an IndexedDB load error without marking the store loaded', async () => {
		const count = vi.spyOn(db.drafts, 'count').mockRejectedValueOnce(new Error('IDB indisponible'));
		const orderBy = vi.spyOn(db.drafts, 'orderBy').mockImplementationOnce(() => {
			throw new Error('IDB indisponible');
		});
		filesStore.loaded = false;

		await filesStore.load();

		expect(filesStore.loadError).toBeTruthy();
		expect(filesStore.loaded).toBe(false);
		count.mockRestore();
		orderBy.mockRestore();
	});
});

describe('cross-tab synchronization', () => {
	it('protects a failed write and keeps the remote branch during retry', async () => {
		const file = filesStore.createNew('quota.md', 'initial');
		await filesStore.flushPendingAwait();
		filesStore.updateContent(file.id, 'local non durable');
		const put = vi.spyOn(db.drafts, 'put').mockRejectedValueOnce(new Error('quota'));
		await expect(filesStore.flushPendingAwait()).rejects.toThrow();
		expect(filesStore.hasSaveError(file.id)).toBe(true);
		expect(filesStore.hasPendingSave).toBe(true);
		put.mockRestore();
		await db.drafts.put({
			...draftRow(file.id, file.name, 'branche distante'),
			updatedAt: Date.now() + 1
		});
		receiveCrossTab({ type: 'draft-written', id: file.id, updatedAt: Date.now() + 1 });
		expect(filesStore.files.find((entry) => entry.id === file.id)?.content).toBe(
			'local non durable'
		);
		await filesStore.flushPendingAwait();
		expect(filesStore.hasSaveError(file.id)).toBe(false);
		expect((await db.drafts.toArray()).map((entry) => entry.content).sort()).toEqual([
			'branche distante',
			'local non durable'
		]);
		expect(filesStore.closedFiles.some((entry) => entry.content === 'branche distante')).toBe(true);
	});

	it('reloads a remote draft without a pending local save', async () => {
		const file = filesStore.createNew('local.md', 'local');
		filesStore.flushPending();
		await vi.waitFor(() => expect(filesStore.hasPendingSave).toBe(false));
		await db.drafts.put({
			...draftRow(file.id, 'remote.md', 'remote', 0),
			updatedAt: 2000
		});

		receiveCrossTab({ type: 'draft-written', id: file.id, updatedAt: 2000 });

		await vi.waitFor(() =>
			expect(filesStore.files.find((candidate) => candidate.id === file.id)?.content).toBe('remote')
		);
		const synced = filesStore.files.find((candidate) => candidate.id === file.id);
		expect(synced?.name).toBe('remote.md');
		expect(synced?.dirty).toBe(false);
	});

	it('removes a remotely deleted draft but keeps a pending local edit', async () => {
		const clean = filesStore.createNew('clean.md', 'clean');
		filesStore.flushPending();
		await vi.waitFor(() => expect(filesStore.hasPendingSave).toBe(false));
		receiveCrossTab({ type: 'removed', id: clean.id });
		expect(filesStore.files.some((file) => file.id === clean.id)).toBe(false);

		const dirty = filesStore.createNew('dirty.md', 'dirty');
		receiveCrossTab({ type: 'removed', id: dirty.id });
		expect(filesStore.files.some((file) => file.id === dirty.id)).toBe(true);
		expect(notify.toasts.at(-1)?.action).toBeTruthy();

		receiveCrossTab({ type: 'removed', id: 'ghost' });
	});

	it('reports a global conflict when reorder occurs during editing', () => {
		filesStore.createNew('pending.md', 'pending');
		const reload = vi.spyOn(filesStore, 'reload');

		receiveCrossTab({ type: 'reorder' });

		expect(reload).not.toHaveBeenCalled();
		expect(notify.toasts.at(-1)?.action).toBeTruthy();
		reload.mockRestore();
	});
});

describe('trash recovery', () => {
	it('reverts optimistic close when the trash transaction fails', async () => {
		const moveToTrash = vi.spyOn(trashOps, 'moveToTrash').mockResolvedValueOnce(false);
		const file = filesStore.createNew('rollback.md', '# Rollback');
		filesStore.delete(file.id);

		await vi.waitFor(() =>
			expect(filesStore.files.some((candidate) => candidate.id === file.id)).toBe(true)
		);
		expect(filesStore.trash.some((entry) => entry.file.id === file.id)).toBe(false);
		expect(moveToTrash).toHaveBeenCalledOnce();
		moveToTrash.mockRestore();
	});
});

describe('backlinks / wiki-links', () => {
	it('refreshes backlinks when another tab changes a closed document', async () => {
		const a = filesStore.createNew('a.md');
		const b = filesStore.createNew('b.md');
		const source = filesStore.createNew('source.md', '[[a]]');
		filesStore.close(source.id);
		await filesStore.flushPendingAwait();
		await vi.waitFor(() =>
			expect(filesStore.backlinks(a.id).map((file) => file.id)).toEqual([source.id])
		);
		const updatedAt = Date.now() + 100;
		await db.drafts.update(source.id, { content: '[[b]]', updatedAt });
		receiveCrossTab({ type: 'draft-written', id: source.id, updatedAt });
		await vi.waitFor(() =>
			expect(filesStore.backlinks(b.id).map((file) => file.id)).toEqual([source.id])
		);
		expect(filesStore.backlinks(a.id)).toEqual([]);
	});
	it('serializes consecutive renames against the latest link targets', async () => {
		const file = filesStore.createNew('original.md', '[[original]]');
		const first = filesStore.rename(file.id, 'second');
		const next = filesStore.rename(file.id, 'third');
		expect(await first).toBe(true);
		expect(await next).toBe(true);
		expect(filesStore.active?.name).toBe('third.md');
		expect(filesStore.active?.content).toBe('[[third]]');
	});
	it('does not rename or rewrite links when its history checkpoint fails', async () => {
		const file = filesStore.createNew('original.md', '[[original]]');
		vi.spyOn(versionHistory, 'createCheckpoints').mockRejectedValueOnce(new Error('Full'));
		expect(await filesStore.rename(file.id, 'second')).toBe(false);
		expect(filesStore.active?.name).toBe('original.md');
		expect(filesStore.active?.content).toBe('[[original]]');
		expect(await filesStore.rename(file.id, 'bad|target')).toBe(false);
	});
	it('updates incoming links in closed documents and preserves their history', async () => {
		const target = filesStore.createNew('Target.md', '# Original');
		const source = filesStore.createNew('Source.md', '[[Target|label]] `[[Target]]`');
		filesStore.close(source.id);
		expect(await filesStore.rename(target.id, 'Renamed')).toBe(true);
		await filesStore.flushPendingAwait();
		expect((await db.drafts.get(source.id))?.content).toBe('[[Renamed|label]] `[[Target]]`');
		expect((await db.drafts.get(source.id))?.open).toBe(false);
		expect(
			(await db.versions.where('draftId').equals(source.id).toArray()).some(
				(v) => v.content === '[[Target|label]] `[[Target]]`'
			)
		).toBe(true);
		expect(filesStore.resolveWikiLink('Renamed')).toBe(target.id);
	});
	it('rejects a rename that would make link targets ambiguous', async () => {
		const first = filesStore.createNew('first.md');
		filesStore.createNew('other.md');
		expect(await filesStore.rename(first.id, 'OTHER')).toBe(false);
		expect(first.name).toBe('first.md');
	});
	it('reuses the library view until an open or closed list changes', async () => {
		const first = filesStore.createNew('one.md', 'content');
		filesStore.createNew('two.md', 'content');
		const view = filesStore.library;
		expect(filesStore.library).toBe(view);
		expect(view).toHaveLength(2);

		filesStore.close(first.id);
		const closedView = filesStore.library;
		expect(closedView).not.toBe(view);
		expect(closedView.map((file) => file.name)).toEqual(['two.md', 'one.md']);
		expect(filesStore.library).toBe(closedView);

		filesStore.reopen(first.id);
		const reopened = filesStore.library;
		expect(reopened).not.toBe(closedView);
		expect(reopened.map((file) => file.name)).toEqual(['two.md', 'one.md']);
	});

	it('does not guess between imported documents with the same name', async () => {
		await db.drafts.bulkPut([draftRow('a', 'same.md'), draftRow('b', 'same.md')]);
		await filesStore.reload(false);
		expect(filesStore.openWikiLink('same')).toBeNull();
		expect(filesStore.library).toHaveLength(2);
	});
	it('replaces closed content in library scope without reopening it', async () => {
		const file = filesStore.createNew('closed.md', 'find this');
		filesStore.close(file.id);
		const options = { caseSensitive: false, wholeWord: false, useRegex: false };
		expect((await filesStore.replaceInAll('find', 'keep', options, 'open')).files).toBe(0);
		expect((await filesStore.replaceInAll('find', 'keep', options)).files).toBe(1);
		await filesStore.flushPendingAwait();
		expect(await db.drafts.get(file.id)).toMatchObject({ content: 'keep this', open: false });
	});
});

describe('replaceInAll', () => {
	it('archives the latest edits before replacement during throttling', async () => {
		const file = filesStore.createNew('a.md', 'foo initial');
		await filesStore.flushPendingAwait();
		filesStore.updateContent(file.id, 'foo juste avant');
		await filesStore.replaceInAll('foo', 'bar', {
			caseSensitive: true,
			wholeWord: false,
			useRegex: false
		});
		expect(
			(await db.versions.where('draftId').equals(file.id).toArray()).map(
				(version) => version.content
			)
		).toContain('foo juste avant');
		expect(filesStore.files.find((entry) => entry.id === file.id)?.content).toBe('bar juste avant');
	});

	it('does not change documents when the batch checkpoint fails', async () => {
		const file = filesStore.createNew('a.md', 'foo avant');
		await filesStore.flushPendingAwait();
		filesStore.updateContent(file.id, 'foo dernières frappes');
		const put = vi.spyOn(db.versions, 'put').mockRejectedValue(new Error('quota'));
		try {
			await expect(
				filesStore.replaceInAll('foo', 'bar', {
					caseSensitive: true,
					wholeWord: false,
					useRegex: false
				})
			).rejects.toThrow('quota');
			expect(filesStore.files.find((entry) => entry.id === file.id)?.content).toBe(
				'foo dernières frappes'
			);
		} finally {
			put.mockRestore();
		}
	});

	it('archives the state before version restoration', async () => {
		const file = filesStore.createNew('a.md', 'état courant');
		await filesStore.flushPendingAwait();
		await filesStore.restoreVersion(file.id, 'version ancienne');
		expect(filesStore.files.find((entry) => entry.id === file.id)?.content).toBe(
			'version ancienne'
		);
		expect(
			(await db.versions.where('draftId').equals(file.id).toArray()).map(
				(version) => version.content
			)
		).toContain('état courant');
	});

	it('returns regexError for an invalid regular expression', async () => {
		filesStore.createNew('a.md', 'foo bar');
		const res = await filesStore.replaceInAll('(unclosed', 'x', {
			caseSensitive: false,
			wholeWord: false,
			useRegex: true
		});
		expect(res.regexError).not.toBeNull();
		expect(res.files).toBe(0);
		expect(res.occurrences).toBe(0);
		// An invalid regular expression must not change content.
		expect(filesStore.files.find((x) => x.name === 'a.md')?.content).toBe('foo bar');
	});
});

describe('disk save barrier', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('flushes current WYSIWYG content before disk save reads the draft', async () => {
		const file = filesStore.createNew('wysiwyg.md', 'before');
		window.addEventListener(
			'mdsh:flush-editor',
			() => filesStore.updateContent(file.id, 'latest editor content'),
			{ once: true }
		);
		vi.mocked(diskSync.saveToDisk).mockImplementationOnce(async (id, deps) => {
			expect(id).toBe(file.id);
			expect(deps.getFile(id)?.content).toBe('latest editor content');
			return true;
		});

		expect(await filesStore.saveToDisk(file.id)).toBe(true);
	});
});

describe('closeMany / openMany', () => {
	it('ignores already open rows by ID in openMany', () => {
		filesStore.openMany([draftRow('x', 'x.md', '# X', 0)]);
		const before = filesStore.files.length;
		filesStore.openMany([draftRow('x', 'x.md', '# X bis', 0)]);
		expect(filesStore.files.length).toBe(before);
		// Existing content must not be overwritten.
		expect(filesStore.files.find((f) => f.id === 'x')?.content).toBe('# X');
	});
});

describe('bounded import orchestration', () => {
	it('imports 300 notes and rejects additional notes without reading', async () => {
		const extra = { name: 'extra.md', size: 1, arrayBuffer: vi.fn() } as unknown as File;
		const result = await filesStore.importFiles([
			...Array.from({ length: 300 }, (_, index) => mdFile(`${index}.md`, '# Note')),
			extra
		]);
		expect(result.created).toHaveLength(300);
		expect(result.failed).toBe(1);
		expect(extra.arrayBuffer).not.toHaveBeenCalled();
		expect(filesStore.lastImportReport?.issues[0]?.reason).toBe('file-count');
		expect(filesStore.importProgress).toBeNull();
	});
	it('requests separate approval for each large document', () => {
		const first = filesStore.createNew('large.md', 'x'.repeat(256 * 1024));
		const second = filesStore.createNew('large2.md', first.content);
		expect(filesStore.requiresRenderConfirmation(first.id)).toBe(true);
		filesStore.allowDocumentRendering(first.id);
		filesStore.allowDocumentRendering(first.id);
		expect(filesStore.requiresRenderConfirmation(first.id)).toBe(false);
		expect(filesStore.requiresRenderConfirmation(second.id)).toBe(true);
		expect(filesStore.requiresRenderConfirmation('missing')).toBe(false);
	});
	it('keeps new import progress when the previous import finishes', async () => {
		let resolveFirst!: (value: ArrayBuffer) => void;
		const first = {
			name: 'first.md',
			size: 1,
			arrayBuffer: () =>
				new Promise<ArrayBuffer>((resolve) => {
					resolveFirst = resolve;
				})
		} as File;
		const pendingFirst = filesStore.importFiles([first]);
		await vi.waitFor(() => expect(resolveFirst).toBeTypeOf('function'));
		const second = await filesStore.importFiles([mdFile('second.md')]);
		resolveFirst(new Uint8Array([65]).buffer);
		await pendingFirst;
		expect(filesStore.lastImportReport).toEqual(second.report);
		expect(filesStore.files.map((file) => file.name)).toEqual(['second.md']);
	});
});

describe('argv barrier and recovery errors', () => {
	it('acknowledges native open only after the document is durable', async () => {
		vi.mocked(diskSync.openPathsFromDesktop).mockImplementationOnce(async (_grants, deps) => ({
			files: [deps.onCreate('argv.md', 'contenu natif')],
			processedTokens: ['argv-token']
		}));
		const processed = await filesStore.openPathsFromDesktop([]);
		expect(processed).toEqual(['argv-token']);
		expect((await db.drafts.toArray())[0]?.content).toBe('contenu natif');
	});
	it('returns a persistence error before native acknowledgment', async () => {
		vi.mocked(diskSync.openPathsFromDesktop).mockImplementationOnce(async (_grants, deps) => ({
			files: [deps.onCreate('argv.md', 'contenu natif')],
			processedTokens: ['argv-token']
		}));
		const put = vi.spyOn(db.drafts, 'put').mockRejectedValue(new Error('quota'));
		try {
			await expect(filesStore.openPathsFromDesktop([])).rejects.toThrow();
			expect(filesStore.files[0]?.content).toBe('contenu natif');
			expect(filesStore.hasSaveError(filesStore.files[0]!.id)).toBe(true);
		} finally {
			put.mockRestore();
			await filesStore.flushPendingAwait();
		}
	});
	it('keeps a note in visible trash after purge failure', async () => {
		const file = filesStore.createNew('safe.md', 'safe');
		await filesStore.flushPendingAwait();
		filesStore.delete(file.id);
		await filesStore.flushPendingAwait();
		const purge = vi.spyOn(trashOps, 'purgePermanently').mockRejectedValue(new Error('storage'));
		try {
			filesStore.purgeTrash(file.id);
			await vi.waitFor(() => expect(purge).toHaveBeenCalled());
			expect(filesStore.trash.some((entry) => entry.file.id === file.id)).toBe(true);
		} finally {
			purge.mockRestore();
		}
	});
});

describe('conflicts between full restoration and trash', () => {
	async function replaceCurrent() {
		const { applyBackup, BACKUP_FORMAT } = await import('./services/backup');
		const file = filesStore.createNew('same.md', 'version A');
		await filesStore.flushPendingAwait();
		await applyBackup(
			{
				format: BACKUP_FORMAT,
				schemaVersion: 1,
				exportedAt: Date.now(),
				drafts: [{ ...draftRow(file.id, file.name, 'version B'), updatedAt: Date.now() }],
				workspaces: [],
				templates: []
			},
			'replace'
		);
		await filesStore.reload();
		return file.id;
	}
	it('deletes B after full restoration without losing A or its history', async () => {
		const id = await replaceCurrent();
		filesStore.delete(id);
		expect(new Set(filesStore.trash.map((entry) => entry.file.id)).size).toBe(
			filesStore.trash.length
		);
		await filesStore.flushPendingAwait();
		const rows = await db.trashed.toArray();
		expect(rows.map((row) => row.file.content).sort()).toEqual(['version A', 'version B']);
		expect(new Set(rows.map((row) => row.id)).size).toBe(2);
		const old = rows.find((row) => row.file.content === 'version A')!;
		expect(old.file.id).toBe(old.id);
		expect(await db.versions.where('draftId').equals(old.id).count()).toBeGreaterThan(0);
		expect(filesStore.trash.map((entry) => entry.file.content).sort()).toEqual([
			'version A',
			'version B'
		]);
	});
	it.each([false, true])('restores A without conflict when B closed is %s', async (closed) => {
		const id = await replaceCurrent();
		if (closed) {
			filesStore.close(id);
			await filesStore.flushPendingAwait();
		}
		const restored = filesStore.restore(id)!;
		expect(restored.id).not.toBe(id);
		await filesStore.flushPendingAwait();
		expect((await db.drafts.get(id))?.content).toBe('version B');
		expect((await db.drafts.get(restored.id))?.content).toBe('version A');
		const all = [...filesStore.files, ...filesStore.closedFiles];
		expect(all.map((file) => file.content).sort()).toEqual(['version A', 'version B']);
		expect(new Set(all.map((file) => file.id)).size).toBe(2);
		expect(await db.versions.where('draftId').equals(restored.id).count()).toBeGreaterThan(0);
	});
	it('restores open B and trashed A after a trash copy error', async () => {
		const id = await replaceCurrent();
		const put = vi.spyOn(db.trashed, 'put').mockRejectedValueOnce(new Error('quota'));
		try {
			filesStore.delete(id);
			await filesStore.flushPendingAwait();
			expect(filesStore.files.map((file) => file.content)).toEqual(['version B']);
			expect(filesStore.trash.map((entry) => entry.file.content)).toEqual(['version A']);
			expect((await db.trashed.get(id))?.file.content).toBe('version A');
		} finally {
			put.mockRestore();
		}
	});
	it('does not create duplicate tabs for repeated references in openMany', async () => {
		const row = draftRow('duplicate', 'duplicate.md');
		filesStore.openMany([row, row, row]);
		expect(filesStore.files.map((file) => file.id)).toEqual(['duplicate']);
	});
});

describe('references replaced during operations', () => {
	it('rejects version restoration after reload replaces the current object', async () => {
		const file = filesStore.createNew('same.md', 'before');
		await filesStore.flushPendingAwait();
		let release!: (ok: boolean) => void;
		const checkpoint = vi.spyOn(versionHistory, 'createCheckpoint').mockImplementation(
			() =>
				new Promise((resolve) => {
					release = resolve;
				})
		);
		try {
			const restoring = filesStore.restoreVersion(file.id, 'old');
			filesStore.files = [{ ...filesStore.files[0]!, content: 'newly loaded' }];
			release(true);
			await expect(restoring).rejects.toThrow();
			expect(filesStore.files[0]?.content).toBe('newly loaded');
		} finally {
			checkpoint.mockRestore();
		}
	});
	it('removes a closed document deleted by another tab without restoring it', async () => {
		const file = filesStore.createNew('closed.md', 'before');
		filesStore.close(file.id);
		await filesStore.flushPendingAwait();
		await db.drafts.delete(file.id);
		receiveCrossTab({ type: 'removed', id: file.id });
		expect(filesStore.closedFiles).toHaveLength(0);
		expect(filesStore.reopen(file.id)).toBeNull();
		await filesStore.flushPendingAwait();
		expect(await db.drafts.get(file.id)).toBeUndefined();
	});
});

describe('editor synchronization barrier', () => {
	it('requests current Milkdown content before a durability barrier', async () => {
		const file = filesStore.createNew('wysiwyg.md', 'avant');
		await filesStore.flushPendingAwait();
		const listener = () => filesStore.updateContent(file.id, 'frappe non débouncée');
		window.addEventListener('mdsh:flush-editor', listener, { once: true });
		await filesStore.flushPendingAwait();
		expect((await db.drafts.get(file.id))?.content).toBe('frappe non débouncée');
	});
	it('also starts the synchronous pagehide barrier', async () => {
		const file = filesStore.createNew('wysiwyg.md', 'avant');
		await filesStore.flushPendingAwait();
		window.addEventListener(
			'mdsh:flush-editor',
			() => filesStore.updateContent(file.id, 'dernière frappe'),
			{ once: true }
		);
		filesStore.flushPending();
		await filesStore.flushPendingAwait();
		expect((await db.drafts.get(file.id))?.content).toBe('dernière frappe');
	});
});

describe('store recovery paths', () => {
	it('deletes a closed document and ignores an unknown ID', async () => {
		const file = filesStore.createNew('closed.md', 'body');
		filesStore.close(file.id);
		await filesStore.flushPendingAwait();
		filesStore.delete('missing');
		filesStore.delete(file.id);
		await filesStore.flushPendingAwait();
		expect(filesStore.closedFiles).toEqual([]);
		expect((await db.trashed.get(file.id))?.file.content).toBe('body');
	});
	it('restores a closed view when its trash operation fails', async () => {
		const file = filesStore.createNew('closed.md', 'body');
		filesStore.close(file.id);
		await filesStore.flushPendingAwait();
		const move = vi.spyOn(trashOps, 'moveToTrash').mockResolvedValueOnce(false);
		try {
			filesStore.delete(file.id);
			await vi.waitFor(() =>
				expect(filesStore.closedFiles.map((entry) => entry.id)).toEqual([file.id])
			);
			expect(filesStore.trash).toEqual([]);
		} finally {
			move.mockRestore();
		}
	});
	it('cancels a failed restoration without removing the conflicting branch', async () => {
		const current = filesStore.createNew('current.md', 'current');
		filesStore.trash = [
			{ file: { ...current, name: 'old.md', content: 'old' }, order: 0, trashedAt: Date.now() }
		];
		const restore = vi.spyOn(trashOps, 'restoreFromTrash').mockResolvedValueOnce(false);
		try {
			const optimistic = filesStore.restore(current.id)!;
			await vi.waitFor(() =>
				expect(filesStore.trash.map((entry) => entry.file.content)).toEqual(['old'])
			);
			expect(filesStore.files.map((entry) => entry.content)).toEqual(['current']);
			expect(optimistic.id).not.toBe(current.id);
		} finally {
			restore.mockRestore();
		}
	});
	it('imports a desktop directory with a partial summary and applies the browser guard', async () => {
		(window as Window & { isTauri?: boolean }).isTauri = true;
		vi.mocked(diskSync.openDirectoryFromDisk).mockImplementationOnce(async (deps, options) => {
			options?.onProgress?.({
				processed: 2,
				imported: 1,
				skipped: 0,
				failed: 1,
				bytes: 4,
				cancelled: false,
				issues: [{ name: 'bad.md', reason: 'read' }]
			});
			return [deps.onCreate('good.md', 'good')];
		});
		try {
			const result = await filesStore.importDirectory();
			expect(result).toMatchObject({
				count: 1,
				truncated: true,
				report: { imported: 1, failed: 1 }
			});
			expect(filesStore.lastImportReport).toMatchObject({ imported: 1, failed: 1 });
		} finally {
			delete (window as Window & { isTauri?: boolean }).isTauri;
		}
		expect(await filesStore.importDirectoryFromDesktop()).toEqual({ count: 0, truncated: false });
	});
});

describe('defensive workspace reopen and links', () => {
	it('reopens a closed row without creating its content again', async () => {
		const file = filesStore.createNew('closed.md', 'mémoire');
		filesStore.close(file.id);
		await filesStore.flushPendingAwait();
		filesStore.openMany([{ ...draftRow(file.id, 'disk.md', 'disque'), open: false }]);
		expect(filesStore.files).toHaveLength(1);
		expect(filesStore.files[0]).toMatchObject({
			id: file.id,
			name: 'closed.md',
			content: 'mémoire'
		});
		expect(filesStore.closedFiles).toEqual([]);
	});
	it('ignores missing and repeated references and keeps tabs outside the workspace', () => {
		const a = filesStore.createNew('a.md');
		const b = filesStore.createNew('b.md');
		const c = filesStore.createNew('c.md');
		filesStore.reorderToIds(['missing', b.id, b.id]);
		expect(filesStore.files.map((file) => file.id)).toEqual([b.id, a.id, c.id]);
		filesStore.reorderToIds([b.id, a.id, c.id]);
		expect(filesStore.files.map((file) => file.id)).toEqual([b.id, a.id, c.id]);
	});
	it('does not add a variant twice after backend restoration', async () => {
		const current = filesStore.createNew('current.md', 'current');
		filesStore.trash = [
			{ file: { ...current, id: 'trash', content: 'trash' }, order: 0, trashedAt: Date.now() }
		];
		const variant = { ...draftRow('variant', 'variant.md', 'variant'), open: false };
		filesStore.closedFiles = [{ ...variant, dirty: false }];
		const restore = vi
			.spyOn(trashOps, 'restoreFromTrash')
			.mockImplementationOnce(async (_id, _row, onPreserved) => {
				onPreserved?.(variant);
				return true;
			});
		try {
			filesStore.restore('trash');
			await filesStore.flushPendingAwait();
			expect(filesStore.closedFiles.filter((file) => file.id === 'variant')).toHaveLength(1);
		} finally {
			restore.mockRestore();
		}
	});
});

describe('project markdown links', () => {
	it('uses canonical path keys and rejects an ambiguous duplicate', async () => {
		const base = { content: '', createdAt: 1, updatedAt: 1, dirty: false, linkedToDisk: false };
		const reader = {
			...base,
			id: 'reader',
			name: 'reader.md',
			projectId: 'p',
			relativePath: 'notes/reader.md'
		};
		const guide = {
			...base,
			id: 'guide',
			name: 'Guide.md',
			projectId: 'p',
			relativePath: 'docs/Guide.md'
		};
		const foreign = {
			...base,
			id: 'foreign',
			name: 'guide.md',
			projectId: 'q',
			relativePath: 'docs/guide.md'
		};
		filesStore.files = [reader, guide, foreign];
		filesStore.activeId = 'reader';
		await filesStore.openProjectLink('reader', '../docs/guide.md#Heading%20One');
		expect(filesStore.activeId).toBe('guide');
		expect(filesStore.projectAnchor).toEqual({ id: 'guide', fragment: 'Heading One' });

		const unicode = {
			...guide,
			id: 'unicode',
			name: 'Café.md',
			relativePath: 'docs/Cafe\u0301.md'
		};
		filesStore.files = [reader, unicode, foreign];
		filesStore.activeId = 'reader';
		await filesStore.openProjectLink('reader', '../docs/Caf%C3%A9.md');
		expect(filesStore.activeId).toBe('unicode');

		filesStore.files = [reader, guide, { ...guide, id: 'duplicate' }, foreign];
		filesStore.activeId = 'reader';
		notify.clear();
		await filesStore.openProjectLink('reader', '../docs/guide.md');
		expect(filesStore.activeId).toBe('reader');
		expect(notify.toasts.some((toast) => toast.level === 'error')).toBe(true);
	});
});

// The browser workflow restores deferred tabs, but it cannot separate an
// inactive body placeholder from an empty document through the UI. This
// isolated case retains the concrete export failure: the ZIP must not encode
// the placeholder while the durable row holds the text.
describe('export open hydration', () => {
	it('hydrates the deferred open tabs before building the archive', async () => {
		await db.drafts.bulkPut([draftRow('open', 'open.md', '# Durable body')]);
		const deferred = {
			id: 'open',
			name: 'open.md',
			content: '',
			createdAt: 1000,
			updatedAt: 1000,
			dirty: false,
			linkedToDisk: false,
			contentDeferred: true
		};
		filesStore.files = [deferred];
		filesStore.activeId = 'open';
		await filesStore.exportOpen();
		expect(filesStore.files[0]?.content).toBe('# Durable body');
		expect(filesStore.files[0]?.contentDeferred).toBe(false);
	});
});

describe('deferred activation intent', () => {
	it('does not steal focus when a slower hydration finishes after another tab', async () => {
		const base = { createdAt: 1, updatedAt: 2, dirty: false, linkedToDisk: false };
		const deferred = { ...base, id: 'slow', name: 'slow.md', content: '', contentDeferred: true };
		const fast = { ...base, id: 'fast', name: 'fast.md', content: '# Fast' };
		filesStore.closedFiles = [deferred];
		filesStore.files = [fast];
		filesStore.activeId = 'fast';
		let release!: (row: DraftRow) => void;
		const pending = new Promise<DraftRow | undefined>((resolve) => (release = resolve));
		const get = vi.spyOn(db.drafts, 'get').mockReturnValue(pending as never);
		const opening = filesStore.openDocument('slow');
		filesStore.setActive('fast');
		release({ ...draftRow('slow', 'slow.md', '# Slow'), updatedAt: 3 });
		await opening;
		await vi.waitFor(() => expect(filesStore.closedFiles[0]?.content).toBe('# Slow'));
		expect(filesStore.closedFiles).toHaveLength(1);
		expect(filesStore.activeId).toBe('fast');
		get.mockRestore();
	});

	it('keeps Home selected when a deferred body finishes afterwards', async () => {
		const base = { createdAt: 1, updatedAt: 2, dirty: false, linkedToDisk: false };
		const deferred = { ...base, id: 'slow', name: 'slow.md', content: '', contentDeferred: true };
		filesStore.closedFiles = [deferred];
		filesStore.activeId = null;
		let release!: (row: DraftRow) => void;
		const pending = new Promise<DraftRow | undefined>((resolve) => (release = resolve));
		const get = vi.spyOn(db.drafts, 'get').mockReturnValue(pending as never);
		const opening = filesStore.openDocument('slow');
		filesStore.showHome();
		release({ ...draftRow('slow', 'slow.md', '# Slow'), updatedAt: 3 });
		await opening;
		await vi.waitFor(() => expect(filesStore.closedFiles[0]?.content).toBe('# Slow'));
		expect(filesStore.activeId).toBeNull();
		expect(filesStore.files).toHaveLength(0);
		get.mockRestore();
	});

	it('does not publish workspace tabs when the open flag write fails', async () => {
		await db.drafts.bulkPut([draftRow('a', 'a.md', '# A'), draftRow('b', 'b.md', '# B')]);
		const where = vi.spyOn(db.drafts, 'where').mockReturnValue({
			anyOf: () => ({
				modify: async () => {
					throw new Error('abort');
				}
			})
		} as never);
		await expect(filesStore.openWorkspace(['a', 'b'])).rejects.toThrow('abort');
		expect(filesStore.files).toHaveLength(0);
		expect(filesStore.closedFiles).toHaveLength(0);
		expect(filesStore.activeId).toBeNull();
		expect((await db.drafts.get('a'))?.open).not.toBe(true);
		where.mockRestore();
	});

	it('does not publish a superseded workspace restore', async () => {
		await db.drafts.bulkPut([draftRow('a', 'a.md', '# A')]);
		let current = true;
		const opening = filesStore.openWorkspace(['a'], () => current);
		current = false;
		await opening;
		expect(filesStore.files).toHaveLength(0);
		expect(filesStore.closedFiles).toHaveLength(0);
	});

	it('bounds concurrent deferred body reads', async () => {
		const base = { createdAt: 1, updatedAt: 2, dirty: false, linkedToDisk: false };
		const items = Array.from({ length: 20 }, (_, index) => ({
			...base,
			id: `d${index}`,
			name: `d${index}.md`,
			content: '',
			contentDeferred: true
		}));
		filesStore.files = items;
		filesStore.activeId = null;
		let inFlight = 0;
		let peak = 0;
		const get = vi.spyOn(db.drafts, 'get').mockImplementation((async (id: string) => {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 2));
			inFlight -= 1;
			return { ...draftRow(id, `${id}.md`, `# ${id}`), updatedAt: 3 };
		}) as never);
		await filesStore.ensureContent(items.map((item) => item.id));
		expect(peak).toBeLessThanOrEqual(4);
		expect(filesStore.files.every((file) => file.content === `# ${file.id}`)).toBe(true);
		get.mockRestore();
	});
});

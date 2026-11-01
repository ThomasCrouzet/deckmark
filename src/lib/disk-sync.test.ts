import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { notify } from './notify.svelte';
import { diskConflictStore } from './disk-conflict.svelte';
import type { FileItem } from './types';

// Mock all FSA operations to test disk synchronization, FileItem flags,
// notifications, mtime guards, and per-file error handling.
// jsdom does not provide the native File System Access API.
vi.mock('./fsa', () => ({
	isFSASupported: vi.fn(() => true),
	getFsaLink: vi.fn(),
	getHandle: vi.fn(),
	getPathLink: vi.fn(),
	getPathLinkWithEpoch: vi.fn(),
	requestPermission: vi.fn(),
	pickSaveTarget: vi.fn(),
	revisionForFile: vi.fn(),
	revisionForText: vi.fn(),
	saveHandle: vi.fn(),
	savePathLink: vi.fn(),
	writeHandle: vi.fn(),
	deleteHandle: vi.fn(),
	checkHandle: vi.fn(),
	pickAndOpen: vi.fn()
}));

vi.mock('./desktop', () => ({
	isDesktop: vi.fn(() => false)
}));

vi.mock('./db', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./db')>();
	return { ...actual, getDiskLinkEpoch: vi.fn(async () => 'epoch') };
});

vi.mock('./disk-tauri', () => ({
	tauriRenamePath: vi.fn(),
	tauriForgetPath: vi.fn(async () => {}),
	tauriPickDirectoryAndOpen: vi.fn(async () => ({ files: [], failed: 0 })),
	tauriPickAndOpen: vi.fn(async () => ({ files: [], failed: 0 })),
	tauriPickSaveTarget: vi.fn(async () => null),
	tauriWritePath: vi.fn(async () => ({
		lastModified: 1,
		size: 1,
		revision: 'sha256:written'
	})),
	tauriReadMeta: vi.fn(async () => null),
	tauriReadPath: vi.fn(async () => ({
		content: 'external',
		stat: { lastModified: 2, size: 8, revision: 'sha256:external' }
	})),
	tauriCheckPath: vi.fn(async () => 'ok'),
	tauriOpenNativeGrants: vi.fn(async () => ({ files: [], failed: 0 }))
}));

import * as fsa from './fsa';
import * as desktop from './desktop';
import * as diskTauri from './disk-tauri';
import * as database from './db';
import {
	openFromDisk,
	openDirectoryFromDisk,
	openPathsFromDesktop,
	saveToDisk,
	renameOnDisk,
	unlinkFromDisk,
	refreshBrokenLinks,
	type DiskSyncDeps
} from './disk-sync';

function makeFile(over: Partial<FileItem> = {}): FileItem {
	return {
		id: 'a',
		name: 'note.md',
		content: 'contenu',
		createdAt: 0,
		updatedAt: 0,
		dirty: true,
		linkedToDisk: false,
		...over
	};
}

const handle = {} as unknown as FileSystemFileHandle;

// jsdom does not implement File.prototype.text. Create a file-like object with
// text, lastModified, and size values. openFromDisk uses only these properties.
function fakeFile(
	name: string,
	content: string,
	over: { lastModified?: number; size?: number } = {}
): File {
	return {
		name,
		lastModified: over.lastModified ?? 0,
		size: over.size ?? content.length,
		arrayBuffer: async () => new TextEncoder().encode(content).buffer
	} as unknown as File;
}

function testDeps(store: FileItem[]): DiskSyncDeps {
	return {
		getFile: (id) => store.find((file) => file.id === id),
		onCreate: (name, content) => {
			const item = makeFile({ id: `test-${name}`, name, content });
			store.push(item);
			return item;
		},
		scheduleSave: vi.fn()
	};
}

beforeEach(() => {
	notify.clear();
	vi.clearAllMocks();
	// Hide expected reportError output.
	vi.spyOn(console, 'error').mockImplementation(() => {});
	// Use FSA support without desktop support by default.
	vi.mocked(fsa.isFSASupported).mockReturnValue(true);
	vi.mocked(desktop.isDesktop).mockReturnValue(false);
	vi.mocked(fsa.getFsaLink).mockResolvedValue(null);
	vi.mocked(fsa.getPathLink).mockResolvedValue(null);
	vi.mocked(fsa.getPathLinkWithEpoch).mockImplementation(async (id) => {
		const record = await fsa.getPathLink(id);
		return record ? { record, epoch: 'epoch' } : null;
	});
	vi.mocked(fsa.revisionForFile).mockResolvedValue('sha256:disk');
	vi.mocked(fsa.revisionForText).mockResolvedValue('sha256:local');
	vi.mocked(database.getDiskLinkEpoch).mockResolvedValue('epoch');
});

describe('openFromDisk', () => {
	function depsFor(store: FileItem[]): DiskSyncDeps {
		return {
			getFile: (id) => store.find((f) => f.id === id),
			onCreate: (name, content) => {
				const item = makeFile({ id: `id-${name}`, name, content, dirty: false });
				store.push(item);
				return item;
			},
			scheduleSave: vi.fn()
		};
	}

	it('continues after an unreadable file and shows a partial info toast', async () => {
		const good = fakeFile('good.md', 'ok');
		// Reject `.text()` to simulate a content read failure.
		const bad = {
			name: 'bad.md',
			lastModified: 0,
			size: 0,
			arrayBuffer: vi.fn().mockRejectedValue(new Error('illisible'))
		} as unknown as File;
		vi.mocked(fsa.pickAndOpen).mockResolvedValue([
			{ handle, file: good },
			{ handle, file: bad }
		]);
		vi.mocked(fsa.saveHandle).mockResolvedValue(undefined);

		const store: FileItem[] = [];
		const created = await openFromDisk(depsFor(store));

		expect(created).toHaveLength(1);
		expect(created[0]!.name).toBe('good.md');
		// reportError receives the failed file.
		expect(console.error).toHaveBeenCalled();
		// Show the partial result in an info toast.
		expect(notify.toasts.some((t) => t.level === 'info')).toBe(true);
	});

	it('counts a handle persistence failure as a skipped file', async () => {
		const f = fakeFile('x.md', 'ok');
		vi.mocked(fsa.pickAndOpen).mockResolvedValue([{ handle, file: f }]);
		vi.mocked(fsa.saveHandle).mockRejectedValue(new Error('IDB plein'));

		const store: FileItem[] = [];
		const created = await openFromDisk(depsFor(store));

		// onCreate runs, but saveHandle failure excludes the file from the result.
		// Do not show a partial toast because no file succeeded.
		expect(created).toHaveLength(0);
		expect(console.error).toHaveBeenCalled();
		expect(notify.toasts.some((t) => t.level === 'info')).toBe(false);
	});
});

describe('saveToDisk', () => {
	let file: FileItem;
	let scheduleSave: Mock<(id: string) => void>;
	let deps: DiskSyncDeps;

	beforeEach(() => {
		file = makeFile();
		scheduleSave = vi.fn();
		deps = { getFile: () => file, onCreate: () => file, scheduleSave };
	});

	it('returns false without a toast when handle permission is denied', async () => {
		vi.mocked(fsa.getFsaLink).mockResolvedValue({
			handle,
			revision: 'sha256:disk',
			epoch: 'epoch'
		});
		vi.mocked(fsa.requestPermission).mockResolvedValue(false);
		expect(await saveToDisk('a', deps)).toBe(false);
		expect(notify.toasts).toHaveLength(0);
		expect(fsa.writeHandle).not.toHaveBeenCalled();
	});

	it('returns false and marks the link broken after a write failure', async () => {
		vi.mocked(fsa.getFsaLink).mockResolvedValue({
			handle,
			revision: 'sha256:disk',
			epoch: 'epoch'
		});
		vi.mocked(fsa.requestPermission).mockResolvedValue(true);
		vi.mocked(fsa.writeHandle).mockRejectedValue(new Error('disk fail'));
		const ok = await saveToDisk('a', deps);
		expect(ok).toBe(false);
		expect(file.brokenLink).toBe(true);
		expect(notify.toasts.some((t) => t.level === 'error')).toBe(true);
		expect(scheduleSave).not.toHaveBeenCalled();
	});

	it('does not persist a new handle when the write fails', async () => {
		const picked = { tag: 'picked' } as unknown as FileSystemFileHandle;
		vi.mocked(fsa.pickSaveTarget).mockResolvedValue(picked);
		vi.mocked(fsa.writeHandle).mockRejectedValue(new Error('disk fail'));

		expect(await saveToDisk('a', deps)).toBe(false);
		expect(fsa.saveHandle).not.toHaveBeenCalled();
	});

	it('writes one content snapshot and keeps a later edit dirty', async () => {
		const picked = { tag: 'picked' } as unknown as FileSystemFileHandle;
		let releaseHash!: (revision: string) => void;
		vi.mocked(fsa.pickSaveTarget).mockResolvedValue(picked);
		vi.mocked(fsa.revisionForText).mockImplementation(
			() => new Promise<string>((resolve) => (releaseHash = resolve))
		);
		vi.mocked(fsa.writeHandle).mockResolvedValue(undefined);

		const saving = saveToDisk('a', deps);
		await vi.waitFor(() => expect(fsa.revisionForText).toHaveBeenCalledWith('contenu'));
		file.content = 'later edit';
		releaseHash('sha256:snapshot');

		expect(await saving).toBe(true);
		expect(fsa.writeHandle).toHaveBeenCalledWith(picked, 'contenu');
		expect(fsa.saveHandle).toHaveBeenCalledWith('a', picked, 'sha256:snapshot', 'epoch');
		expect(file.dirty).toBe(true);
	});

	it('returns false without a write after picker cancellation', async () => {
		vi.mocked(fsa.getFsaLink).mockResolvedValue(null);
		vi.mocked(fsa.pickSaveTarget).mockResolvedValue(null);
		expect(await saveToDisk('a', deps)).toBe(false);
		expect(fsa.writeHandle).not.toHaveBeenCalled();
		expect(fsa.saveHandle).not.toHaveBeenCalled();
	});

	describe('overwrite guard for mtime conflicts (§C2)', () => {
		beforeEach(() => {
			// Use an existing link with a known disk baseline.
			file = makeFile({ linkedToDisk: true, diskLastModified: 1000, diskSize: 7 });
			deps = { getFile: () => file, onCreate: () => file, scheduleSave };
		});

		it('writes after confirmation when disk content differs', async () => {
			const onDisk = new File(['autre contenu disque'], 'note.md');
			Object.defineProperty(onDisk, 'lastModified', { value: 9999, configurable: true });
			const writtenAfter = new File(['contenu'], 'note.md');
			Object.defineProperty(writtenAfter, 'lastModified', { value: 12345, configurable: true });
			const getFile = vi
				.fn()
				.mockResolvedValueOnce(onDisk)
				.mockResolvedValueOnce(onDisk)
				.mockResolvedValueOnce(onDisk)
				.mockResolvedValueOnce(writtenAfter); // rafraîchissement baseline
			const h = { getFile } as unknown as FileSystemFileHandle;
			vi.mocked(fsa.getFsaLink).mockResolvedValue({
				handle: h,
				revision: 'sha256:before',
				epoch: 'epoch'
			});
			vi.mocked(fsa.revisionForFile).mockResolvedValue('sha256:changed');
			vi.mocked(fsa.requestPermission).mockResolvedValue(true);
			vi.mocked(fsa.writeHandle).mockResolvedValue(undefined);
			const confirmSpy = vi.spyOn(diskConflictStore, 'resolve').mockResolvedValue('overwrite');

			const ok = await saveToDisk('a', deps);

			expect(confirmSpy).toHaveBeenCalled();
			expect(ok).toBe(true);
			expect(fsa.writeHandle).toHaveBeenCalled();
			expect(file.diskLastModified).toBe(12345);
			confirmSpy.mockRestore();
		});

		it('writes unchanged disk content without confirmation', async () => {
			const onDisk = new File(['1234567'], 'note.md'); // 7 octets, mtime 1000 = baseline
			Object.defineProperty(onDisk, 'lastModified', { value: 1000, configurable: true });
			const writtenAfter = new File(['contenu'], 'note.md');
			Object.defineProperty(writtenAfter, 'lastModified', { value: 2000, configurable: true });
			const getFile = vi
				.fn()
				.mockResolvedValueOnce(onDisk)
				.mockResolvedValueOnce(onDisk)
				.mockResolvedValueOnce(writtenAfter);
			const h = { getFile } as unknown as FileSystemFileHandle;
			vi.mocked(fsa.getFsaLink).mockResolvedValue({
				handle: h,
				revision: 'sha256:disk',
				epoch: 'epoch'
			});
			vi.mocked(fsa.requestPermission).mockResolvedValue(true);
			vi.mocked(fsa.writeHandle).mockResolvedValue(undefined);
			const confirmSpy = vi.spyOn(diskConflictStore, 'resolve');

			const ok = await saveToDisk('a', deps);

			expect(ok).toBe(true);
			expect(confirmSpy).not.toHaveBeenCalled();
			confirmSpy.mockRestore();
		});

		it('requires confirmation when a legacy link has no stored revision', async () => {
			const onDisk = new File(['contenu'], 'note.md');
			const h = { getFile: vi.fn().mockResolvedValue(onDisk) } as unknown as FileSystemFileHandle;
			vi.mocked(fsa.getFsaLink).mockResolvedValue({ handle: h, revision: null, epoch: 'epoch' });
			const confirmSpy = vi.spyOn(diskConflictStore, 'resolve').mockResolvedValue('cancel');

			expect(await saveToDisk('a', deps)).toBe(false);
			expect(confirmSpy).toHaveBeenCalled();
			expect(fsa.writeHandle).not.toHaveBeenCalled();
			confirmSpy.mockRestore();
		});

		it('blocks the write when the revision check fails', async () => {
			const writtenAfter = new File(['contenu'], 'note.md');
			Object.defineProperty(writtenAfter, 'lastModified', { value: 3000, configurable: true });
			const getFile = vi
				.fn()
				.mockRejectedValueOnce(new Error('lecture check KO')) // check anti-écrasement
				.mockResolvedValueOnce(writtenAfter); // rafraîchissement baseline post-write
			const h = { getFile } as unknown as FileSystemFileHandle;
			vi.mocked(fsa.getFsaLink).mockResolvedValue({
				handle: h,
				revision: 'sha256:disk',
				epoch: 'epoch'
			});
			vi.mocked(fsa.requestPermission).mockResolvedValue(true);
			vi.mocked(fsa.writeHandle).mockResolvedValue(undefined);
			const confirmSpy = vi.spyOn(diskConflictStore, 'resolve');

			const ok = await saveToDisk('a', deps);

			// A failed preflight read cannot prove that the file is unchanged.
			expect(confirmSpy).not.toHaveBeenCalled();
			expect(console.error).toHaveBeenCalled();
			expect(ok).toBe(false);
			expect(fsa.writeHandle).not.toHaveBeenCalled();
			confirmSpy.mockRestore();
		});
	});
});

describe('rename linked files', () => {
	beforeEach(() => {
		vi.mocked(desktop.isDesktop).mockReturnValue(true);
		vi.mocked(fsa.savePathLink).mockReset();
		vi.mocked(diskTauri.tauriRenamePath).mockReset();
		vi.mocked(fsa.getPathLinkWithEpoch).mockResolvedValue({
			record: { kind: 'path', path: '/tmp/note.md' },
			epoch: 'epoch',
			revision: 'sha256:before'
		});
	});

	it('stores the native name and revision without changing unsaved content', async () => {
		const file = makeFile({ linkedToDisk: true, content: 'local edits' });
		vi.mocked(diskTauri.tauriRenamePath).mockResolvedValue({
			token: 'token',
			path: '/tmp/renamed.md',
			stat: { lastModified: 1, size: 3, revision: 'sha256:before' }
		});
		expect(await renameOnDisk('a', 'renamed.md', testDeps([file]))).toBe(true);
		expect(diskTauri.tauriRenamePath).toHaveBeenCalledWith(
			'/tmp/note.md',
			'renamed.md',
			'sha256:before'
		);
		expect(fsa.savePathLink).toHaveBeenCalledWith(
			'a',
			{ kind: 'path', path: '/tmp/renamed.md' },
			'epoch',
			'sha256:before'
		);
		expect(file.content).toBe('local edits');
		expect(file.dirty).toBe(true);
	});

	it('rolls back the disk rename when the new link cannot be saved', async () => {
		const file = makeFile({ linkedToDisk: true, diskRevision: 'sha256:before' });
		vi.mocked(diskTauri.tauriRenamePath).mockResolvedValue({
			token: 'token',
			path: '/tmp/renamed.md',
			stat: { lastModified: 1, size: 3, revision: 'sha256:before' }
		});
		vi.mocked(fsa.savePathLink).mockRejectedValueOnce(new Error('IndexedDB unavailable'));
		expect(await renameOnDisk('a', 'renamed.md', testDeps([file]))).toBe(false);
		expect(diskTauri.tauriRenamePath).toHaveBeenLastCalledWith(
			'/tmp/renamed.md',
			'note.md',
			'sha256:before'
		);
		expect(file.name).toBe('note.md');
		expect(notify.toasts.some((toast) => toast.level === 'error')).toBe(true);
	});

	it.each(['permission denied'])('keeps the old link on %s', async (message) => {
		vi.mocked(diskTauri.tauriRenamePath).mockRejectedValue(new Error(message));
		const file = makeFile({ linkedToDisk: true });
		expect(await renameOnDisk('a', 'renamed.md', testDeps([file]))).toBe(false);
		expect(fsa.savePathLink).not.toHaveBeenCalled();
		expect(file.name).toBe('note.md');
	});

	it('rejects missing files and missing disk links', async () => {
		expect(await renameOnDisk('a', 'renamed.md', testDeps([]))).toBe(false);
		vi.mocked(fsa.getPathLinkWithEpoch).mockResolvedValue(null);
		expect(await renameOnDisk('a', 'renamed.md', testDeps([makeFile()]))).toBe(false);
		expect(diskTauri.tauriRenamePath).not.toHaveBeenCalled();
	});

	it('detaches browser handles so the next save uses the new draft name', async () => {
		vi.mocked(desktop.isDesktop).mockReturnValue(false);
		const file = makeFile({ linkedToDisk: true });
		expect(await renameOnDisk('a', 'renamed.md', testDeps([file]))).toBe(true);
		expect(file.linkedToDisk).toBe(false);
		expect(fsa.deleteHandle).toHaveBeenCalledWith('a');
		expect(diskTauri.tauriRenamePath).not.toHaveBeenCalled();
		expect(notify.toasts.some((toast) => toast.level === 'info')).toBe(true);
	});

	it('revokes remembered native access when a link is removed', async () => {
		vi.mocked(fsa.getPathLink).mockResolvedValue({ kind: 'path', path: '/tmp/note.md' });
		await unlinkFromDisk('a', testDeps([makeFile({ linkedToDisk: true })]));
		expect(diskTauri.tauriForgetPath).toHaveBeenCalledWith('/tmp/note.md');
		expect(fsa.deleteHandle).toHaveBeenCalledWith('a');
	});
});

describe('saveToDisk desktop capability backend', () => {
	function desktopDeps(file: FileItem) {
		const scheduleSave = vi.fn();
		const onSyncName = vi.fn((id: string, name: string) => {
			if (id === file.id) file.name = name;
		});
		const deps: DiskSyncDeps = {
			getFile: () => file,
			onCreate: () => file,
			onSyncName,
			scheduleSave
		};
		vi.mocked(desktop.isDesktop).mockReturnValue(true);
		vi.mocked(fsa.isFSASupported).mockReturnValue(false);
		return { deps, onSyncName, scheduleSave };
	}

	it('returns false when the native picker is canceled', async () => {
		const file = makeFile();
		const { deps, onSyncName } = desktopDeps(file);
		vi.mocked(fsa.getPathLink).mockResolvedValue(null);
		vi.mocked(diskTauri.tauriPickSaveTarget).mockResolvedValue(null);

		expect(await saveToDisk('a', deps)).toBe(false);
		expect(diskTauri.tauriWritePath).not.toHaveBeenCalled();
		expect(onSyncName).not.toHaveBeenCalled();
	});

	it('persists a newly selected target and writes with its native revision', async () => {
		const file = makeFile({ name: 'Untitled.md' });
		const { deps, onSyncName, scheduleSave } = desktopDeps(file);
		const pathLink = { kind: 'path' as const, path: '/tmp/Chosen.MDX' };
		vi.mocked(fsa.getPathLink).mockResolvedValue(null);
		vi.mocked(diskTauri.tauriPickSaveTarget).mockResolvedValue(pathLink);
		vi.mocked(diskTauri.tauriReadMeta).mockResolvedValue({
			lastModified: 10,
			size: 3,
			revision: 'sha256:selected'
		});
		vi.mocked(diskTauri.tauriWritePath).mockResolvedValue({
			lastModified: 20,
			size: 7,
			revision: 'sha256:written'
		});

		expect(await saveToDisk('a', deps)).toBe(true);
		expect(fsa.savePathLink).toHaveBeenCalledWith('a', pathLink, 'epoch', 'sha256:written');
		expect(file.linkedToDisk).toBe(true);
		expect(diskTauri.tauriWritePath).toHaveBeenCalledWith(
			'/tmp/Chosen.MDX',
			'contenu',
			'sha256:selected',
			false
		);
		expect(file.diskRevision).toBe('sha256:written');
		expect(file.name).toBe('Chosen.MDX');
		expect(onSyncName).toHaveBeenCalledWith('a', 'Chosen.MDX');
		expect(notify.toasts.find((toast) => toast.level === 'success')?.message).toContain(
			'Chosen.MDX'
		);
		expect(scheduleSave).toHaveBeenCalledWith('a');
	});

	it('does not persist a new path when the native write fails', async () => {
		const file = makeFile();
		const { deps, onSyncName } = desktopDeps(file);
		vi.mocked(fsa.getPathLink).mockResolvedValue(null);
		vi.mocked(diskTauri.tauriPickSaveTarget).mockResolvedValue({
			kind: 'path',
			path: '/tmp/new.md'
		});
		vi.mocked(diskTauri.tauriWritePath).mockRejectedValue(new Error('disk full'));

		expect(await saveToDisk('a', deps)).toBe(false);
		expect(fsa.savePathLink).not.toHaveBeenCalled();
		expect(onSyncName).not.toHaveBeenCalled();
		expect(file.name).toBe('note.md');
	});

	it('keeps a concurrent draft rename after a successful native write', async () => {
		const file = makeFile({ name: 'Untitled.md' });
		const { deps, onSyncName } = desktopDeps(file);
		const pathLink = { kind: 'path' as const, path: '/tmp/chosen.md' };
		vi.mocked(fsa.getPathLink).mockResolvedValue(null);
		vi.mocked(diskTauri.tauriPickSaveTarget).mockResolvedValue(pathLink);
		vi.mocked(diskTauri.tauriWritePath).mockImplementation(async () => {
			file.name = 'Manual.md';
			return { lastModified: 20, size: 7, revision: 'sha256:written' };
		});

		expect(await saveToDisk('a', deps)).toBe(true);
		expect(file.name).toBe('Manual.md');
		expect(onSyncName).not.toHaveBeenCalled();
		expect(notify.toasts.find((toast) => toast.level === 'success')?.message).toContain(
			'chosen.md'
		);
	});

	it('keeps an edit made during a native write dirty', async () => {
		const file = makeFile({ content: 'snapshot' });
		const { deps } = desktopDeps(file);
		let releaseWrite!: (value: { lastModified: number; size: number; revision: string }) => void;
		vi.mocked(fsa.getPathLink).mockResolvedValue({ kind: 'path', path: '/tmp/note.md' });
		vi.mocked(diskTauri.tauriWritePath).mockImplementation(
			() =>
				new Promise((resolve) => {
					releaseWrite = resolve;
				})
		);

		const saving = saveToDisk('a', deps);
		await vi.waitFor(() =>
			expect(diskTauri.tauriWritePath).toHaveBeenCalledWith('/tmp/note.md', 'snapshot', null, false)
		);
		file.content = 'later edit';
		releaseWrite({ lastModified: 2, size: 8, revision: 'sha256:snapshot' });

		expect(await saving).toBe(true);
		expect(file.dirty).toBe(true);
	});

	it('cancels when the native final revision check reports a conflict', async () => {
		const file = makeFile({ diskRevision: 'sha256:before' });
		const { deps } = desktopDeps(file);
		vi.mocked(fsa.getPathLink).mockResolvedValue({ kind: 'path', path: '/tmp/note.md' });
		vi.mocked(diskTauri.tauriWritePath).mockRejectedValue(
			new Error('disk conflict: target changed since it was opened')
		);
		const confirmSpy = vi.spyOn(diskConflictStore, 'resolve').mockResolvedValue('cancel');

		expect(await saveToDisk('a', deps)).toBe(false);
		expect(diskTauri.tauriWritePath).toHaveBeenCalledOnce();
		expect(notify.toasts.some((toast) => toast.level === 'info')).toBe(true);
		confirmSpy.mockRestore();
	});

	it('compares the approved external revision again before writing', async () => {
		const file = makeFile({ diskRevision: 'sha256:before' });
		const { deps } = desktopDeps(file);
		vi.mocked(fsa.getPathLink).mockResolvedValue({ kind: 'path', path: '/tmp/note.md' });
		vi.mocked(diskTauri.tauriWritePath)
			.mockRejectedValueOnce(new Error('disk conflict: target changed since it was opened'))
			.mockResolvedValueOnce({
				lastModified: 30,
				size: 7,
				revision: 'sha256:forced'
			});
		const confirmSpy = vi.spyOn(diskConflictStore, 'resolve').mockResolvedValue('overwrite');

		expect(await saveToDisk('a', deps)).toBe(true);
		expect(diskTauri.tauriWritePath).toHaveBeenLastCalledWith(
			'/tmp/note.md',
			'contenu',
			'sha256:external',
			false
		);
		expect(file.diskRevision).toBe('sha256:forced');
		confirmSpy.mockRestore();
	});

	it('reports a native write error and marks the link broken', async () => {
		const file = makeFile();
		const { deps, scheduleSave } = desktopDeps(file);
		vi.mocked(fsa.getPathLink).mockResolvedValue({ kind: 'path', path: '/tmp/note.md' });
		vi.mocked(diskTauri.tauriWritePath).mockRejectedValue(new Error('disk full'));

		expect(await saveToDisk('a', deps)).toBe(false);
		expect(file.brokenLink).toBe(true);
		expect(notify.toasts.some((toast) => toast.level === 'error')).toBe(true);
		expect(scheduleSave).not.toHaveBeenCalled();
	});

	it('requires a fresh native picker after the session capability expires', async () => {
		const file = makeFile({ diskRevision: 'sha256:old' });
		const { deps, onSyncName } = desktopDeps(file);
		vi.mocked(fsa.getPathLink).mockResolvedValue({ kind: 'path', path: '/tmp/note.md' });
		vi.mocked(diskTauri.tauriWritePath)
			.mockRejectedValueOnce(new Error('Disk capability expired. Choose the file again.'))
			.mockResolvedValueOnce({
				lastModified: 50,
				size: 7,
				revision: 'sha256:reauthorized'
			});
		vi.mocked(diskTauri.tauriPickSaveTarget).mockResolvedValue({
			kind: 'path',
			path: '/tmp/reauthorized.md'
		});
		vi.mocked(diskTauri.tauriReadMeta).mockResolvedValue({
			lastModified: 40,
			size: 3,
			revision: 'sha256:selected'
		});

		expect(await saveToDisk('a', deps)).toBe(true);
		expect(fsa.savePathLink).toHaveBeenCalledWith(
			'a',
			{
				kind: 'path',
				path: '/tmp/reauthorized.md'
			},
			'epoch',
			'sha256:reauthorized'
		);
		expect(file.diskRevision).toBe('sha256:reauthorized');
		expect(file.name).toBe('reauthorized.md');
		expect(onSyncName).toHaveBeenCalledWith('a', 'reauthorized.md');
		expect(notify.toasts.find((toast) => toast.level === 'success')?.message).toContain(
			'reauthorized.md'
		);
	});

	it('keeps the old name when a retargeted path cannot be persisted', async () => {
		const file = makeFile({ name: 'note.md', diskRevision: 'sha256:old' });
		const { deps, onSyncName } = desktopDeps(file);
		let storedPath: { kind: 'path'; path: string } | null = {
			kind: 'path',
			path: '/tmp/note.md'
		};
		vi.mocked(fsa.getPathLink).mockImplementation(async () => storedPath);
		vi.mocked(fsa.deleteHandle).mockImplementation(async () => {
			storedPath = null;
		});
		vi.mocked(diskTauri.tauriWritePath)
			.mockRejectedValueOnce(new Error('Disk capability expired. Choose the file again.'))
			.mockResolvedValue({
				lastModified: 50,
				size: 7,
				revision: 'sha256:reauthorized'
			});
		vi.mocked(diskTauri.tauriPickSaveTarget)
			.mockResolvedValueOnce({ kind: 'path', path: '/tmp/new-target.md' })
			.mockResolvedValueOnce({ kind: 'path', path: '/tmp/retry-target.md' });
		vi.mocked(diskTauri.tauriReadMeta).mockResolvedValue({
			lastModified: 40,
			size: 3,
			revision: 'sha256:selected'
		});
		vi.mocked(fsa.savePathLink).mockRejectedValueOnce(new Error('IndexedDB'));

		expect(await saveToDisk('a', deps)).toBe(true);
		expect(file.linkedToDisk).toBe(false);
		expect(file.name).toBe('note.md');
		expect(onSyncName).not.toHaveBeenCalled();
		expect(notify.toasts.some((toast) => toast.level === 'error')).toBe(true);
		expect(fsa.deleteHandle).toHaveBeenCalledWith('a');

		vi.mocked(fsa.savePathLink).mockResolvedValueOnce(undefined);
		expect(await saveToDisk('a', deps)).toBe(true);
		expect(diskTauri.tauriPickSaveTarget).toHaveBeenCalledTimes(2);
		expect(vi.mocked(diskTauri.tauriWritePath).mock.calls.map(([path]) => path)).toEqual([
			'/tmp/note.md',
			'/tmp/new-target.md',
			'/tmp/retry-target.md'
		]);
		expect(file.name).toBe('retry-target.md');
	});

	it('aborts a retarget before writing when the old link cannot be deleted', async () => {
		const file = makeFile({ name: 'note.md', diskRevision: 'sha256:old' });
		const { deps, onSyncName } = desktopDeps(file);
		vi.mocked(fsa.getPathLink).mockResolvedValue({ kind: 'path', path: '/tmp/note.md' });
		vi.mocked(diskTauri.tauriWritePath).mockRejectedValueOnce(
			new Error('Disk capability expired. Choose the file again.')
		);
		vi.mocked(diskTauri.tauriPickSaveTarget).mockResolvedValue({
			kind: 'path',
			path: '/tmp/new-target.md'
		});
		vi.mocked(fsa.deleteHandle).mockRejectedValueOnce(new Error('IndexedDB'));

		expect(await saveToDisk('a', deps)).toBe(false);
		expect(fsa.deleteHandle).toHaveBeenCalledWith('a');
		expect(diskTauri.tauriWritePath).toHaveBeenCalledOnce();
		expect(fsa.savePathLink).not.toHaveBeenCalled();
		expect(file.name).toBe('note.md');
		expect(onSyncName).not.toHaveBeenCalled();
		expect(notify.toasts.some((toast) => toast.level === 'error')).toBe(true);
	});
});

describe('refreshBrokenLinks', () => {
	it('sets brokenLink when checkHandle returns broken', async () => {
		const f = makeFile({ id: 'f1', linkedToDisk: true });
		vi.mocked(fsa.getHandle).mockResolvedValue(handle);
		vi.mocked(fsa.checkHandle).mockResolvedValue('broken');
		await refreshBrokenLinks([f], (id) => (id === 'f1' ? f : undefined));
		expect(f.brokenLink).toBe(true);
		expect(f.linkedToDisk).toBe(true); // handle présent → on garde le lien
	});

	it('sets brokenLink and clears linkedToDisk for a missing handle', async () => {
		const f = makeFile({ id: 'f1', linkedToDisk: true });
		vi.mocked(fsa.getHandle).mockResolvedValue(null);
		await refreshBrokenLinks([f], (id) => (id === 'f1' ? f : undefined));
		expect(f.brokenLink).toBe(true);
		expect(f.linkedToDisk).toBe(false);
		// Do not call checkHandle without a handle.
		expect(fsa.checkHandle).not.toHaveBeenCalled();
	});

	it('skips an update when FileItem is missing from the store', async () => {
		const f = makeFile({ id: 'f1', linkedToDisk: true });
		vi.mocked(fsa.getHandle).mockResolvedValue(handle);
		vi.mocked(fsa.checkHandle).mockResolvedValue('broken');
		// getFileMutable cannot find the file after concurrent deletion.
		await expect(refreshBrokenLinks([f], () => undefined)).resolves.toBeUndefined();
		// Do not change the original object when lookup returns undefined.
		expect(f.brokenLink).toBeUndefined();
	});
});

describe('guarded native imports', () => {
	const opened = {
		name: 'note.md',
		content: 'disk',
		path: '/tmp/note.md',
		lastModified: 42,
		size: 4,
		revision: 'new-disk-revision',
		link: { kind: 'path' as const, path: '/tmp/note.md' }
	};
	it('reactivates an existing dirty draft without branch or revision changes', async () => {
		vi.mocked(desktop.isDesktop).mockReturnValue(true);
		vi.mocked(diskTauri.tauriPickAndOpen).mockResolvedValue({ files: [opened], failed: 0 });
		const file = makeFile({
			name: 'Untitled.md',
			content: 'local unsaved',
			dirty: true,
			diskRevision: 'old-revision'
		});
		vi.mocked(fsa.getPathLink).mockResolvedValue({ kind: 'path', path: opened.path });
		const onCreate = vi.fn();
		const onActivate = vi.fn();
		const onSyncName = vi.fn((id: string, name: string) => {
			if (id === file.id) file.name = name;
		});
		const result = await openFromDisk({
			getFile: () => file,
			getFiles: () => [file],
			onCreate,
			onActivate,
			onSyncName,
			scheduleSave: vi.fn()
		});
		expect(result).toEqual([file]);
		expect(onActivate).toHaveBeenCalledWith(file.id);
		expect(onSyncName).toHaveBeenCalledWith(file.id, 'note.md');
		expect(onCreate).not.toHaveBeenCalled();
		expect(file).toMatchObject({
			name: 'note.md',
			content: 'local unsaved',
			dirty: true,
			diskRevision: 'old-revision'
		});
	});

	it('imports a native directory and keeps backend failures in the summary', async () => {
		vi.mocked(desktop.isDesktop).mockReturnValue(true);
		vi.mocked(diskTauri.tauriPickDirectoryAndOpen).mockResolvedValue({
			files: [opened],
			failed: 1
		});
		const onProgress = vi.fn();
		const result = await openDirectoryFromDisk(
			{
				getFile: () => undefined,
				onCreate: (name, content) => makeFile({ name, content }),
				scheduleSave: vi.fn()
			},
			{ onProgress }
		);
		expect(result).toHaveLength(1);
		expect(onProgress).toHaveBeenLastCalledWith(
			expect.objectContaining({ imported: 1, failed: 1 })
		);
	});
	it('rejects false Markdown and stops creation after cancellation', async () => {
		vi.mocked(desktop.isDesktop).mockReturnValue(true);
		const onCreate = vi.fn();
		const deps = { getFile: () => undefined, onCreate, scheduleSave: vi.fn() };
		vi.mocked(diskTauri.tauriPickAndOpen).mockResolvedValue({
			files: [{ ...opened, content: '\0' }],
			failed: 0
		});
		expect(await openFromDisk(deps)).toEqual([]);
		const controller = new AbortController();
		controller.abort();
		expect(await openFromDisk(deps, { signal: controller.signal })).toEqual([]);
		expect(onCreate).not.toHaveBeenCalled();
	});
	it('does not start a native picker in a browser', async () => {
		expect(
			await openDirectoryFromDisk({
				getFile: () => undefined,
				onCreate: vi.fn(),
				scheduleSave: vi.fn()
			})
		).toEqual([]);
		expect(diskTauri.tauriPickDirectoryAndOpen).not.toHaveBeenCalled();
	});
});

describe('native capability acknowledgment', () => {
	it('returns only created or deduplicated tokens with persistent links', async () => {
		vi.mocked(desktop.isDesktop).mockReturnValue(true);
		vi.mocked(diskTauri.tauriOpenNativeGrants).mockResolvedValue({
			files: [
				{
					token: 'good-token',
					name: 'good.md',
					content: 'ok',
					path: '/tmp/good.md',
					lastModified: 1,
					size: 2,
					revision: 'r1',
					link: { kind: 'path', path: '/tmp/good.md' }
				},
				{
					token: 'binary-token',
					name: 'binary.md',
					content: '\0',
					path: '/tmp/binary.md',
					lastModified: 1,
					size: 1,
					revision: 'r2',
					link: { kind: 'path', path: '/tmp/binary.md' }
				}
			],
			failed: 1
		});
		const result = await openPathsFromDesktop(
			[
				{ token: 'good-token', path: '/tmp/good.md', stat: null },
				{ token: 'binary-token', path: '/tmp/binary.md', stat: null },
				{ token: 'read-failed-token', path: '/tmp/read-failed.md', stat: null }
			],
			testDeps([])
		);
		expect(result.files.map((file) => file.name)).toEqual(['good.md']);
		expect(result.processedTokens).toEqual(['good-token']);
	});
	it('reverts in-memory creation when token link persistence fails', async () => {
		vi.mocked(desktop.isDesktop).mockReturnValue(true);
		vi.mocked(diskTauri.tauriOpenNativeGrants).mockResolvedValue({
			files: [
				{
					token: 'failed-token',
					name: 'failed.md',
					content: 'ok',
					path: '/tmp/failed.md',
					lastModified: 1,
					size: 2,
					revision: 'r1',
					link: { kind: 'path', path: '/tmp/failed.md' }
				}
			],
			failed: 0
		});
		vi.mocked(fsa.savePathLink).mockRejectedValueOnce(new Error('IndexedDB'));
		const store: FileItem[] = [];
		const deps = testDeps(store);
		deps.onImportRollback = (id) =>
			store.splice(
				store.findIndex((file) => file.id === id),
				1
			);
		const result = await openPathsFromDesktop(
			[{ token: 'failed-token', path: '/tmp/failed.md', stat: null }],
			deps
		);
		expect(result).toEqual({ files: [], processedTokens: [] });
		expect(store).toEqual([]);
	});
	it('also acknowledges a token that reactivates an existing local branch', async () => {
		vi.mocked(desktop.isDesktop).mockReturnValue(true);
		const existing = makeFile({ id: 'existing', content: 'local' });
		vi.mocked(fsa.getPathLink).mockResolvedValue({ kind: 'path', path: '/tmp/same.md' });
		vi.mocked(diskTauri.tauriOpenNativeGrants).mockResolvedValue({
			files: [
				{
					token: 'same-token',
					name: 'same.md',
					content: 'disk',
					path: '/tmp/same.md',
					lastModified: 1,
					size: 4,
					revision: 'r1',
					link: { kind: 'path', path: '/tmp/same.md' }
				}
			],
			failed: 0
		});
		const result = await openPathsFromDesktop(
			[{ token: 'same-token', path: '/tmp/same.md', stat: null }],
			{
				getFile: () => existing,
				getFiles: () => [existing],
				onCreate: vi.fn(),
				onActivate: vi.fn(),
				scheduleSave: vi.fn()
			}
		);
		expect(result.processedTokens).toEqual(['same-token']);
		expect(result.files).toEqual([existing]);
	});
});

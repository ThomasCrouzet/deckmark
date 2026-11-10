import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackupEntry } from '#lib/desktop-backup.js';

// The Web edition never mounts this panel, so a browser workflow cannot reach
// the deferred list and read races. These cases call the panel with a replaced
// native bridge. See docs/TESTING.md for the retained failure risks.

const native = vi.hoisted(() => {
	const state = {
		enabled: false,
		root: '/folder-a',
		rootId: 'root-a',
		intervalHours: 24,
		retention: 10,
		lastSuccessAt: null as number | null,
		nextRunAt: null as number | null,
		lastError: null as string | null
	};
	const listeners = new Set<() => void>();
	const api = {
		chooseBackupFolder: vi.fn(),
		listBackupSnapshots: vi.fn(),
		readBackupSnapshot: vi.fn(),
		writeBackupNow: vi.fn()
	};
	function setRoot(rootId: string, root: string): void {
		state.rootId = rootId;
		state.root = root;
		for (const listener of listeners) listener();
	}
	return { state, listeners, api, setRoot };
});

vi.mock('#lib/desktop-backup.js', () => ({
	chooseBackupFolder: native.api.chooseBackupFolder,
	disableDesktopBackup: vi.fn(),
	enableDesktopBackup: vi.fn(),
	getDesktopBackupState: () => ({ ...native.state }),
	listBackupSnapshots: native.api.listBackupSnapshots,
	readBackupSnapshot: native.api.readBackupSnapshot,
	setBackupIntervalHours: vi.fn(),
	setBackupRetention: vi.fn(),
	subscribeDesktopBackup: (listener: () => void) => {
		native.listeners.add(listener);
		listener();
		return () => {
			native.listeners.delete(listener);
		};
	},
	writeBackupNow: native.api.writeBackupNow
}));

import DesktopBackupPanel from './DesktopBackupPanel.svelte';

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((accept, refuse) => {
		resolve = accept;
		reject = refuse;
	});
	return { promise, resolve, reject };
}

function entry(rootId: string, fileName: string): BackupEntry {
	return {
		rootId,
		path: `/${rootId}/${fileName}`,
		fileName,
		size: 1024,
		modifiedMs: 1_700_000_000_000
	};
}

function backupText(draftCount: number): string {
	const drafts = Array.from({ length: draftCount }, (_, index) => ({
		id: `draft-${index}`,
		name: `Draft ${index}`,
		content: `# Draft ${index}\n`,
		createdAt: 1_700_000_000_000,
		updatedAt: 1_700_000_000_000,
		order: index,
		open: false
	}));
	return JSON.stringify({
		format: 'mdsh-backup',
		schemaVersion: 2,
		exportedAt: 1_700_000_000_000,
		drafts,
		workspaces: [],
		templates: [],
		projects: [],
		projectAssets: []
	});
}

function renderPanel(): ReturnType<typeof render> {
	return render(DesktopBackupPanel, { props: { onRestore: vi.fn() } });
}

beforeEach(() => {
	native.listeners.clear();
	native.state.enabled = false;
	native.state.root = '/folder-a';
	native.state.rootId = 'root-a';
	native.state.lastSuccessAt = null;
	native.state.nextRunAt = null;
	native.state.lastError = null;
	native.api.chooseBackupFolder.mockReset();
	native.api.listBackupSnapshots.mockReset();
	native.api.readBackupSnapshot.mockReset();
	native.api.writeBackupNow.mockReset();
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe('Desktop backup panel folder identity', () => {
	it('discards a delayed list from the folder that is no longer selected', async () => {
		const user = userEvent.setup();
		const first = deferred<BackupEntry[]>();
		const second = deferred<BackupEntry[]>();
		native.api.listBackupSnapshots
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		native.api.chooseBackupFolder.mockImplementation(async () => {
			native.setRoot('root-b', '/folder-b');
			return '/folder-b';
		});
		renderPanel();
		await waitFor(() => expect(native.api.listBackupSnapshots).toHaveBeenCalledWith('root-a'));

		await user.click(screen.getByRole('button', { name: 'Choisir un dossier' }));
		await waitFor(() => expect(native.api.listBackupSnapshots).toHaveBeenCalledWith('root-b'));
		second.resolve([entry('root-b', 'deckmark-backup-b.json')]);
		expect(await screen.findByText('deckmark-backup-b.json')).toBeInTheDocument();

		first.resolve([entry('root-a', 'deckmark-backup-a.json')]);
		await waitFor(() => expect(native.listeners.size).toBe(1));
		expect(screen.queryByText('deckmark-backup-a.json')).not.toBeInTheDocument();
		expect(screen.getByText('deckmark-backup-b.json')).toBeInTheDocument();
	});

	it('ignores a delayed list error from the folder that is no longer selected', async () => {
		const user = userEvent.setup();
		const first = deferred<BackupEntry[]>();
		const second = deferred<BackupEntry[]>();
		native.api.listBackupSnapshots
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		native.api.chooseBackupFolder.mockImplementation(async () => {
			native.setRoot('root-b', '/folder-b');
			return '/folder-b';
		});
		renderPanel();
		await waitFor(() => expect(native.api.listBackupSnapshots).toHaveBeenCalledWith('root-a'));

		await user.click(screen.getByRole('button', { name: 'Choisir un dossier' }));
		await waitFor(() => expect(native.api.listBackupSnapshots).toHaveBeenCalledWith('root-b'));
		second.resolve([entry('root-b', 'deckmark-backup-b.json')]);
		expect(await screen.findByText('deckmark-backup-b.json')).toBeInTheDocument();

		first.reject(new Error('old folder failed'));
		await waitFor(() => expect(native.listeners.size).toBe(1));
		expect(screen.queryByRole('alert')).not.toBeInTheDocument();
		expect(screen.getByText('deckmark-backup-b.json')).toBeInTheDocument();
	});

	it('lets the newest list win after a return to the first folder', async () => {
		const user = userEvent.setup();
		const initial = deferred<BackupEntry[]>();
		const folderB = deferred<BackupEntry[]>();
		const returned = deferred<BackupEntry[]>();
		native.api.listBackupSnapshots
			.mockReturnValueOnce(initial.promise)
			.mockReturnValueOnce(folderB.promise)
			.mockReturnValueOnce(returned.promise);
		const choices = [
			{ rootId: 'root-b', path: '/folder-b' },
			{ rootId: 'root-a', path: '/folder-a' }
		];
		native.api.chooseBackupFolder.mockImplementation(async () => {
			const choice = choices.shift();
			if (!choice) throw new Error('unexpected folder choice');
			native.setRoot(choice.rootId, choice.path);
			return choice.path;
		});
		renderPanel();
		await waitFor(() => expect(native.api.listBackupSnapshots).toHaveBeenCalledWith('root-a'));

		const choose = screen.getByRole('button', { name: 'Choisir un dossier' });
		await user.click(choose);
		await waitFor(() => expect(native.api.listBackupSnapshots).toHaveBeenCalledWith('root-b'));
		folderB.resolve([entry('root-b', 'deckmark-backup-b.json')]);
		expect(await screen.findByText('deckmark-backup-b.json')).toBeInTheDocument();
		await user.click(choose);
		await waitFor(() => expect(native.api.listBackupSnapshots).toHaveBeenCalledTimes(3));

		initial.resolve([entry('root-a', 'deckmark-backup-old-a.json')]);
		await waitFor(() => expect(native.listeners.size).toBe(1));
		expect(screen.queryByText('deckmark-backup-old-a.json')).not.toBeInTheDocument();
		expect(screen.queryByText('deckmark-backup-b.json')).not.toBeInTheDocument();
		returned.resolve([entry('root-a', 'deckmark-backup-new-a.json')]);
		expect(await screen.findByText('deckmark-backup-new-a.json')).toBeInTheDocument();
		expect(screen.queryByText('deckmark-backup-old-a.json')).not.toBeInTheDocument();
	});

	it('previews the exact folder and filename shown for the same name', async () => {
		const user = userEvent.setup();
		const initial = deferred<BackupEntry[]>();
		const folderB = deferred<BackupEntry[]>();
		const firstRead = deferred<string>();
		const secondRead = deferred<string>();
		native.api.listBackupSnapshots
			.mockReturnValueOnce(initial.promise)
			.mockReturnValueOnce(folderB.promise);
		native.api.readBackupSnapshot
			.mockReturnValueOnce(firstRead.promise)
			.mockReturnValueOnce(secondRead.promise);
		native.api.chooseBackupFolder.mockImplementation(async () => {
			native.setRoot('root-b', '/folder-b');
			return '/folder-b';
		});
		renderPanel();
		initial.resolve([entry('root-a', 'deckmark-backup-same.json')]);
		expect(await screen.findByText('deckmark-backup-same.json')).toBeInTheDocument();

		await user.click(screen.getByRole('button', { name: 'Aperçu' }));
		expect(native.api.readBackupSnapshot).toHaveBeenCalledWith(
			'root-a',
			'deckmark-backup-same.json'
		);
		firstRead.resolve(backupText(1));
		const preview = await screen.findByTestId('desktop-backup-preview');
		expect(preview).toHaveTextContent('1 fichier');

		await user.click(screen.getByRole('button', { name: 'Choisir un dossier' }));
		await waitFor(() => expect(native.api.listBackupSnapshots).toHaveBeenCalledWith('root-b'));
		folderB.resolve([entry('root-b', 'deckmark-backup-same.json')]);
		expect(await screen.findByText('deckmark-backup-same.json')).toBeInTheDocument();

		await user.click(screen.getByRole('button', { name: 'Aperçu' }));
		expect(native.api.readBackupSnapshot).toHaveBeenLastCalledWith(
			'root-b',
			'deckmark-backup-same.json'
		);
		secondRead.resolve(backupText(3));
		expect(await screen.findByTestId('desktop-backup-preview')).toHaveTextContent('3 fichier');
	});

	it('drops a preview that finishes after the folder changes', async () => {
		const user = userEvent.setup();
		const initial = deferred<BackupEntry[]>();
		const folderB = deferred<BackupEntry[]>();
		const read = deferred<string>();
		native.api.listBackupSnapshots
			.mockReturnValueOnce(initial.promise)
			.mockReturnValueOnce(folderB.promise);
		native.api.readBackupSnapshot.mockReturnValueOnce(read.promise);
		renderPanel();
		initial.resolve([entry('root-a', 'deckmark-backup-a.json')]);
		expect(await screen.findByText('deckmark-backup-a.json')).toBeInTheDocument();

		await user.click(screen.getByRole('button', { name: 'Aperçu' }));
		native.setRoot('root-b', '/folder-b');
		await waitFor(() =>
			expect(screen.queryByText('deckmark-backup-a.json')).not.toBeInTheDocument()
		);
		read.resolve(backupText(2));
		await waitFor(() =>
			expect(screen.queryByTestId('desktop-backup-preview')).not.toBeInTheDocument()
		);
		await user.click(screen.getByRole('button', { name: 'Actualiser la liste' }));
		await waitFor(() => expect(native.api.listBackupSnapshots).toHaveBeenCalledWith('root-b'));
		folderB.resolve([entry('root-b', 'deckmark-backup-b.json')]);
		expect(await screen.findByText('deckmark-backup-b.json')).toBeInTheDocument();
	});

	it('clears the old rows while the new folder list is pending', async () => {
		const user = userEvent.setup();
		const initial = deferred<BackupEntry[]>();
		const folderB = deferred<BackupEntry[]>();
		native.api.listBackupSnapshots
			.mockReturnValueOnce(initial.promise)
			.mockReturnValueOnce(folderB.promise);
		native.api.chooseBackupFolder.mockImplementation(async () => {
			native.setRoot('root-b', '/folder-b');
			return '/folder-b';
		});
		renderPanel();
		initial.resolve([entry('root-a', 'deckmark-backup-a.json')]);
		expect(await screen.findByText('deckmark-backup-a.json')).toBeInTheDocument();

		await user.click(screen.getByRole('button', { name: 'Choisir un dossier' }));
		await waitFor(() => expect(native.api.listBackupSnapshots).toHaveBeenCalledWith('root-b'));
		expect(screen.queryByText('deckmark-backup-a.json')).not.toBeInTheDocument();
		expect(screen.getByText('Chargement des réglages de sauvegarde locale...')).toBeInTheDocument();
	});

	it('reports a missing snapshot in the selected folder', async () => {
		const user = userEvent.setup();
		const initial = deferred<BackupEntry[]>();
		native.api.listBackupSnapshots.mockReturnValueOnce(initial.promise);
		native.api.readBackupSnapshot.mockRejectedValueOnce(new Error('missing file'));
		renderPanel();
		initial.resolve([entry('root-a', 'deckmark-backup-gone.json')]);
		expect(await screen.findByText('deckmark-backup-gone.json')).toBeInTheDocument();

		await user.click(screen.getByRole('button', { name: 'Aperçu' }));
		expect(await screen.findByRole('alert')).toHaveTextContent(
			'Lecture de l’instantané impossible. missing file'
		);
		expect(screen.queryByTestId('desktop-backup-preview')).not.toBeInTheDocument();
		expect(screen.getByText('deckmark-backup-gone.json')).toBeInTheDocument();
	});

	it('does not update state after the panel unmounts', async () => {
		const failure = vi.spyOn(console, 'error').mockImplementation(() => {});
		const initial = deferred<BackupEntry[]>();
		const folderB = deferred<BackupEntry[]>();
		native.api.listBackupSnapshots
			.mockReturnValueOnce(initial.promise)
			.mockReturnValueOnce(folderB.promise);
		const view = renderPanel();
		await waitFor(() => expect(native.api.listBackupSnapshots).toHaveBeenCalledWith('root-a'));
		view.unmount();
		expect(native.listeners.size).toBe(0);
		initial.resolve([entry('root-a', 'deckmark-backup-a.json')]);
		folderB.resolve([entry('root-b', 'deckmark-backup-b.json')]);
		await waitFor(() => expect(failure).not.toHaveBeenCalled());
	});
});

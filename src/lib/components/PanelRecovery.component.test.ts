import { render, screen, waitFor, cleanup } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, it, expect, vi } from 'vitest';
import WorkspacesPanel from './WorkspacesPanel.svelte';
import DiskLinksPanel from './DiskLinksPanel.svelte';
import { workspaceStore } from '#lib/workspaces.svelte.js';
import * as fsa from '#lib/fsa.js';
import { t } from '#lib/i18n/index.js';

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it('retries a failed workspace read', async () => {
	workspaceStore.loaded = false;
	const load = vi.spyOn(workspaceStore, 'load').mockRejectedValue(new Error('Storage unavailable'));
	render(WorkspacesPanel, { open: true, onClose: vi.fn() });
	await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(t('panels.loadFailed')));
	load.mockImplementation(async () => {
		workspaceStore.loaded = true;
	});
	await userEvent.setup().click(screen.getByRole('button', { name: t('source.retry') }));
	await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
	expect(load.mock.calls.length).toBeGreaterThanOrEqual(2);
});

it('retries a failed disk-link read', async () => {
	vi.stubGlobal('showOpenFilePicker', vi.fn());
	vi.stubGlobal('showSaveFilePicker', vi.fn());
	const list = vi.spyOn(fsa, 'listDiskLinks').mockRejectedValue(new Error('Storage unavailable'));
	render(DiskLinksPanel, { open: true, onClose: vi.fn() });
	await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(t('panels.loadFailed')));
	list.mockResolvedValue([]);
	await userEvent.setup().click(screen.getByRole('button', { name: t('source.retry') }));
	await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
	expect(list).toHaveBeenCalledTimes(2);
});

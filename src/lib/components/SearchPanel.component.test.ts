import { render, screen, waitFor, cleanup } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import SearchPanel from './SearchPanel.svelte';
import { filesStore } from '#lib/files.svelte.js';
import { promptStore } from '#lib/prompt.svelte.js';
import { notify } from '#lib/notify.svelte.js';
import { t } from '#lib/i18n/index.js';
import { commitReplacements } from '#lib/replacement-commit.js';

vi.mock('#lib/replace-worker.js', () => ({
	replaceInFilesAsync: vi.fn(async () => ({
		results: [{ id: 'a', name: 'a.md', content: 'after', count: 1 }],
		total: 1,
		regexError: null
	}))
}));

vi.mock('#lib/replacement-commit.js', () => ({
	commitReplacements: vi.fn()
}));

beforeEach(() => {
	filesStore.files = [
		{ id: 'a', name: 'a.md', content: 'before', createdAt: 1, updatedAt: 1, dirty: false }
	];
	vi.stubGlobal(
		'Worker',
		class {
			addEventListener() {}
			postMessage() {}
			terminate() {}
		}
	);
	vi.spyOn(promptStore, 'confirm').mockResolvedValue(true);
	vi.mocked(commitReplacements).mockResolvedValue({ status: 'stale' });
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function replace() {
	const user = userEvent.setup();
	await user.type(screen.getByRole('combobox'), 'before');
	await user.click(screen.getByTitle(t('search.replaceInFiles')));
	const button = screen.getByRole('button', { name: t('search.replaceAll') });
	await waitFor(() => expect(button).toBeEnabled());
	await user.click(button);
	await user.click(await screen.findByRole('button', { name: t('replacePreview.confirm') }));
}

describe('replacement failure handling', () => {
	it('keeps the panel open when the store refuses a stale replacement', async () => {
		const success = vi.spyOn(notify, 'success');
		const onClose = vi.fn();
		render(SearchPanel, { open: true, onClose });
		await replace();
		await waitFor(() =>
			expect(screen.getByRole('alert')).toHaveTextContent(t('replacePreview.stale'))
		);
		expect(onClose).not.toHaveBeenCalled();
		expect(success).not.toHaveBeenCalled();
	});

	it('reports a checkpoint failure and lets the user retry', async () => {
		vi.mocked(commitReplacements).mockRejectedValue(new DOMException('Full', 'QuotaExceededError'));
		const success = vi.spyOn(notify, 'success');
		const onClose = vi.fn();
		render(SearchPanel, { open: true, onClose });
		await replace();
		await waitFor(() =>
			expect(screen.getByRole('alert')).toHaveTextContent(t('search.replaceFailed'))
		);
		expect(screen.getByRole('button', { name: t('replacePreview.confirm') })).toBeEnabled();
		expect(onClose).not.toHaveBeenCalled();
		expect(success).not.toHaveBeenCalled();
	});

	it('does not label a worker timeout as a syntax error', async () => {
		render(SearchPanel, { open: true, onClose: vi.fn() });
		await userEvent.setup().type(screen.getByRole('combobox'), 'before');
		await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(t('search.timeout')), {
			timeout: 2000
		});
		expect(screen.getByRole('alert')).not.toHaveTextContent('Regex invalide');
		expect(screen.queryByText(t('search.resultCount', { n: 0 }))).not.toBeInTheDocument();
		expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
	});
});

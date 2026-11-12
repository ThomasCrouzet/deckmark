import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The Web edition never mounts the Git panel, so the browser suite cannot
// reach its diff paging. These cases replace the native Git bridge. They check
// the rendered DOM, keyboard activation, and the native size-limit state. See
// docs/TESTING.md for the retained native WebView risks.

const git = vi.hoisted(() => ({
	status: vi.fn(),
	log: vi.fn(),
	diff: vi.fn(),
	stage: vi.fn(),
	unstage: vi.fn(),
	commit: vi.fn()
}));

vi.mock('#lib/git-native.js', () => ({
	gitStatus: git.status,
	gitLog: git.log,
	gitDiff: git.diff,
	gitStage: git.stage,
	gitUnstage: git.unstage,
	gitCommit: git.commit,
	isGitReviewRequired: () => false
}));

import GitPanel from './GitPanel.svelte';

const status = {
	repository: 'self' as const,
	repositoryName: null,
	branch: 'main',
	head: 'a'.repeat(40),
	detached: false,
	initial: false,
	stagedTree: 'b'.repeat(40),
	clean: false,
	dirty: true,
	conflicts: [],
	nestedRepositories: [],
	nestedScanTruncated: false,
	outsideChanges: 0,
	files: [
		{
			path: 'long.md',
			originalPath: null,
			index: '.',
			worktree: 'M',
			untracked: false,
			conflicted: false
		}
	]
};

const diffLines = Array.from({ length: 2600 }, (_, index) => {
	const line = `line ${String(index + 1).padStart(4, '0')}`;
	return index === 2599 ? `${line} END` : line;
});

function renderPanel(): ReturnType<typeof render> {
	return render(GitPanel, {
		props: { rootId: 'root-a', projectName: 'Native project', onClose: vi.fn() }
	});
}

async function openLongDiff(): Promise<void> {
	renderPanel();
	await fireEvent.click(await screen.findByText('long.md'));
	await waitFor(() =>
		expect(
			within(screen.getByRole('list', { name: /long\.md/ })).getAllByRole('listitem')
		).toHaveLength(2000)
	);
}

beforeEach(() => {
	git.status.mockResolvedValue(status);
	git.log.mockResolvedValue([]);
	git.diff.mockResolvedValue(`${diffLines.join('\n')}\n`);
	git.stage.mockReset();
	git.unstage.mockReset();
	git.commit.mockReset();
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe('Git diff review beyond the initial page', () => {
	it('reviews the final hunk and returns to the first page by keyboard', async () => {
		const user = userEvent.setup();
		await openLongDiff();

		expect(screen.queryByText('line 2600 END')).not.toBeInTheDocument();
		expect(screen.getByTestId('git-diff-range')).toHaveAttribute('data-review-state', 'partial');

		const last = screen.getByTestId('git-diff-last');
		last.focus();
		await user.keyboard('{Enter}');

		expect(await screen.findByText('line 2600 END')).toBeInTheDocument();
		expect(
			within(screen.getByRole('list', { name: /long\.md/ })).getAllByRole('listitem')
		).toHaveLength(600);
		expect(screen.getByTestId('git-diff-range')).toHaveAttribute('data-review-state', 'complete');
		expect(screen.getByTestId('git-diff-range')).toHaveTextContent('2600');
		expect(document.activeElement).toBe(last);
		expect(screen.getByRole('heading', { name: /long\.md/ })).toBeInTheDocument();

		const first = screen.getByTestId('git-diff-first');
		first.focus();
		await user.keyboard('{Enter}');

		expect(await screen.findByText('line 0001')).toBeInTheDocument();
		expect(screen.queryByText('line 2600 END')).not.toBeInTheDocument();
		expect(screen.getByTestId('git-diff-range')).toHaveAttribute('data-review-state', 'partial');
		expect(document.activeElement).toBe(first);
	});

	it('reports the native 1 MiB output limit as a separate state', async () => {
		git.diff.mockRejectedValueOnce(new Error('Git output exceeds the 1 MiB limit'));
		renderPanel();
		await fireEvent.click(await screen.findByText('long.md'));

		const notice = await screen.findByTestId('git-diff-too-large');
		expect(notice).toHaveTextContent(/1 MiB|1 Mio/);
		expect(screen.queryByTestId('git-operation-error')).not.toBeInTheDocument();
		expect(screen.queryByText('line 0001')).not.toBeInTheDocument();
	});

	it('keeps the generic error for a different diff failure', async () => {
		git.diff.mockRejectedValueOnce(new Error('Git permission denied'));
		renderPanel();
		await fireEvent.click(await screen.findByText('long.md'));

		const error = await screen.findByTestId('git-operation-error');
		expect(error).toHaveTextContent('Git permission denied');
		expect(screen.queryByTestId('git-diff-too-large')).not.toBeInTheDocument();
	});
});

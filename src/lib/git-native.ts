import { IS_DESKTOP_EDITION } from './edition';

/**
 * Typed wrappers for the native Git commands.
 *
 * The desktop edition loads the Tauri bridge lazily. The Web edition never
 * reaches this module because the Git panel loader has a Web stub.
 */

export interface GitFileStatus {
	path: string;
	originalPath: string | null;
	index: string;
	worktree: string;
	untracked: boolean;
	conflicted: boolean;
}

export interface GitStatusSnapshot {
	repository: 'self' | 'parent';
	repositoryName: string | null;
	branch: string | null;
	head: string | null;
	detached: boolean;
	initial: boolean;
	/** Tree object written from the exact index shown to the user. */
	stagedTree: string | null;
	clean: boolean;
	dirty: boolean;
	conflicts: string[];
	nestedRepositories: string[];
	nestedScanTruncated: boolean;
	outsideChanges: number;
	files: GitFileStatus[];
}

export interface GitCommitEntry {
	hash: string;
	shortHash: string;
	author: string;
	timestamp: number;
	subject: string;
}

export interface GitCommitResult {
	hash: string;
}

export interface GitCommitReview {
	/** Index tree captured with the status the user reviewed. */
	tree: string;
	head: string | null;
	branch: string | null;
}

export const GIT_REVIEW_REQUIRED = 'DeckMark review required';

export function isGitReviewRequired(error: unknown): boolean {
	return String(error).includes(GIT_REVIEW_REQUIRED);
}

function ensureDesktopEdition(): void {
	if (!IS_DESKTOP_EDITION) {
		throw new Error('Git operations are available only in the desktop edition.');
	}
}

async function invokeGit<T>(command: string, args: Record<string, unknown>): Promise<T> {
	ensureDesktopEdition();
	const { invoke } = await import('@tauri-apps/api/core');
	return invoke<T>(command, args);
}

export function gitStatus(rootId: string): Promise<GitStatusSnapshot> {
	return invokeGit<GitStatusSnapshot>('git_status', { rootId });
}

export function gitDiff(rootId: string, path: string | null, staged: boolean): Promise<string> {
	return invokeGit<string>('git_diff', { rootId, path, staged });
}

export function gitLog(rootId: string, limit = 20): Promise<GitCommitEntry[]> {
	return invokeGit<GitCommitEntry[]>('git_log', { rootId, limit });
}

export function gitStage(rootId: string, paths: string[]): Promise<void> {
	return invokeGit<void>('git_stage', { rootId, paths });
}

export function gitUnstage(rootId: string, paths: string[]): Promise<void> {
	return invokeGit<void>('git_unstage', { rootId, paths });
}

export function gitCommit(
	rootId: string,
	message: string,
	review: GitCommitReview
): Promise<GitCommitResult> {
	return invokeGit<GitCommitResult>('git_commit', {
		rootId,
		message,
		expectedTree: review.tree,
		expectedHead: review.head,
		expectedBranch: review.branch
	});
}

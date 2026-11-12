<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { focusTrap } from '#lib/a11y/focusTrap.js';
	import { i18n } from '#lib/i18n/index.js';
	import { interpolate, type Locale } from '#lib/i18n/locale.js';
	import { gitEn, type GitMessageKey } from '#lib/i18n/messages/git-en.js';
	import { gitFr } from '#lib/i18n/messages/git-fr.js';
	import { promptStore } from '#lib/prompt.svelte.js';
	import {
		gitCommit,
		gitDiff,
		gitLog,
		gitStage,
		gitStatus,
		gitUnstage,
		isGitReviewRequired,
		type GitCommitEntry,
		type GitFileStatus,
		type GitStatusSnapshot
	} from '#lib/git-native.js';

	interface Props {
		rootId: string;
		projectName: string;
		onClose: () => void;
	}

	let { rootId, projectName, onClose }: Props = $props();

	const MESSAGES: Record<Locale, Record<GitMessageKey, string>> = {
		en: gitEn,
		fr: gitFr
	};

	function tg(key: GitMessageKey, params?: Record<string, string | number>): string {
		const dictionary = MESSAGES[i18n.locale] ?? gitEn;
		return interpolate(dictionary[key] ?? gitEn[key] ?? key, params);
	}

	type GroupKey = 'conflicted' | 'staged' | 'modified' | 'untracked' | 'deleted';

	interface FileRow {
		file: GitFileStatus;
		group: GroupKey;
		staged: boolean;
		partlyStaged: boolean;
	}

	let status = $state<GitStatusSnapshot | null>(null);
	let log = $state<GitCommitEntry[]>([]);
	let selectedPath = $state<string | null>(null);
	let diffStaged = $state(false);
	let diff = $state('');
	let diffLoading = $state(false);
	let loading = $state(true);
	let refreshing = $state(false);
	let busy = $state(false);
	let errorMessage = $state('');
	let notice = $state('');
	let commitMessage = $state('');
	let closeButton: HTMLButtonElement;
	let refreshCounter = 0;
	let diffCounter = 0;
	const DIFF_PAGE_SIZE = 2000;
	let diffPage = $state(0);
	let diffTooLarge = $state(false);
	let diffList = $state<HTMLOListElement | null>(null);

	const mutable = $derived(status?.repository === 'self');
	const stagedFiles = $derived(
		(status?.files ?? []).filter(
			(file) => file.index !== '.' && !file.untracked && !file.conflicted
		)
	);
	const selectedFile = $derived(
		(status?.files ?? []).find((file) => file.path === selectedPath) ?? null
	);
	const rows = $derived.by(() => {
		const result: FileRow[] = [];
		for (const file of status?.files ?? []) {
			const group = groupFor(file);
			result.push({
				file,
				group,
				staged: file.index !== '.' && !file.untracked && !file.conflicted,
				partlyStaged:
					!file.untracked && !file.conflicted && file.index !== '.' && file.worktree !== '.'
			});
		}
		return result;
	});
	const groups = $derived.by(() => [
		{
			key: 'conflicted' as const,
			label: tg('git.group.conflicted'),
			files: rows.filter((row) => row.group === 'conflicted')
		},
		{
			key: 'staged' as const,
			label: tg('git.group.staged'),
			files: rows.filter((row) => row.group === 'staged')
		},
		{
			key: 'modified' as const,
			label: tg('git.group.modified'),
			files: rows.filter((row) => row.group === 'modified')
		},
		{
			key: 'untracked' as const,
			label: tg('git.group.untracked'),
			files: rows.filter((row) => row.group === 'untracked')
		},
		{
			key: 'deleted' as const,
			label: tg('git.group.deleted'),
			files: rows.filter((row) => row.group === 'deleted')
		}
	]);
	let groupLimit = $state(100);
	$effect(() => {
		void status;
		groupLimit = 100;
	});
	const diffLines = $derived.by(() => {
		const lines = diff.split('\n');
		// A unified diff ends with a newline. Do not count the empty tail as a line.
		if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
		return lines;
	});
	const diffPageCount = $derived(Math.max(1, Math.ceil(diffLines.length / DIFF_PAGE_SIZE)));
	const diffPageIndex = $derived(Math.min(diffPage, diffPageCount - 1));
	const diffStart = $derived(diffPageIndex * DIFF_PAGE_SIZE);
	const diffEnd = $derived(Math.min(diffStart + DIFF_PAGE_SIZE, diffLines.length));
	const diffTruncated = $derived(diffLines.length > DIFF_PAGE_SIZE);
	const diffOnLastPage = $derived(diffPageIndex === diffPageCount - 1);
	const diffRows = $derived(diffLines.slice(diffStart, diffEnd));
	const commitCount = $derived(stagedFiles.length);
	const commitDisabled = $derived(
		busy ||
			!mutable ||
			commitCount === 0 ||
			!status?.stagedTree ||
			commitMessage.trim().length === 0 ||
			(status?.conflicts.length ?? 0) > 0
	);

	function groupFor(file: GitFileStatus): GroupKey {
		if (file.conflicted) return 'conflicted';
		if (file.untracked) return 'untracked';
		if (file.index === 'D' || file.worktree === 'D') return 'deleted';
		if (file.index !== '.' && file.worktree === '.') return 'staged';
		return 'modified';
	}

	function pathsFor(file: GitFileStatus): string[] {
		return file.originalPath && file.originalPath !== file.path
			? [file.path, file.originalPath]
			: [file.path];
	}

	/** The native command rejects output above 1 MiB before Git returns a diff. */
	function isGitOutputTooLarge(error: unknown): boolean {
		return /exceeds the 1 MiB limit/i.test(String(error));
	}

	function goToDiffPage(page: number, align: 'start' | 'end' = 'start'): void {
		const next = Math.min(Math.max(page, 0), diffPageCount - 1);
		if (next !== diffPage) diffPage = next;
		void tick().then(() => {
			if (!diffList) return;
			// The list keeps its old scroll offset when only the rows change.
			// Reset the section start, or show the final hunk for Last.
			diffList.scrollTop = align === 'end' ? diffList.scrollHeight : 0;
		});
	}

	function formatDate(timestamp: number): string {
		if (!timestamp) return '';
		return new Date(timestamp * 1000).toLocaleString(i18n.locale === 'fr' ? 'fr-FR' : 'en-US', {
			dateStyle: 'medium',
			timeStyle: 'short'
		});
	}

	async function loadDiff(): Promise<void> {
		const path = selectedPath;
		const request = ++diffCounter;
		if (!path) {
			diff = '';
			diffPage = 0;
			diffTooLarge = false;
			diffLoading = false;
			return;
		}
		diffLoading = true;
		try {
			const value = await gitDiff(rootId, path, diffStaged);
			if (request === diffCounter) {
				diff = value;
				diffPage = 0;
				diffTooLarge = false;
			}
		} catch (error) {
			if (request === diffCounter) {
				diff = '';
				diffPage = 0;
				if (isGitOutputTooLarge(error)) {
					diffTooLarge = true;
					errorMessage = '';
				} else {
					diffTooLarge = false;
					errorMessage = tg('git.operationFailed', { message: String(error) });
				}
			}
		} finally {
			if (request === diffCounter) diffLoading = false;
		}
	}

	async function refresh(initial = false): Promise<void> {
		const request = ++refreshCounter;
		if (initial) loading = true;
		else refreshing = true;
		try {
			const [nextStatus, nextLog] = await Promise.all([gitStatus(rootId), gitLog(rootId, 20)]);
			if (request !== refreshCounter) return;
			status = nextStatus;
			log = nextLog;
			errorMessage = '';
			if (selectedPath && !nextStatus.files.some((file) => file.path === selectedPath)) {
				selectedPath = null;
				diff = '';
				diffPage = 0;
				diffTooLarge = false;
			}
			if (selectedPath) await loadDiff();
		} catch (error) {
			if (request === refreshCounter) {
				errorMessage = tg('git.operationFailed', { message: String(error) });
			}
		} finally {
			if (request === refreshCounter) {
				loading = false;
				refreshing = false;
			}
		}
	}

	async function selectFile(file: GitFileStatus): Promise<void> {
		selectedPath = file.path;
		diffStaged = file.index !== '.' && !file.untracked && !file.conflicted;
		diff = '';
		diffPage = 0;
		diffTooLarge = false;
		await loadDiff();
	}

	async function setDiffMode(staged: boolean): Promise<void> {
		if (diffStaged === staged) return;
		diffStaged = staged;
		diffPage = 0;
		diffTooLarge = false;
		await loadDiff();
	}

	async function toggleStage(file: GitFileStatus, checked: boolean): Promise<void> {
		if (!mutable || busy) return;
		busy = true;
		errorMessage = '';
		notice = '';
		try {
			if (checked) await gitStage(rootId, pathsFor(file));
			else await gitUnstage(rootId, pathsFor(file));
			await refresh();
		} catch (error) {
			errorMessage = tg('git.operationFailed', { message: String(error) });
		} finally {
			busy = false;
			await tick();
		}
	}

	async function createCommit(): Promise<void> {
		const message = commitMessage.trim();
		if (!message) {
			errorMessage = tg('git.commit.empty');
			return;
		}
		if ([...message].length > 2000) {
			errorMessage = tg('git.commit.tooLong');
			return;
		}
		if (!mutable || commitCount === 0 || (status?.conflicts.length ?? 0) > 0) {
			errorMessage = tg('git.commit.noStaged');
			return;
		}
		const tree = status?.stagedTree;
		if (!tree) {
			errorMessage = tg('git.commit.noStaged');
			return;
		}
		const review = { tree, head: status?.head ?? null, branch: status?.branch ?? null };
		busy = true;
		errorMessage = '';
		notice = '';
		try {
			const confirmed = await promptStore.confirm({
				title: tg('git.commit.confirmTitle'),
				message: tg('git.commit.confirmMessage', { n: commitCount, message }),
				confirmLabel: tg('git.commit.action'),
				cancelLabel: tg('git.commit.cancel')
			});
			if (!confirmed) return;
			const result = await gitCommit(rootId, message, review);
			commitMessage = '';
			notice = tg('git.commit.done', { hash: result.hash.slice(0, 8) });
			await refresh();
		} catch (error) {
			if (isGitReviewRequired(error)) {
				errorMessage = tg('git.commit.reviewRequired');
				await refresh();
			} else {
				errorMessage = tg('git.operationFailed', { message: String(error) });
			}
		} finally {
			busy = false;
			await tick();
			closeButton?.focus();
		}
	}

	function close(): void {
		if (!busy) onClose();
	}

	function onKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape' && !busy && !promptStore.open) {
			event.stopPropagation();
			onClose();
		}
	}

	onMount(() => {
		const onNativeSave = () => void refresh();
		window.addEventListener('mdsh:native-project-saved', onNativeSave);
		closeButton.focus();
		void refresh(true);
		return () => window.removeEventListener('mdsh:native-project-saved', onNativeSave);
	});
</script>

<div
	class="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-3"
	role="presentation"
>
	<div
		class="flex max-h-[92dvh] w-full max-w-6xl flex-col overflow-hidden rounded-lg border border-border bg-bg-1 text-fg shadow-xl"
		role="dialog"
		aria-modal="true"
		aria-labelledby="git-panel-title"
		tabindex="-1"
		use:focusTrap
		data-testid="git-panel"
		aria-busy={busy || loading}
		inert={promptStore.open}
		onkeydown={onKeydown}
	>
		<header class="flex items-center gap-3 border-b border-border p-4">
			<div class="min-w-0 flex-1">
				<h2 id="git-panel-title" class="truncate font-semibold">{tg('git.title')}</h2>
				<p class="truncate text-xs text-fg-muted">{projectName}</p>
			</div>
			{#if status}
				<span class="text-xs text-fg-muted">
					{#if status.detached}{tg('git.detached.short')}
					{:else if status.branch}{status.branch}
					{:else}{tg('git.branchUnknown')}{/if}
					{#if status.head}<span class="ml-2 font-mono">{status.head.slice(0, 8)}</span>{/if}
				</span>
			{/if}
			<button
				bind:this={closeButton}
				type="button"
				onclick={close}
				disabled={busy}
				class="rounded border border-border px-3 py-1"
				aria-label={tg('git.close')}>x</button
			>
		</header>
		<div class="flex flex-wrap items-center gap-2 border-b border-border p-3">
			<button
				type="button"
				onclick={() => void refresh()}
				disabled={busy || refreshing || loading}
				class="rounded border border-border px-3 py-1 text-sm">{tg('git.refresh')}</button
			>
			{#if refreshing}<span role="status" class="text-xs text-fg-muted">{tg('git.busy')}</span>{/if}
			{#if status}
				<span class="text-xs text-fg-muted">{tg('git.count', { n: status.files.length })}</span>
			{/if}
		</div>
		{#if errorMessage}
			<p
				role="alert"
				data-testid="git-operation-error"
				class="border-b border-border bg-bg-2 px-4 py-2 text-sm text-danger"
			>
				{errorMessage}
			</p>
		{/if}
		{#if notice}
			<p role="status" class="border-b border-border bg-bg-2 px-4 py-2 text-sm">
				{notice}
			</p>
		{/if}
		<div class="min-h-0 flex-1 overflow-auto">
			{#if loading}
				<p role="status" class="p-4 text-sm text-fg-muted">{tg('git.loading')}</p>
			{:else if status}
				<div class="grid gap-4 p-4 lg:grid-cols-[minmax(18rem,24rem)_minmax(0,1fr)]">
					<div class="min-w-0 space-y-3">
						{#if status.repository === 'parent'}
							<p role="status" class="rounded border border-border bg-bg-2 p-3 text-sm">
								{status.repositoryName
									? tg('git.parent.named', { name: status.repositoryName })
									: tg('git.parent.unnamed')}
							</p>
						{/if}
						{#if status.detached}
							<p role="status" class="rounded border border-border bg-bg-2 p-3 text-sm">
								{tg('git.detached')}
							</p>
						{/if}
						{#if status.initial}
							<p role="status" class="rounded border border-border bg-bg-2 p-3 text-sm">
								{tg('git.initial')}
							</p>
						{/if}
						{#if status.conflicts.length > 0}
							<p role="alert" class="rounded border border-danger p-3 text-sm text-danger">
								{tg('git.conflicts', { paths: status.conflicts.join(', ') })}
							</p>
						{/if}
						{#if status.nestedRepositories.length > 0}
							<p role="status" class="rounded border border-border bg-bg-2 p-3 text-sm">
								{tg('git.nested', { paths: status.nestedRepositories.join(', ') })}
							</p>
						{/if}
						{#if status.nestedScanTruncated}
							<p role="status" class="text-xs text-fg-muted">{tg('git.nestedTruncated')}</p>
						{/if}
						{#if status.outsideChanges > 0}
							<p role="status" class="rounded border border-border bg-bg-2 p-3 text-sm">
								{tg('git.outsideChanges', { n: status.outsideChanges })}
							</p>
						{/if}
						{#if status.clean}
							<p role="status" class="text-sm text-fg-muted">{tg('git.clean')}</p>
						{/if}
						{#each groups as group (group.key)}
							<section data-git-group={group.key}>
								<h3 class="flex items-center justify-between text-sm font-semibold">
									<span>{group.label}</span>
									<span class="text-xs font-normal text-fg-muted">{group.files.length}</span>
								</h3>
								{#if group.files.length === 0}
									<p class="text-xs text-fg-muted">{tg('git.group.empty')}</p>
								{:else}
									<ul class="mt-1 space-y-1">
										{#each group.files.slice(0, groupLimit) as row (row.file.path)}
											<li class="flex min-w-0 items-center gap-2">
												<input
													type="checkbox"
													checked={row.staged}
													disabled={!mutable || busy || row.file.conflicted}
													aria-label={row.staged
														? tg('git.unstage', { path: row.file.path })
														: tg('git.stage', { path: row.file.path })}
													onchange={(event) =>
														void toggleStage(
															row.file,
															(event.currentTarget as HTMLInputElement).checked
														)}
												/>
												<button
													type="button"
													class="min-w-0 flex-1 break-all text-left font-mono text-xs"
													class:text-accent={selectedPath === row.file.path}
													onclick={() => void selectFile(row.file)}
												>
													{row.file.path}
													{#if row.file.originalPath}
														<span class="text-fg-muted"> ({row.file.originalPath})</span>
													{/if}
												</button>
												{#if row.partlyStaged}
													<span class="text-xs text-fg-muted">{tg('git.file.partlyStaged')}</span>
												{/if}
											</li>
										{/each}
									</ul>
								{/if}
							</section>
						{/each}
					</div>
					<div class="min-w-0 space-y-4">
						<section aria-labelledby="git-diff-title">
							<div class="flex flex-wrap items-center gap-2">
								<h3 id="git-diff-title" class="flex-1 text-sm font-semibold">
									{selectedPath ? tg('git.diff', { path: selectedPath }) : tg('git.diff')}
								</h3>
								{#if selectedFile && !selectedFile.untracked}
									<button
										type="button"
										class="rounded border border-border px-2 py-0.5 text-xs"
										class:bg-bg-2={!diffStaged}
										onclick={() => void setDiffMode(false)}>{tg('git.diff.worktree')}</button
									>
									<button
										type="button"
										class="rounded border border-border px-2 py-0.5 text-xs"
										class:bg-bg-2={diffStaged}
										onclick={() => void setDiffMode(true)}>{tg('git.diff.staged')}</button
									>
								{/if}
							</div>
							{#if !selectedPath}
								<p class="mt-2 text-sm text-fg-muted">{tg('git.selectFile')}</p>
							{:else if diffLoading}
								<p role="status" class="mt-2 text-sm text-fg-muted">{tg('git.diff.loading')}</p>
							{:else if diffTooLarge}
								<p
									role="alert"
									data-testid="git-diff-too-large"
									class="mt-2 rounded border border-danger p-3 text-sm text-danger"
								>
									{tg('git.diff.review.tooLarge')}
								</p>
							{:else if !diff}
								<p class="mt-2 text-sm text-fg-muted">{tg('git.diff.empty')}</p>
							{:else}
								<!-- The focusable list lets keyboard users scroll long diffs. -->
								<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
								<ol
									bind:this={diffList}
									class="mt-2 max-h-[40dvh] overflow-auto rounded border border-border bg-bg p-0 font-mono text-xs leading-5"
									aria-label={tg('git.diff', { path: selectedPath })}
									tabindex="0"
								>
									{#each diffRows as line, index (index)}
										<li
											class="whitespace-pre-wrap break-words px-2"
											class:text-danger={line.startsWith('-') && !line.startsWith('---')}
											class:text-accent={line.startsWith('+') && !line.startsWith('+++')}
											class:text-fg-muted={line.startsWith('@@') ||
												line.startsWith('---') ||
												line.startsWith('+++')}
										>
											{line || ' '}
										</li>
									{/each}
								</ol>
								{#if diffTruncated}
									<div class="mt-2 flex flex-wrap items-center gap-2" data-testid="git-diff-review">
										<button
											type="button"
											class="rounded border border-border px-2 py-0.5 text-xs"
											data-testid="git-diff-first"
											aria-disabled={diffPageIndex === 0}
											onclick={() => goToDiffPage(0)}>{tg('git.diff.review.first')}</button
										>
										<button
											type="button"
											class="rounded border border-border px-2 py-0.5 text-xs"
											data-testid="git-diff-previous"
											aria-disabled={diffPageIndex === 0}
											onclick={() => goToDiffPage(diffPageIndex - 1)}
											>{tg('git.diff.review.previous')}</button
										>
										<button
											type="button"
											class="rounded border border-border px-2 py-0.5 text-xs"
											data-testid="git-diff-next"
											aria-disabled={diffOnLastPage}
											onclick={() => goToDiffPage(diffPageIndex + 1)}
											>{tg('git.diff.review.next')}</button
										>
										<button
											type="button"
											class="rounded border border-border px-2 py-0.5 text-xs"
											data-testid="git-diff-last"
											aria-disabled={diffOnLastPage}
											onclick={() => goToDiffPage(diffPageCount - 1, 'end')}
											>{tg('git.diff.review.last')}</button
										>
									</div>
									<p
										role="status"
										aria-live="polite"
										data-testid="git-diff-range"
										data-review-state={diffOnLastPage ? 'complete' : 'partial'}
										class="mt-1 text-xs text-fg-muted"
									>
										{diffOnLastPage
											? tg('git.diff.review.complete', {
													start: diffStart + 1,
													end: diffEnd,
													total: diffLines.length,
													pages: diffPageCount
												})
											: tg('git.diff.review.partial', {
													start: diffStart + 1,
													end: diffEnd,
													total: diffLines.length,
													page: diffPageIndex + 1,
													pages: diffPageCount
												})}
									</p>
								{/if}
							{/if}
						</section>
						<section aria-labelledby="git-commit-title">
							<h3 id="git-commit-title" class="text-sm font-semibold">
								{tg('git.commit.title')}
							</h3>
							<p class="text-xs text-fg-muted">{tg('git.commit.count', { n: commitCount })}</p>
							<textarea
								class="mt-2 w-full rounded border border-border bg-bg p-2 text-sm"
								rows="3"
								maxlength="2000"
								bind:value={commitMessage}
								placeholder={tg('git.commit.placeholder')}
								aria-label={tg('git.commit.message')}
								disabled={busy || !mutable}></textarea>
							<div class="mt-2 flex flex-wrap items-center gap-2">
								<button
									type="button"
									class="rounded border border-border px-3 py-1 text-sm"
									disabled={commitDisabled}
									onclick={() => void createCommit()}>{tg('git.commit.action')}</button
								>
								{#if !mutable}<span class="text-xs text-fg-muted">{tg('git.readOnly')}</span>{/if}
							</div>
						</section>
						<section aria-labelledby="git-log-title">
							<h3 id="git-log-title" class="text-sm font-semibold">{tg('git.log')}</h3>
							{#if log.length === 0}
								<p class="text-sm text-fg-muted">{tg('git.log.empty')}</p>
							{:else}
								<ol class="mt-1 space-y-1">
									{#each log as commit (commit.hash)}
										<li class="rounded border border-border bg-bg p-2 text-xs">
											<div class="flex flex-wrap items-baseline gap-2">
												<span class="font-mono text-fg-muted">{commit.shortHash}</span>
												<span class="min-w-0 flex-1 break-words">{commit.subject}</span>
											</div>
											<div class="mt-0.5 text-fg-muted">
												{commit.author}
												{#if commit.timestamp}<span> {formatDate(commit.timestamp)}</span>{/if}
											</div>
										</li>
									{/each}
								</ol>
							{/if}
						</section>
					</div>
				</div>
			{/if}
		</div>
	</div>
</div>

<style>
	button {
		border-radius: 4px;
	}
	button:hover:enabled {
		background: var(--color-bg-2);
	}
	button:disabled {
		opacity: 0.5;
	}
	button:focus-visible,
	input:focus-visible,
	textarea:focus-visible,
	ol:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}
</style>

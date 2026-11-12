<script lang="ts">
	import { onMount } from 'svelte';
	import { X } from '@lucide/svelte';
	import { focusTrap } from '#lib/a11y/focusTrap.js';
	import { filesStore } from '#lib/files.svelte.js';
	import { db, newId, type CommentRow } from '#lib/db.js';
	import {
		commentAuthor,
		commentReport,
		createAnchor,
		resolveCommentAnchor,
		resolveCommentAnchors,
		shiftCommentAnchors,
		setCommentAuthor,
		type CommentAnchor
	} from '#lib/comments.js';
	import { t } from '#lib/i18n/index.js';
	import { triggerDownload } from '#lib/services/export.js';

	let { open, onClose }: { open: boolean; onClose: () => void } = $props();

	let comments = $state<CommentRow[]>([]);
	const COMMENT_PAGE = 100;
	let visibleComments = $state(COMMENT_PAGE);
	const shownComments = $derived(comments.slice(0, visibleComments));
	let quote = $state('');
	let body = $state('');
	let author = $state('');
	let error = $state('');
	let adding = $state(false);
	let selected = $state<string | null>(null);
	let boundId = $state<string | null>(null);
	const boundFile = $derived(
		boundId ? filesStore.library.find((entry) => entry.id === boundId) : undefined
	);
	let anchors = $state<Record<string, CommentAnchor>>({});
	let anchorJob = 0;

	$effect(() => {
		if (!open) return;
		void boundId;
		visibleComments = COMMENT_PAGE;
	});

	let lastAnchorFile: string | null = null;
	let lastAnchorContent = '';
	let lastAnchors: Record<string, CommentAnchor> = {};
	// A metadata-only status or author change keeps the same quote and offsets.
	// Reuse the prior resolution instead of checking every comment again.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- transient cache, never rendered
	const resolvedAnchors = new Map<
		string,
		{ content: string; quote: string; from: number; to: number; anchor: CommentAnchor }
	>();
	$effect(() => {
		const content = boundFile?.content ?? '';
		const fileId = boundFile?.id ?? null;
		const list = comments;
		const job = ++anchorJob;
		const timer = setTimeout(() => {
			if (job !== anchorJob) return;
			const cachedFor = (comment: CommentRow) => {
				const cached = resolvedAnchors.get(comment.id);
				return cached &&
					cached.content === content &&
					cached.quote === comment.quote &&
					cached.from === comment.from &&
					cached.to === comment.to
					? cached.anchor
					: undefined;
			};
			if (fileId === lastAnchorFile && lastAnchorContent !== content) {
				anchors = shiftCommentAnchors(lastAnchorContent, content, list, lastAnchors);
			} else {
				// Resolve every uncached comment in one shared pass. A file switch or a
				// full external replace must not run one whole-note search per comment.
				const pending = list.filter((comment) => cachedFor(comment) === undefined);
				const resolved = resolveCommentAnchors(content, pending);
				anchors = Object.fromEntries(
					list.map((comment) => [
						comment.id,
						cachedFor(comment) ?? resolved[comment.id] ?? resolveCommentAnchor(content, comment)
					])
				) as Record<string, CommentAnchor>;
			}
			const live = new Set(list.map((comment) => comment.id));
			for (const id of resolvedAnchors.keys()) if (!live.has(id)) resolvedAnchors.delete(id);
			for (const comment of list) {
				const anchor = anchors[comment.id];
				if (anchor)
					resolvedAnchors.set(comment.id, {
						content,
						quote: comment.quote,
						from: comment.from,
						to: comment.to,
						anchor
					});
			}
			lastAnchorFile = fileId;
			lastAnchorContent = content;
			lastAnchors = anchors;
		}, 150);
		return () => clearTimeout(timer);
	});

	onMount(() => {
		author = commentAuthor();
		selected = window.getSelection()?.toString() ?? '';
		quote = selected;
	});

	$effect(() => {
		if (!open) {
			boundId = null;
			return;
		}
		const id = filesStore.activeId;
		if (id === boundId) return;
		boundId = id;
		quote = '';
		body = '';
		error = '';
		comments = [];
		void load();
	});

	async function load() {
		const id = boundId;
		if (!id) return;
		const rows = await db.comments.where('draftId').equals(id).sortBy('createdAt');
		if (boundId === id) comments = rows;
	}

	function useSelection() {
		quote = window.getSelection()?.toString() ?? '';
	}

	async function addComment() {
		if (adding) return;
		const activeId = boundId;
		const file = boundFile;
		if (!activeId || !file) {
			error = t('comments.staleDocument');
			return;
		}
		const content = file.content;
		const anchor = createAnchor(content, quote);
		if (!anchor) {
			error = t('comments.anchorFailed');
			return;
		}
		if (!body.trim()) {
			error = t('comments.bodyRequired');
			return;
		}
		const now = Date.now();
		const row: CommentRow = {
			id: newId(),
			draftId: activeId,
			quote: anchor.quote,
			from: anchor.from,
			to: anchor.to,
			body: body.trim(),
			author: author.trim() || t('comments.localReviewer'),
			status: 'open',
			createdAt: now,
			updatedAt: now
		};
		adding = true;
		try {
			await db.comments.put($state.snapshot(row));
		} catch {
			// Keep the unsaved text so the user can retry the durable write.
			error = t('comments.saveFailed');
			adding = false;
			return;
		}
		// The optional author preference cannot reject a saved comment.
		setCommentAuthor(author);
		body = '';
		error = '';
		try {
			await load();
		} catch {
			error = t('comments.refreshFailed');
		}
		adding = false;
	}

	async function setStatus(comment: CommentRow, status: CommentRow['status']) {
		await db.comments.put({ ...comment, status, updatedAt: Date.now() });
		await load();
	}

	async function remove(comment: CommentRow) {
		await db.comments.delete(comment.id);
		await load();
	}

	async function exportReport() {
		const content = boundFile?.content ?? '';
		const blob = new Blob([commentReport(comments, content)], { type: 'application/json' });
		await triggerDownload(blob, 'comments-report.json');
	}

	function anchorKey(comment: CommentRow): string {
		return anchors[comment.id]?.state ?? 'detached';
	}
</script>

<svelte:window
	onkeydown={(event) => {
		if (open && event.key === 'Escape') onClose();
	}}
/>

{#if open}
	<div class="comments-backdrop">
		<div
			class="comments-panel"
			role="dialog"
			aria-modal="true"
			aria-labelledby="comments-title"
			tabindex="-1"
			use:focusTrap
			onkeydown={(event) => {
				if (event.key === 'Escape') onClose();
			}}
			data-testid="comments-panel"
		>
			<header>
				<h2 id="comments-title">{t('comments.title')}</h2>
				<button type="button" onclick={onClose} aria-label={t('settings.close')}
					><X size={16} /></button
				>
			</header>
			<div class="comments-body">
				<section class="comment-form">
					<label>
						<span>{t('comments.quote')}</span>
						<textarea bind:value={quote} rows="2" data-testid="comment-quote"></textarea>
					</label>
					<button type="button" onclick={useSelection} data-testid="comment-use-selection">
						{t('comments.useSelection')}
					</button>
					<label>
						<span>{t('comments.body')}</span>
						<textarea bind:value={body} rows="3" data-testid="comment-body"></textarea>
					</label>
					<label>
						<span>{t('comments.author')}</span>
						<input type="text" bind:value={author} data-testid="comment-author" />
					</label>
					{#if error}<p class="error" role="alert" data-testid="comment-error">{error}</p>{/if}
					<button
						type="button"
						class="primary"
						disabled={adding}
						onclick={() => void addComment()}
						data-testid="comment-add"
					>
						{t('comments.add')}
					</button>
				</section>
				<section class="comment-list" aria-label={t('comments.list')}>
					{#each shownComments as comment (comment.id)}
						<article
							class="comment"
							data-anchor={anchorKey(comment)}
							data-testid={`comment-${comment.id}`}
						>
							<header class="comment-head">
								<strong>{comment.author}</strong>
								<span class="state"
									>{t(`comments.anchor_${anchorKey(comment)}` as 'comments.anchor_attached')}</span
								>
								<span class="status"
									>{t(`comments.status_${comment.status}` as 'comments.status_open')}</span
								>
							</header>
							<blockquote>{comment.quote}</blockquote>
							<p>{comment.body}</p>
							<footer>
								<button
									type="button"
									onclick={() =>
										void setStatus(comment, comment.status === 'open' ? 'resolved' : 'open')}
								>
									{t(comment.status === 'open' ? 'comments.resolve' : 'comments.reopen')}
								</button>
								<button type="button" onclick={() => void remove(comment)}
									>{t('comments.delete')}</button
								>
							</footer>
						</article>
					{:else}
						<p class="empty">{t('comments.empty')}</p>
					{/each}
					{#if visibleComments < comments.length}
						<button
							type="button"
							class="show-more"
							data-testid="comments-show-more"
							onclick={() => (visibleComments += COMMENT_PAGE)}
						>
							{t('comments.showMore', {
								n: Math.min(COMMENT_PAGE, comments.length - visibleComments)
							})}
						</button>
					{/if}
				</section>
				<div class="comments-actions">
					<p>{t('comments.note')}</p>
					<button type="button" onclick={() => void exportReport()} data-testid="comments-export">
						{t('comments.export')}
					</button>
				</div>
			</div>
		</div>
	</div>
{/if}

<style>
	.comments-backdrop {
		position: fixed;
		inset: 0;
		z-index: 70;
		display: grid;
		place-items: center;
		padding: 16px;
		background: rgb(0 0 0 / 0.55);
	}
	.comments-panel {
		display: flex;
		max-height: calc(100dvh - 32px);
		width: min(100%, 620px);
		flex-direction: column;
		overflow: hidden;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		background: var(--color-bg-1);
		color: var(--color-fg);
		box-shadow: var(--shadow-lg);
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 12px 16px;
		border-bottom: 1px solid var(--color-border);
	}
	h2 {
		margin: 0;
		font-size: 15px;
	}
	header button {
		min-width: 36px;
		min-height: 36px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-xs);
		background: transparent;
		color: var(--color-fg);
	}
	.comments-body {
		min-height: 0;
		flex: 1;
		overflow-y: auto;
		padding: 12px 16px;
	}
	.comment-form {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding-bottom: 12px;
		border-bottom: 1px solid var(--color-border);
	}
	.comment-form label {
		display: flex;
		flex-direction: column;
		gap: 2px;
		font-size: 11px;
		color: var(--color-fg-muted);
	}
	.comment-form textarea,
	.comment-form input {
		width: 100%;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-xs);
		background: var(--color-bg-2);
		color: var(--color-fg);
		padding: 4px 6px;
		font: inherit;
	}
	/* Safari zooms a focused field below 16 px. The compact label keeps its
	   density and the field restores the touch field size. */
	:global(:root[data-touch-capable='true']) .comment-form textarea,
	:global(:root[data-touch-capable='true']) .comment-form input {
		font-size: max(1rem, 16px);
	}
	.comment-form button,
	.comment footer button,
	.comments-actions button {
		min-height: 32px;
		padding: 4px 9px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-xs);
		background: var(--color-bg-2);
		color: var(--color-fg);
		font-size: 11px;
	}
	.comment-form .primary {
		border-color: var(--color-accent);
		color: var(--color-accent);
	}
	.comment-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding-top: 12px;
	}
	.comment {
		padding: 8px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-xs);
		background: var(--color-bg-2);
	}
	.comment[data-anchor='detached'],
	.comment[data-anchor='ambiguous'] {
		border-color: var(--color-warning, #d19a66);
	}
	.comment-head {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		font-size: 11px;
	}
	.comment-head .state,
	.comment-head .status {
		color: var(--color-fg-muted);
	}
	.comment blockquote {
		margin: 6px 0;
		padding-left: 8px;
		border-left: 2px solid var(--color-border-strong);
		font-size: 12px;
		color: var(--color-fg-muted);
	}
	.comment p {
		margin: 6px 0;
		font-size: 13px;
	}
	.comment footer {
		display: flex;
		gap: 6px;
	}
	.comments-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding-top: 12px;
		font-size: 11px;
		color: var(--color-fg-muted);
	}
	.error {
		color: var(--color-danger);
		font-size: 12px;
	}
	.empty {
		color: var(--color-fg-muted);
		font-size: 12px;
	}
</style>

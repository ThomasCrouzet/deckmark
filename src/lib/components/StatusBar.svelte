<script lang="ts">
	import { filesStore } from '#lib/files.svelte.js';
	import type { DocStats, SelectionStats } from '#lib/stats-count.js';
	import type { StatsRuntime } from '#lib/stats-runtime.js';
	import { reportError } from '#lib/report.js';
	import { t } from '#lib/i18n/index.js';
	import { onMount } from 'svelte';
	import {
		formatSaveAge,
		reportPersistenceError,
		getStorageHealth,
		recordBackupReminderShown
	} from '#lib/storage.js';
	import type { DocumentKind } from '#lib/document-kind.js';
	let { kind = 'note', onOpenSettings }: { kind?: DocumentKind; onOpenSettings?: () => void } =
		$props();
	let backupDue = $state(false);
	function dismissReminder() {
		recordBackupReminderShown();
		backupDue = false;
	}
	async function retrySave() {
		try {
			await filesStore.flushPendingAwait();
		} catch (error) {
			reportPersistenceError(error, 'save');
		}
	}

	let now = $state(Date.now());
	// Plain text of a nonempty selection inside the active editor or reader.
	// The selection never leaves this component.
	let selectedText = $state('');
	let selectedFileId = $state<string | null>(null);

	$effect(() => {
		const id = filesStore.activeId;
		if (id !== selectedFileId) {
			selectedFileId = id;
			selectedText = '';
		}
	});

	onMount(() => {
		void getStorageHealth().then((health) => (backupDue = health.backupReminderDue));
		const id = setInterval(() => (now = Date.now()), 10_000);
		// Edit, Source and Read use different DOM roots. One listener covers
		// them and rejects selections that start in application chrome.
		const rootOf = (node: Node | null): Element | null => {
			const element =
				node?.nodeType === Node.ELEMENT_NODE ? (node as Element) : node?.parentElement;
			return element?.closest('.ProseMirror, .cm-content, .mdsh-preview') ?? null;
		};
		const onSelectionChange = () => {
			const selection = document.getSelection();
			if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
				selectedText = '';
				return;
			}
			const start = rootOf(selection.anchorNode);
			const end = rootOf(selection.focusNode);
			selectedText = start && start === end ? selection.toString() : '';
		};
		document.addEventListener('selectionchange', onSelectionChange);
		return () => {
			clearInterval(id);
			document.removeEventListener('selectionchange', onSelectionChange);
		};
	});

	// The empty shell needs save status, not the counter and Worker runtime.
	const emptyStats: DocStats = { chars: 0, words: 0, lines: 0, readMinutes: 0 };
	let stats = $state<DocStats | null>(emptyStats);
	let selectionStats = $state<SelectionStats | null>(null);
	let loadFailed = $state(false);
	let runtime: StatsRuntime | null = null;
	let runtimeLoad: Promise<StatsRuntime | null> | null = null;
	let requestedId: string | null = null;
	let disposed = false;

	function getRuntime(): Promise<StatsRuntime | null> {
		return (runtimeLoad ??= import('#lib/stats-runtime.js')
			.then((module) => {
				if (disposed) return null;
				runtime = module.createStatsRuntime((id, content, value) => {
					if (disposed || filesStore.activeId !== id || filesStore.active?.content !== content)
						return;
					stats = value;
				});
				// One pending load reads current state, not one retained text closure per edit.
				const active = filesStore.active;
				if (kind === 'note' && active) runtime.setDocument(active.id, active.content);
				if (kind === 'note' && selectedText)
					void runtime.selection(selectedText).then((value) => {
						if (!disposed) selectionStats = value;
					});
				else selectionStats = null;
				return runtime;
			})
			.catch((error) => {
				if (!disposed) {
					loadFailed = true;
					reportError('statistics module', error, { notifyUser: t('panels.loadFailed') });
				}
				return null;
			}));
	}

	$effect(() => {
		const active = filesStore.active;
		const id = active?.id ?? null;
		const content = kind === 'note' ? (active?.content ?? '') : '';
		if (!id || kind !== 'note') {
			runtime?.setDocument(null, '');
			requestedId = null;
			stats = emptyStats;
			return;
		}
		if (id !== requestedId || !runtime) stats = content.length === 0 ? emptyStats : null;
		requestedId = id;
		if (runtime) runtime.setDocument(id, content);
		else void getRuntime();
	});

	let selectionJob = 0;
	$effect(() => {
		const text = selectedText;
		const job = ++selectionJob;
		if (!text || kind !== 'note') {
			selectionStats = null;
			return;
		}
		// Selection counting is O(selection length). Run it after the input event
		// and cancel an older selection walk as soon as the selection changes.
		const run = () => {
			if (job !== selectionJob || disposed) return;
			if (runtime)
				void runtime.selection(text).then((value) => {
					if (job === selectionJob && !disposed) selectionStats = value;
				});
			else void getRuntime();
		};
		const handle =
			typeof requestIdleCallback === 'function'
				? requestIdleCallback(run, { timeout: 200 })
				: setTimeout(run, 0);
		return () => {
			selectionJob += 1;
			if (typeof cancelIdleCallback === 'function' && typeof handle === 'number')
				cancelIdleCallback(handle);
			else clearTimeout(handle as ReturnType<typeof setTimeout>);
		};
	});

	onMount(() => () => {
		disposed = true;
		runtime?.dispose();
		runtime = null;
	});
	let saveLabel = $derived.by(() => {
		if (!filesStore.active) return '';
		// Restored drafts are durable before this session records a save time.
		return filesStore.lastSavedAt === 0
			? t('stats.saved')
			: formatSaveAge(filesStore.lastSavedAt, now);
	});
</script>

{#if filesStore.active || filesStore.saveErrorIds.length > 0}
	<footer
		id="app-statusbar"
		class="flex min-h-6 flex-shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border
		       bg-bg px-3 font-mono text-[11px] text-fg-muted"
	>
		{#if kind === 'note'}<div class="flex items-center gap-3" data-testid="document-stats">
				{#if selectionStats}
					<span class="text-accent" data-testid="selection-stats">{t('statusBar.selection')}</span>
					<span>{t('statusBar.words', { n: selectionStats.words })}</span>
					<span class="text-fg-dim/60">·</span>
					<span>{t('statusBar.chars', { n: selectionStats.chars })}</span>
					<span class="hidden sm:inline text-fg-dim/60">·</span>
					<span class="hidden sm:inline">{t('statusBar.lines', { n: selectionStats.lines })}</span>
				{:else if stats}
					<span>{t('statusBar.words', { n: stats.words })}</span>
					<span class="text-fg-dim/60">·</span>
					<span>{t('statusBar.chars', { n: stats.chars })}</span>
					<span class="hidden sm:inline text-fg-dim/60">·</span>
					<span class="hidden sm:inline">{t('statusBar.lines', { n: stats.lines })}</span>
					<span class="hidden md:inline text-fg-dim/60">·</span>
					<span class="hidden md:inline"
						>{t('statusBar.readMinutes', { n: stats.readMinutes })}</span
					>
				{:else}
					<span aria-busy={!loadFailed} data-testid={loadFailed ? 'stats-load-error' : undefined}>
						{t(loadFailed ? 'panels.loadFailed' : 'diskLinks.loading')}
					</span>
				{/if}
			</div>{/if}
		<!-- §B3.2 - Ephemeral "saving" state during the debounce + IDB write.
		     Without this, the "saved Xs ago" label only moves every 10 s
		     (setInterval), with no feedback that typing has been saved. -->
		<div class="flex flex-wrap items-center gap-2">
			{#if backupDue && onOpenSettings && filesStore.library.some((file) => file.contentDeferred || file.content.trim())}
				<button
					class="text-accent underline"
					onclick={() => {
						backupDue = false;
						onOpenSettings?.();
					}}>{t('statusBar.backupDue')}</button
				>
				<button
					class="px-1 text-fg-muted"
					onclick={dismissReminder}
					aria-label={t('statusBar.dismissReminder')}>×</button
				>
			{/if}
			{#if filesStore.active?.linkedToDisk}<span
					class="hidden lg:inline text-fg-muted"
					title={t('statusBar.diskManual')}>{t('statusBar.diskManual')}</span
				>{/if}
			{#if filesStore.saveErrorIds.length > 0}
				<span role="status" class="text-danger">{t('statusBar.saveFailed')}</span>
				<button class="ml-2 underline text-danger" onclick={() => void retrySave()}
					>{t('statusBar.retrySave')}</button
				>
			{:else if filesStore.hasPendingSave}
				<span class="text-accent" aria-live="off">{t('statusBar.saving')}</span>
			{:else}
				<span>{t('statusBar.local', { state: saveLabel })}</span>
			{/if}
		</div>
	</footer>
{/if}

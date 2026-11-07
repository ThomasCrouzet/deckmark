<script lang="ts">
	import { filesStore } from '#lib/files.svelte.js';
	import {
		computeSelectionStats,
		computeStats,
		createStatsCache,
		formatSaveAge,
		type DocStats
	} from '#lib/stats.js';
	import { t } from '#lib/i18n/index.js';
	import { onMount } from 'svelte';
	import {
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

	// Keep the last complete count during edits. A switch publishes immediately.
	// Cache exact strings, not editor-local counters or future store revisions.
	const cached = createStatsCache();
	let stats = $state<DocStats>(computeStats(''));
	let statsActiveId: string | null = null;
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	let workerTimer: ReturnType<typeof setTimeout> | null = null;
	let worker: Worker | null = null;
	let workerBusy = false;
	let workerUnavailable = false;
	let sequence = 0;

	function cancelPending() {
		sequence += 1;
		if (debounceTimer) clearTimeout(debounceTimer);
		if (workerTimer) clearTimeout(workerTimer);
		debounceTimer = null;
		workerTimer = null;
		if (workerBusy) {
			worker?.terminate();
			worker = null;
			workerBusy = false;
		}
	}

	function publish(id: string | null, content: string, value: DocStats) {
		cached.set(id, content, value);
		stats = value;
	}

	function measure(id: string, content: string, token: number) {
		const current = () =>
			token === sequence && filesStore.activeId === id && filesStore.active?.content === content;
		if (!current()) return;
		if (content.length < 256 * 1024 || workerUnavailable || typeof Worker === 'undefined') {
			publish(id, content, computeStats(content));
			return;
		}
		const fallback = () => {
			if (!current()) return;
			worker?.terminate();
			worker = null;
			workerBusy = false;
			workerUnavailable = true;
			if (workerTimer) clearTimeout(workerTimer);
			workerTimer = null;
			if (current()) publish(id, content, computeStats(content));
		};
		try {
			worker ??= new Worker(new URL('../workers/stats.worker.ts', import.meta.url), {
				type: 'module'
			});
			workerBusy = true;
			worker.onmessage = (event: MessageEvent<{ token: number; stats: DocStats }>) => {
				if (!current() || event.data.token !== token) return;
				if (workerTimer) clearTimeout(workerTimer);
				workerTimer = null;
				workerBusy = false;
				worker!.onmessage = null;
				worker!.onerror = null;
				worker!.onmessageerror = null;
				publish(id, content, event.data.stats);
			};
			worker.onerror = fallback;
			worker.onmessageerror = fallback;
			workerTimer = setTimeout(fallback, 5000);
			worker.postMessage({ token, text: content });
		} catch {
			fallback();
		}
	}

	$effect(() => {
		const active = filesStore.active;
		const id = active?.id ?? null;
		const content = kind === 'note' ? (active?.content ?? '') : '';
		cancelPending();
		const switched = id !== statsActiveId;
		statsActiveId = id;
		const hit = cached.get(id, content);
		if (hit) {
			stats = hit;
			return;
		}
		if (switched || !id) {
			publish(id, content, computeStats(content));
			return;
		}
		const token = sequence;
		debounceTimer = setTimeout(() => {
			debounceTimer = null;
			measure(id, content, token);
		}, 200);
		return cancelPending;
	});

	onMount(() => () => {
		cancelPending();
		worker?.terminate();
		worker = null;
		cached.clear();
	});

	let selectionStats = $derived(
		selectedText.length > 0 ? computeSelectionStats(selectedText) : null
	);
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
				{:else}
					<span>{t('statusBar.words', { n: stats.words })}</span>
					<span class="text-fg-dim/60">·</span>
					<span>{t('statusBar.chars', { n: stats.chars })}</span>
					<span class="hidden sm:inline text-fg-dim/60">·</span>
					<span class="hidden sm:inline">{t('statusBar.lines', { n: stats.lines })}</span>
					<span class="hidden md:inline text-fg-dim/60">·</span>
					<span class="hidden md:inline"
						>{t('statusBar.readMinutes', { n: stats.readMinutes })}</span
					>
				{/if}
			</div>{/if}
		<!-- §B3.2 - Ephemeral "saving" state during the debounce + IDB write.
		     Without this, the "saved Xs ago" label only moves every 10 s
		     (setInterval), with no feedback that typing has been saved. -->
		<div class="flex flex-wrap items-center gap-2">
			{#if backupDue && onOpenSettings && filesStore.library.some((file) => file.content.trim())}
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

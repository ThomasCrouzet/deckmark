<script lang="ts">
	import { filesStore } from '#lib/files.svelte.js';
	import { computeStats, formatSaveAge } from '#lib/stats.js';
	import { t } from '#lib/i18n/index.js';
	import { onMount } from 'svelte';
	import {
		reportPersistenceError,
		getStorageHealth,
		recordBackupReminderShown
	} from '#lib/storage.js';
	let { onOpenSettings }: { onOpenSettings?: () => void } = $props();
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

	onMount(() => {
		void getStorageHealth().then((health) => (backupDue = health.backupReminderDue));
		const id = setInterval(() => (now = Date.now()), 10_000);
		return () => clearInterval(id);
	});

	// §A2.4 - `computeStats` runs 6 regexes over the full doc; called on every
	// keystroke it is measurable beyond 50 KB. We debounce the content snapshot
	// to 200 ms - the status-bar does not need to react to each individual
	// keystroke, otherwise the counter flickers visibly.
	//
	// A tab switch (change of the active file's identity) writes
	// immediately to avoid a "0 words" flash for 200 ms; only successive
	// keystrokes on the same file are coalesced.
	let debouncedContent = $state('');
	let debouncedActiveId = $state<string | null>(null);
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	$effect(() => {
		const active = filesStore.active;
		const id = active?.id ?? null;
		const c = active?.content ?? '';
		if (id !== debouncedActiveId) {
			// File switch or opening: immediate flush of the snapshot.
			if (debounceTimer) {
				clearTimeout(debounceTimer);
				debounceTimer = null;
			}
			debouncedActiveId = id;
			debouncedContent = c;
			return;
		}
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			debouncedContent = c;
			debounceTimer = null;
		}, 200);
		return () => {
			if (debounceTimer) {
				clearTimeout(debounceTimer);
				debounceTimer = null;
			}
		};
	});

	let stats = $derived(computeStats(debouncedContent));
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
		<div class="flex items-center gap-3">
			<span>{t('statusBar.words', { n: stats.words })}</span>
			<span class="text-fg-dim/60">·</span>
			<span>{t('statusBar.chars', { n: stats.chars })}</span>
			<span class="hidden sm:inline text-fg-dim/60">·</span>
			<span class="hidden sm:inline">{t('statusBar.lines', { n: stats.lines })}</span>
			<span class="hidden md:inline text-fg-dim/60">·</span>
			<span class="hidden md:inline">{t('statusBar.readMinutes', { n: stats.readMinutes })}</span>
		</div>
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

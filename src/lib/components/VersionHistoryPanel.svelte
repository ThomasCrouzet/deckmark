<script lang="ts">
	// §2.4 - Version history panel for the active file.
	//
	// Lists the timestamped snapshots (db.versions), shows a preview of a selected
	// version's content with a bounded line diff, and allows a safe restore.
	// All local (Dexie), no network.

	import { tick } from 'svelte';
	import { browser } from '$app/env';
	import { t } from '#lib/i18n/index.js';
	import { focusTrap } from '#lib/a11y/focusTrap.js';
	import { filesStore } from '#lib/files.svelte.js';
	import { promptStore } from '#lib/prompt.svelte.js';
	import { notify } from '#lib/notify.svelte.js';
	import { reportError } from '#lib/report.js';
	import { reportPersistenceError } from '#lib/storage.js';
	import { listVersions } from '#lib/version-history.js';
	import { formatSaveAge } from '#lib/stats.js';
	import type { VersionRow } from '#lib/db.js';
	import { History, X, RotateCcw } from '@lucide/svelte';
	import DiffView from './DiffView.svelte';

	interface Props {
		open: boolean;
		onClose: () => void;
	}

	let { open, onClose }: Props = $props();

	let versions = $state<VersionRow[]>([]);
	let loading = $state(true);
	let selectedId = $state<string | null>(null);
	let closeButton: HTMLButtonElement | null = $state(null);

	const selected = $derived(versions.find((v) => v.id === selectedId) ?? null);
	const currentContent = $derived(filesStore.active?.content ?? '');

	$effect(() => {
		if (!open || !browser) return;
		let cancelled = false;
		loading = true;
		const id = filesStore.active?.id;
		if (!id) {
			versions = [];
			loading = false;
			return;
		}
		void listVersions(id)
			.then((rows) => {
				if (cancelled) return;
				versions = rows;
				selectedId = rows[0]?.id ?? null;
				loading = false;
				tick().then(() => {
					if (!cancelled) closeButton?.focus();
				});
			})
			.catch((err) => {
				if (cancelled) return;
				// Without this .catch, an IDB failure left the "Loading..." spinner
				// frozen indefinitely. We exit the loading state and notify.
				versions = [];
				loading = false;
				reportError('load version history', err, {
					notifyUser: t('versionHistory.loadError')
				});
				tick().then(() => {
					if (!cancelled) closeButton?.focus();
				});
			});
		return () => {
			cancelled = true;
		};
	});

	async function handleRestore(): Promise<void> {
		const v = selected;
		const active = filesStore.active;
		if (!v || !active) return;
		const ok = await promptStore.confirm({
			title: t('versionHistory.restoreConfirmTitle'),
			message: t('versionHistory.restoreConfirmMessage'),
			confirmLabel: t('versionHistory.restore')
		});
		if (!ok) return;
		try {
			const restored = await filesStore.restoreVersion(active.id, v.content);
			if (!restored) return;
			notify.success(t('versionHistory.restored'));
			onClose();
		} catch (error) {
			reportPersistenceError(error, 'save');
		}
	}
</script>

{#if open}
	<div
		class="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pb-4 backdrop-blur-sm
		       pt-[max(env(safe-area-inset-top),8vh)]"
		style:padding-left="max(env(safe-area-inset-left), 1rem)"
		style:padding-right="max(env(safe-area-inset-right), 1rem)"
		onclick={(e) => {
			if (e.target === e.currentTarget) onClose();
		}}
		onkeydown={(e) => {
			if (e.key === 'Escape') onClose();
		}}
		inert={promptStore.open}
		aria-hidden={promptStore.open ? 'true' : undefined}
		role="dialog"
		aria-modal="true"
		aria-labelledby="history-title"
		tabindex="-1"
		use:focusTrap
	>
		<div
			class="mdsh-dialog-panel flex h-[80vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-border
			       bg-bg-1 shadow-2xl animate-fade-in"
		>
			<header class="flex items-center gap-2 border-b border-border px-4 py-2.5">
				<History size={16} class="text-fg-dim" aria-hidden="true" />
				<h2 id="history-title" class="flex-1 text-sm font-medium text-fg">
					{t('versionHistory.title')}
					{#if filesStore.active}<span class="text-fg-dim">- {filesStore.active.name}</span>{/if}
				</h2>
				<button
					bind:this={closeButton}
					class="rounded p-1 text-fg-dim transition hover:bg-bg-2 hover:text-fg"
					onclick={onClose}
					aria-label={t('versionHistory.close')}
				>
					<X size={14} />
				</button>
			</header>

			{#if !filesStore.active}
				<p class="px-4 py-8 text-center text-sm text-fg-dim">{t('versionHistory.noFileOpen')}</p>
			{:else if loading}
				<p class="px-4 py-8 text-center text-sm text-fg-dim">{t('versionHistory.loading')}</p>
			{:else if versions.length === 0}
				<p class="px-4 py-8 text-center text-sm text-fg-dim">
					{t('versionHistory.empty')}
				</p>
			{:else}
				<div class="flex min-h-0 flex-1 flex-col sm:flex-row">
					<!-- Version list -->
					<ul
						class="max-h-32 w-full sm:max-h-none sm:w-56 shrink-0 overflow-y-auto border-b sm:border-r border-border py-1"
						aria-label={t('versionHistory.availableVersions')}
					>
						{#each versions as v, i (v.id)}
							<li>
								<button
									class="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-sm transition"
									class:bg-bg-2={v.id === selectedId}
									class:text-fg={v.id === selectedId}
									class:text-fg-muted={v.id !== selectedId}
									onclick={() => (selectedId = v.id)}
									aria-current={v.id === selectedId}
								>
									<span>{formatSaveAge(v.createdAt)}</span>
									<span class="text-[10px] text-fg-dim">
										{i === 0
											? t('versionHistory.mostRecent')
											: t('versionHistory.versionLabel', { n: versions.length - i })}
									</span>
								</button>
							</li>
						{/each}
					</ul>

					<!-- Preview of the selected version -->
					<div class="flex min-h-0 min-w-0 flex-1 flex-col">
						{#if selected}
							<div class="min-h-0 flex-1 overflow-auto p-3">
								<DiffView
									before={currentContent}
									after={selected.content}
									ariaLabel={`${t('versionHistory.preview')} ${t('versionHistory.vsCurrent')}`}
									maxHeight="55vh"
								/>
							</div>
						{/if}
					</div>
				</div>

				<footer class="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
					<span class="text-[11px] text-fg-dim">
						{t('versionHistory.kept', { n: versions.length })}
					</span>
					<button
						class="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-fg-muted transition hover:bg-bg-2 hover:text-fg disabled:opacity-40"
						onclick={() => void handleRestore()}
						disabled={!selected}
					>
						<RotateCcw size={13} aria-hidden="true" />
						<span>{t('versionHistory.restoreThisVersion')}</span>
					</button>
				</footer>
			{/if}
		</div>
	</div>
{/if}

<script lang="ts">
	// §6.8 - Workspace management modal.
	//
	// Lists the saved workspaces with actions:
	//   - Restore: restores the set of open files
	//   - Update: refreshes with the current state
	//   - Rename: native prompt (simple, no nested modal)
	//   - Delete: native confirmation + delete
	//
	// No initial focus on a list item (the list may be empty): we target the
	// "Save" button at the top, which acts as a natural entry point.

	import { tick } from 'svelte';
	import LoadError from './LoadError.svelte';
	import { reportPersistenceError } from '#lib/storage.js';
	import { browser } from '$app/env';
	import { t } from '#lib/i18n/index.js';
	import { workspaceStore } from '#lib/workspaces.svelte.js';
	import { promptStore } from '#lib/prompt.svelte.js';
	import { focusTrap } from '#lib/a11y/focusTrap.js';
	import { formatSaveAge } from '#lib/stats.js';
	import { Layers, Plus, Play, RefreshCw, Pencil, Trash2, X } from '@lucide/svelte';

	interface Props {
		open: boolean;
		onClose: () => void;
	}

	let { open, onClose }: Props = $props();

	let saveButton: HTMLButtonElement | null = $state(null);

	let loadError = $state(false);
	let loading = $state(false);
	async function loadWorkspaces() {
		loading = true;
		loadError = false;
		try {
			await workspaceStore.load();
		} catch (error) {
			loadError = true;
			reportPersistenceError(error, 'load');
		} finally {
			loading = false;
			await tick();
			saveButton?.focus();
		}
	}
	$effect(() => {
		if (open && browser) void loadWorkspaces();
	});

	async function handleSave(): Promise<void> {
		if (!browser) return;
		// §B1.3 - Custom modal (cf. PromptModal + promptStore). Previously: window.prompt.
		const name = await promptStore.prompt({
			title: t('workspaces.promptSaveTitle'),
			placeholder: t('workspaces.promptSavePlaceholder')
		});
		if (name === null) return;
		await workspaceStore.save(name);
	}

	async function handleRestore(id: string): Promise<void> {
		await workspaceStore.restore(id);
		onClose();
	}

	async function handleUpdate(id: string): Promise<void> {
		await workspaceStore.update(id);
	}

	async function handleRename(id: string, currentName: string): Promise<void> {
		if (!browser) return;
		const next = await promptStore.prompt({
			title: t('workspaces.promptRenameTitle'),
			defaultValue: currentName
		});
		if (next === null) return;
		await workspaceStore.rename(id, next);
	}

	async function handleDelete(id: string, name: string): Promise<void> {
		if (!browser) return;
		const ok = await promptStore.confirm({
			title: t('workspaces.confirmDeleteTitle', { name }),
			message: t('workspaces.confirmDeleteMessage'),
			confirmLabel: t('workspaces.confirmDeleteLabel'),
			danger: true
		});
		if (!ok) return;
		await workspaceStore.delete(id);
	}
</script>

{#if open}
	<div
		class="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pb-4 backdrop-blur-sm
		       pt-[max(env(safe-area-inset-top),12vh)]"
		style:padding-left="max(env(safe-area-inset-left), 1rem)"
		style:padding-right="max(env(safe-area-inset-right), 1rem)"
		onclick={(e) => {
			if (e.target === e.currentTarget) onClose();
		}}
		onkeydown={(e) => {
			if (e.key === 'Escape') onClose();
		}}
		role="dialog"
		aria-modal="true"
		aria-labelledby="workspaces-title"
		inert={promptStore.open}
		aria-hidden={promptStore.open ? 'true' : undefined}
		tabindex="-1"
		use:focusTrap
	>
		<div
			class="mdsh-dialog-panel flex w-full max-w-xl flex-col overflow-hidden rounded-lg border border-border
			       bg-bg-1 shadow-2xl animate-fade-in"
		>
			<header class="flex items-center gap-2 border-b border-border px-3 py-2">
				<Layers size={16} class="text-fg-dim" aria-hidden="true" />
				<h2 id="workspaces-title" class="flex-1 text-sm font-medium text-fg">
					{t('workspaces.title')}
				</h2>
				<button
					bind:this={saveButton}
					class="flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-fg-muted transition hover:bg-bg-2 hover:text-fg"
					onclick={() => void handleSave()}
					aria-label={t('workspaces.saveCurrentAria')}
				>
					<Plus size={12} aria-hidden="true" />
					<span>{t('workspaces.save')}</span>
				</button>
				<button
					class="rounded p-1 text-fg-dim transition hover:bg-bg-2 hover:text-fg"
					onclick={onClose}
					aria-label={t('workspaces.close')}
				>
					<X size={14} />
				</button>
			</header>

			<div class="max-h-[60vh] overflow-y-auto">
				{#if loadError}
					<LoadError onRetry={() => void loadWorkspaces()} busy={loading} />
				{:else if !workspaceStore.loaded}
					<p class="px-4 py-6 text-center text-xs text-fg-dim">{t('workspaces.loading')}</p>
				{:else if workspaceStore.workspaces.length === 0}
					<p class="px-4 py-6 text-center text-xs text-fg-dim">
						{t('workspaces.empty')}
					</p>
				{:else}
					<ul class="divide-y divide-border" aria-label={t('workspaces.listAria')}>
						{#each workspaceStore.workspaces as ws (ws.id)}
							<li class="flex items-center gap-3 px-3 py-2.5">
								<div class="min-w-0 flex-1">
									<div class="truncate text-sm text-fg" title={ws.name}>{ws.name}</div>
									<div class="text-[10px] text-fg-dim">
										{t('workspaces.fileCount', { n: ws.fileIds.length })}
										· {formatSaveAge(ws.updatedAt)}
									</div>
								</div>
								<button
									class="flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-fg-muted transition hover:bg-bg-2 hover:text-accent"
									onclick={() => void handleRestore(ws.id)}
									aria-label={t('workspaces.restoreAria', { name: ws.name })}
								>
									<Play size={12} aria-hidden="true" />
									<span>{t('workspaces.restore')}</span>
								</button>
								<button
									class="rounded border border-border p-1.5 text-fg-muted transition hover:bg-bg-2 hover:text-fg"
									onclick={() => void handleUpdate(ws.id)}
									title={t('workspaces.updateTitle')}
									aria-label={t('workspaces.updateAria', { name: ws.name })}
								>
									<RefreshCw size={12} aria-hidden="true" />
								</button>
								<button
									class="rounded border border-border p-1.5 text-fg-muted transition hover:bg-bg-2 hover:text-fg"
									onclick={() => void handleRename(ws.id, ws.name)}
									title={t('workspaces.renameTitle')}
									aria-label={t('workspaces.renameAria', { name: ws.name })}
								>
									<Pencil size={12} aria-hidden="true" />
								</button>
								<button
									class="rounded border border-border p-1.5 text-fg-muted transition hover:bg-bg-2 hover:text-danger"
									onclick={() => void handleDelete(ws.id, ws.name)}
									title={t('workspaces.deleteTitle')}
									aria-label={t('workspaces.deleteAria', { name: ws.name })}
								>
									<Trash2 size={12} aria-hidden="true" />
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</div>

			<footer class="border-t border-border px-3 py-2 text-[11px] text-fg-dim">
				{t('workspaces.footerCount', { n: workspaceStore.workspaces.length })}
				· {t('workspaces.footerHint')}
			</footer>
		</div>
	</div>
{/if}

<script lang="ts">
	import { tick } from 'svelte';
	import { X } from '@lucide/svelte';
	import { filesStore } from '#lib/files.svelte.js';
	import { promptStore } from '#lib/prompt.svelte.js';
	import { t } from '#lib/i18n/index.js';

	let { onEmpty }: { onEmpty: () => void } = $props();
	let summary: HTMLElement | undefined = $state();
	let selectedIds = $state<string[]>([]);
	const selected = $derived(new Set(selectedIds));
	const selectedEntries = $derived(filesStore.trash.filter((entry) => selected.has(entry.file.id)));
	$effect(() => {
		const available = new Set(filesStore.trash.map((entry) => entry.file.id));
		const retained = selectedIds.filter((id) => available.has(id));
		if (retained.length !== selectedIds.length) selectedIds = retained;
	});

	async function focusAfterChange() {
		await tick();
		if (filesStore.trash.length) summary?.focus();
		else onEmpty();
	}

	async function purge(ids: string[], all = false, single = false) {
		if (filesStore.trashBusy || ids.length === 0) return;
		if (
			!(await promptStore.confirm({
				title: t(
					single
						? 'sidebar.purgeConfirm'
						: all
							? 'bulkDelete.emptyConfirm'
							: 'bulkDelete.purgeSelectedConfirm',
					{ n: ids.length }
				),
				message: t('bulkDelete.purgeMessage'),
				confirmLabel: t(all ? 'bulkDelete.emptyTrash' : 'bulkDelete.purge'),
				danger: true
			}))
		)
			return;
		if (await filesStore.purgeTrashMany(ids)) selectedIds = [];
		await focusAfterChange();
	}

	async function restore(id: string) {
		if (filesStore.trashBusy) return;
		filesStore.restore(id);
		await focusAfterChange();
	}
</script>

<details
	class="max-h-72 overflow-y-auto border-t border-border px-3 py-2 text-xs"
	aria-busy={filesStore.trashBusy}
>
	<summary bind:this={summary} class="cursor-pointer text-fg">
		{t('sidebar.trash')} ({filesStore.trash.length})
	</summary>
	<div class="flex flex-col gap-2 py-2" role="group" aria-label={t('bulkDelete.trashActions')}>
		<label class="flex min-h-10 cursor-pointer items-center gap-2">
			<input
				type="checkbox"
				class="size-4 accent-accent"
				checked={filesStore.trash.length > 0 && selectedEntries.length === filesStore.trash.length}
				indeterminate={selectedEntries.length > 0 &&
					selectedEntries.length < filesStore.trash.length}
				disabled={filesStore.trashBusy}
				onchange={(event) =>
					(selectedIds = event.currentTarget.checked
						? filesStore.trash.map((entry) => entry.file.id)
						: [])}
			/>
			{t('bulkDelete.selectTrash')}
		</label>
		<span class="text-fg-muted" role="status" aria-live="polite" aria-atomic="true"
			>{t('bulkDelete.selectedCount', { n: selectedEntries.length })}</span
		>
		<div class="flex flex-wrap gap-2">
			<button
				class="rounded border border-border px-2 py-2 text-danger disabled:opacity-50"
				disabled={filesStore.trashBusy || selectedEntries.length === 0}
				onclick={() => void purge(selectedEntries.map((entry) => entry.file.id))}
				>{t('bulkDelete.deleteSelected')}</button
			>
			<button
				class="rounded border border-border px-2 py-2 text-danger disabled:opacity-50"
				disabled={filesStore.trashBusy}
				onclick={() =>
					void purge(
						filesStore.trash.map((entry) => entry.file.id),
						true
					)}>{t('bulkDelete.emptyTrash')}</button
			>
		</div>
	</div>
	{#each filesStore.trash as entry (entry.file.id)}
		<div class="flex items-center gap-1">
			<label class="flex min-h-11 min-w-11 cursor-pointer items-center justify-center">
				<input
					type="checkbox"
					class="size-4 accent-accent"
					aria-label={t('bulkDelete.selectDocument', { name: entry.file.name })}
					checked={selected.has(entry.file.id)}
					disabled={filesStore.trashBusy}
					onchange={(event) => {
						selectedIds = event.currentTarget.checked
							? [...selectedIds, entry.file.id]
							: selectedIds.filter((id) => id !== entry.file.id);
					}}
				/>
			</label>
			<button
				class="min-w-0 flex-1 truncate py-2 text-left"
				disabled={filesStore.trashBusy}
				onclick={() => void restore(entry.file.id)}
				>{t('sidebar.restore', { name: entry.file.name })}</button
			>
			<button
				class="p-2 text-danger"
				disabled={filesStore.trashBusy}
				aria-label={t('sidebar.purge', { name: entry.file.name })}
				onclick={() => void purge([entry.file.id], false, true)}><X size={14} /></button
			>
		</div>
	{/each}
</details>

<script lang="ts">
	import { tick } from 'svelte';
	import { filesStore } from '#lib/files.svelte.js';
	import { t, i18n } from '#lib/i18n/index.js';
	import { normalizeCommandSearch } from '#lib/ui/commands.js';
	import { focusTrap } from '#lib/a11y/focusTrap.js';
	import { promptStore } from '#lib/prompt.svelte.js';
	import { X, Search, Trash2 } from '@lucide/svelte';
	let { onClose }: { onClose: () => void } = $props();
	let input: HTMLInputElement | undefined = $state();
	let query = $state('');
	let scope = $state('all');
	let selectedIds = $state<string[]>([]);
	const openIds = $derived(new Set(filesStore.files.map((file) => file.id)));
	const unresolved = $derived(
		filesStore.library.flatMap((file) =>
			filesStore
				.wikiLinkTargets(file.id)
				.filter((target) => !filesStore.resolveWikiLink(target, file.id))
				.map((target) => ({ file, target }))
		)
	);
	const matches = $derived(
		filesStore.library
			.filter((file) => {
				if (scope === 'open' && !openIds.has(file.id)) return false;
				if (scope === 'closed' && openIds.has(file.id)) return false;
				return normalizeCommandSearch(
					`${file.name} ${file.relativePath ?? ''} ${filesStore.documentTitle(file.id)} ${filesStore.getTags(file.id).join(' ')}`
				).includes(normalizeCommandSearch(query.trim()));
			})
			.sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name))
	);
	const selected = $derived(new Set(selectedIds));
	const selectedMatches = $derived(matches.filter((file) => selected.has(file.id)));
	$effect(() => {
		const visibleIds = new Set(matches.map((file) => file.id));
		const retained = selectedIds.filter((id) => visibleIds.has(id));
		if (retained.length !== selectedIds.length) selectedIds = retained;
	});
	$effect(() => {
		void tick().then(() => input?.focus());
	});
	function open(id: string) {
		if (filesStore.trashBusy) return;
		filesStore.openDocument(id);
		onClose();
	}
	async function remove(id: string) {
		if (filesStore.trashBusy) return;
		if (
			await promptStore.confirm({
				title: t('sidebar.deleteConfirm'),
				message: t('sidebar.deleteMessage'),
				danger: true
			})
		) {
			await filesStore.deleteMany([id]);
			await tick();
			input?.focus();
		}
	}
	async function removeMany(all: boolean) {
		const ids = (all ? filesStore.library : selectedMatches).map((file) => file.id);
		if (filesStore.trashBusy || ids.length === 0) return;
		if (
			!(await promptStore.confirm({
				title: t(all ? 'bulkDelete.libraryAllConfirm' : 'bulkDelete.librarySelectedConfirm', {
					n: ids.length
				}),
				message: t(all ? 'bulkDelete.libraryAllMessage' : 'bulkDelete.librarySelectedMessage'),
				confirmLabel: t(all ? 'bulkDelete.deleteAll' : 'bulkDelete.deleteSelected'),
				danger: true
			}))
		)
			return;
		if (await filesStore.deleteMany(ids)) selectedIds = [];
		await tick();
		input?.focus();
	}
</script>

<div
	class="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-[max(env(safe-area-inset-top),8vh)]"
	role="dialog"
	aria-modal="true"
	aria-label={t('library.title')}
	inert={promptStore.open}
	aria-hidden={promptStore.open ? 'true' : undefined}
	tabindex="-1"
	use:focusTrap
	onclick={(event) => {
		if (event.target === event.currentTarget && !filesStore.trashBusy) onClose();
	}}
	onkeydown={(event) => {
		if (event.key === 'Escape' && !filesStore.trashBusy) onClose();
	}}
>
	<section
		class="mdsh-dialog-panel flex max-h-[80dvh] w-full max-w-2xl flex-col border border-border bg-bg-1 shadow-xl"
		aria-busy={filesStore.trashBusy}
	>
		<header class="flex items-center gap-3 border-b border-border px-4 py-3">
			<h2 class="flex-1 text-sm font-medium">
				{t('library.title')} <span class="text-fg-muted">({filesStore.library.length})</span>
			</h2>
			<button
				class="rounded p-2"
				onclick={onClose}
				disabled={filesStore.trashBusy}
				aria-label={t('settings.close')}><X size={16} /></button
			>
		</header>
		<label class="flex items-center gap-2 px-4 py-3"
			><Search size={16} /><input
				bind:this={input}
				bind:value={query}
				oninput={() => (selectedIds = [])}
				disabled={filesStore.trashBusy}
				class="min-w-0 flex-1 rounded border border-border bg-bg px-3 py-2 text-sm"
				aria-label={t('library.filter')}
				placeholder={t('library.filter')}
				onkeydown={(event) => {
					if (event.key === 'Enter' && matches[0]) open(matches[0].id);
				}}
			/></label
		>
		<div class="flex flex-wrap gap-2 px-4 pb-3" role="group" aria-label={t('library.scope')}>
			{#each ['all', 'open', 'closed'] as value (value)}<button
					class="rounded border border-border px-3 py-2 text-xs"
					class:text-accent={scope === value}
					aria-pressed={scope === value}
					disabled={filesStore.trashBusy}
					onclick={() => {
						scope = value;
						selectedIds = [];
					}}
					>{t(
						value === 'all' ? 'library.all' : value === 'open' ? 'library.open' : 'library.closed'
					)}</button
				>{/each}
		</div>
		<div
			class="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2"
			role="group"
			aria-label={t('bulkDelete.libraryActions')}
		>
			<label class="flex min-h-10 cursor-pointer items-center gap-2 text-xs">
				<input
					type="checkbox"
					class="size-4 accent-accent"
					checked={matches.length > 0 && selectedMatches.length === matches.length}
					indeterminate={selectedMatches.length > 0 && selectedMatches.length < matches.length}
					disabled={filesStore.trashBusy || matches.length === 0}
					onchange={(event) =>
						(selectedIds = event.currentTarget.checked ? matches.map((file) => file.id) : [])}
				/>
				{t('bulkDelete.selectResults')}
			</label>
			<span class="text-xs text-fg-muted" role="status" aria-live="polite" aria-atomic="true"
				>{t('bulkDelete.selectedCount', { n: selectedMatches.length })}</span
			>
			<button
				class="rounded border border-border px-3 py-2 text-xs text-danger disabled:opacity-50"
				disabled={filesStore.trashBusy || selectedMatches.length === 0}
				onclick={() => void removeMany(false)}>{t('bulkDelete.deleteSelected')}</button
			>
			<button
				class="rounded border border-border px-3 py-2 text-xs text-danger disabled:opacity-50"
				disabled={filesStore.trashBusy || filesStore.library.length === 0}
				onclick={() => void removeMany(true)}>{t('bulkDelete.deleteAll')}</button
			>
		</div>
		{#if unresolved.length}
			<details
				class="max-h-48 overflow-y-auto border-t border-border px-4 py-2 text-xs text-fg-muted"
			>
				<summary class="cursor-pointer py-1"
					>{t('library.unresolved', { n: unresolved.length })}</summary
				>
				<p class="py-2">{t('library.repairHint')}</p>
				{#each unresolved.slice(0, 200) as link (link.file.id + ':' + link.target)}<button
						class="block w-full truncate py-2 text-left underline"
						disabled={filesStore.trashBusy}
						onclick={() => open(link.file.id)}>{link.file.name} → [[{link.target}]]</button
					>{/each}
			</details>
		{/if}
		<ul class="min-h-0 flex-1 overflow-y-auto border-t border-border">
			{#each matches as file (file.id)}
				<li class="flex items-center border-b border-border px-2" data-document-id={file.id}>
					<label class="flex min-h-11 min-w-11 cursor-pointer items-center justify-center">
						<input
							type="checkbox"
							class="size-4 accent-accent"
							aria-label={t('bulkDelete.selectDocument', { name: file.name })}
							checked={selected.has(file.id)}
							disabled={filesStore.trashBusy}
							onchange={(event) => {
								selectedIds = event.currentTarget.checked
									? [...selectedIds, file.id]
									: selectedIds.filter((id) => id !== file.id);
							}}
						/>
					</label>
					<button
						class="flex min-w-0 flex-1 flex-col gap-1 p-3 text-left hover:bg-bg-2"
						onclick={() => open(file.id)}
						disabled={filesStore.trashBusy}
						aria-label={t('library.openDocument', { name: file.relativePath ?? file.name })}
					>
						<span class="max-w-full truncate text-sm font-medium">{file.name}</span>
						{#if file.relativePath}<span class="max-w-full truncate text-xs text-fg-muted"
								>{file.relativePath}</span
							>{/if}
						<span class="max-w-full truncate text-xs text-fg-muted"
							>{filesStore.documentTitle(file.id)} · {new Intl.DateTimeFormat(i18n.locale, {
								dateStyle: 'medium',
								timeStyle: 'short'
							}).format(file.updatedAt)}</span
						>
						<span class="text-xs text-fg-muted"
							>{t(
								openIds.has(file.id) ? 'library.open' : 'library.closed'
							)}{#each filesStore.getTags(file.id) as tag (tag)}
								· #{tag}{/each}</span
						>
					</button>
					<button
						class="rounded p-3 text-fg-muted hover:text-danger"
						onclick={() => void remove(file.id)}
						disabled={filesStore.trashBusy}
						aria-label={`${t('palette.deleteFile')}: ${file.name}`}><Trash2 size={16} /></button
					>
				</li>
			{:else}<li class="p-6 text-center text-sm text-fg-muted">{t('library.empty')}</li>{/each}
		</ul>
	</section>
</div>

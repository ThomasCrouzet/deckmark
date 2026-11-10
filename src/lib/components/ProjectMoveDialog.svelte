<script lang="ts">
	import { tick } from 'svelte';
	import { focusTrap } from '#lib/a11y/focusTrap.js';
	import { t } from '#lib/i18n/index.js';
	import { notify } from '#lib/notify.svelte.js';
	import { promptStore } from '#lib/prompt.svelte.js';
	import { reportError } from '#lib/report.js';
	import type { TransferResult, TransferSelection } from '#lib/project-transfer.js';
	import type { ProjectRoot } from '#lib/project-explorer.svelte.js';

	interface Props {
		open: boolean;
		selection: TransferSelection | null;
		projects: ProjectRoot[];
		onClose: () => void;
		onDone: (result: TransferResult) => void;
	}

	let { open, selection, projects, onClose, onDone }: Props = $props();
	let targetProjectId = $state('');
	let targetFolder = $state('');
	let busy = $state(false);
	let error = $state(false);
	let firstField = $state<HTMLSelectElement | null>(null);

	$effect(() => {
		if (!open || !selection) return;
		targetProjectId = selection.projectId ?? projects[0]?.id ?? '';
		targetFolder = '';
		busy = false;
		error = false;
		void tick().then(() => firstField?.focus());
	});

	async function run(mode: 'move' | 'copy'): Promise<void> {
		if (!selection || busy || !targetProjectId) return;
		busy = true;
		error = false;
		try {
			const { transferProjectSelection } = await import('#lib/project-io.js');
			const result = await transferProjectSelection(selection, {
				mode,
				targetProjectId,
				...(targetFolder.trim() ? { targetFolder: targetFolder.trim() } : {}),
				onConflict: async (conflicts) =>
					promptStore.confirm({
						title: t('projects.conflictTitle'),
						message: t('projects.conflictMessage', { path: conflicts[0]!.path }),
						confirmLabel: t('projects.keepBoth')
					})
			});
			if (result.status === 'done') {
				if (result.documents)
					notify.success(
						t(mode === 'move' ? 'projects.movedCount' : 'projects.copiedCount', {
							n: result.documents
						})
					);
				if (result.unresolved.length)
					notify.info(t('projects.unresolvedLinks', { n: result.unresolved.length }));
				onDone(result);
				onClose();
			}
		} catch (failure) {
			error = true;
			reportError('project transfer', failure);
		} finally {
			busy = false;
		}
	}
</script>

{#if open && selection}
	<div
		class="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-3"
		role="presentation"
		onclick={(event) => {
			if (event.target === event.currentTarget && !busy) onClose();
		}}
	>
		<div
			class="w-full max-w-md rounded-lg border border-border bg-bg-1 p-4 text-fg shadow-xl"
			role="dialog"
			aria-modal="true"
			aria-labelledby="project-move-title"
			tabindex="-1"
			use:focusTrap
			onkeydown={(event) => {
				if (event.key === 'Escape' && !busy) {
					event.stopPropagation();
					onClose();
				}
			}}
		>
			<h2 id="project-move-title" class="text-sm font-medium">{t('projects.moveTitle')}</h2>
			<p class="mt-1 text-xs text-fg-muted">{t('projects.moveSemantics')}</p>
			<div class="mt-4 space-y-3">
				<label class="block text-xs text-fg-muted">
					<span class="mb-1 block">{t('projects.moveTargetProject')}</span>
					<select
						bind:this={firstField}
						bind:value={targetProjectId}
						data-testid="project-move-project"
						class="w-full rounded border border-border bg-bg px-2 py-2 text-sm text-fg"
						disabled={busy}
					>
						{#each projects as project (project.id)}
							<option value={project.id}>{project.name}</option>
						{/each}
					</select>
				</label>
				<label class="block text-xs text-fg-muted">
					<span class="mb-1 block">{t('projects.moveTargetFolder')}</span>
					<input
						bind:value={targetFolder}
						data-testid="project-move-folder"
						placeholder={t('projects.moveFolderPlaceholder')}
						class="w-full rounded border border-border bg-bg px-2 py-2 text-sm text-fg"
						spellcheck="false"
						autocapitalize="off"
						disabled={busy}
					/>
				</label>
			</div>
			{#if error}<p role="alert" class="mt-3 text-sm text-danger">
					{t('projects.transferFailed')}
				</p>{/if}
			<div class="mt-4 flex flex-wrap justify-end gap-2">
				<button
					type="button"
					class="rounded border border-border px-3 py-2 text-sm"
					onclick={onClose}
					disabled={busy}>{t('projects.cancel')}</button
				>
				<button
					type="button"
					class="rounded border border-border px-3 py-2 text-sm"
					onclick={() => void run('copy')}
					disabled={busy}
					data-testid="project-move-copy">{t('projects.copy')}</button
				>
				<button
					type="button"
					class="rounded border border-accent bg-accent px-3 py-2 text-sm text-on-accent"
					onclick={() => void run('move')}
					disabled={busy}
					data-testid="project-move-submit">{t('projects.move')}</button
				>
			</div>
		</div>
	</div>
{/if}

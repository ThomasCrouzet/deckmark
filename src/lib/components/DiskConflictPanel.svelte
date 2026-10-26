<script lang="ts">
	import { tick } from 'svelte';
	import { Download, Upload, X } from '@lucide/svelte';
	import DiffView from './DiffView.svelte';
	import { focusTrap } from '#lib/a11y/focusTrap.js';
	import { diskConflictStore } from '#lib/disk-conflict.svelte.js';
	import { t, type MessageKey } from '#lib/i18n/index.js';

	let cancelButton: HTMLButtonElement | null = $state(null);
	const request = $derived(diskConflictStore.pending);

	function message(key: MessageKey, params?: Record<string, string | number>): string {
		return t(key, params);
	}

	$effect(() => {
		if (request) void tick().then(() => cancelButton?.focus());
	});
</script>

{#if request}
	<div
		class="fixed inset-0 z-[70] flex items-start justify-center bg-black/70 px-4 pb-4 backdrop-blur-sm pt-[max(env(safe-area-inset-top),5vh)]"
		style:padding-left="max(env(safe-area-inset-left), 1rem)"
		style:padding-right="max(env(safe-area-inset-right), 1rem)"
		onkeydown={(event) => {
			if (event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				diskConflictStore.choose('cancel');
			}
		}}
		role="dialog"
		aria-modal="true"
		aria-labelledby="disk-conflict-title"
		aria-describedby="disk-conflict-description"
		tabindex="-1"
		use:focusTrap
	>
		<div
			class="mdsh-dialog-panel flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-border bg-bg-1 shadow-2xl animate-fade-in"
		>
			<header class="flex items-start gap-3 border-b border-border px-4 py-3">
				<div class="min-w-0 flex-1">
					<h2 id="disk-conflict-title" class="truncate text-sm font-medium text-fg">
						{message('diskConflict.title', { name: request.name })}
					</h2>
					<p id="disk-conflict-description" class="mt-1 text-xs text-fg-muted">
						{message('diskConflict.description')}
					</p>
				</div>
				<button
					bind:this={cancelButton}
					class="rounded p-1 text-fg-dim transition hover:bg-bg-2 hover:text-fg"
					onclick={() => diskConflictStore.choose('cancel')}
					aria-label={message('diskConflict.cancel')}
				>
					<X size={16} />
				</button>
			</header>
			<div class="min-h-0 flex-1 overflow-auto p-4">
				<DiffView
					before={request.localContent}
					after={request.diskContent}
					beforeLabel={message('diskConflict.local')}
					afterLabel={message('diskConflict.disk')}
					ariaLabel={message('diskConflict.title', { name: request.name })}
					maxHeight="55vh"
				/>
			</div>
			<footer class="flex flex-wrap justify-end gap-2 border-t border-border px-4 py-3">
				<button
					class="rounded-md border border-border px-3 py-2 text-xs text-fg-muted transition hover:bg-bg-2 hover:text-fg"
					onclick={() => diskConflictStore.choose('cancel')}
				>
					{message('diskConflict.cancel')}
				</button>
				<button
					class="flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-xs text-fg-muted transition hover:bg-bg-2 hover:text-fg"
					onclick={() => diskConflictStore.choose('reload')}
				>
					<Download size={14} aria-hidden="true" />
					{message('diskConflict.reload')}
				</button>
				<button
					class="flex items-center gap-1.5 rounded-md bg-danger px-3 py-2 text-xs text-white transition hover:opacity-90"
					onclick={() => diskConflictStore.choose('overwrite')}
				>
					<Upload size={14} aria-hidden="true" />
					{message('diskConflict.overwrite')}
				</button>
			</footer>
		</div>
	</div>
{/if}

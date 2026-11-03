<script lang="ts">
	import { Download, Image as ImageIcon } from '@lucide/svelte';
	import type { FileItem } from '#lib/types.js';
	import { filesStore } from '#lib/files.svelte.js';
	import { t } from '#lib/i18n/index.js';

	let { file }: { file: FileItem } = $props();
</script>

<div class="image-document" data-testid="image-document">
	<div class="image-toolbar">
		<span class="image-kind"><ImageIcon size={14} aria-hidden="true" />{t('documents.image')}</span>
		<span class="image-meta">{file.mime ?? 'image'} · {file.name}</span>
		<button type="button" onclick={() => filesStore.export(file.id)}>
			<Download size={14} aria-hidden="true" />
			{t('toolbar.export')}
		</button>
	</div>
	<div class="image-viewport">
		{#if file.data}
			<img src={file.data} alt={file.name} />
		{:else}
			<p role="alert">{t('documents.imageUnavailable')}</p>
		{/if}
	</div>
</div>

<style>
	.image-document {
		display: flex;
		height: 100%;
		min-height: 0;
		flex-direction: column;
	}
	.image-toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 12px;
		padding: 8px 12px;
		border-bottom: 1px solid var(--color-border);
		background: var(--color-bg-1);
		font-size: 12px;
		color: var(--color-fg-muted);
	}
	.image-kind {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		color: var(--color-fg);
		font-weight: 500;
	}
	.image-meta {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-mono);
		font-size: 11px;
	}
	button {
		display: inline-flex;
		min-height: 36px;
		align-items: center;
		gap: 6px;
		margin-left: auto;
		padding: 4px 10px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-xs);
		background: var(--color-bg-2);
		color: var(--color-fg);
		cursor: pointer;
	}
	button:hover {
		border-color: var(--color-accent);
	}
	button:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}
	.image-viewport {
		display: flex;
		min-height: 0;
		flex: 1;
		align-items: center;
		justify-content: center;
		overflow: auto;
		padding: 16px;
		background: var(--color-bg);
	}
	img {
		max-width: 100%;
		max-height: 100%;
		object-fit: contain;
		box-shadow: var(--shadow-lg);
	}
</style>

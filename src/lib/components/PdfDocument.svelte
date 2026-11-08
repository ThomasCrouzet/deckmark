<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { Download, ExternalLink, FileText } from '@lucide/svelte';
	import type { FileItem } from '#lib/types.js';
	import { filesStore } from '#lib/files.svelte.js';
	import { t } from '#lib/i18n/index.js';

	let { file }: { file: FileItem } = $props();
	let url = $state('');
	let blocked = $state(false);
	let failed = $state(false);

	onMount(() => {
		if (!file.data) return;
		let disposed = false;
		const fileId = file.id;
		void import('#lib/data-url.js')
			.then(({ dataUrlToBlob }) => dataUrlToBlob(file.data!))
			.then((blob) => {
				if (disposed || file.id !== fileId) return;
				if (!blob.size) {
					failed = true;
					return;
				}
				url = URL.createObjectURL(blob);
			})
			.catch(() => {
				if (!disposed) failed = true;
			});
		return () => {
			disposed = true;
		};
	});

	onDestroy(() => {
		if (url) URL.revokeObjectURL(url);
	});

	function open() {
		if (url) window.open(url, '_blank', 'noopener');
	}
</script>

<div class="pdf-document" data-testid="pdf-document">
	<div class="pdf-toolbar">
		<span class="pdf-kind"><FileText size={14} aria-hidden="true" />{t('documents.pdf')}</span>
		<span class="pdf-meta">{file.name}</span>
		<button type="button" onclick={open} disabled={!url}>
			<ExternalLink size={14} aria-hidden="true" />
			{t('documents.openPdf')}
		</button>
		<button type="button" onclick={() => filesStore.export(file.id)}>
			<Download size={14} aria-hidden="true" />
			{t('toolbar.export')}
		</button>
	</div>
	<div class="pdf-viewport">
		{#if !file.data || failed}
			<p role="alert">{t('documents.pdfUnavailable')}</p>
		{:else if url}
			<iframe
				src={url}
				title={file.name}
				data-testid="pdf-frame"
				onload={() => (blocked = false)}
				onerror={() => (blocked = true)}
			></iframe>
			{#if blocked}
				<p role="status">{t('documents.pdfFallback')}</p>
			{/if}
		{/if}
	</div>
</div>

<style>
	.pdf-document {
		display: flex;
		height: 100%;
		min-height: 0;
		flex-direction: column;
	}
	.pdf-toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		padding: 6px 10px;
		border-bottom: 1px solid var(--color-border);
		background: var(--color-bg-1);
		font-size: 11px;
		color: var(--color-fg-muted);
	}
	.pdf-kind {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		color: var(--color-fg);
		font-weight: 500;
	}
	.pdf-meta {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-mono);
		font-size: 10px;
	}
	.pdf-toolbar button {
		display: inline-flex;
		min-height: 32px;
		align-items: center;
		gap: 4px;
		padding: 3px 8px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-xs);
		background: var(--color-bg-2);
		color: var(--color-fg);
	}
	.pdf-viewport {
		min-height: 0;
		flex: 1;
		background: var(--color-bg);
	}
	iframe {
		width: 100%;
		height: 100%;
		border: 0;
	}
</style>
